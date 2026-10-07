// What an employee's terminal shows. A session tells the office what happened in the words of its harness reduced to one
// event shape (`TermEvent`), `TerminalBuffer` folds them into blocks of styled lines the way Claude Code's own terminal
// lays them out, and `screenOf` lays the blocks out for a width: the monitor on a desk and the zoomed terminal both draw
// that. Pure and free of Node and Electron, so the office, the renderer and the check scripts import the same code.
import type { AllowRule, EmployeeStatus, PermissionMode, Question } from './protocol.ts';
import { ruleFor, SHELL_TOOL } from './permissions.ts';

// ---------------------------------------------------------------- the shape

// Colours are names, the renderer owns the palette.
export type Tone = 'fg' | 'dim' | 'bright' | 'accent' | 'ok' | 'err' | 'warn' | 'info' | 'rule' | 'violet';
// A highlight behind a span ('user' echoes what the owner typed) or behind a whole row (a diff row).
export type Bg = 'user' | 'add' | 'del';
export type Span = { t: string; c?: Tone; b?: boolean; i?: boolean; bg?: Bg };
// `hang` is how far wrapped rows of this line are indented. `fill` colours the whole row instead of only its text.
export type TerminalLine = { spans: Span[]; hang?: number; fill?: Bg };
// A block is what one thing printed: a message, a tool call with its result, a notice. Blocks never reorder. `n` counts
// up from 0 over the life of the buffer, and block 0 is the banner, which stays when old blocks are dropped.
export type TermBlock = { n: number; lines: TerminalLine[] };
// What the screen shows besides the blocks: how many tokens the turn wrote so far, what the employee's todo list says they are doing
// and will do next, and what the calls waiting on the owner say they are for.
export type Plan = { active: string; next?: string };
// What a call waiting for approval says about itself. `detail` is the command or path the question carries, and `description`
// is the line the model wrote for the owner under a Bash command ("Run the test suite").
export type Ask = { detail: string; description?: string; reason?: string };
export type TermLive = { tokens: number; plan?: Plan; asks?: Ask[] };
// What changed since the last push. Blocks below `from` (other than the banner) are gone. `reset` says the sender holds
// nothing the receiver can keep, so it starts from these blocks alone.
export type TerminalPush = { from: number; blocks: TermBlock[]; live: TermLive; reset?: boolean };

// ---------------------------------------------------------------- what a session reports

export type TermEvent =
  // A message the model is about to read, as the owner or a teammate wrote it.
  | { k: 'prompt'; text: string }
  // The assistant's text so far. The same `id` again replaces it.
  | { k: 'text'; id: string; text: string }
  // The model is thinking. `secs` closes it.
  | { k: 'thinking'; id: string; secs?: number }
  // A tool call the moment it is known, and the result when it comes back. `data` is the harness's own structured result.
  | { k: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { k: 'result'; id: string; ok: boolean; text: string; data?: unknown }
  // The turn is over. `interrupted` is the owner pressing Esc.
  // `ms` is how long the turn took.
  | { k: 'end'; how: 'done' | 'interrupted' | 'error'; message?: string; ms?: number }
  | { k: 'note'; text: string; tone?: Tone }
  | { k: 'tokens'; out: number }
  // A call is about to ask the owner for approval, with what the harness says about it.
  | { k: 'approval'; detail: string; description?: string; reason?: string }
  // The header: which harness, which model, where.
  | { k: 'banner'; title: string; model: string; cwd: string };

// ---------------------------------------------------------------- building lines

const sp = (t: string, c?: Tone, more: Partial<Span> = {}): Span => ({ t, ...(c ? { c } : {}), ...more });
const line = (spans: Span[], more: Partial<TerminalLine> = {}): TerminalLine => ({ spans, ...more });

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// A little of markdown, the part an assistant message uses most: **bold**, `code`, # headings and lists. Anything else is text.
export function inline(text: string): Span[] {
  const out: Span[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push(sp(text.slice(at, m.index)));
    const hit = m[0];
    out.push(hit.startsWith('**') ? sp(hit.slice(2, -2), undefined, { b: true }) : sp(hit.slice(1, -1), 'info'));
    at = m.index + hit.length;
  }
  if (at < text.length) out.push(sp(text.slice(at)));
  return out.length ? out : [sp('')];
}

function proseLines(text: string, lead: Span[]): TerminalLine[] {
  const rows = text.replace(/\r/g, '').trimEnd().split('\n');
  return rows.map((raw, i) => {
    const first = i === 0;
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    const body = heading ? [sp(heading[1]!, undefined, { b: true })] : bullet ? [sp(`${bullet[1]}• `), ...inline(bullet[2]!)] : inline(raw);
    return line([...(first ? lead : [sp('  ')]), ...body], { hang: 2 + (bullet ? bullet[1]!.length + 2 : 0) });
  });
}

// ---------------------------------------------------------------- how each tool reads, as Claude Code writes it

type Result = { ok: boolean; text: string; data?: unknown };
type Facts = { name: string; input: Record<string, unknown>; cwd: string };
type ToolStyle = {
  label: (f: Facts) => string;
  // What goes in the parentheses after the label.
  arg: (f: Facts) => string;
  // The lines under the call once it returned. `⎿` leads the first of them.
  done: (f: Facts, r: Result) => Span[][];
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function relPath(file: string, cwd: string): string {
  if (!file.startsWith('/')) return file;
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return file.startsWith(base) ? file.slice(base.length) : file;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lines = (text: string) => (text ? text.replace(/\r/g, '').replace(/\n+$/, '').split('\n') : []);

// "Read 46 lines": the words dim, the number bold.
const counted = (before: string, n: number, after: string): Span[] => [sp(before, 'fg'), sp(String(n), 'bright', { b: true }), sp(after, 'fg')];

// The first few lines of a result, with how many were left out.
function head(text: string, tone: Tone | undefined, max = 3): Span[][] {
  const all = lines(text);
  if (!all.length) return [[sp('(No content)', 'dim')]];
  const shown = all.slice(0, max).map((l) => [sp(cut(l, 240), tone)]);
  if (all.length > max) shown.push([sp(`… +${plural(all.length - max, 'line')}`, 'dim')]);
  return shown;
}

type Hunk = { oldStart: number; newStart: number; lines: string[] };
const hunksOf = (data: unknown): Hunk[] => {
  const patch = obj(data).structuredPatch;
  if (!Array.isArray(patch)) return [];
  return patch.flatMap((h) => {
    const o = obj(h);
    const ls = Array.isArray(o.lines) ? o.lines.filter((l): l is string => typeof l === 'string') : [];
    return [{ oldStart: num(o.oldStart) ?? 1, newStart: num(o.newStart) ?? 1, lines: ls }];
  });
};

// Rows of a diff the way Claude Code draws it: the line number, a sign, the text, and the whole row tinted.
function diffRows(hunks: Hunk[], max = 14): TerminalLine[] {
  const out: TerminalLine[] = [];
  let width = 2;
  for (const h of hunks) width = Math.max(width, String(h.newStart + h.lines.length).length);
  for (const h of hunks) {
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      const sign = l[0] === '+' || l[0] === '-' ? l[0] : ' ';
      const body = l.slice(1);
      const at = sign === '-' ? o : n;
      if (sign !== '+') o++;
      if (sign !== '-') n++;
      const gutter = `${String(at).padStart(width)} ${sign} `;
      const bg = sign === '+' ? 'add' : sign === '-' ? 'del' : undefined;
      out.push(line([sp(gutter, bg ? undefined : 'dim'), sp(cut(body, 200), bg ? 'bright' : 'dim')], { hang: gutter.length, ...(bg ? { fill: bg } : {}) }));
    }
  }
  if (out.length <= max) return out;
  return [...out.slice(0, max), line([sp(`… +${plural(out.length - max, 'line')}`, 'dim')])];
}

const countChanges = (hunks: Hunk[]) => {
  let add = 0;
  let del = 0;
  for (const h of hunks) for (const l of h.lines) (l[0] === '+' ? add++ : l[0] === '-' && del++);
  return { add, del };
};

const TOOLS: Record<string, ToolStyle> = {
  Read: {
    label: () => 'Read',
    arg: (f) => relPath(str(f.input.file_path), f.cwd),
    done: (_f, r) => {
      const file = obj(obj(r.data).file);
      const n = num(file.numLines) ?? lines(r.text).length;
      return [counted('Read ', n, n === 1 ? ' line' : ' lines')];
    },
  },
  Write: {
    label: () => 'Write',
    arg: (f) => relPath(str(f.input.file_path), f.cwd),
    done: (f, r) => {
      const content = str(f.input.content);
      const all = lines(content);
      const created = obj(r.data).type !== 'update';
      const head2: Span[] = [sp(created ? 'Wrote ' : 'Updated ', 'fg'), sp(String(all.length), 'bright', { b: true }), sp(` ${all.length === 1 ? 'line' : 'lines'} to ${relPath(str(f.input.file_path), f.cwd)}`, 'fg')];
      const shown = all.slice(0, 4).map((l, i) => [sp(`${String(i + 1).padStart(3)}  `, 'dim'), sp(cut(l, 200), 'dim')]);
      return [head2, ...shown, ...(all.length > 4 ? [[sp(`… +${plural(all.length - 4, 'line')}`, 'dim')]] : [])];
    },
  },
  Edit: {
    label: () => 'Update',
    arg: (f) => relPath(str(f.input.file_path), f.cwd),
    done: (f, r) => {
      const hunks = hunksOf(r.data);
      const { add, del } = countChanges(hunks);
      const where = relPath(str(f.input.file_path), f.cwd);
      const words: Span[] = [sp('Updated ', 'fg'), sp(where, 'bright', { b: true }), sp(' with ', 'fg')];
      if (add) words.push(sp(String(add), 'bright', { b: true }), sp(add === 1 ? ' addition' : ' additions', 'fg'));
      if (add && del) words.push(sp(' and ', 'fg'));
      if (del) words.push(sp(String(del), 'bright', { b: true }), sp(del === 1 ? ' removal' : ' removals', 'fg'));
      if (!add && !del) words.push(sp('no changes', 'fg'));
      return [words];
    },
  },
  Bash: {
    label: () => 'Bash',
    arg: (f) => cut(flat(str(f.input.command)), 160),
    done: (_f, r) => {
      const out = obj(r.data);
      const text = str(out.stdout) || str(out.stderr) ? [str(out.stdout), str(out.stderr)].filter(Boolean).join('\n') : r.text;
      return head(text, r.ok ? 'fg' : 'err');
    },
  },
  Glob: {
    label: () => 'Search',
    arg: (f) => [`pattern: "${str(f.input.pattern)}"`, str(f.input.path) ? `path: "${relPath(str(f.input.path), f.cwd)}"` : ''].filter(Boolean).join(', '),
    done: (_f, r) => {
      const n = num(obj(r.data).numFiles) ?? lines(r.text).filter((l) => l && !l.startsWith('No files')).length;
      return [counted('Found ', n, n === 1 ? ' file' : ' files')];
    },
  },
  Grep: {
    label: () => 'Search',
    arg: (f) => [`pattern: "${str(f.input.pattern)}"`, str(f.input.path) ? `path: "${relPath(str(f.input.path), f.cwd)}"` : ''].filter(Boolean).join(', '),
    done: (_f, r) => {
      const data = obj(r.data);
      const n = num(data.numFiles) ?? num(data.numLines) ?? lines(r.text).length;
      return [counted('Found ', n, data.mode === 'content' ? (n === 1 ? ' line' : ' lines') : n === 1 ? ' file' : ' files')];
    },
  },
  LS: { label: () => 'List', arg: (f) => relPath(str(f.input.path), f.cwd), done: (_f, r) => [counted('Listed ', lines(r.text).length, ' paths')] },
  WebFetch: { label: () => 'Fetch', arg: (f) => str(f.input.url), done: (_f, r) => head(r.text, undefined, 1) },
  WebSearch: { label: () => 'Web Search', arg: (f) => `"${str(f.input.query)}"`, done: () => [counted('Did ', 1, ' search')] },
  TodoWrite: {
    label: () => 'Update Todos',
    arg: () => '',
    done: (f) => {
      const todos = Array.isArray(f.input.todos) ? f.input.todos.map(obj) : [];
      return todos.map((t) => {
        const done = t.status === 'completed';
        return [sp(done ? '☒ ' : '☐ ', done ? 'dim' : 'fg'), sp(str(t.content), done ? 'dim' : 'fg')];
      });
    },
  },
  Task: { label: () => 'Task', arg: (f) => cut(flat(str(f.input.description)), 100), done: (_f, r) => head(r.text, undefined, 2) },
};
// A change a harness reports by the files it touched and not by what it changed in them.
TOOLS.Patch = {
  label: () => 'Update',
  arg: (f) => cut(((Array.isArray(f.input.paths) ? f.input.paths : [str(f.input.file_path)]).filter((p): p is string => typeof p === 'string' && !!p)).map((p) => relPath(p, f.cwd)).join(', ') || 'files', 100),
  done: (f) => {
    const n = Array.isArray(f.input.paths) ? f.input.paths.length : 1;
    return [[sp('Updated ', 'fg'), sp(String(n), 'bright', { b: true }), sp(n === 1 ? ' file' : ' files', 'fg')]];
  },
};
TOOLS.MultiEdit = TOOLS.Edit!;
TOOLS.NotebookEdit = TOOLS.Edit!;
TOOLS.Agent = TOOLS.Task!;

// The office's own tools read like any other server's: "office - message (MCP)(text: "…")".
const mcp = /^mcp__(.+?)__(.+)$/;
function compact(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([k]) => k !== 'requestId')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${cut(flat(v), 80)}"` : cut(JSON.stringify(v) ?? '', 60)}`)
    .join(', ');
}

function styleOf(name: string): ToolStyle {
  const known = TOOLS[name];
  if (known) return known;
  const m = mcp.exec(name);
  return {
    label: () => (m ? `${m[1]} - ${m[2]} (MCP)` : name),
    arg: (f) => cut(compact(f.input), 160),
    // A server that says only that it is fine has nothing to show under the call.
    done: (_f, r) => (/^\s*\{\s*"ok"\s*:\s*true\s*\}\s*$/.test(r.text) ? [] : head(r.text, undefined, 2)),
  };
}

const DENIED = /^The boss did not allow this/;
// What the SDK sends back for a call the owner stopped with Esc.
const STOPPED = /^(The user doesn't want to proceed with this tool use|\[Request interrupted by user)/;
const interruptedRow = (): Span[] => [sp('Interrupted', 'err'), sp(' · What should Claude do instead?', 'dim')];

// The call, and the result under it when there is one.
export function toolLines(name: string, input: Record<string, unknown>, cwd: string, result?: Result): TerminalLine[] {
  const style = styleOf(name);
  const f: Facts = { name, input, cwd };
  const dot = !result ? sp('● ', 'dim') : sp('● ', result.ok ? 'ok' : 'err');
  const arg = style.arg(f);
  const call = line([dot, sp(style.label(f), 'bright', { b: true }), sp(`(${arg})`, 'fg')], { hang: 2 });
  const out: TerminalLine[] = [call];
  if (!result) return out;
  let rows: Span[][];
  if (!result.ok) {
    const first = lines(result.text);
    rows = STOPPED.test(result.text)
      ? [interruptedRow()]
      : DENIED.test(result.text)
      ? [[sp(cut(first[0] ?? 'Denied', 240), 'err')]]
      : first.length
        ? first.slice(0, 3).map((l, i) => [sp(i === 0 ? `Error: ${cut(l, 230)}` : cut(l, 240), 'err')]).concat(first.length > 3 ? [[sp(`… +${plural(first.length - 3, 'line')}`, 'dim')]] : [])
        : [[sp('Error', 'err')]];
  } else {
    rows = style.done(f, result);
  }
  rows.forEach((spans, i) => out.push(line([sp(i === 0 ? '  ⎿  ' : '     ', 'dim'), ...spans], { hang: 5 })));
  if (result.ok && (name === 'Edit' || name === 'MultiEdit')) out.push(...diffRows(hunksOf(result.data)).map((l) => ({ ...l, spans: [sp('     '), ...l.spans], hang: (l.hang ?? 0) + 5 })));
  return out;
}

// ---------------------------------------------------------------- the buffer

// Lines kept per employee. Old blocks go first, the banner never.
export const TERMINAL_LINES = 800;
// What one prompt echo shows before it is cut.
const PROMPT_LINES = 8;
const PROMPT_TEXT = 1200;

const CLAWD = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝'];

// The block glyphs the mascot is drawn with, as which quarters of the cell they fill: upper left, upper right, lower left, lower right.
// A font draws them with gaps at the edges of the line, so both renderers fill the quarters themselves.
const QUARTERS: Record<string, readonly [boolean, boolean, boolean, boolean]> = {
  '▘': [true, false, false, false], '▝': [false, true, false, false], '▖': [false, false, true, false], '▗': [false, false, false, true],
  '▌': [true, false, true, false], '▐': [false, true, false, true], '▀': [true, true, false, false], '▄': [false, false, true, true],
  '▛': [true, true, true, false], '▜': [true, true, false, true], '▙': [true, false, true, true], '▟': [false, true, true, true],
  '█': [true, true, true, true], '▚': [true, false, false, true], '▞': [false, true, true, false],
};
export const quartersOf = (ch: string): readonly [boolean, boolean, boolean, boolean] | undefined => QUARTERS[ch];

// "claude-haiku-4-5-20251001" reads "Haiku 4.5", as the header of Claude Code writes a model. Another harness's model id stays as it is.
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id;
}

// A long folder keeps its tail: the name of the project is what the owner knows it by.
const tail = (path: string, n: number) => (path.length > n ? `…${path.slice(-(n - 1))}` : path);

function bannerLines(title: string, model: string, cwd: string): TerminalLine[] {
  const info = [[sp(title, 'bright', { b: true })], [sp(modelName(model), 'dim')], [sp(tail(cwd, 44), 'dim')]];
  return CLAWD.map((art, i) => line([sp(art.padEnd(11), 'accent'), ...(info[i] ?? [])], { hang: 11 }));
}

export class TerminalBuffer {
  private readonly blocks = new Map<number, TermBlock>();
  private next = 1;
  // Which block holds a text, thinking or tool id.
  private readonly byId = new Map<string, number>();
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  // A call already says it was interrupted, so the end of the turn need not.
  private stoppedCall = false;
  // The last block added is a thought, so another one right after it joins it.
  private lastIsThought = false;
  private dirty = new Set<number>();
  // The token count changed, though no block did.
  private liveDirty = false;
  private from = 1;
  private everSent = false;
  private tokens = 0;
  private plan: Plan | undefined;
  private asks: Ask[] = [];
  private readonly cwd: string;

  constructor(cwd: string, title = 'Claude Code', model = '') {
    this.cwd = cwd;
    this.blocks.set(0, { n: 0, lines: bannerLines(title, model, cwd) });
    this.dirty.add(0);
  }

  private put(n: number, ls: TerminalLine[]) {
    this.blocks.set(n, { n, lines: ls });
    this.dirty.add(n);
  }

  private add(ls: TerminalLine[], id?: string): number {
    this.lastIsThought = false;
    const n = this.next++;
    this.put(n, ls);
    if (id) this.byId.set(id, n);
    this.trim();
    return n;
  }

  private trim() {
    let total = 0;
    for (const b of this.blocks.values()) total += b.lines.length;
    if (total <= TERMINAL_LINES) return;
    for (const n of [...this.blocks.keys()].sort((a, b) => a - b)) {
      if (n === 0) continue;
      if (total <= TERMINAL_LINES || this.blocks.size <= 2) break;
      total -= this.blocks.get(n)!.lines.length;
      this.blocks.delete(n);
      this.dirty.delete(n);
      this.from = n + 1;
    }
  }

  get live(): TermLive {
    return { tokens: this.tokens, ...(this.plan ? { plan: this.plan } : {}), ...(this.asks.length ? { asks: this.asks } : {}) };
  }

  apply(e: TermEvent): void {
    switch (e.k) {
      case 'prompt': {
        const all = e.text.replace(/\r/g, '').trim().split('\n');
        const shown = all.slice(0, PROMPT_LINES);
        const ls = shown.map((l, i) => line([sp(i === 0 ? '❯ ' : '  ', 'dim', { bg: 'user' }), sp(cut(l, PROMPT_TEXT), 'bright', { bg: 'user' })], { hang: 2 }));
        if (all.length > PROMPT_LINES) ls.push(line([sp(`  … +${plural(all.length - PROMPT_LINES, 'line')}`, 'dim')]));
        this.add(ls);
        return;
      }
      case 'text': {
        const ls = proseLines(e.text, [sp('● ', 'bright')]);
        const n = this.byId.get(`text:${e.id}`);
        if (n !== undefined && this.blocks.has(n)) this.put(n, ls);
        else this.add(ls, `text:${e.id}`);
        return;
      }
      case 'thinking': {
        // Thoughts with nothing printed between them are one line.
        const key = `think:${e.id}`;
        const n = this.byId.get(key) ?? (this.lastIsThought ? this.next - 1 : undefined);
        const ls = [line([sp(e.secs === undefined ? '∴ Thinking…' : `∴ Thought for ${Math.max(1, Math.round(e.secs))}s`, 'dim', { i: true })])];
        if (n !== undefined && this.blocks.has(n)) {
          this.put(n, ls);
          this.byId.set(key, n);
        } else this.add(ls, key);
        this.lastIsThought = true;
        return;
      }
      case 'tool': {
        this.tools.set(e.id, { name: e.name, input: e.input });
        const key = `tool:${e.id}`;
        const ls = toolLines(e.name, e.input, this.cwd);
        const n = this.byId.get(key);
        if (n !== undefined && this.blocks.has(n)) this.put(n, ls);
        else this.add(ls, key);
        return;
      }
      case 'result': {
        if (!e.ok && STOPPED.test(e.text)) this.stoppedCall = true;
        const call = this.tools.get(e.id);
        const key = `tool:${e.id}`;
        const ls = toolLines(call?.name ?? 'Tool', call?.input ?? {}, this.cwd, { ok: e.ok, text: e.text.slice(0, 20_000), data: e.data });
        const n = this.byId.get(key);
        if (n !== undefined && this.blocks.has(n)) this.put(n, ls);
        else this.add(ls, key);
        this.tools.delete(e.id);
        return;
      }
      case 'end': {
        // A call still waiting for its result will never get one.
        let said = this.stoppedCall;
        for (const [id, call] of this.tools) {
          const n = this.byId.get(`tool:${id}`);
          if (n === undefined || !this.blocks.has(n)) continue;
          this.put(n, toolLines(call.name, call.input, this.cwd, { ok: false, text: e.how === 'interrupted' ? "The user doesn't want to proceed with this tool use" : 'Stopped' }));
          said ||= e.how === 'interrupted';
        }
        this.tools.clear();
        this.stoppedCall = false;
        this.tokens = 0;
        this.plan = undefined;
        this.asks = [];
        this.liveDirty = true;
        if (e.how === 'interrupted') {
          if (!said) this.add([line([sp('  ⎿  ', 'dim'), ...interruptedRow()])]);
        } else if (e.how === 'done' && e.ms !== undefined && e.ms >= 5000) {
          // A turn that took a while says how long, with a verb in the past, as Claude Code does.
          this.add([line([sp('✻ ', 'accent'), sp(`${PAST[Math.floor(e.ms / 1000) % PAST.length]} for ${secsText(e.ms)}`, 'dim')])]);
        } else if (e.how === 'error') this.add([line([sp('  ⎿  ', 'dim'), sp(`Error: ${cut(flat(e.message ?? 'The turn failed'), 300)}`, 'err')], { hang: 5 })]);
        return;
      }
      case 'note':
        this.add([line([sp(e.text, e.tone ?? 'dim')], { hang: 2 })]);
        return;
      case 'tokens':
        this.tokens = e.out;
        this.liveDirty = true;
        return;
      case 'approval':
        // The last few are kept: a turn can have several calls waiting, and the owner sees them one at a time.
        this.asks = [...this.asks.filter((a) => a.detail !== e.detail), { detail: e.detail, ...(e.description ? { description: e.description } : {}), ...(e.reason ? { reason: e.reason } : {}) }].slice(-4);
        this.liveDirty = true;
        return;
      case 'banner':
        this.put(0, bannerLines(e.title, e.model, e.cwd));
        return;
    }
  }

  // The blocks that changed since the last call, or undefined when nothing did.
  take(): TerminalPush | undefined {
    if (!this.dirty.size && !this.liveDirty && this.everSent) return undefined;
    const blocks = [...this.dirty].sort((a, b) => a - b).flatMap((n) => this.blocks.get(n) ?? []);
    this.dirty = new Set();
    this.liveDirty = false;
    const reset = !this.everSent;
    this.everSent = true;
    return { from: this.from, blocks, live: this.live, ...(reset ? { reset } : {}) };
  }

  // Everything the buffer holds, for a window that just opened.
  full(): TerminalPush {
    this.everSent = true;
    this.dirty = new Set();
    this.liveDirty = false;
    return { from: this.from, blocks: [...this.blocks.values()].sort((a, b) => a.n - b.n), live: this.live, reset: true };
  }

  get size(): number {
    return this.blocks.size;
  }

  all(): TermBlock[] {
    return [...this.blocks.values()].sort((a, b) => a.n - b.n);
  }
}

// What a window does with a push: replace the blocks it names, forget the ones the sender dropped.
export function applyPush(held: Map<number, TermBlock>, push: TerminalPush): void {
  if (push.reset) held.clear();
  for (const b of push.blocks) held.set(b.n, b);
  for (const n of [...held.keys()]) if (n !== 0 && n < push.from) held.delete(n);
}

// ---------------------------------------------------------------- laying out for a width

// What a click on a row does: open or close an old turn, open or close a call's whole result, or pick a choice of the dialog.
export type Act = { turn: number } | { block: number } | { option: number };
// `old` marks a row of an old turn the owner opened, which is drawn dimmer than the turn in progress.
export type Row = { spans: Span[]; fill?: Bg; act?: Act; old?: true };

const sameStyle = (a: Span, b: Span) => a.c === b.c && a.b === b.b && a.i === b.i && a.bg === b.bg;
function push(row: Span[], s: Span) {
  if (!s.t) return;
  const last = row[row.length - 1];
  if (last && sameStyle(last, s)) last.t += s.t;
  else row.push({ ...s });
}

// Breaks a line into rows no wider than `cols`, at spaces where it can and mid-word where it must. Every character is one cell.
export function wrap(l: TerminalLine, cols: number): Row[] {
  const width = Math.max(8, cols);
  const hang = Math.min(l.hang ?? 0, Math.floor(width / 2));
  const rows: Row[] = [];
  let cur: Span[] = [];
  let col = 0;
  const flush = () => {
    const last = cur[cur.length - 1];
    if (last) last.t = last.t.trimEnd();
    if (last && !last.t) cur.pop();
    rows.push({ spans: cur, ...(l.fill ? { fill: l.fill } : {}) });
    cur = [];
    col = 0;
  };
  const indent = () => {
    if (hang) push(cur, sp(' '.repeat(hang)));
    col = hang;
  };
  for (const s of l.spans) {
    for (const tok of s.t.match(/ +|[^ ]+/g) ?? []) {
      const isSpace = tok[0] === ' ';
      if (col + tok.length <= width) {
        push(cur, { ...s, t: tok });
        col += tok.length;
        continue;
      }
      if (isSpace) {
        flush();
        indent();
        continue;
      }
      if (col > hang) {
        flush();
        indent();
      }
      let rest = tok;
      while (col + rest.length > width) {
        const room = Math.max(1, width - col);
        push(cur, { ...s, t: rest.slice(0, room) });
        rest = rest.slice(room);
        flush();
        indent();
      }
      push(cur, { ...s, t: rest });
      col += rest.length;
    }
  }
  if (cur.length || !rows.length) flush();
  return rows;
}

const blankRow = (): Row => ({ spans: [] });

// Blocks in order, one blank row between neighbours, as the terminal prints them.
export function layoutBlocks(blocks: readonly TermBlock[], cols: number): Row[] {
  const out: Row[] = [];
  blocks.forEach((b, i) => {
    if (i > 0 && b.lines.length) out.push(blankRow());
    for (const l of b.lines) out.push(...wrap(l, cols));
  });
  return out;
}

export const rowText = (r: Row): string => r.spans.map((s) => s.t).join('');

// ---------------------------------------------------------------- the part under the blocks

const GLYPHS = ['·', '✢', '✳', '∗', '✻', '✽'];
const VERBS = [
  'Accomplishing', 'Baking', 'Brewing', 'Calculating', 'Cerebrating', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Computing', 'Conjuring',
  'Considering', 'Cooking', 'Crafting', 'Crunching', 'Deliberating', 'Finagling', 'Forging', 'Generating', 'Grooving', 'Hatching', 'Herding', 'Hustling',
  'Ideating', 'Inferring', 'Manifesting', 'Marinating', 'Moseying', 'Mulling', 'Musing', 'Noodling', 'Percolating', 'Pondering', 'Processing',
  'Puzzling', 'Reticulating', 'Ruminating', 'Simmering', 'Spinning', 'Stewing', 'Synthesizing', 'Transmuting', 'Vibing', 'Working',
];

const PAST = ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Pondered', 'Simmered', 'Worked'];
export const verbOf = (startedAt: number): string => VERBS[Math.abs(Math.floor(startedAt / 1000)) % VERBS.length]!;
export const glyphOf = (now: number): string => GLYPHS[Math.floor(now / 160) % GLYPHS.length]!;

const tokensText = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const secsText = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

export function spinnerRow(startedAt: number, now: number, tokens: number, quantum = 160): Row {
  const glyph = GLYPHS[Math.floor(now / quantum) % GLYPHS.length]!;
  const bits = [secsText(now - startedAt), ...(tokens > 0 ? [`↑ ${tokensText(tokens)} tokens`] : []), 'esc to interrupt'];
  return { spans: [sp(`${glyph} `, 'accent'), sp(`${verbOf(startedAt)}… `, 'accent'), sp(`(${bits.join(' · ')})`, 'dim')] };
}

// The rule above and below the prompt, and the dashed one around a command.
export const ruleRow = (cols: number, tone: Tone = 'rule'): Row => ({ spans: [sp('─'.repeat(cols), tone)] });
const dashedRow = (cols: number): Row => ({ spans: [sp('╌'.repeat(cols), 'rule')] });

// What a choice does. `pick` is one of the options an employee offered.
export type Option = { key: string; label: string; kind: 'allow' | 'always' | 'deny' | 'pick' };

// What the "don't ask again" choice stores, word for word: `npm test *` is every command that starts with those words, `exactly`
// is that command and no other, and a tool is every use of it. The office stores `ruleFor(question)`, and this prints the same rule.
export function alwaysLabel(rule: AllowRule): string {
  switch (rule.kind) {
    case 'command':
      return `Yes, and don't ask again for: ${rule.prefix} *`;
    case 'exact':
      return `Yes, and don't ask again for exactly: ${rule.command}`;
    case 'tool':
      return `Yes, and don't ask again for: all ${rule.name} calls`;
  }
}

// What the owner can pick on a card: the same choices Claude Code's permission dialog offers.
export function optionsOf(q: Question): Option[] {
  if (q.kind === 'permission') {
    const rule = ruleFor(q);
    return [
      { key: '1', label: 'Yes', kind: 'allow' },
      ...(rule ? [{ key: '2', label: alwaysLabel(rule), kind: 'always' as const }] : []),
      { key: rule ? '3' : '2', label: 'No', kind: 'deny' },
    ];
  }
  return (q.options ?? []).map((label, i) => ({ key: String(i + 1), label, kind: 'pick' as const }));
}

const TITLES: Record<string, string> = { [SHELL_TOOL]: 'Bash command', Write: 'Create file', Edit: 'Edit file', MultiEdit: 'Edit file', NotebookEdit: 'Edit notebook', Read: 'Read file' };
export const questionTitle = (q: Question): string => (q.kind === 'permission' ? (TITLES[q.tool] ?? `Use ${q.tool}`) : 'The employee is asking you');

// What the owner's typing under the No choice reads, so the choice and the words stay on one row.
export const AMEND_LEAD = 'No, and tell them what to do differently: ';

export type QuestionView = {
  picked?: number;
  // What the call waiting says about itself, from `TermLive.asks`.
  ask?: Ask;
  // Who is asking and on what, for the foot of the dialog.
  who?: string;
  // The words typed under No, once the owner pressed Tab. Undefined while the owner is not amending.
  amend?: string;
  // A monitor on a desk: the command and the choices, nothing else.
  compact?: boolean;
};

// A command between its rules. A long one keeps its first rows and says how many it left out.
function commandRows(detail: string, cols: number, max: number): Row[] {
  const rows = detail.replace(/\r/g, '').split('\n').flatMap((l) => wrap(line([sp(' '), sp(cut(l, 400), 'bright')], { hang: 1 }), cols));
  return rows.length <= max ? rows : [...rows.slice(0, max), { spans: [sp(` … +${plural(rows.length - max, 'line')}`, 'dim')] }];
}

// The dialog a question puts on the screen: Claude Code's own permission prompt for a call, a plain list for a question.
export function questionRows(q: Question, cols: number, v: QuestionView = {}): Row[] {
  const { picked = 0, compact = false } = v;
  const out: Row[] = [ruleRow(cols, 'violet'), { spans: [sp(` ${questionTitle(q)}`, 'violet', { b: true })] }];
  const options = optionsOf(q);
  const optionRows = () =>
    options.flatMap((o, i) => {
      const on = i === picked;
      const amending = v.amend !== undefined && o.kind === 'deny';
      const text = amending ? `${o.key}. ${AMEND_LEAD}${v.amend}` : `${o.key}. ${o.label}`;
      return wrap(line([sp(on ? ' ❯ ' : '   ', 'violet'), sp(text, on ? 'violet' : 'fg'), ...(amending ? [sp('█', 'dim')] : [])], { hang: 6 }), cols).map((r) => ({ ...r, act: { option: i } }));
    });
  if (q.kind === 'permission') {
    if (!compact) {
      if (v.ask?.description) out.push({ spans: [sp(` ${cut(flat(v.ask.description), Math.max(8, cols - 2))}`, 'dim')] });
      out.push(dashedRow(cols));
    }
    out.push(...commandRows(q.detail, cols, compact ? 2 : 8));
    if (!compact) {
      const what = q.tool === SHELL_TOOL ? 'command' : 'action';
      out.push(dashedRow(cols), { spans: [sp(` This ${what} requires approval`, 'fg'), ...(v.ask?.reason ? [sp(` · ${cut(flat(v.ask.reason), 160)}`, 'dim')] : [])] }, blankRow());
    }
    out.push({ spans: [sp(' Do you want to proceed?', 'fg')] }, ...optionRows());
    if (!compact) {
      const hint = v.amend === undefined ? ' Esc to cancel · Tab to amend' : ' Enter to send · Esc to cancel';
      const right = v.who ?? '';
      out.push(blankRow(), { spans: [sp(hint, 'dim'), ...(right ? [sp(' '.repeat(Math.max(1, cols - hint.length - right.length - 1)) + right, 'dim')] : [])] });
    }
    return out;
  }
  out.push(blankRow(), ...wrap(line([sp(' '), sp(q.text, 'bright')], { hang: 1 }), cols), ...optionRows());
  return out;
}

export type ScreenArgs = {
  blocks: readonly TermBlock[];
  live: TermLive;
  status: EmployeeStatus;
  now: number;
  cols: number;
  rows: number;
  // Fewer rows of furniture: no blank rows, no hint line. The monitor on a desk uses it.
  compact?: boolean;
  draft?: string;
  // Who and what the status line names, and how much the employee may do without asking.
  who?: string;
  model?: string;
  mode?: PermissionMode;
};

// What Claude Code's status line says of a permission mode. `ask` is its default mode, which says nothing.
export const MODE_LINE: Record<PermissionMode, { glyph: string; text: string; tone: Tone }> = {
  inherit: { glyph: '▸▸', text: 'accept edits on', tone: 'violet' },
  ask: { glyph: '⏸', text: 'manual mode on', tone: 'dim' },
  auto: { glyph: '▸▸', text: 'auto mode on', tone: 'warn' },
  yolo: { glyph: '▸▸', text: 'bypass permissions on', tone: 'err' },
};

// The bottom of the screen: what the harness is doing, a question waiting on the owner, the prompt.
export function footerOf(a: ScreenArgs): Row[] {
  const { cols, status, now } = a;
  const out: Row[] = [];
  const gap = () => {
    if (!a.compact) out.push(blankRow());
  };
  if (status.kind === 'blocked_on_owner') {
    gap();
    const q = status.question;
    const who = [a.who, a.model].filter(Boolean).join(' · ');
    const ask = q.kind === 'permission' ? a.live.asks?.find((x) => x.detail === q.detail) : undefined;
    out.push(...questionRows(q, cols, { ...(ask ? { ask } : {}), who, compact: a.compact }));
    // A permission dialog is the whole bottom of the screen: no prompt box under it, as in Claude Code.
    if (q.kind === 'permission') return out;
  } else if (status.kind === 'working') {
    gap();
    out.push(spinnerRow(status.startedAt, now, a.live.tokens, a.compact ? 500 : 160));
    gap();
  } else if (status.kind === 'error') {
    gap();
    out.push({ spans: [sp('  ⎿  ', 'dim'), sp(cut(`Error: ${flat(status.message)}`, Math.max(20, cols - 6)), 'err')] });
    gap();
  }
  out.push(ruleRow(cols), { spans: [sp('❯ ', 'dim'), sp(a.draft ?? '', 'bright'), sp('█', 'dim')] }, ruleRow(cols));
  if (!a.compact) {
    const mode = a.mode ? MODE_LINE[a.mode] : undefined;
    const left: Span[] = mode ? [sp(`  ${mode.glyph} ${mode.text} `, mode.tone), sp(mode.glyph === '⏸' ? '· ? for shortcuts' : '(shift+tab to cycle)', 'dim')] : [sp('  ? for shortcuts', 'dim')];
    const right = [a.who, a.model].filter(Boolean).join(' · ');
    const used = left.reduce((n, x) => n + x.t.length, 0);
    out.push({ spans: [...left, sp(' '.repeat(Math.max(1, cols - used - right.length - 1)) + right, 'dim')] });
  }
  return out;
}

// What the screen shows, exactly `rows` rows: the last of the blocks above the footer. A short log leaves the prompt under it, as a terminal does.
export function screenOf(a: ScreenArgs): Row[] {
  const body = layoutBlocks(a.blocks, a.cols);
  const all = [...body, ...footerOf(a)];
  if (all.length > a.rows) {
    const foot = footerOf(a);
    const keep = Math.max(0, a.rows - foot.length);
    return [...(keep ? body.slice(-keep) : []), ...foot].slice(-a.rows);
  }
  while (all.length < a.rows) all.push(blankRow());
  return all;
}
