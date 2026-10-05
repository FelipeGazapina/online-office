// No model, no network, no Codex. The real Codex adapter and its server pool against a scripted stand-in for the app-server
// process: what the adapter starts the server with, what it sends, what it answers, and what it tells the office.
// The frames the stand-in sends follow what a real codex-cli 0.158.0 sent in the runs recorded in docs/research/codex.md and
// in the README of this repo.
// Run from app/: node verify/codex-check.ts   Exits 1 on any failed check.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { covers, ruleFor } from '../src/shared/permissions.ts';
import type { BlockId, Employee, EmployeeId, ModelId, PermissionMode, PermissionPolicy, QuestionBody, Subagent } from '../src/shared/protocol.ts';
import {
  inheritedPolicy,
  insideBlock,
  parseFrame,
  parseOwnerAuth,
  policyFor,
  unwrapShell,
} from '../src/main/office/adapters/codex-protocol.ts';
import { CodexPool, codexCommand, codexPaths, type Child } from '../src/main/office/adapters/codex-server.ts';
import { CodexSession, codexDefaultModel, listModels } from '../src/main/office/adapters/codex.ts';
import { CodexSetupError } from '../src/main/office/adapters/codex-protocol.ts';
import type { SessionHost } from '../src/main/office/adapters/types.ts';
import { check, finish, sleep, until } from './check.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-check-')));
const repo = join(dir, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
const officeHome = join(dir, 'office-home');
const ownerHome = join(dir, 'owner-codex');
mkdirSync(ownerHome);

console.log('# shell commands');
const unwrapped: [raw: string, want: string][] = [
  ["/bin/zsh -lc 'git status --short .'", 'git status --short .'],
  ['/bin/zsh -lc ls', 'ls'],
  ['/bin/zsh -lc "cat a.txt"', 'cat a.txt'],
  ["/bin/zsh -lc 'echo \"a b\" && ls'", 'echo "a b" && ls'],
  ['/bin/zsh -lc \'echo it\'"\'"\'s\'', "echo it's"],
  ['/bin/bash -c "echo \\"hi\\""', 'echo "hi"'],
  ['bash -lic "npm test"', 'npm test'],
  ['sh -c npm', 'npm'],
  ["  /bin/zsh -lc 'npm test'  ", 'npm test'],
  ["/bin/zsh -lc 'cd sub && npm test'", 'cd sub && npm test'],
  ["/bin/zsh -lc 'npm test' extra", "/bin/zsh -lc 'npm test' extra"],
  ["/bin/zsh -l 'npm test'", "/bin/zsh -l 'npm test'"],
  ["/bin/zsh -lc 'unterminated", "/bin/zsh -lc 'unterminated"],
  ["python -c 'print(1)'", "python -c 'print(1)'"],
  ['git status', 'git status'],
  ['', ''],
];
for (const [raw, want] of unwrapped) check(unwrapShell(raw) === want, `${JSON.stringify(raw)} unwraps to ${JSON.stringify(want)}`, `got ${JSON.stringify(unwrapShell(raw))}`);
const bare = unwrapShell("/bin/zsh -lc 'git status --short .'");
const statusRule = ruleFor({ kind: 'permission', text: '', tool: 'Bash', detail: bare });
check(JSON.stringify(statusRule) === '{"kind":"command","prefix":"git status"}', 'the bare command makes the rule an Always allow click would add');
check(!!statusRule && covers(statusRule, { kind: 'permission', text: '', tool: 'Bash', detail: unwrapShell("/bin/zsh -lc 'git status'") }), 'and covers the same command the next time');
const wrappedRule = ruleFor({ kind: 'permission', text: '', tool: 'Bash', detail: "/bin/zsh -lc 'git status --short .'" });
check(wrappedRule?.kind === 'exact', 'a command left wrapped could only make an exact rule for the shell, and never one that covers git status');

console.log('\n# the four modes in Codex words');
const owner = (toml: string | undefined) => () => inheritedPolicy(toml);
const modes: [mode: PermissionMode, toml: string | undefined, want: string][] = [
  ['ask', undefined, 'untrusted workspace-write'],
  ['auto', undefined, 'on-request workspace-write'],
  ['yolo', undefined, 'never danger-full-access'],
  ['inherit', 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n', 'never danger-full-access'],
  ['inherit', 'model = "x"\napproval_policy = "untrusted" # careful\nsandbox_mode = \'read-only\'\n[projects."/a"]\napproval_policy = "never"\n', 'untrusted read-only'],
  ['inherit', undefined, 'on-request workspace-write'],
  ['inherit', '# nothing set\nmodel = "x"\n', 'on-request workspace-write'],
  ['inherit', 'approval_policy = "on-failure"\nsandbox_mode = "everything"\n', 'on-request workspace-write'],
  ['inherit', 'approval_policy = { granular = { rules = true } }\n', 'on-request workspace-write'],
  ['inherit', '[tui]\napproval_policy = "never"\n', 'on-request workspace-write'],
];
for (const [mode, toml, want] of modes) {
  const p = policyFor(mode, owner(toml));
  check(`${p.approval} ${p.sandbox}` === want, `${mode}${toml === undefined ? '' : ` with ${JSON.stringify(toml.slice(0, 60))}`} is ${want}`, `got ${p.approval} ${p.sandbox}`);
}

console.log('\n# the owner sign-in');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (exp: number, account?: string) => `${b64({ alg: 'none' })}.${b64({ exp, ...(account ? { 'https://api.openai.com/auth': { chatgpt_account_id: account } } : {}) })}.sig`;
const now = Date.now();
const signedIn = (extra: object, token = jwt(now / 1000 + 3600)) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'refresh-SECRET', ...extra } });
const authError = (text: string | undefined) => {
  try {
    parseOwnerAuth(text, now);
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
const good = parseOwnerAuth(signedIn({ account_id: 'acct-1' }), now);
check(good.accountId === 'acct-1' && good.accessToken.split('.').length === 3 && !JSON.stringify(good).includes('SECRET'), 'the access token and account id are read, and the refresh token is not carried along');
check(parseOwnerAuth(signedIn({}, jwt(now / 1000 + 3600, 'acct-from-claims')), now).accountId === 'acct-from-claims', 'an account id missing from auth.json comes from the token');
check(/not signed in on this Mac.*codex login/.test(authError(undefined)), 'no auth.json says to sign in with codex login');
check(/not signed in with ChatGPT/.test(authError(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x', tokens: null }))), 'an API key sign-in is not a ChatGPT one');
check(/not signed in with ChatGPT/.test(authError('not json')), 'a file that is not JSON says the same');
check(/expired.*Open Codex once/.test(authError(signedIn({ account_id: 'a' }, jwt(now / 1000 - 5)))), 'an expired access token says to open Codex once, and does not start Codex on it');
check(/no account id/.test(authError(signedIn({}, jwt(now / 1000 + 3600)))), 'a sign-in with no account id anywhere is refused');

console.log('\n# which files are inside the block');
writeFileSync(join(repo, 'src', 'a.ts'), 'x');
mkdirSync(join(dir, 'outside'));
symlinkSync(join(dir, 'outside'), join(repo, 'escape'));
const inside: [paths: string[], want: boolean][] = [
  [[join(repo, 'src', 'a.ts')], true],
  [[join(repo, 'src', 'new', 'deep', 'b.ts')], true],
  [['src/a.ts'], true],
  [[join(repo, 'src', 'a.ts'), join(repo, 'README.md')], true],
  [[join(repo, 'src', '..', 'src', 'a.ts')], true],
  [[join(dir, 'outside', 'x.txt')], false],
  [[join(repo, '..', 'outside', 'x.txt')], false],
  [[join(repo, 'src', 'a.ts'), join(dir, 'outside', 'x.txt')], false],
  [[join(repo, 'escape', 'x.txt')], false],
  [['../outside/x.txt'], false],
  [[repo], false],
  [[join(repo, '.git', 'hooks', 'pre-commit')], false],
  [[join(repo, 'sub', '.codex', 'config.toml')], false],
  [[join(repo, '.agents', 'skills', 's.md')], false],
  [[join(repo, '.gitignore')], true],
  [[join(repo, 'src', '..a')], true],
  [[], false],
];
for (const [paths, want] of inside) check(insideBlock(paths, repo) === want, `${JSON.stringify(paths.map((p) => p.replace(dir, '<dir>')))} is ${want ? 'inside' : 'not inside'} the block`);

console.log('\n# frames');
check(parseFrame('{"id":3,"result":{"a":1}}')?.kind === 'response' && parseFrame('{"id":3,"error":{"code":-32600,"message":"no"}}')?.kind === 'failure', 'a frame with an id and a result or error is a response');
check(parseFrame('{"method":"turn/started","params":{}}')?.kind === 'notification' && parseFrame('{"id":0,"method":"item/tool/call","params":{}}')?.kind === 'request', 'a method with no id is a notification and with one a request');
check(parseFrame('warning: not json') === undefined && parseFrame('[1,2]') === undefined && parseFrame('{"foo":1}') === undefined, 'a line that is not a frame is dropped');

// ---- a scripted app-server

// The process the adapter talks to. `received` is what the adapter sent it, and `handlers` are what it answers.
class FakeChild extends EventEmitter implements Child {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  stdinEnded = false;
  constructor() {
    super();
    this.stdin.on('end', () => (this.stdinEnded = true));
  }
  kill(signal?: NodeJS.Signals) {
    this.signals.push(signal ?? 'SIGTERM');
    queueMicrotask(() => this.die(null, signal ?? 'SIGTERM'));
    return true;
  }
  die(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.dead) return;
    this.dead = true;
    this.stdout.end();
    this.emit('exit', code, signal);
  }
  dead = false;
}

type Received = { method: string; params: any };
type Handler = (params: any) => unknown;

// An answer followed at once by notifications, all in one write, as when a turn fails the moment it starts.
class After {
  readonly result: unknown;
  readonly events: [string, unknown][];
  constructor(result: unknown, events: [string, unknown][]) {
    this.result = result;
    this.events = events;
  }
}

class FakeCodex {
  readonly child = new FakeChild();
  readonly received: Received[] = [];
  readonly handlers = new Map<string, Handler>();
  private replies = new Map<number, (r: { result?: unknown; error?: unknown }) => void>();
  private serverId = 0;
  // The id of the last request the server made.
  lastId = -1;

  constructor(base: Map<string, Handler>) {
    for (const [m, h] of base) this.handlers.set(m, h);
    createInterface({ input: this.child.stdin }).on('line', (line) => {
      const f = JSON.parse(line) as { id?: number; method?: string; params?: any; result?: unknown; error?: unknown };
      if (f.method !== undefined) {
        this.received.push({ method: f.method, params: f.params });
        if (f.id === undefined) return;
        const handler = this.handlers.get(f.method);
        try {
          const result = handler ? handler(f.params) : {};
          if (result instanceof Error) this.write({ id: f.id, error: { code: -32600, message: result.message } });
          else if (result instanceof After) this.write({ id: f.id, result: result.result }, ...result.events.map(([method, params]) => ({ method, params })));
          else this.write({ id: f.id, result });
        } catch (e) {
          this.write({ id: f.id, error: { code: -32603, message: String(e) } });
        }
      } else if (f.id !== undefined) this.replies.get(f.id)?.(f);
    });
  }
  private write(...frames: unknown[]) {
    this.child.stdout.write(frames.map((f) => `${JSON.stringify(f)}\n`).join(''));
  }
  notify(method: string, params: unknown) {
    this.write({ method, params });
  }
  // A request from the server, and what the adapter answered.
  ask(method: string, params: unknown): Promise<{ result?: any; error?: any }> {
    const id = this.serverId++;
    this.lastId = id;
    return new Promise((resolve) => {
      this.replies.set(id, resolve);
      this.write({ id, method, params });
    });
  }
  sent = (method: string) => this.received.filter((r) => r.method === method);
  last = (method: string) => this.received.filter((r) => r.method === method).at(-1)?.params;
}

let threads = 0;
let turns = 0;
const defaults = (): Map<string, Handler> =>
  new Map<string, Handler>([
    ['initialize', () => ({ userAgent: 'fake', codexHome: officeHome, platformFamily: 'unix', platformOs: 'macos' })],
    ['account/login/start', () => ({ type: 'chatgptAuthTokens' })],
    ['thread/start', () => ({ thread: { id: `thread-${++threads}` }, instructionSources: [] })],
    ['thread/resume', (p) => ({ thread: { id: p.threadId } })],
    ['mcpServerStatus/list', () => ({ data: [{ name: 'office', runtimeStatus: 'connected' }], nextCursor: null })],
    ['turn/start', () => ({ turn: { id: `turn-${++turns}`, status: 'inProgress' } })],
    ['turn/steer', (p) => ({ turnId: p.expectedTurnId })],
    ['turn/interrupt', () => ({})],
    ['thread/backgroundTerminals/list', () => ({ data: [] })],
    ['thread/backgroundTerminals/terminate', () => ({ terminated: true })],
  ]);

let ownerAccess = jwt(now / 1000 + 86400, 'acct');
const ownerSignIn = () => parseOwnerAuth(signedIn({ account_id: 'acct' }, ownerAccess), Date.now());

// A pool that starts scripted servers, and the list of the servers it has started.
function makeWorld(ownerAuth = ownerSignIn, spawn?: () => Child) {
  const started: FakeCodex[] = [];
  const world = new CodexPool({
    spawn:
      spawn ??
      (() => {
        const fake = new FakeCodex(defaults());
        started.push(fake);
        return fake.child;
      }),
    home: officeHome,
    ownerHome,
    ownerAuth,
  });
  return { pool: world, servers: started };
}
const main = makeWorld();
const pool = main.pool;
const servers = main.servers;
const app = () => servers.at(-1)!;
const sentCount = (method: string) => servers.at(-1)?.sent(method).length ?? 0;

// Only the fields the adapter reads, in the shape the app-server sends them.
const item = (threadId: string, fields: Record<string, unknown>, turnId = 'turn-x') => ({ threadId, turnId, item: fields });
const turnDone = (threadId: string, turnId: string, status = 'completed', items: unknown[] = [], error: unknown = null) => ({ threadId, turn: { id: turnId, status, items, error } });
const message = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: 'final_answer' });
const command = (id: string, cmd: string) => ({ type: 'commandExecution', id, command: cmd, status: 'inProgress' });

function scripted(sessionId?: string, policy: PermissionPolicy = { mode: 'ask', alwaysAllow: [] }, model = 'gpt-6-luna', use: CodexPool = pool) {
  const employee: Employee = {
    id: 'e1' as EmployeeId,
    name: 'Ana',
    provider: 'codex',
    blockId: 'b1' as BlockId,
    seat: null,
    status: { kind: 'idle' },
    activity: '',
    model: model as ModelId,
    permissions: policy,
    subagents: [],
    hiredAt: 0,
    ...(sessionId ? { sessionId } : {}),
  };
  const asked: QuestionBody[] = [];
  const said: string[] = [];
  const logs: string[] = [];
  const started: Subagent[] = [];
  const finished: string[] = [];
  const activity: string[] = [];
  let xp = 0;
  let answer = 'Allow';
  let rules = '';
  let digest = '';
  let hold: ((text: string) => void) | undefined;
  let holding = false;
  const host: SessionHost = {
    employee,
    block: { id: employee.blockId, name: 'repo', cwd: repo, color: '#000', slot: 0 },
    companyName: 'Gazapina Labs',
    get model() {
      return employee.model;
    },
    get permissions() {
      return employee.permissions;
    },
    setStatus: (status) => void (employee.status = status),
    setActivity: (text) => void (employee.activity = text, activity.push(text)),
    setSessionId: (id) => void (employee.sessionId = id),
    said: (text) => void said.push(text),
    log: (line) => void logs.push(line),
    ask: (body, signal) => {
      asked.push(body);
      if (!holding) return Promise.resolve(answer);
      return new Promise((resolve) => {
        hold = resolve;
        signal?.addEventListener('abort', () => resolve(''), { once: true });
      });
    },
    mcp: { url: 'http://127.0.0.1:1/mcp/scripted', name: 'office' },
    memoryDigest: () => digest,
    rules: () => rules,
    taskCompleted: () => void xp++,
    subagentStarted: (subagent) => void started.push(subagent),
    subagentFinished: (id) => void finished.push(id),
  };
  return {
    employee,
    host,
    asked,
    said,
    logs,
    started,
    finished,
    activity,
    xp: () => xp,
    answers: (text: string) => void (answer = text),
    holdNext: () => void (holding = true),
    release: (text: string) => void (holding = false, hold?.(text)),
    setRules: (text: string) => void (rules = text),
    setDigest: (text: string) => void (digest = text),
    session: new CodexSession(host, use),
  };
}
type Scripted = ReturnType<typeof scripted>;

// A session that has started a turn: the thread and turn ids Codex gave it.
async function working(a: Scripted, task = 'do the thing') {
  const before = sentCount('turn/start');
  a.session.assign(task);
  await until(() => sentCount('turn/start') > before && a.employee.sessionId !== undefined);
  const threadId = a.employee.sessionId!;
  const turnId = `turn-${turns}`;
  app().notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
  await sleep(20);
  return { threadId, turnId };
}

console.log('\n# starting a thread');
check(servers.length === 0, 'building sessions and pools starts no process');
// Holds the server open through the checks below, so what each one sees does not depend on the one before it closing it.
const keeper = { onEvent() {}, onRequest: () => Promise.reject(new Error('no')), serverLost() {}, notice() {} };
await pool.acquire(keeper);
const ana = scripted(undefined, { mode: 'ask', alwaysAllow: [] });
ana.setRules('- Never touch billing');
ana.setDigest('What you remember (call recall for details)\n- Release branch is release-teal');
const first = await working(ana);
check(servers.length === 1 && ana.employee.status.kind === 'working', 'the first task starts one server');
const handshake = app().received.map((r) => r.method);
check(handshake.slice(0, 3).join() === 'initialize,initialized,account/login/start', 'which is initialized and then signed in');
const login = app().last('account/login/start');
check(login.type === 'chatgptAuthTokens' && login.accessToken === ownerAccess && login.chatgptAccountId === 'acct' && !JSON.stringify(app().received).includes('refresh-SECRET'), "with the owner's access token, and no refresh token anywhere in what was sent");
check(existsSync(join(officeHome, 'auth.json')) === false, 'the office home has no auth.json');
const init = app().last('initialize');
check(init.clientInfo.name === 'online-office' && init.capabilities.experimentalApi === true && !init.capabilities.optOutNotificationMethods.includes('item/agentMessage/delta'), 'the handshake names the office and keeps streamed assistant text notifications');
const start = app().last('thread/start');
check(start.cwd === repo && start.model === 'gpt-6-luna' && start.approvalPolicy === 'untrusted' && start.sandbox === 'workspace-write', 'the thread starts in the block folder, on the employee model, in ask mode');
check(start.developerInstructions.includes('You are Ana') && start.developerInstructions.includes('- Never touch billing') && start.developerInstructions.includes('- Release branch is release-teal'), 'and with the persona, the rules and the memory digest');
check(JSON.stringify(start.config) === JSON.stringify({ mcp_servers: { office: { url: 'http://127.0.0.1:1/mcp/scripted', tool_timeout_sec: 86400, default_tools_approval_mode: 'approve' } } }), 'and with the office MCP server, a day to answer, and its own tools approved');
check(ana.employee.sessionId === first.threadId && app().sent('mcpServerStatus/list').length >= 1, 'the thread id is the session id, and the first turn waits for the office tools');
const turn1 = app().last('turn/start');
check(turn1.threadId === first.threadId && turn1.input[0].text === 'do the thing' && turn1.model === 'gpt-6-luna', 'the task is the first turn');
check(turn1.approvalPolicy === 'untrusted' && JSON.stringify(turn1.sandboxPolicy) === '{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false}', 'and carries the mode as an approval policy and a sandbox policy');
check(!('effort' in turn1), 'a turn says nothing of effort unless OFFICE_CODEX_EFFORT does');

console.log('\n# what the employee says and does');
app().notify('item/started', item(first.threadId, command('c1', "/bin/zsh -lc 'npm test -- --watch=false'"), first.turnId));
app().notify('item/started', item(first.threadId, { type: 'fileChange', id: 'p1', changes: [{ path: join(repo, 'src', 'a.ts'), kind: { type: 'update', move_path: null }, diff: '' }] }, first.turnId));
app().notify('item/started', item(first.threadId, { type: 'mcpToolCall', id: 'm1', server: 'office', tool: 'ask_owner' }, first.turnId));
app().notify('item/started', item(first.threadId, { type: 'mcpToolCall', id: 'm2', server: 'office', tool: 'remember' }, first.turnId));
app().notify('item/agentMessage/delta', { threadId: first.threadId, turnId: first.turnId, itemId: 'a1', delta: 'I will run the tests.' });
app().notify('item/completed', item(first.threadId, message('a1', 'I will run the tests.'), first.turnId));
await until(() => ana.said.length === 1);
check(ana.logs.includes('Running npm test -- --watch=false') && ana.logs.includes('Editing src/a.ts') && ana.logs.includes('Writing a note'), 'commands and edits go to the log in the words claude.ts uses, with the shell wrapper off');
check(!ana.logs.includes('Asking the boss') && ana.activity.includes('Asking the boss'), 'ask_owner shows on the desk and not in the log, because the office logs the question itself');
check(ana.said.join() === 'I will run the tests.' && ana.logs.includes('Said: I will run the tests.'), 'a message from the agent is spoken and logged');
check(ana.activity.includes('I will run the tests.'), 'streamed assistant text updates the employee activity before the message completes');
app().notify('thread/settings/updated', { threadId: first.threadId, threadSettings: { model: 'gpt-6-luna', effort: 'low', approvalPolicy: 'untrusted' } });
await until(() => ana.logs.some((l) => l.startsWith('Model:')));
check(ana.logs.includes('Model: gpt-6-luna, low effort'), 'the log says which model the turn runs on');
app().notify('item/started', item('someone-elses-thread', command('c9', 'rm -rf /')));
await sleep(30);
check(!ana.logs.some((l) => l.includes('rm -rf')), 'an event for a thread that is not this employee is not theirs');

console.log('\n# a turn ends');
app().notify('item/completed', item(first.threadId, message('a2', 'All tests pass.'), first.turnId));
app().notify('turn/completed', turnDone(first.threadId, first.turnId, 'completed', [message('a2', 'All tests pass.')]));
await until(() => ana.employee.status.kind === 'idle');
check(ana.xp() === 1 && ana.employee.activity === 'All tests pass.' && ana.logs.includes('Finished: All tests pass.'), 'a finished turn earns the XP, and the desk and log say what it ended with');
check(ana.said.join('|') === 'I will run the tests.|All tests pass.', 'and the last message is not spoken twice');

console.log('\n# approvals');
const second = await working(ana, 'a second task');
const pending = (id: string, cmd: string, extra: Record<string, unknown> = {}) => app().ask('item/commandExecution/requestApproval', { kind: 'command', threadId: second.threadId, turnId: second.turnId, itemId: id, command: cmd, ...extra });
ana.answers('Allow');
let reply = await pending('c2', "/bin/zsh -lc 'git status --short .'");
check(JSON.stringify(ana.asked.at(-1)) === JSON.stringify({ kind: 'permission', text: 'Can I run a shell command?', tool: 'Bash', detail: 'git status --short .' }) && reply.result.decision === 'accept', 'a command asks as the shell tool with the bare command, and an allow is accept');
ana.answers('Deny');
reply = await pending('c3', "/bin/zsh -lc 'git push'");
check(reply.result.decision === 'decline', 'a deny is decline');
await sleep(20);
check(app().sent('turn/steer').length === 0, 'and a bare deny sends the model nothing more');
ana.answers('no, use pnpm and not npm');
reply = await pending('c4', "/bin/zsh -lc 'npm install'");
await until(() => app().sent('turn/steer').length === 1);
check(reply.result.decision === 'decline' && app().last('turn/steer').input[0].text === '[Your boss did not allow that. They said]: no, use pnpm and not npm' && app().last('turn/steer').expectedTurnId === second.turnId, 'a deny with reasons declines, and the reasons reach the running turn');
ana.answers('sim, pode');
reply = await pending('c5', "/bin/zsh -lc 'ls'", { reason: 'The command writes a file outside the workspace.' });
check((ana.asked.at(-1) as { text: string }).text === 'Can I run a shell command? The command writes a file outside the workspace.' && reply.result.decision === 'accept', 'why Codex is asking is part of what the employee says, and a yes in Portuguese allows');
reply = await pending('c6', "/bin/zsh -lc 'cat'", { kind: 'writeStdin' });
check((ana.asked.at(-1) as { tool: string }).tool === 'write_stdin' && reply.result.decision === 'accept', 'input to a running command is its own kind of question');
ana.holdNext();
const heldAsk = pending('c7', '/bin/zsh -lc "sleep 100"');
await until(() => ana.asked.at(-1)?.kind === 'permission' && (ana.asked.at(-1) as { detail: string }).detail === 'sleep 100');
app().notify('serverRequest/resolved', { threadId: second.threadId, requestId: app().lastId });
reply = await heldAsk;
check(reply.result.decision === 'decline', 'when Codex resolves a question itself the card is withdrawn');

console.log('\n# patches');
const patch = async (mode: PermissionMode, paths: string[], extra: Record<string, unknown> = {}) => {
  const a = scripted(undefined, { mode, alwaysAllow: [] });
  const t = await working(a);
  app().notify('item/started', item(t.threadId, { type: 'fileChange', id: 'p9', changes: paths.map((path) => ({ path, kind: { type: 'update', move_path: null }, diff: '' })) }, t.turnId));
  await sleep(20);
  a.answers('Deny');
  const r = await app().ask('item/fileChange/requestApproval', { threadId: t.threadId, turnId: t.turnId, itemId: 'p9', ...extra });
  a.session.stop();
  return { decision: r.result.decision as string, asked: a.asked };
};
const inBlock = [join(repo, 'src', 'a.ts'), join(repo, 'src', 'new.ts')];
const outside = [join(repo, 'src', 'a.ts'), join(dir, 'outside', 'x.txt')];
for (const mode of ['inherit', 'auto', 'yolo'] as const) {
  const r = await patch(mode, inBlock);
  check(r.decision === 'accept' && r.asked.length === 0, `${mode}: a patch whose every path is in the block is accepted without asking`);
}
const askInside = await patch('ask', inBlock);
check(askInside.decision === 'decline' && askInside.asked.length === 1 && (askInside.asked[0] as { detail: string }).detail === 'src/a.ts, src/new.ts' && (askInside.asked[0] as { tool: string }).tool === 'apply_patch', 'ask: the same patch asks, with the files as the detail');
for (const mode of ['ask', 'inherit', 'auto', 'yolo'] as const) {
  const r = await patch(mode, outside);
  check(r.decision === 'decline' && r.asked.length === 1 && (r.asked[0] as { detail: string }).detail.includes(join(dir, 'outside', 'x.txt')), `${mode}: a patch with one path outside the block asks, naming the path`);
}
const escape = await patch('auto', [join(repo, 'escape', 'x.txt')]);
check(escape.decision === 'decline' && escape.asked.length === 1, 'a path that leaves the block through a symlink asks');
const hooks = await patch('auto', [join(repo, '.git', 'hooks', 'pre-commit')]);
check(hooks.decision === 'decline' && hooks.asked.length === 1, 'a path in .git asks, because the sandbox keeps it read-only and a hook runs code later');
const grant = await patch('auto', inBlock, { grantRoot: join(repo, 'src') });
check(grant.decision === 'decline' && grant.asked.length === 1, 'a patch that asks for a wider write grant than its files asks');
const unknown = scripted(undefined, { mode: 'auto', alwaysAllow: [] });
const ut = await working(unknown);
unknown.answers('Deny');
const noItem = await app().ask('item/fileChange/requestApproval', { threadId: ut.threadId, turnId: ut.turnId, itemId: 'never-seen' });
check(noItem.result.decision === 'decline' && unknown.asked.length === 1, 'a patch approval for files the adapter never saw is asked about');
unknown.session.stop();

console.log('\n# elicitations and the rest');
const own = await app().ask('mcpServer/elicitation/request', { threadId: first.threadId, turnId: first.turnId, serverName: 'office', mode: 'form', message: 'Allow the office MCP server to run tool "ask_owner"?', requestedSchema: {}, _meta: {} });
check(own.result.action === 'accept' && own.result.content === null, "a question from the office's own MCP server is accepted without asking");
const other = await app().ask('mcpServer/elicitation/request', { threadId: first.threadId, turnId: first.turnId, serverName: 'slack', mode: 'form', message: 'x', requestedSchema: {}, _meta: {} });
check(other.result.action === 'decline', 'and one from any other server is declined');
const unhandled = await app().ask('item/tool/requestUserInput', { threadId: first.threadId, turnId: first.turnId, itemId: 'q', questions: [] });
check(unhandled.error?.code === -32601, 'a request the office does not answer gets an error back, so Codex does not wait for it forever');
const orphan = await app().ask('item/commandExecution/requestApproval', { kind: 'command', threadId: 'nobody', turnId: 't', itemId: 'i', command: 'ls' });
check(orphan.error?.code === -32602, 'and so does one about a thread no employee owns');

console.log('\n# talking to a working employee');
ana.answers('Allow');
const steersBefore = sentCount('turn/steer');
ana.session.interject('use the staging database', 'next');
await until(() => sentCount('turn/steer') === steersBefore + 1);
const steer = app().last('turn/steer');
check(steer.expectedTurnId === second.turnId && steer.input[0].text === '[Your boss walked over to your desk and said out loud]: use the staging database' && ana.logs.includes('Boss said: use the staging database'), 'a tap on the shoulder steers the running turn');
app().handlers.set('turn/steer', () => new Error('no active turn to steer'));
const turnsBefore = app().sent('turn/start').length;
ana.session.interject('and use a transaction', 'next');
await until(() => app().sent('turn/start').length === turnsBefore + 1);
check(app().last('turn/start').input[0].text.endsWith('and use a transaction') && ana.employee.status.kind === 'working', 'a steer Codex refuses because the turn just ended starts a turn instead');
app().handlers.set('turn/steer', (p) => ({ turnId: p.expectedTurnId }));

console.log('\n# a hard stop');
const running = { threadId: first.threadId, turnId: `turn-${turns}` };
app().notify('turn/started', { threadId: running.threadId, turn: { id: running.turnId, status: 'inProgress' } });
await sleep(20);
app().handlers.set('thread/backgroundTerminals/list', () => ({ data: [{ processId: 'p-77', itemId: 'i', command: 'sleep 99', cwd: repo }] }));
app().handlers.set('turn/interrupt', (p) => {
  queueMicrotask(() => app().notify('turn/completed', turnDone(p.threadId, p.turnId, 'interrupted')));
  return {};
});
const before = app().received.length;
ana.session.interject('stop that and do this instead', 'now');
await until(() => app().received.slice(before).some((r) => r.method === 'turn/start'));
const stopFrames = app().received.slice(before).map((r) => r.method).filter((m) => ['turn/interrupt', 'thread/backgroundTerminals/list', 'thread/backgroundTerminals/terminate', 'turn/start'].includes(m));
check(stopFrames.join() === 'turn/interrupt,thread/backgroundTerminals/list,thread/backgroundTerminals/terminate,turn/start', 'a hard stop interrupts the turn, ends the commands it left running, and only then sends the message as a new turn', stopFrames.join());
check(app().last('thread/backgroundTerminals/terminate').processId === 'p-77' && app().last('turn/interrupt').turnId === running.turnId, 'naming the turn and the command');
check(ana.employee.status.kind === 'working' && ana.xp() === 1, 'the interrupted turn is not a finished task, and the employee is still working');
app().handlers.set('turn/interrupt', () => ({}));
app().handlers.set('thread/backgroundTerminals/list', () => ({ data: [] }));

console.log('\n# model and permissions between turns');
const live = { threadId: first.threadId, turnId: `turn-${turns}` };
app().notify('turn/started', { threadId: live.threadId, turn: { id: live.turnId, status: 'inProgress' } });
app().notify('turn/completed', turnDone(live.threadId, live.turnId, 'completed', [message('a9', 'ok')]));
await until(() => ana.employee.status.kind === 'idle');
ana.employee.model = 'gpt-6-sol' as ModelId;
ana.session.setModel('gpt-6-sol' as ModelId);
ana.employee.permissions = { mode: 'yolo', alwaysAllow: [] };
ana.session.permissionsChanged(ana.employee.permissions);
check(app().sent('thread/settings/update').length === 0, 'a change of model or mode sends nothing by itself');
const startsBefore = sentCount('thread/start');
ana.session.assign('after the change');
await until(() => app().last('turn/start')?.input[0].text === 'after the change');
const changed = app().last('turn/start');
check(changed.model === 'gpt-6-sol' && changed.approvalPolicy === 'never' && changed.sandboxPolicy.type === 'dangerFullAccess', 'the next turn runs on the new model and the new mode');
check(sentCount('thread/start') === startsBefore, 'without starting another thread');

ana.session.stop();

console.log('\n# a turn that fails at once');
const quick = scripted();
await working(quick, 'warm up the server');
app().notify('turn/completed', turnDone(`thread-${threads}`, `turn-${turns}`, 'completed', [message('w', 'ok')]));
await until(() => quick.employee.status.kind === 'idle');
app().handlers.set('turn/start', (p) => new After({ turn: { id: 'turn-fast', status: 'inProgress' } }, [
  ['turn/started', { threadId: p.threadId, turn: { id: 'turn-fast' } }],
  ['error', { threadId: p.threadId, turnId: 'turn-fast', error: { message: 'The model does not exist' }, willRetry: false }],
  ['turn/completed', turnDone(p.threadId, 'turn-fast', 'failed', [], { message: 'The model does not exist' })],
]));
quick.session.assign('go');
await until(() => quick.employee.status.kind === 'error');
check(quick.employee.status.kind === 'error' && quick.employee.status.message === 'The model does not exist' && quick.logs.includes('Error: The model does not exist'), 'a model Codex does not know fails the first turn, and the employee says so');
const interrupts = sentCount('turn/interrupt');
quick.session.stop();
await sleep(50);
check(sentCount('turn/interrupt') === interrupts, 'and nothing is left running for a stop to interrupt, even though the turn ended before turn/start had been answered to');
app().handlers.set('turn/start', () => ({ turn: { id: `turn-${++turns}`, status: 'inProgress' } }));

console.log('\n# resuming a thread');
const resumed = scripted('thread-from-last-run', { mode: 'auto', alwaysAllow: [] });
resumed.setRules('- Answer in Portuguese');
resumed.setDigest('What you remember (call recall for details)\n- Standup is at 09:40');
const resumesBefore = sentCount('thread/resume');
const startsBeforeResume = sentCount('turn/start');
const threadStartsBeforeResume = sentCount('thread/start');
resumed.session.assign('carry on');
await until(() => sentCount('thread/resume') > resumesBefore && sentCount('turn/start') > startsBeforeResume);
const resume = app().last('thread/resume');
check(resume.threadId === 'thread-from-last-run' && resume.cwd === repo && resume.model === 'gpt-6-luna' && resume.approvalPolicy === 'on-request' && resume.sandbox === 'workspace-write' && resume.excludeTurns === true, 'a stored session id resumes that thread, in the block folder, on the model, in the mode');
check(JSON.stringify(resume.config) === JSON.stringify({ mcp_servers: { office: { url: 'http://127.0.0.1:1/mcp/scripted', tool_timeout_sec: 86400, default_tools_approval_mode: 'approve' } } }), 'and sends the office MCP server again, because Codex does not keep it');
check(sentCount('thread/start') === threadStartsBeforeResume && !('developerInstructions' in resume), 'it starts no thread and sends no persona, which a resumed thread would ignore');
const resumedTurn = app().last('turn/start');
check(resumedTurn.threadId === 'thread-from-last-run' && resumedTurn.input[0].text.startsWith('[These are the rules your boss has set for you now') && resumedTurn.input[0].text.includes('- Answer in Portuguese') && resumedTurn.input[0].text.endsWith('carry on'), 'the rules of today go in front of the first task, because a resumed thread keeps the ones it started with');
const resumedId = 'thread-from-last-run';
app().notify('turn/started', { threadId: resumedId, turn: { id: `turn-${turns}` } });
app().notify('turn/completed', turnDone(resumedId, `turn-${turns}`, 'completed', [message('r', 'done')]));
await until(() => resumed.employee.status.kind === 'idle');
resumed.session.assign('and again');
const resumedTurnsBeforeAgain = sentCount('turn/start');
await until(() => sentCount('turn/start') > resumedTurnsBeforeAgain);
check(sentCount('thread/resume') === resumesBefore + 1 && !app().last('turn/start').input[0].text.includes('These are the rules'), 'the thread is resumed once, and the rules go in once');

const gone = scripted('thread-that-was-deleted', { mode: 'ask', alwaysAllow: [] });
app().handlers.set('thread/resume', () => new Error('no rollout found for thread id thread-that-was-deleted'));
const goneTurnsBefore = sentCount('turn/start');
gone.session.assign('start over');
await until(() => gone.employee.sessionId !== 'thread-that-was-deleted' && sentCount('turn/start') > goneTurnsBefore);
check(gone.employee.sessionId === `thread-${threads}` && gone.logs.some((l) => l.includes('Could not pick up the earlier conversation (no rollout found')) && app().last('turn/start').input[0].text === 'start over', 'a thread Codex no longer has is replaced by a new one, and the owner is told');
app().handlers.set('thread/resume', (p) => ({ thread: { id: p.threadId } }));

console.log('\n# the owner rules go only to a thread that follows his settings');
writeFileSync(join(ownerHome, 'config.toml'), 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n');
mkdirSync(join(ownerHome, 'rules'), { recursive: true });
writeFileSync(join(ownerHome, 'rules', 'default.rules'), 'prefix_rule(pattern=["git", "add"], decision="allow")\n');
writeFileSync(join(ownerHome, 'rules', 'notes.txt'), 'not a rules file');
const rulesFile = join(officeHome, 'rules', 'owner.rules');
const seen: string[] = [];
const watch = (p: { threadId?: string }) => void seen.push(existsSync(rulesFile) ? readFileSync(rulesFile, 'utf8').trim() : '(none)');
app().handlers.set('thread/start', (p) => (watch(p), { thread: { id: `thread-${++threads}` }, instructionSources: [] }));
app().handlers.set('thread/resume', (p) => (watch(p), { thread: { id: p.threadId } }));
const followers = [scripted(undefined, { mode: 'inherit', alwaysAllow: [] }), scripted(undefined, { mode: 'ask', alwaysAllow: [] }), scripted('thread-old-inherit', { mode: 'inherit', alwaysAllow: [] }), scripted(undefined, { mode: 'yolo', alwaysAllow: [] })];
for (const f of followers) f.session.assign('go');
await until(() => seen.length === 4);
check(seen.slice().sort().join('|') === '(none)|(none)|prefix_rule(pattern=["git", "add"], decision="allow")|prefix_rule(pattern=["git", "add"], decision="allow")', 'while threads load at the same moment, exactly the two that follow his settings find his rules, one start and one resume', seen.join('|'));
check(!existsSync(rulesFile), 'and the folder is empty again afterwards, so a subagent spawned later gets none');
check(app().received.filter((r) => r.method === 'thread/start' || r.method === 'thread/resume').every((r) => !JSON.stringify(r.params).includes('git", "add')), "the rules are files Codex reads, and never part of what the adapter sends");
const inheritStart = app().received.filter((r) => r.method === 'thread/start').find((r) => r.params.approvalPolicy === 'on-request' && r.params.sandbox === 'workspace-write');
check(!!inheritStart, "an inherit thread starts with the approval policy and sandbox in the owner's config.toml");
app().handlers.set('thread/start', () => ({ thread: { id: `thread-${++threads}` }, instructionSources: [] }));
app().handlers.set('thread/resume', (p) => ({ thread: { id: p.threadId } }));
for (const f of followers) f.session.stop();
await sleep(50);

console.log('\n# a rule the owner changes');
const rulesA = scripted(undefined, { mode: 'ask', alwaysAllow: [] });
rulesA.session.rulesChanged('Nobody is running');
const rulesSteersBefore = sentCount('turn/steer');
const t0 = await working(rulesA, 'first task');
const firstStart = app().sent('turn/start').findLast((r) => r.params.threadId === t0.threadId);
check(sentCount('turn/steer') === rulesSteersBefore && firstStart?.params.input[0].text === 'first task', 'a rule change with no thread loaded is dropped, because the next start reads the rules');
const steersA = sentCount('turn/steer');
rulesA.session.rulesChanged('New rule: answer in Portuguese');
await until(() => sentCount('turn/steer') === steersA + 1);
check(app().last('turn/steer').input[0].text === '[Your boss changed the rules you work by. Acknowledge it in one sentence, then follow it]: New rule: answer in Portuguese' && app().last('turn/steer').expectedTurnId === t0.turnId, 'a rule change while the employee works steers the running turn');
app().notify('turn/completed', turnDone(t0.threadId, t0.turnId, 'completed', [message('z', 'ok')]));
await until(() => rulesA.employee.status.kind === 'idle');
rulesA.session.rulesChanged('First change');
rulesA.session.rulesChanged('Second change');
await sleep(30);
check(sentCount('turn/steer') === steersA + 1, 'a rule change between tasks sends nothing');
const startsA = sentCount('turn/start');
rulesA.session.assign('the next task');
await until(() => sentCount('turn/start') === startsA + 1);
const carried = app().last('turn/start').input[0].text as string;
check(carried.indexOf('First change') < carried.indexOf('Second change') && carried.endsWith('\n\nthe next task'), 'both go in front of the next task, in order');
rulesA.session.stop();

console.log('\n# a message to an idle employee');
const idle = scripted(undefined, { mode: 'ask', alwaysAllow: [] });
idle.session.interject('are you there?', 'next');
await until(() => app().last('turn/start')?.input[0].text?.endsWith('are you there?'));
check(idle.employee.status.kind === 'working' && app().last('turn/start').input[0].text === '[Your boss walked over to your desk and said out loud]: are you there?' && idle.logs.includes('Boss said: are you there?'), 'wakes them with a new turn, whatever the style');
idle.session.stop();

console.log('\n# subagents, as codex-cli 0.158.0 streams them');
const boss = scripted(undefined, { mode: 'ask', alwaysAllow: [] });
const b = await working(boss, 'use a helper');
const child = 'thread-child-1';
const grandchild = 'thread-child-2';
const activity = (threadId: string, kind: string, agent: string, path: string) => item(threadId, { type: 'subAgentActivity', id: `sa-${kind}-${agent}`, kind, agentThreadId: agent, agentPath: path });
app().notify('item/started', activity(b.threadId, 'started', child, '/root/read_a'));
app().notify('item/completed', activity(b.threadId, 'started', child, '/root/read_a'));
await until(() => boss.started.length === 1);
check(boss.started[0]!.id === child && boss.started[0]!.parentId === null && boss.started[0]!.label === 'read a' && boss.finished.length === 0, 'an item that says the employee started a subagent puts a doll on the desk, labelled with its name');
app().notify('turn/started', { threadId: child, turn: { id: 'turn-child' } });
app().notify('item/started', item(child, command('cc1', "/bin/zsh -lc 'cat a.txt'"), 'turn-child'));
await until(() => boss.logs.includes('Running cat a.txt'));
check(boss.employee.status.kind === 'working', 'what the subagent does is logged as the employee working');
boss.answers('Allow');
const childAsk = await app().ask('item/commandExecution/requestApproval', { kind: 'command', threadId: child, turnId: 'turn-child', itemId: 'cc1', command: "/bin/zsh -lc 'cat a.txt'" });
check(childAsk.result.decision === 'accept' && (boss.asked.at(-1) as { detail: string }).detail === 'cat a.txt', "a subagent's permission question comes to the same employee's desk");
app().notify('item/completed', item(child, message('cm', 'alpha'), 'turn-child'));
app().notify('item/started', activity(child, 'interacted', b.threadId, '/root'));
app().notify('turn/completed', turnDone(child, 'turn-child', 'completed', [message('cm', 'alpha')]));
await sleep(30);
check(boss.said.length === 0 && boss.finished.length === 0 && boss.employee.status.kind === 'working' && boss.xp() === 0, "what a subagent says is not spoken, its turn ending is not the employee's, and it reaching the parent ends nothing");
app().notify('item/started', activity(child, 'started', grandchild, '/root/read_a/count_lines'));
await until(() => boss.started.length === 2);
check(boss.started[1]!.id === grandchild && boss.started[1]!.parentId === child && boss.started[1]!.label === 'count lines', 'a subagent started by a subagent sits inside the first, and the parent was reported first');
app().notify('item/started', activity(b.threadId, 'completed', child, '/root/read_a'));
await until(() => boss.finished.length === 2);
check(boss.finished.join() === `${child},${grandchild}`, 'a subagent that completes takes everything under it with it');
app().notify('item/started', activity(b.threadId, 'started', 'thread-child-3', '/root/slow'));
await until(() => boss.started.length === 3);
app().notify('thread/closed', { threadId: 'thread-child-3' });
await until(() => boss.finished.length === 3);
check(boss.finished.at(-1) === 'thread-child-3', 'a subagent thread that closes is over');
app().notify('item/started', activity(b.threadId, 'started', 'thread-child-4', '/root/last'));
await until(() => boss.started.length === 4);
const crashing = app();
crashing.child.die(1);
await until(() => boss.finished.length === 4);
check(boss.finished.at(-1) === 'thread-child-4', 'a server that dies takes its subagents with it');
boss.session.stop();

console.log('\n# the server dies');
const alone = scripted(undefined, { mode: 'ask', alwaysAllow: [] });
const idleTwin = scripted(undefined, { mode: 'yolo', alwaysAllow: [] });
const w = await working(alone, 'a long task');
idleTwin.session.assign('quick one');
await until(() => idleTwin.employee.sessionId !== undefined && sentCount('turn/start') === 2);
const twinThread = idleTwin.employee.sessionId!;
app().notify('turn/started', { threadId: twinThread, turn: { id: `turn-${turns}` } });
app().notify('turn/completed', turnDone(twinThread, `turn-${turns}`, 'completed', [message('q', 'done')]));
await until(() => idleTwin.employee.status.kind === 'idle');
const doomed = app();
const serversBefore = servers.length;
doomed.child.die(1);
await until(() => servers.length === serversBefore + 1 && sentCount('turn/start') === 1);
const revived = app();
const revivedFrames = revived.received.map((r) => r.method);
check(revivedFrames.slice(0, 3).join() === 'initialize,initialized,account/login/start' && alone.logs.some((l) => l.startsWith('Codex stopped (code 1)')), 'the employee whose turn was running gets a new server and is told the old one stopped');
const restart = revived.last('thread/resume');
check(restart.threadId === w.threadId && restart.approvalPolicy === 'untrusted' && restart.sandbox === 'workspace-write' && restart.cwd === repo && restart.config.mcp_servers.office.url === 'http://127.0.0.1:1/mcp/scripted' && restart.config.mcp_servers.office.default_tools_approval_mode === 'approve', 'its thread is resumed with the mode, the sandbox and the office MCP server sent again');
check(revived.last('turn/start').input[0].text.startsWith('[The office restarted the program that runs you') && alone.employee.status.kind === 'working', 'and it carries on with its task, still working');
check(!revived.sent('thread/resume').some((r) => r.params.threadId === twinThread) && revived.sent('thread/start').length === 0, 'the employee that was idle is left alone, and no thread is started', JSON.stringify({ resumes: revived.sent('thread/resume'), starts: revived.sent('thread/start'), idleStatus: idleTwin.employee.status, aloneStatus: alone.employee.status }));
idleTwin.session.assign('one more thing');
await until(() => revived.sent('turn/start').length === 2);
const twinResume = revived.sent('thread/resume').find((r) => r.params.threadId === twinThread)?.params;
check(twinResume?.approvalPolicy === 'never' && twinResume.sandbox === 'danger-full-access' && !!twinResume.config.mcp_servers.office, 'the idle one is resumed when it is next used, with its own mode and the office MCP server again');
alone.session.stop();
idleTwin.session.stop();
await sleep(30);

console.log('\n# a server that keeps dying');
const loop = makeWorld();
const looper = scripted(undefined, { mode: 'ask', alwaysAllow: [] }, 'gpt-6-luna', loop.pool);
looper.session.assign('crash me');
for (let i = 1; i <= 3; i++) {
  await until(() => loop.servers.length === i && loop.servers[i - 1]!.sent('turn/start').length === 1);
  loop.servers[i - 1]!.child.die(1);
  await sleep(50);
}
await until(() => looper.employee.status.kind === 'error');
check(loop.servers.length === 3 && looper.employee.status.kind === 'error' && /Codex keeps stopping/.test(looper.employee.status.message), 'a server that dies three times in a minute is not started a fourth time, and the employee says why');
looper.session.stop();

console.log('\n# the sign-in');
const refresher = scripted();
const rw = await working(refresher, 'anything');
const refused = await app().ask('account/chatgptAuthTokens/refresh', { reason: 'unauthorized', previousAccountId: 'acct' });
check(refused.error?.message.includes('no longer accepts the sign-in') && refresher.logs.some((l) => l.includes('no longer accepts')), 'when Codex says its token was refused and the owner file holds the same one, there is nothing to give, and the owner is told');
ownerAccess = jwt(now / 1000 + 90000, 'acct');
const renewed = await app().ask('account/chatgptAuthTokens/refresh', { reason: 'unauthorized', previousAccountId: 'acct' });
check(renewed.result.accessToken === ownerAccess && renewed.result.chatgptAccountId === 'acct' && !JSON.stringify(renewed).includes('refresh-SECRET'), "when his own Codex has renewed it since, that one is handed over, and the refresh token never is");
const again = await app().ask('account/chatgptAuthTokens/refresh', { reason: 'unauthorized', previousAccountId: 'acct' });
check(!!again.error, 'and asking again for the same one is refused, so Codex cannot loop on a token that does not work');
void rw;
refresher.session.stop();

const signedOut = makeWorld(() => {
  throw new CodexSetupError('ChatGPT is not signed in on this Mac. Run codex login in a terminal, then ask me again.');
});
const nobody = scripted(undefined, { mode: 'ask', alwaysAllow: [] }, 'gpt-6-luna', signedOut.pool);
nobody.session.assign('hello');
await until(() => nobody.employee.status.kind === 'error');
check(signedOut.servers.length === 0 && nobody.employee.status.kind === 'error' && nobody.said.some((s) => s.includes('codex login')), 'with no sign-in no server is started, and the employee says what to do out loud');
nobody.session.stop();

const missing = makeWorld(ownerSignIn, () => {
  const child = new FakeChild();
  queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
  return child;
});
const noCodex = scripted(undefined, { mode: 'ask', alwaysAllow: [] }, 'gpt-6-luna', missing.pool);
noCodex.session.assign('hello');
await until(() => noCodex.employee.status.kind === 'error');
check(noCodex.employee.status.kind === 'error' && noCodex.employee.status.message === 'Codex is not installed on this Mac', 'a Mac without Codex says so');
noCodex.session.stop();

console.log('\n# models');
check(codexDefaultModel() === 'gpt-6-astra', 'before the list is asked for, a new employee starts on the default Codex had when this was written');
const listing = makeWorld();
let asks = 0;
const catalogFrom = (fake: FakeCodex) => {
  fake.handlers.set('model/list', (p) => {
    asks++;
    return p.cursor
      ? { data: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna', hidden: false, isDefault: false }, { id: 'old-secret', displayName: 'Old', hidden: true, isDefault: false }], nextCursor: null }
      : { data: [{ id: 'gpt-6-sol', displayName: 'GPT-6-Sol', hidden: false, isDefault: false }, { id: 'gpt-7-default', displayName: 'GPT-7', hidden: false, isDefault: true }], nextCursor: 'page-2' };
  });
};
const listingPromise = listModels(listing.pool);
await until(() => listing.servers.length === 1);
catalogFrom(listing.servers[0]!);
const catalog = await listingPromise;
check(catalog.kind === 'ready' && catalog.models.map((m) => `${m.id}=${m.label}`).join() === 'gpt-6-sol=GPT-6-Sol,gpt-7-default=GPT-7,gpt-6-luna=GPT-6-Luna' && catalog.defaultModel === 'gpt-7-default' && asks === 2, 'the list is every page Codex gives, without the hidden models, labelled with their names, and the default is the one Codex marks');
check(codexDefaultModel() === 'gpt-7-default', 'and the next hire starts on that default');
await until(() => listing.servers[0]!.child.dead);
await sleep(0);
check(listing.servers[0]!.child.stdinEnded, 'asking for the list starts a server and closes it again when nobody else uses it');
const empty = makeWorld();
const emptyPromise = listModels(empty.pool);
await until(() => empty.servers.length === 1);
empty.servers[0]!.handlers.set('model/list', () => ({ data: [], nextCursor: null }));
check((await emptyPromise).kind === 'error', 'a Codex with no models is an error the owner can read');
const notSignedIn = makeWorld(() => {
  throw new CodexSetupError('ChatGPT is not signed in on this Mac.');
});
check(await listModels(notSignedIn.pool).then(() => 'resolved', (e: Error) => e.message) === 'ChatGPT is not signed in on this Mac.', 'and a Mac that is not signed in rejects with the reason, which the office turns into an error');

console.log('\n# how the server is started');
const spec = codexCommand(codexPaths('/data/codex'), '/Users/owner', { PATH: '/bin', OPENAI_API_KEY: 'sk-x' });
const specEnv = spec.env as Record<string, string | undefined>;
check(spec.command === 'codex' && spec.args[0] === 'app-server' && spec.env.CODEX_HOME === '/data/codex/home' && spec.env.HOME === '/data/codex/empty-home' && specEnv.PATH === '/bin', 'the app-server runs on the office own CODEX_HOME and an empty HOME');
const joined = spec.args.join(' ');
check(['--disable apps', '--disable plugins', '--disable remote_plugin', '-c features.memories=false'].every((f) => joined.includes(f)), 'with connectors, plugins, the remote plugin catalog and memories off');
check(joined.includes('-c shell_environment_policy.set={HOME="/Users/owner"}'), 'and commands still get the real HOME');

console.log('\n# reasoning effort');
process.env.OFFICE_CODEX_EFFORT = 'low';
const effort = scripted();
await working(effort, 'cheap');
check(app().last('turn/start').effort === 'low', 'OFFICE_CODEX_EFFORT goes with every turn');
process.env.OFFICE_CODEX_EFFORT = 'enormous';
effort.session.interject('again', 'next');
await sleep(30);
delete process.env.OFFICE_CODEX_EFFORT;
effort.session.stop();

console.log('\n# stopping');
const stopper = scripted();
const sw = await working(stopper, 'long running');
app().handlers.set('thread/backgroundTerminals/list', () => ({ data: [{ processId: 'p-1', itemId: 'i', command: 'sleep 99', cwd: repo }] }));
const others = scripted();
await working(others, 'another employee');
const beforeStop = app().received.length;
stopper.session.stop();
await until(() => app().received.slice(beforeStop).some((r) => r.method === 'thread/backgroundTerminals/terminate'));
const stopFrame = app().received.slice(beforeStop);
check(stopFrame.some((r) => r.method === 'turn/interrupt' && r.params.turnId === sw.turnId) && stopFrame.some((r) => r.method === 'thread/backgroundTerminals/terminate' && r.params.processId === 'p-1'), 'stopping an employee whose turn is running interrupts it and ends its commands');
app().notify('turn/completed', turnDone(sw.threadId, sw.turnId, 'completed', [message('s', 'late')]));
await sleep(30);
check(stopper.employee.status.kind === 'working' && stopper.xp() === 0, 'and what the stopped session would have reported is ignored');
others.session.stop();

console.log('\n# one server for everyone');
const shared = makeWorld();
const s1 = scripted(undefined, { mode: 'ask', alwaysAllow: [] }, 'gpt-6-luna', shared.pool);
const s2 = scripted(undefined, { mode: 'ask', alwaysAllow: [] }, 'gpt-6-luna', shared.pool);
s1.session.assign('first');
s2.session.assign('second');
await until(() => shared.servers.length > 0 && shared.servers[0]!.sent('turn/start').length === 2);
check(shared.servers.length === 1 && shared.servers[0]!.sent('thread/start').length === 2, 'two employees share one server, each on a thread of its own');
s1.session.stop();
await sleep(50);
check(!shared.servers[0]!.child.dead, 'one letting go leaves it running for the other');
s2.session.stop();
await until(() => shared.servers[0]!.child.dead);
check(shared.servers[0]!.child.stdinEnded && shared.servers[0]!.child.signals.includes('SIGTERM'), 'when the last one lets go it is closed: its pipe ends and it is told to stop');

const early = makeWorld();
const hasty = scripted(undefined, { mode: 'ask', alwaysAllow: [] }, 'gpt-6-luna', early.pool);
hasty.session.assign('never mind');
hasty.session.stop();
await sleep(100);
check(early.servers.every((s) => s.child.dead || s.sent('turn/start').length === 0) && early.servers.every((s) => s.sent('turn/start').length === 0), 'a session stopped while the server was still starting never sends its task, and the server is closed');
finish();
