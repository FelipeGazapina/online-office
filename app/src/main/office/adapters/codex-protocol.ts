// The Codex app-server protocol as far as the office uses it, and the rules for turning what Codex says into what the
// owner sees. Codex marks the protocol experimental and changes it between versions (`codex app-server generate-ts
// --experimental` prints the current one), so every frame the app-server sends is parsed here and nothing else touches a
// raw one. Verified against codex-cli 0.158.0. Plain Node with no Electron import: the check scripts run it directly.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { SHELL_TOOL } from '../../../shared/permissions.ts';
import type { PermissionMode, QuestionBody } from '../../../shared/protocol.ts';

export const short = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// The app-server answered a request with an error. Distinct from the process dying, which no answer ever follows.
export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// Something the owner has to do on this Mac before Codex can work. The message says what, in words that can be spoken.
export class CodexSetupError extends Error {}

// ---- frames

export type RequestId = number | string;
const requestId = z.union([z.number(), z.string()]);

export type Inbound =
  | { kind: 'response'; id: RequestId; result: unknown }
  | { kind: 'failure'; id: RequestId; code: number; message: string }
  | { kind: 'request'; id: RequestId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown };

const frame = z.object({
  id: requestId.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

// One line of the app-server's stdout. Anything that is not a JSON-RPC frame is dropped.
export function parseFrame(line: string): Inbound | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = frame.safeParse(raw);
  if (!parsed.success) return undefined;
  const { id, method, params, result, error } = parsed.data;
  if (method !== undefined) return id === undefined ? { kind: 'notification', method, params } : { kind: 'request', id, method, params };
  if (id === undefined) return undefined;
  return error ? { kind: 'failure', id, code: error.code, message: error.message } : { kind: 'response', id, result };
}

// ---- what the app-server sends about a thread

const str = z.string();
const change = z.object({ path: str, kind: z.object({ type: str, move_path: str.nullish() }) });

const knownItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agentMessage'), id: str, text: str }),
  z.object({ type: z.literal('commandExecution'), id: str, command: str, aggregatedOutput: str.nullish(), exitCode: z.number().nullish() }),
  z.object({ type: z.literal('fileChange'), id: str, changes: z.array(change) }),
  z.object({ type: z.literal('mcpToolCall'), id: str, server: str, tool: str, arguments: z.unknown().optional(), error: z.unknown().optional() }),
  z.object({ type: z.literal('subAgentActivity'), kind: z.enum(['started', 'interacted', 'interrupted', 'completed']), agentThreadId: str, agentPath: str }),
  z.object({ type: z.literal('webSearch') }),
]);
export type Item = z.infer<typeof knownItem> | { type: 'other' };
// Codex has a dozen more item types and adds them freely. The ones the office does not read are all `other`.
const item = z.unknown().transform((v): Item => {
  const parsed = knownItem.safeParse(v);
  return parsed.success ? parsed.data : { type: 'other' };
});

const turnStatus = z.enum(['completed', 'interrupted', 'failed', 'inProgress']);

const eventSchemas = {
  'turn/started': z.object({ threadId: str, turn: z.object({ id: str }) }),
  'turn/completed': z.object({
    threadId: str,
    turn: z.object({ id: str, status: turnStatus, error: z.object({ message: str }).nullish(), items: z.array(item).optional() }),
  }),
  'item/agentMessage/delta': z.object({ threadId: str, turnId: str, itemId: str, delta: str }),
  'item/started': z.object({ threadId: str, item }),
  'item/completed': z.object({ threadId: str, item }),
  'thread/settings/updated': z.object({ threadId: str, threadSettings: z.object({ model: str, effort: str.nullish() }) }),
  'thread/closed': z.object({ threadId: str }),
  'serverRequest/resolved': z.object({ threadId: str, requestId }),
  error: z.object({ threadId: str, error: z.object({ message: str }), willRetry: z.boolean() }),
};
type EventSchemas = typeof eventSchemas;
export type ThreadEvent = { [M in keyof EventSchemas]: { method: M } & z.infer<EventSchemas[M]> }[keyof EventSchemas];

// Every event the office reads carries the id of the thread it is about. Undefined for the rest.
export function parseEvent(method: string, params: unknown): ThreadEvent | undefined {
  if (!Object.hasOwn(eventSchemas, method)) return undefined;
  const parsed = eventSchemas[method as keyof EventSchemas].safeParse(params);
  // The schema was picked by the method, so the parsed shape is the one the type names for that method.
  return parsed.success ? ({ method, ...parsed.data } as ThreadEvent) : undefined;
}

const requestSchemas = {
  'item/commandExecution/requestApproval': z.object({ threadId: str, itemId: str, command: str.nullish(), reason: str.nullish(), kind: str.nullish() }),
  'item/fileChange/requestApproval': z.object({ threadId: str, itemId: str, reason: str.nullish(), grantRoot: str.nullish() }),
  'mcpServer/elicitation/request': z.object({ threadId: str, serverName: str }),
};
type RequestSchemas = typeof requestSchemas;
export type ServerRequest = { [M in keyof RequestSchemas]: { method: M } & z.infer<RequestSchemas[M]> }[keyof RequestSchemas];

export function parseRequest(method: string, params: unknown): ServerRequest | undefined {
  if (!Object.hasOwn(requestSchemas, method)) return undefined;
  const parsed = requestSchemas[method as keyof RequestSchemas].safeParse(params);
  return parsed.success ? ({ method, ...parsed.data } as ServerRequest) : undefined;
}

// ---- what the app-server answers to the office's own requests

export const threadLoaded = z.object({ thread: z.object({ id: str }), instructionSources: z.array(str).optional() });
export const turnStarted = z.object({ turn: z.object({ id: str }) });
export const terminals = z.object({ data: z.array(z.object({ processId: str })) });
export const mcpStatuses = z.object({ data: z.array(z.object({ name: str, runtimeStatus: str.nullish() })) });
export const modelPage = z.object({
  data: z.array(z.object({ id: str, displayName: str, hidden: z.boolean(), isDefault: z.boolean() })),
  nextCursor: str.nullish(),
});
export const anything = z.unknown();

// ---- permissions: the four modes, in Codex's words

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type Policy = { approval: ApprovalPolicy; sandbox: SandboxMode };

// docs/beta-plan.md maps each mode onto Codex's switches. `inherit` is the owner's own, read by `inheritedPolicy`.
const MODE_POLICIES: Record<Exclude<PermissionMode, 'inherit'>, Policy> = {
  ask: { approval: 'untrusted', sandbox: 'workspace-write' },
  auto: { approval: 'on-request', sandbox: 'workspace-write' },
  yolo: { approval: 'never', sandbox: 'danger-full-access' },
};

export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

// A thread starts with a sandbox *mode*, and a turn overrides it with the sandbox *policy* that mode stands for. These are
// the objects `thread/start` reports back for each mode: the block folder is always writable, so no extra roots.
export const SANDBOX_POLICIES: Record<SandboxMode, SandboxPolicy> = {
  'read-only': { type: 'readOnly', networkAccess: false },
  'workspace-write': { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  'danger-full-access': { type: 'dangerFullAccess' },
};

const APPROVALS: readonly string[] = ['untrusted', 'on-request', 'never'] satisfies ApprovalPolicy[];
const SANDBOXES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access'] satisfies SandboxMode[];

// What Codex itself does when the owner's config sets neither: the settings of a trusted project.
const CODEX_DEFAULT: Policy = { approval: 'on-request', sandbox: 'workspace-write' };

// The top-level `key = "value"` lines of a config.toml, which is where approval_policy and sandbox_mode live. A table
// header ends them. Other value shapes (approval_policy can be a table) are not read.
function topLevelStrings(toml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of toml.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) break;
    const m = /^([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(t);
    if (m) out.set(m[1]!, m[2] ?? m[3]!);
  }
  return out;
}

// The owner's own approval policy and sandbox, from his config.toml text, or Codex's own defaults for what it leaves out.
export function inheritedPolicy(toml: string | undefined): Policy {
  const keys = topLevelStrings(toml ?? '');
  const approval = keys.get('approval_policy');
  const sandbox = keys.get('sandbox_mode');
  return {
    approval: approval && APPROVALS.includes(approval) ? (approval as ApprovalPolicy) : CODEX_DEFAULT.approval,
    sandbox: sandbox && SANDBOXES.includes(sandbox) ? (sandbox as SandboxMode) : CODEX_DEFAULT.sandbox,
  };
}

export const policyFor = (mode: PermissionMode, inherited: () => Policy): Policy => (mode === 'inherit' ? inherited() : MODE_POLICIES[mode]);

// ---- the owner's own Codex setup, read and never written

export const ownerCodexHome = (env: NodeJS.ProcessEnv, home: string): string => env.OFFICE_CODEX_OWNER_HOME || env.CODEX_HOME || join(home, '.codex');

const readOptional = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

export const readOwnerConfig = (ownerHome: string): string | undefined => readOptional(join(ownerHome, 'config.toml'));

// Every rules file of the owner, as one text. Codex reads `rules/*.rules` at the start of a thread.
export function readOwnerRules(ownerHome: string): string {
  const dir = join(ownerHome, 'rules');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.rules'))
    .sort()
    .map((f) => readOptional(join(dir, f)) ?? '')
    .join('\n');
}

export type OwnerAuth = { accessToken: string; accountId: string };

const authFile = z.object({
  tokens: z.object({ access_token: str, account_id: str.optional() }).optional(),
});

const tokenClaims = z.object({ exp: z.number().optional(), 'https://api.openai.com/auth': z.object({ chatgpt_account_id: str.optional() }).optional() });

function claimsOf(jwt: string) {
  try {
    return tokenClaims.parse(JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')));
  } catch {
    return {};
  }
}

// The ChatGPT sign-in the owner's own Codex keeps in auth.json. The office hands only the access token to its app-server and
// never reads or sends the refresh token, so it cannot rotate the one credential the owner's Codex depends on.
export function parseOwnerAuth(text: string | undefined, nowMs: number): OwnerAuth {
  if (text === undefined) throw new CodexSetupError('ChatGPT is not signed in on this Mac. Run codex login in a terminal, then ask me again.');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = authFile.safeParse(json);
  if (!parsed.success || !parsed.data.tokens) {
    throw new CodexSetupError('Codex on this Mac is not signed in with ChatGPT. Run codex login and choose ChatGPT, then ask me again.');
  }
  const { access_token: accessToken, account_id } = parsed.data.tokens;
  const claims = claimsOf(accessToken);
  if (claims.exp !== undefined && claims.exp * 1000 <= nowMs) {
    throw new CodexSetupError('Your ChatGPT sign-in in Codex has expired. Open Codex once so it renews, then ask me again.');
  }
  const accountId = account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!accountId) throw new CodexSetupError('The ChatGPT sign-in in Codex has no account id. Run codex login again, then ask me again.');
  return { accessToken, accountId };
}

export const readOwnerAuth = (ownerHome: string, nowMs = Date.now()): OwnerAuth => parseOwnerAuth(readOptional(join(ownerHome, 'auth.json')), nowMs);

// ---- shell commands

// A command line split into words the way a POSIX shell reads it, or undefined when it does not parse (a quote left open).
function shellWords(line: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += line.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (ch === '"') {
      let closed = false;
      for (i++; i < line.length; i++) {
        const c = line[i]!;
        if (c === '"') {
          closed = true;
          break;
        }
        word += c === '\\' && i + 1 < line.length && '\\"$`'.includes(line[i + 1]!) ? line[++i]! : c;
      }
      if (!closed) return undefined;
      inWord = true;
    } else if (ch === '\\') {
      if (i + 1 >= line.length) return undefined;
      word += line[++i]!;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

// Codex runs every command as `/bin/zsh -lc '<the command>'`. The office's Always-allow rules match the bare command, so
// the wrapper comes off. Anything that is not exactly a shell, a -c flag and one script is left as it is.
export function unwrapShell(command: string): string {
  const [shell, flag, script, ...rest] = shellWords(command.trim()) ?? [];
  if (shell === undefined || flag === undefined || script === undefined || rest.length) return command.trim();
  if (!/^(?:zsh|bash|sh)$/.test(basename(shell)) || !/^-[a-z]*c[a-z]*$/.test(flag)) return command.trim();
  return script.trim();
}

// ---- files

// The deepest part of a path that exists, with symlinks resolved, followed by the part that does not exist yet.
function realish(path: string): string {
  const abs = resolve(path);
  const missing: string[] = [];
  for (let head = abs; ; ) {
    try {
      return join(realpathSync(head), ...missing.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      missing.push(basename(head));
      head = parent;
    }
  }
}

// Inside the workspace sandbox these stay read-only even in the block folder, because a write to them can run code later.
// A patch to one is the owner's call, so it never counts as inside.
const PROTECTED_DIRS = new Set(['.git', '.codex', '.agents']);

// Whether every path is a file inside the block folder, after resolving symlinks and `..`. No paths means no.
export function insideBlock(paths: readonly string[], cwd: string): boolean {
  const root = realish(cwd);
  return (
    paths.length > 0 &&
    paths.every((p) => {
      const rel = relative(root, realish(isAbsolute(p) ? p : join(cwd, p)));
      return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !rel.split(sep).some((s) => PROTECTED_DIRS.has(s));
    })
  );
}

// A file as the owner reads it: relative to the block folder when it is inside, else in full.
export function targetOf(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) ? path : rel;
}

export const changedPaths = (item: Extract<Item, { type: 'fileChange' }>): string[] =>
  item.changes.flatMap((c) => (c.kind.move_path ? [c.path, c.kind.move_path] : [c.path]));

// ---- what the owner sees

// The office matches Always-allow rules against `tool` and `detail`, so a shell command goes out as the shell tool with the
// bare command in `detail`. Codex says why when the sandbox is what stopped it ("writes a file outside the workspace").
export function commandBody(command: string | null | undefined, reason: string | null | undefined, kind: string | null | undefined): QuestionBody {
  const why = reason ? ` ${short(reason, 120)}` : '';
  if (kind === 'writeStdin') return { kind: 'permission', text: `Can I send input to a command that is running?${why}`, tool: 'write_stdin', detail: unwrapShell(command ?? '') };
  return { kind: 'permission', text: `Can I run a shell command?${why}`, tool: SHELL_TOOL, detail: unwrapShell(command ?? '') };
}

export function patchBody(paths: readonly string[], cwd: string, reason: string | null | undefined): QuestionBody {
  const detail = paths.map((p) => targetOf(p, cwd)).join(', ') || 'files';
  return { kind: 'permission', text: `Can I edit files?${reason ? ` ${short(reason, 120)}` : ''}`, tool: 'apply_patch', detail: short(detail, 200) };
}

// The office tools by their names, in the words claude.ts uses for the same tools.
const OFFICE_LINES: Record<string, string> = {
  ask_owner: 'Asking the boss',
  draw_diagram: 'Drawing on the whiteboard',
  remember: 'Writing a note',
  recall: 'Checking my notes',
  forget: 'Checking my notes',
};

// What an item that starts says the employee is doing, or undefined when it says nothing.
export function describeItem(item: Item, cwd: string): string | undefined {
  switch (item.type) {
    case 'commandExecution':
      return `Running ${short(unwrapShell(item.command), 50)}`;
    case 'fileChange':
      return item.changes.length === 1 ? `Editing ${targetOf(item.changes[0]!.path, cwd)}` : `Editing ${item.changes.length} files`;
    case 'mcpToolCall':
      return item.server === 'office' ? (OFFICE_LINES[item.tool] ?? `Using ${item.tool}`) : `Using ${item.tool}`;
    case 'webSearch':
      return 'Looking something up online';
    case 'agentMessage':
    case 'subAgentActivity':
    case 'other':
      return undefined;
  }
}

// `/root/read_a` is what Codex calls the subagent that reads a: the last word of its path is the name it was given.
export const subagentLabel = (agentPath: string): string => short((agentPath.split('/').filter(Boolean).at(-1) ?? '').replace(/[_-]+/g, ' '), 60) || 'Helper';
