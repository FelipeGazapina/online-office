// The office's own memory. Notes are small Markdown files under one root, keyed by employee and by block, so
// they survive a harness swap, a moved folder and a restart. Plain Node: the MCP check script runs this file directly.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlockId, EmployeeId, Provider } from '../../shared/protocol.ts';

export type NoteId = string & { readonly __brand: 'NoteId' };

// What the model calls a scope. `me` is the employee's own notebook, `block` is shared by the whole project team.
export type ScopeName = 'me' | 'block';

export type Who = { employeeId: EmployeeId; blockId: BlockId; provider: Provider };

type MemoryScope = { kind: 'employee'; employeeId: EmployeeId } | { kind: 'block'; blockId: BlockId };

export type Note = {
  id: NoteId;
  title: string;
  body: string;
  // Absent on a note the owner typed by hand.
  author?: { employeeId: EmployeeId; provider: Provider };
  createdAt: number;
  updatedAt: number;
};

// Sized so that every title of a full notebook fits in the digest: a digest line is at most 63 characters,
// so 25 and 40 notes come to 1,575 and 2,520, inside the 1,600 and 2,600 budgets. No ordering or truncation logic needed.
export const LIMITS = {
  titleChars: 60,
  bodyChars: 500,
  notes: { employee: 25, block: 40 },
  digestChars: 4200,
  recallResults: 5,
} as const;

const BLOCK_NAME_IN_DIGEST = 24;

export type TitleRef = { id: NoteId; title: string };

export type RememberResult =
  | { ok: true; id: NoteId; used: number; cap: number }
  | { ok: false; reason: string; titles?: TitleRef[] };

export type ForgetResult = { ok: true; id: NoteId } | { ok: false; reason: string };

export type RecallResult =
  | { mode: 'list'; total: number; notes: (TitleRef & { scope: ScopeName })[] }
  | { mode: 'search'; total: number; notes: (Pick<Note, 'id' | 'title' | 'body' | 'updatedAt'> & { scope: ScopeName })[] };

// One employee's view of memory. The MCP server hands this to tools, so a tool can only reach the caller's own notes and their block's.
export type Notebook = {
  remember(scope: ScopeName, title: string, body: string): Promise<RememberResult>;
  recall(query: string | undefined, scope: ScopeName | 'both'): RecallResult;
  forget(scope: ScopeName, id: string): Promise<ForgetResult>;
  // Titles only, frozen by the caller for the length of a harness session. Empty when nothing is saved.
  digest(blockName: string): string;
};

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

// Notes are plain files that leave the machine inside prompts, so anything credential-shaped is refused.
const SECRETS: [label: string, pattern: RegExp][] = [
  ['an Anthropic or OpenAI style API key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['a private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Stripe live key', /\b[rs]k_live_[A-Za-z0-9]{16,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a password or key assignment', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"']{12,}/i],
];

export function secretIn(text: string): string | undefined {
  return SECRETS.find(([, pattern]) => pattern.test(text))?.[0];
}

// The note id is the title's slug, so saving the same title twice is an update, not a duplicate.
export function slug(title: string): NoteId | undefined {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.titleChars)
    .replace(/-+$/, '');
  return s ? (s as NoteId) : undefined;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Every frontmatter value is JSON, which is also valid YAML, so notes read fine in Finder and parse without a YAML library.
function serialize(n: Note): string {
  const head = [`id: ${n.id}`, `title: ${JSON.stringify(n.title)}`];
  if (n.author) head.push(`author: ${JSON.stringify(n.author)}`);
  head.push(`createdAt: ${n.createdAt}`, `updatedAt: ${n.updatedAt}`);
  return ['---', ...head, '---', n.body, ''].join('\n');
}

const jsonOr = (raw: string | undefined): unknown => {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

// The owner may edit a note by hand, so a file that no longer parses is skipped instead of breaking recall.
function parse(id: NoteId, text: string): Note | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  const fields = new Map<string, string>();
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const title = jsonOr(fields.get('title'));
  if (typeof title !== 'string' || !title.trim()) return undefined;
  const num = (k: string) => (typeof jsonOr(fields.get(k)) === 'number' ? (jsonOr(fields.get(k)) as number) : 0);
  const a = jsonOr(fields.get('author')) as { employeeId?: unknown; provider?: unknown } | undefined;
  const author = a && typeof a.employeeId === 'string' && typeof a.provider === 'string' ? (a as Note['author']) : undefined;
  return { id, title: oneLine(title), body: m[2]!.trim(), ...(author ? { author } : {}), createdAt: num('createdAt'), updatedAt: num('updatedAt') };
}

const scopeName = (s: MemoryScope): ScopeName => (s.kind === 'employee' ? 'me' : 'block');

const assertSegment = (id: string) => {
  if (!SEGMENT_PATTERN.test(id)) throw new Error(`Unsafe memory path segment ${JSON.stringify(id)}`);
  return id;
};

export class MemoryStore {
  private readonly root: string;
  // One promise chain per scope directory. Every write goes through here, so the cap check and the write cannot interleave.
  private readonly locks = new Map<string, Promise<void>>();

  private constructor(root: string) {
    this.root = root;
  }

  // Creates the folders and deletes temp files a crash left half-written.
  static open(root: string): MemoryStore {
    for (const top of ['employees', 'blocks', 'alumni']) {
      const dir = join(root, top);
      mkdirSync(dir, { recursive: true });
      for (const owner of readdirSync(dir, { withFileTypes: true })) {
        if (!owner.isDirectory()) continue;
        for (const f of readdirSync(join(dir, owner.name))) if (f.endsWith('.tmp')) rmSync(join(dir, owner.name, f), { force: true });
      }
    }
    return new MemoryStore(root);
  }

  notebook(who: Who): Notebook {
    const scopeOf = (name: ScopeName): MemoryScope =>
      name === 'me' ? { kind: 'employee', employeeId: who.employeeId } : { kind: 'block', blockId: who.blockId };
    const author = { employeeId: who.employeeId, provider: who.provider };
    return {
      remember: (scope, title, body) => this.remember(scopeOf(scope), author, title, body),
      recall: (query, scope) => this.recall(query, scope === 'both' ? [scopeOf('me'), scopeOf('block')] : [scopeOf(scope)]),
      forget: (scope, id) => this.forget(scopeOf(scope), id),
      digest: (blockName) => this.digest(scopeOf('me'), scopeOf('block'), blockName),
    };
  }

  // A fired employee's notes move to alumni/. Block notes stay. Safe to call twice.
  async archive(employeeId: EmployeeId): Promise<void> {
    const scope: MemoryScope = { kind: 'employee', employeeId };
    const from = this.dirOf(scope);
    await this.locked(from, async () => {
      if (!existsSync(from)) return;
      await mkdir(join(this.root, 'alumni'), { recursive: true });
      const taken = existsSync(join(this.root, 'alumni', employeeId));
      await rename(from, join(this.root, 'alumni', taken ? `${employeeId}-${Date.now()}` : employeeId));
    });
  }

  // reset_company. The caller has already detached every employee, so no new write can start behind this.
  async wipe(): Promise<void> {
    await Promise.all([...this.locks.values()]);
    await Promise.all(['employees', 'blocks', 'alumni'].map((d) => rm(join(this.root, d), { recursive: true, force: true })));
    for (const d of ['employees', 'blocks', 'alumni']) await mkdir(join(this.root, d), { recursive: true });
  }

  private dirOf(scope: MemoryScope): string {
    return scope.kind === 'employee'
      ? join(this.root, 'employees', assertSegment(scope.employeeId))
      : join(this.root, 'blocks', assertSegment(scope.blockId));
  }

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  // Reads are synchronous on purpose: files are tiny, and the digest has to be available while a session is being built.
  private readNotes(scope: MemoryScope): Note[] {
    const dir = this.dirOf(scope);
    if (!existsSync(dir)) return [];
    const notes: Note[] = [];
    for (const f of readdirSync(dir)) {
      const id = f.slice(0, -'.md'.length);
      if (!f.endsWith('.md') || !ID_PATTERN.test(id)) continue;
      const note = parse(id as NoteId, readFileSync(join(dir, f), 'utf8'));
      if (note) notes.push(note);
    }
    return notes.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private async remember(scope: MemoryScope, author: NonNullable<Note['author']>, rawTitle: string, rawBody: string): Promise<RememberResult> {
    const title = oneLine(rawTitle);
    const body = rawBody.trim();
    const id = slug(title);
    if (!id) return { ok: false, reason: 'The title needs some letters or digits. Write it as one short fact.' };
    if (title.length > LIMITS.titleChars) {
      return { ok: false, reason: `The title is ${title.length} characters and the limit is ${LIMITS.titleChars}. Shorten it to one short fact.` };
    }
    if (body.length > LIMITS.bodyChars) {
      return { ok: false, reason: `The body is ${body.length} characters and the limit is ${LIMITS.bodyChars}. Keep only the detail a teammate would need.` };
    }
    const secret = secretIn(`${title}\n${body}`);
    if (secret) return { ok: false, reason: `This looks like ${secret}. Notes are plain files, so never save credentials. Say where the secret is kept instead.` };

    const dir = this.dirOf(scope);
    const cap = LIMITS.notes[scope.kind];
    return this.locked(dir, async () => {
      const notes = this.readNotes(scope);
      const existing = notes.find((n) => n.id === id);
      if (!existing && notes.length >= cap) {
        return {
          ok: false,
          reason: `The ${scopeName(scope) === 'me' ? 'personal' : 'team'} notebook is full (${cap} notes). Forget or merge a note first.`,
          titles: notes.map((n) => ({ id: n.id, title: n.title })),
        } satisfies RememberResult;
      }
      const now = Date.now();
      await this.writeNote(dir, { id, title, body, author, createdAt: existing?.createdAt ?? now, updatedAt: now });
      return { ok: true, id, used: existing ? notes.length : notes.length + 1, cap } satisfies RememberResult;
    });
  }

  // tmp + rename, so a reader or a crash never sees half a note.
  private async writeNote(dir: string, note: Note) {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${note.id}.md`);
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, serialize(note), { mode: 0o600 });
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  private async forget(scope: MemoryScope, rawId: string): Promise<ForgetResult> {
    const id = rawId.trim();
    if (!ID_PATTERN.test(id) || id.length > LIMITS.titleChars) return { ok: false, reason: `${JSON.stringify(rawId)} is not a note id. Take the id from recall.` };
    return this.locked(this.dirOf(scope), async () => {
      try {
        await unlink(join(this.dirOf(scope), `${id}.md`));
        return { ok: true, id: id as NoteId } satisfies ForgetResult;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        return { ok: false, reason: `There is no note ${id} in the ${scopeName(scope) === 'me' ? 'personal' : 'team'} notebook.` } satisfies ForgetResult;
      }
    });
  }

  private recall(query: string | undefined, scopes: MemoryScope[]): RecallResult {
    const all = scopes.flatMap((s) => this.readNotes(s).map((n) => ({ scope: scopeName(s), note: n })));
    const q = query?.trim();
    if (!q) return { mode: 'list', total: all.length, notes: all.map(({ scope, note }) => ({ scope, id: note.id, title: note.title })) };

    const words = fold(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const long = words.filter((w) => w.length >= 3);
    const terms = long.length ? long : words;
    // Titles say the fact, so a hit there counts for more than one in the body.
    const scored = all
      .map(({ scope, note }) => {
        const title = fold(note.title);
        const body = fold(note.body);
        const score = terms.reduce((sum, t) => sum + (title.includes(t) ? 3 : 0) + (body.includes(t) ? 1 : 0), 0);
        return { scope, note, score };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt);
    return {
      mode: 'search',
      total: scored.length,
      notes: scored.slice(0, LIMITS.recallResults).map(({ scope, note }) => ({ scope, id: note.id, title: note.title, body: note.body, updatedAt: note.updatedAt })),
    };
  }

  private digest(mine: MemoryScope, team: MemoryScope, blockName: string): string {
    // Clipping and slicing only matter for notes the owner added by hand, but they make the size bound hold whatever is on disk.
    const lines = (scope: MemoryScope) =>
      this.readNotes(scope)
        .slice(0, LIMITS.notes[scope.kind])
        .map((n) => `- ${clip(n.title, LIMITS.titleChars)}`);
    const own = lines(mine);
    const shared = lines(team);
    if (!own.length && !shared.length) return '';
    const out = ['What you remember (call recall for details)'];
    if (own.length) out.push('', 'About you', ...own);
    if (shared.length) out.push('', `About the ${clip(oneLine(blockName), BLOCK_NAME_IN_DIGEST)} team`, ...shared);
    return out.join('\n');
  }
}
