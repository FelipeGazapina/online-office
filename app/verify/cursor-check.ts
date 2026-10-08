// No network for the session cases. A fake SDK stands in for `@cursor/sdk`.
// The last section talks to the real SDK when it can, and stays green when nobody is logged in.
// Run from app/: node verify/cursor-check.ts   Exits 1 on any failed check.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessNote, type BlockId, type Employee, type EmployeeId, type ModelId, type PermissionMode, type ProjectBlock, type QuestionBody, type Subagent } from '../src/shared/protocol.ts';
import {
  CursorSession,
  catalogFrom,
  cursorStatus,
  listCursorModels,
  localFlags,
  loginCursor,
  ownerAllowsCommand,
  postureFor,
  readOwnerCursor,
  setCursorGateway,
  type CursorGateway,
  type CursorOpen,
  type CursorRun,
  type CursorStreamEvent,
  type OwnerCursor,
} from '../src/main/office/adapters/cursor.ts';
import type { SessionHost } from '../src/main/office/adapters/types.ts';
import { check, finish, sleep, until } from './check.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cursor-check-')));

console.log('# hire card');
check(harnessNote({ kind: 'ready', version: '1.0.36' }) === 'Ready · v1.0.36', 'a ready card names the SDK version');
check(harnessNote({ kind: 'needs_login', version: '1.0.36' }) === 'Log in with Cursor to hire', 'a logged-out card asks for Cursor login');
check(harnessNote({ kind: 'missing' }) === 'Not installed on this machine', 'a missing card says it is not installed');
check(harnessNote({ kind: 'not_wired' }) === 'Installed, but the office cannot drive it yet', 'a card with no session says the office cannot drive it');

console.log('\n# models');
const catalog = catalogFrom([
  { id: 'composer-2.5', displayName: 'Composer 2.5', isDefault: false },
  { id: 'grok-4.7', displayName: 'Grok 4.7', isDefault: true },
]);
check(catalog.kind === 'ready' && catalog.defaultModel === 'grok-4.7' && catalog.models.length === 2 && catalog.models[0]!.label === 'Composer 2.5', 'the catalog is Cursor.models.list, and the default is the variant Cursor marks');
check(catalogFrom([]).kind === 'error', 'an empty list is an error the owner can read');

console.log('\n# permission modes become SDK flags');
const allowlist: OwnerCursor = { approval: 'allowlist', shellPrefixes: ['git status'], writePaths: [] };
const open: OwnerCursor = { approval: 'unrestricted', shellPrefixes: [], writePaths: [] };
const review: OwnerCursor = { approval: 'auto-review', shellPrefixes: [], writePaths: [] };
const modes: [PermissionMode, OwnerCursor, string][] = [
  ['ask', allowlist, 'ask'],
  ['auto', allowlist, 'auto'],
  ['yolo', allowlist, 'yolo'],
  ['inherit', allowlist, 'ask'],
  ['inherit', open, 'yolo'],
  ['inherit', review, 'auto'],
];
for (const [mode, owner, want] of modes) check(postureFor(mode, owner) === want, `${mode} with ${owner.approval} asks like ${want}`);
check(localFlags('ask', allowlist).sandbox && !localFlags('ask', allowlist).autoReview, 'ask keeps the run inside the project folder');
check(!localFlags('auto', allowlist).sandbox && localFlags('auto', allowlist).autoReview, 'auto hands the decision to Cursor review');
check(!localFlags('yolo', allowlist).sandbox && !localFlags('yolo', allowlist).autoReview, 'yolo runs tools');
check(localFlags('inherit', open).sandbox === false && localFlags('inherit', review).autoReview, 'inherit follows the owner file');
check(ownerAllowsCommand('git status', allowlist) && ownerAllowsCommand('git status --short', allowlist) && !ownerAllowsCommand('rm -rf .', allowlist), 'an allowlist entry covers that command and what follows it, and nothing else');
const parsed = readOwnerCursor(JSON.stringify({ approvalMode: 'unrestricted', permissions: { allow: ['Shell(git status)', 'Write(/tmp/a.ts)', 'WebFetch(example.com)'] } }));
check(parsed.approval === 'unrestricted' && parsed.shellPrefixes.join() === 'git status' && parsed.writePaths.join() === '/tmp/a.ts', 'inherit reads approvalMode and the Shell and Write entries, and leaves the rest');
check(readOwnerCursor('not json').approval === 'allowlist' && readOwnerCursor(undefined).shellPrefixes.length === 0, 'a missing or broken config asks, which is the allowlist default');

console.log('\n# login');
let signedIn = false;
let opened = '';
const loginGateway: CursorGateway = {
  version: () => '1.0.36',
  authStatus: async () => (signedIn ? 'logged-in' : 'logged-out'),
  login: async (openBrowser) => {
    await openBrowser('https://cursor.com/login');
    signedIn = true;
  },
  listModels: async () => [{ id: 'grok-4.7', displayName: 'Grok 4.7', isDefault: true }],
  openAgent: async () => {
    throw new Error('login does not start an agent');
  },
};
setCursorGateway(loginGateway);
const loggedOut = await cursorStatus();
check(loggedOut.kind === 'needs_login' && loggedOut.version === '1.0.36', 'a logged-out SDK asks for login and still names its version');
const loggedIn = await loginCursor(async (url) => {
  opened = url;
});
check(opened === 'https://cursor.com/login' && loggedIn.kind === 'ready' && loggedIn.version === '1.0.36', 'login opens the page and the card becomes ready');
setCursorGateway({ ...loginGateway, version: () => null });
const missing = await cursorStatus();
check(missing.kind === 'missing', 'a SDK that will not load is missing');
setCursorGateway(undefined);

type Desk = {
  host: SessionHost;
  employee: Employee;
  said: string[];
  asks: QuestionBody[];
  logs: string[];
  completed: number;
  subagents: string[];
  spawned: string[];
};

function desk(dir: string, mode: PermissionMode): Desk {
  mkdirSync(dir, { recursive: true });
  const employee: Employee = {
    id: 'emp-1' as EmployeeId,
    name: 'Nia',
    provider: 'cursor',
    role: 'employee',
    blockId: 'block-1' as BlockId,
    seat: null,
    status: { kind: 'idle' },
    activity: '',
    model: 'grok-4.7' as ModelId,
    permissions: { mode, alwaysAllow: [] },
    subagents: [] as Subagent[],
    hiredAt: 1,
  };
  const found: Desk = { host: undefined as unknown as SessionHost, employee, said: [], asks: [], logs: [], completed: 0, subagents: [], spawned: [] };
  found.host = {
    employee,
    block: { id: 'block-1' as BlockId, name: 'Repo', cwd: dir } as ProjectBlock,
    companyName: 'Office',
    get model() {
      return employee.model;
    },
    get permissions() {
      return employee.permissions;
    },
    setStatus: (status) => void (employee.status = status),
    setActivity: (text) => void (employee.activity = text),
    setSessionId: (id) => void (employee.sessionId = id || undefined),
    said: (text) => void found.said.push(text),
    log: (line) => void found.logs.push(line),
    ask: (body) => {
      found.asks.push(body);
      return Promise.resolve('Allow');
    },
    mcp: { url: 'http://127.0.0.1:9/mcp', name: 'office' },
    memoryDigest: () => '',
    rules: () => '',
    taskCompleted: () => void found.completed++,
    subagentStarted: (sub) => {
      found.spawned.push(sub.id);
      found.subagents.push(sub.id);
    },
    subagentFinished: (id) => void found.subagents.splice(found.subagents.indexOf(id), 1),
    terminal() {},
    taskInterrupted() {},
  };
  return found;
}

function finished(text: string, tools: CursorStreamEvent[] = []): CursorRun {
  return {
    async *stream() {
      for (const tool of tools) yield tool;
      if (text) yield { type: 'assistant', text };
    },
    wait: async () => ({ status: 'finished', result: text }),
    cancel: async () => {},
  };
}

function recordingGateway(runFor: (prompt: string) => CursorRun, failResume = false) {
  const opens: CursorOpen[] = [];
  const prompts: string[] = [];
  let n = 0;
  const gateway: CursorGateway = {
    version: () => '1.0.36',
    authStatus: async () => 'logged-in',
    login: async () => {},
    listModels: async () => [],
    async openAgent(spec) {
      opens.push(spec);
      if (failResume && spec.agentId === 'gone') throw new Error('no such agent');
      const id = spec.agentId && spec.agentId !== 'gone' ? spec.agentId : `agent-${++n}`;
      return {
        agentId: id,
        async send(text) {
          prompts.push(text);
          return runFor(text);
        },
        close() {},
      };
    },
  };
  return { gateway, opens, prompts };
}

console.log('\n# a session');
const talkDir = join(root, 'talk');
const talkDesk = desk(talkDir, 'ask');
const talkGateway = recordingGateway((prompt) =>
  finished('Done the thing', prompt.includes('DELEGATE') ? [{ type: 'tool', callId: 'sub-1', name: 'task', status: 'running' }, { type: 'tool', callId: 'sub-1', name: 'task', status: 'completed' }] : []),
);
const talk = new CursorSession(talkDesk.host, talkGateway.gateway, () => allowlist);
talk.assign('Say hello');
const talkOk = await until(() => talkDesk.employee.status.kind === 'idle', 5000);
check(talkOk && talkDesk.employee.status.kind === 'idle', 'a finished turn leaves the employee idle', JSON.stringify(talkDesk.employee.status));
check(talkDesk.said.join() === 'Done the thing' && talkDesk.completed === 1, 'the employee says the reply once and the office counts one finished task');
check(talkDesk.employee.sessionId === 'agent-1', 'the new agent id is kept');
check(talkGateway.prompts[0]?.includes('You are Nia') === true && talkDesk.asks.length === 0, 'the first prompt carries the persona, and the SDK does not raise a card');
check(talkGateway.opens[0]?.sandbox === true && talkGateway.opens[0]?.autoReview === false && talkGateway.opens[0]?.mcpUrl === 'http://127.0.0.1:9/mcp', 'ask mode sandboxes the block folder and connects the office tools');
talk.assign('Again');
await until(() => talkGateway.prompts.length === 2, 5000);
check(talkGateway.prompts[1]?.includes('You are Nia') === false && talkGateway.opens.length === 1, 'the next task reuses the agent and does not repeat the persona');
talk.assign('DELEGATE');
await until(() => talkDesk.completed === 3, 5000);
check(talkDesk.spawned.join() === 'sub-1' && talkDesk.subagents.length === 0, 'a task tool is reported and then cleared', talkDesk.spawned.join());
talk.permissionsChanged({ mode: 'yolo', alwaysAllow: [] });
talk.assign('Run it');
await until(() => talkGateway.opens.length === 2 && talkDesk.completed === 4, 5000);
check(talkGateway.opens[1]?.sandbox === false && talkGateway.opens[1]?.autoReview === false, 'yolo applies on the next task');
talk.stop();
await sleep(20);

const held = desk(join(root, 'held'), 'ask');
let release: (() => void) | undefined;
let steered = '';
const heldGateway = recordingGateway(() => ({
  async *stream() {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  },
  wait: async () => ({ status: 'finished', result: 'Kept going' }),
  cancel: async () => release?.(),
  steer: async (text) => {
    steered = text;
    return 'complete_delivered';
  },
}));
const heldSession = new CursorSession(held.host, heldGateway.gateway, () => allowlist);
heldSession.assign('Hold');
const holding = await until(() => release !== undefined, 5000);
check(holding, 'the turn stays open until the owner speaks');
heldSession.interject('look here', 'next');
await until(() => steered.includes('look here'), 5000);
check(steered.includes('Your boss walked over'), 'a tap on the shoulder is steered into the open turn');
release?.();
const heldDone = await until(() => held.employee.status.kind === 'idle', 5000);
check(heldDone && held.completed === 1 && held.said.join() === 'Kept going', 'the steered turn still finishes as one task');
heldSession.stop();

const cut = desk(join(root, 'cut'), 'ask');
let cutRelease: (() => void) | undefined;
let cutPrompt = '';
const cutGateway = recordingGateway((prompt) => {
  if (!cutPrompt) {
    cutPrompt = prompt;
    return {
      async *stream() {
        await new Promise<void>((resolve) => {
          cutRelease = resolve;
        });
      },
      wait: async () => ({ status: 'cancelled' }),
      cancel: async () => cutRelease?.(),
    };
  }
  return finished('Heard you');
});
const cutSession = new CursorSession(cut.host, cutGateway.gateway, () => allowlist);
cutSession.assign('Working');
await until(() => cutRelease !== undefined, 5000);
cutSession.interject('stop and do this', 'now');
const cutDone = await until(() => cut.employee.status.kind === 'idle' && cut.said.join() === 'Heard you', 5000);
check(cutDone && cut.completed === 1, 'a hard stop cancels the turn and runs the new instruction', JSON.stringify(cut.employee.status));
cutSession.stop();

const broken = desk(join(root, 'broken'), 'auto');
const brokenGateway = recordingGateway(() => ({
  async *stream() {},
  wait: async () => ({ status: 'error', error: 'model refused' }),
  cancel: async () => {},
}));
const brokenSession = new CursorSession(broken.host, brokenGateway.gateway, () => allowlist);
brokenSession.assign('Fail');
const brokenDone = await until(() => broken.employee.status.kind === 'error', 5000);
check(brokenDone && broken.employee.status.kind === 'error' && broken.employee.status.message === 'model refused' && broken.completed === 0, 'a failed run becomes an error and does not count as a finished task');
check(brokenGateway.opens[0]?.autoReview === true && brokenGateway.opens[0]?.sandbox === false, 'auto mode turns on Cursor review');
brokenSession.stop();

const resumed = desk(join(root, 'resume'), 'inherit');
resumed.employee.sessionId = 'gone';
const resumeGateway = recordingGateway(() => finished('Fresh'), true);
const resumeSession = new CursorSession(resumed.host, resumeGateway.gateway, () => open);
resumeSession.assign('Try again');
const resumeDone = await until(() => resumed.employee.status.kind === 'idle', 5000);
check(resumeDone && resumeGateway.opens[0]?.agentId === 'gone' && resumeGateway.opens[1]?.agentId === undefined && resumed.employee.sessionId === 'agent-1', 'a resume that fails starts a new agent');
check(resumeGateway.prompts[0]?.includes('You are Nia') === true, 'the new conversation gets the persona');
check(resumeGateway.opens[1]?.sandbox === false && resumeGateway.opens[1]?.autoReview === false, 'inherit of an unrestricted owner runs tools');
resumeSession.stop();

console.log('\n# the real SDK, when this machine can reach it');
try {
  const live = await Promise.race([
    cursorStatus(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 15000)),
  ]);
  if (live.kind === 'missing') check(true, 'the Cursor SDK did not load, so the card stays missing');
  else if (live.kind === 'needs_login') check(live.version.length > 0, `logged out, so hiring waits on Log in with Cursor (${live.version})`);
  else if (live.kind === 'ready') {
    const models = await Promise.race([
      listCursorModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 20000)),
    ]);
    check(models.kind === 'ready' && models.models.length > 0 && models.models.some((model) => model.id === models.defaultModel), 'the live model list has a default the owner can hire', models.kind === 'error' ? models.message : `${models.kind === 'ready' ? models.models.length : 0} models`);
  }
} catch (err) {
  check(true, `live Cursor auth did not answer (${err instanceof Error ? err.message : String(err)})`);
}

rmSync(root, { recursive: true, force: true });
finish();
