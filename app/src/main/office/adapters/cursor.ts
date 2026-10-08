// Cursor employees run through `@cursor/sdk` in the block folder. Hiring waits on
// `Cursor.auth.login()`, which opens a browser and stores a key the SDK can use.
// The SDK has no permission callback, so ask, auto, and yolo become sandbox and
// auto-review flags. The office does not raise a card for a Cursor tool call.
// Plain Node: the check script runs this file.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InterruptStyle, ModelCatalog, ModelId, PermissionMode, PermissionPolicy } from '../../../shared/protocol.ts';
import { logger } from '../debug.ts';
import { persona } from '../persona.ts';
import type { EmployeeSession, SessionFactory, SessionHost } from './types.ts';

const debug = logger('cursor');
const nodeRequire = createRequire(import.meta.url);

const short = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const FALLBACK_MODEL = 'auto';

export type CursorApproval = 'allowlist' | 'unrestricted' | 'auto-review';

export type OwnerCursor = {
  approval: CursorApproval;
  shellPrefixes: string[];
  writePaths: string[];
};

const EMPTY_OWNER: OwnerCursor = { approval: 'allowlist', shellPrefixes: [], writePaths: [] };

type Posture = 'ask' | 'auto' | 'yolo';

export type CursorModel = { id: string; displayName: string; isDefault: boolean };

export type CursorStreamEvent =
  | { type: 'assistant'; text: string }
  | { type: 'tool'; callId: string; name: string; status: 'running' | 'completed' | 'error' };

export type CursorRunResult = { status: 'finished' | 'error' | 'cancelled'; result?: string; error?: string };

export type CursorRun = {
  stream(): AsyncIterable<CursorStreamEvent>;
  wait(): Promise<CursorRunResult>;
  cancel(): Promise<void>;
  steer?(text: string): Promise<'complete_delivered' | 'revert_to_followup'>;
};

export type CursorAgent = {
  agentId: string;
  send(text: string, model: string): Promise<CursorRun>;
  close(): void;
};

export type CursorOpen = {
  agentId?: string;
  cwd: string;
  model: string;
  mcpUrl: string;
  mcpName: 'office';
  sandbox: boolean;
  autoReview: boolean;
};

export type CursorGateway = {
  version(): string | null;
  authStatus(): Promise<'logged-in' | 'logged-out'>;
  login(open: (url: string) => void | Promise<void>): Promise<void>;
  listModels(): Promise<CursorModel[]>;
  openAgent(spec: CursorOpen): Promise<CursorAgent>;
};

type Turn = { followUp?: string; esc?: boolean };

const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function sdkVersion(): string | null {
  try {
    // The package exports map does not expose package.json, so walk up from the entry file.
    let dir = dirname(nodeRequire.resolve('@cursor/sdk') as string);
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (pkg.name === '@cursor/sdk' && pkg.version) return pkg.version;
      } catch {
        // Not this directory.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

async function loadSdk() {
  return import('@cursor/sdk');
}

const realGateway: CursorGateway = {
  version: sdkVersion,
  async authStatus() {
    const { Cursor } = await loadSdk();
    const status = await Cursor.auth.status();
    return status.status;
  },
  async login(open) {
    const { Cursor } = await loadSdk();
    await Cursor.auth.login({ openBrowser: open, apiKeyName: 'Online Office' });
  },
  async listModels() {
    const { Cursor } = await loadSdk();
    const models = await Cursor.models.list();
    return models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      isDefault: model.variants?.some((variant) => variant.isDefault) ?? false,
    }));
  },
  async openAgent(spec) {
    const { Agent } = await loadSdk();
    const options = {
      model: { id: spec.model },
      mcpServers: { [spec.mcpName]: { type: 'http' as const, url: spec.mcpUrl } },
      local: {
        cwd: spec.cwd,
        sandboxOptions: { enabled: spec.sandbox },
        autoReview: spec.autoReview,
      },
    };
    const agent = spec.agentId ? await Agent.resume(spec.agentId, options) : await Agent.create(options);
    return {
      agentId: agent.agentId,
      async send(text, model) {
        const run = await agent.send(text, { model: { id: model } });
        const wrapped: CursorRun = {
          async *stream() {
            for await (const update of run.stream()) {
              if (update.type === 'assistant') {
                const text = update.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
                if (text) yield { type: 'assistant', text };
              } else if (update.type === 'tool_call') {
                yield { type: 'tool', callId: update.call_id, name: update.name, status: update.status };
              }
            }
          },
          async wait() {
            const result = await run.wait();
            return { status: result.status, result: result.result, error: result.error?.message };
          },
          cancel: () => run.cancel(),
        };
        if (run.steer) wrapped.steer = (text) => run.steer!(text);
        return wrapped;
      },
      close: () => agent.close(),
    };
  },
};

let gateway: CursorGateway = realGateway;

export const cursorGateway = (): CursorGateway => gateway;

export function setCursorGateway(next?: CursorGateway) {
  gateway = next ?? realGateway;
}

export function readOwnerCursor(text: string | undefined): OwnerCursor {
  if (!text) return EMPTY_OWNER;
  try {
    const parsed = object(JSON.parse(text));
    const approval = parsed.approvalMode;
    const mode: CursorApproval = approval === 'unrestricted' || approval === 'auto-review' || approval === 'allowlist' ? approval : 'allowlist';
    const allow = object(parsed.permissions).allow;
    const shellPrefixes: string[] = [];
    const writePaths: string[] = [];
    if (Array.isArray(allow)) {
      for (const entry of allow) {
        if (typeof entry !== 'string') continue;
        const shell = /^Shell\((.+)\)$/.exec(entry);
        if (shell?.[1]) shellPrefixes.push(shell[1]);
        const write = /^Write\((.+)\)$/.exec(entry);
        if (write?.[1]) writePaths.push(write[1]);
      }
    }
    return { approval: mode, shellPrefixes, writePaths };
  } catch {
    return EMPTY_OWNER;
  }
}

function loadOwnerCursor(): OwnerCursor {
  try {
    return readOwnerCursor(readFileSync(join(homedir(), '.cursor', 'cli-config.json'), 'utf8'));
  } catch {
    return EMPTY_OWNER;
  }
}

export function postureFor(mode: PermissionMode, owner: OwnerCursor): Posture {
  if (mode === 'yolo') return 'yolo';
  if (mode === 'auto') return 'auto';
  if (mode === 'ask') return 'ask';
  if (owner.approval === 'unrestricted') return 'yolo';
  if (owner.approval === 'auto-review') return 'auto';
  return 'ask';
}

export function ownerAllowsCommand(command: string, owner: OwnerCursor): boolean {
  const cmd = command.trim();
  return owner.shellPrefixes.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `));
}

// Ask keeps writes in the project folder. Auto lets Cursor's reviewer decide.
// Yolo runs tools. The SDK cannot put a card on the owner's desk.
export function localFlags(mode: PermissionMode, owner: OwnerCursor): { sandbox: boolean; autoReview: boolean } {
  const posture = postureFor(mode, owner);
  if (posture === 'yolo') return { sandbox: false, autoReview: false };
  if (posture === 'auto') return { sandbox: false, autoReview: true };
  return { sandbox: true, autoReview: false };
}

let listedDefault: ModelId | undefined;

export function catalogFrom(models: CursorModel[]): ModelCatalog {
  if (!models.length) return { kind: 'error', message: 'Cursor offered no models. Log in with Cursor, then ask again.' };
  const want = process.env.OFFICE_CURSOR_MODEL;
  const ids = models.map((model) => model.id);
  const preferred = models.find((model) => model.isDefault)?.id ?? models[0]!.id;
  const defaultModel = (want && ids.includes(want) ? want : preferred) as ModelId;
  listedDefault = defaultModel;
  return {
    kind: 'ready',
    models: models.map((model) => ({ id: model.id as ModelId, label: model.displayName || model.id })),
    defaultModel,
  };
}

export const cursorDefaultModel = (): ModelId => (process.env.OFFICE_CURSOR_MODEL as ModelId | undefined) ?? listedDefault ?? (FALLBACK_MODEL as ModelId);

export async function detectCursor(): Promise<string | null> {
  return cursorGateway().version();
}

export async function cursorStatus() {
  const version = cursorGateway().version();
  if (!version) return { kind: 'missing' as const };
  try {
    const auth = await cursorGateway().authStatus();
    return auth === 'logged-in' ? { kind: 'ready' as const, version } : { kind: 'needs_login' as const, version };
  } catch (err) {
    debug('auth status failed:', message(err));
    return { kind: 'needs_login' as const, version };
  }
}

export async function loginCursor(open: (url: string) => void | Promise<void>) {
  await cursorGateway().login(open);
  return cursorStatus();
}

export async function listCursorModels(): Promise<ModelCatalog> {
  return catalogFrom(await cursorGateway().listModels());
}

export async function configureCursorStore(rootDir: string): Promise<void> {
  const { Cursor, JsonlLocalAgentStore } = await loadSdk();
  Cursor.configure({ local: { store: new JsonlLocalAgentStore(rootDir) } });
}

const absorb = (soFar: string, text: string) => {
  if (!soFar) return text;
  if (text.startsWith(soFar)) return text;
  if (soFar.endsWith(text)) return soFar;
  return soFar + text;
};

const isSubagent = (name: string) => name === 'task' || name === 'Task';

export class CursorSession implements EmployeeSession {
  private agent?: CursorAgent;
  private starting?: Promise<CursorAgent>;
  private turn?: Turn;
  private run?: CursorRun;
  private stopped = false;
  private fresh: boolean;
  private policy: PermissionPolicy;
  private owner: OwnerCursor;
  private notices: string[] = [];
  private recreate = false;
  private subagents = new Set<string>();

  private readonly host: SessionHost;
  private readonly agents: CursorGateway;
  private readonly readOwner: () => OwnerCursor;

  constructor(host: SessionHost, agents: CursorGateway = cursorGateway(), readOwner: () => OwnerCursor = loadOwnerCursor) {
    this.host = host;
    this.agents = agents;
    this.readOwner = readOwner;
    this.policy = host.permissions;
    this.owner = readOwner();
    this.fresh = !host.employee.sessionId;
  }

  assign(task: string) {
    this.begin(task);
    void this.runTurns(task);
  }

  interject(text: string, style: InterruptStyle) {
    const framed = `[Your boss walked over to your desk and said out loud]: ${text}`;
    const { kind } = this.host.employee.status;
    this.host.log(`Boss said: ${text}`);
    if (kind === 'idle' || kind === 'error') {
      this.begin(short(text, 80));
      void this.runTurns(framed);
    } else if (style === 'now') {
      this.cutIn(framed);
    } else {
      this.steer(framed);
    }
  }

  setModel(_model: ModelId) {}

  permissionsChanged(policy: PermissionPolicy) {
    const before = localFlags(this.policy.mode, this.owner);
    this.policy = policy;
    this.owner = this.readOwner();
    const after = localFlags(policy.mode, this.owner);
    if (before.sandbox === after.sandbox && before.autoReview === after.autoReview) return;
    this.recreate = true;
    if (this.agent) this.host.log(`${policy.mode} applies from the next task`);
  }

  // Esc on the terminal: drop the step that is running. Nothing follows it.
  interrupt() {
    if (!this.turn || !this.run) return;
    this.turn.esc = true;
    void this.run.cancel();
  }

  rulesChanged(text: string) {
    if (!this.agent) return;
    const notice = `[Your boss changed the rules you work by. Acknowledge it in one sentence, then follow it]: ${text}`;
    if (this.turn) this.steer(notice);
    else this.notices.push(notice);
  }

  stop() {
    this.stopped = true;
    void this.run?.cancel();
    this.agent?.close();
    this.agent = undefined;
    for (const id of this.subagents) this.host.subagentFinished(id);
    this.subagents.clear();
  }

  private begin(task: string) {
    this.host.setStatus({ kind: 'working', task, startedAt: Date.now() });
    this.host.setActivity('Getting started');
  }

  private cutIn(text: string) {
    if (!this.turn || !this.run) return this.steer(text);
    this.turn.followUp = text;
    void this.run.cancel();
  }

  private steer(text: string) {
    const run = this.run;
    if (!this.turn || !run?.steer) {
      this.notices.push(text);
      return;
    }
    void run.steer(text).then(
      (outcome) => {
        if (outcome === 'revert_to_followup' && this.turn) this.turn.followUp = text;
      },
      (err: unknown) => debug('steer failed:', message(err)),
    );
  }

  private async runTurns(first: string) {
    let next: string | undefined = first;
    while (next !== undefined && !this.stopped) next = await this.oneTurn(next);
    this.turn = undefined;
    this.run = undefined;
  }

  private async oneTurn(text: string): Promise<string | undefined> {
    const turn: Turn = {};
    this.turn = turn;
    try {
      const agent = await this.ensureAgent();
      if (this.stopped) return undefined;
      const prompt = this.compose(text);
      const run = await agent.send(prompt, this.host.model);
      this.run = run;
      let spoken = '';
      for await (const event of run.stream()) {
        if (this.stopped) return undefined;
        if (event.type === 'assistant') {
          spoken = absorb(spoken, event.text);
          this.host.setActivity(short(event.text, 80) || 'Working');
        } else if (event.status === 'running') {
          this.host.setActivity(event.name);
          if (isSubagent(event.name) && !this.subagents.has(event.callId)) {
            this.subagents.add(event.callId);
            this.host.subagentStarted({ id: event.callId, parentId: null, label: event.name, startedAt: Date.now() });
          }
        } else if (this.subagents.has(event.callId)) {
          this.subagents.delete(event.callId);
          this.host.subagentFinished(event.callId);
        }
      }
      if (this.stopped) return undefined;
      const done = await run.wait();
      if (this.stopped) return undefined;
      if (done.status === 'cancelled') {
        if (turn.followUp) return turn.followUp;
        if (turn.esc) {
          this.host.taskInterrupted();
          return undefined;
        }
        this.host.setActivity('Stopped');
        this.host.setStatus({ kind: 'idle' });
        this.host.log('Stopped');
        return undefined;
      }
      if (done.status === 'error') {
        const why = done.error || 'Cursor stopped';
        this.host.setStatus({ kind: 'error', message: why });
        this.host.log(why);
        return undefined;
      }
      const reply = spoken.trim() || done.result?.trim() || '';
      if (reply) this.host.said(short(reply, 200));
      if (turn.followUp) return turn.followUp;
      this.host.taskCompleted();
      this.host.setActivity(short(reply, 120) || 'Finished the task');
      this.host.setStatus({ kind: 'idle' });
      this.host.log(`Finished: ${short(reply, 200) || text}`);
      return undefined;
    } catch (err) {
      if (this.stopped) return undefined;
      const why = message(err);
      debug('turn failed:', why);
      this.host.setStatus({ kind: 'error', message: why });
      this.host.log(why);
      return undefined;
    }
  }

  private async ensureAgent(): Promise<CursorAgent> {
    if (this.agent && !this.recreate) return this.agent;
    this.starting ??= this.open().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private flags() {
    this.owner = this.readOwner();
    return localFlags(this.policy.mode, this.owner);
  }

  private async open(): Promise<CursorAgent> {
    const flags = this.flags();
    if (this.recreate && this.agent) {
      this.agent.close();
      this.agent = undefined;
    }
    this.recreate = false;
    const agentId = this.host.employee.sessionId;
    const spec = {
      cwd: this.host.block.cwd,
      model: this.host.model,
      mcpUrl: this.host.mcp.url,
      mcpName: this.host.mcp.name,
      sandbox: flags.sandbox,
      autoReview: flags.autoReview,
    };
    try {
      const agent = await this.agents.openAgent({ ...spec, ...(agentId && { agentId }) });
      this.agent = agent;
      this.host.setSessionId(agent.agentId);
      this.host.log(`Session started ${agent.agentId}`);
      return agent;
    } catch (err) {
      if (!agentId) throw err;
      this.fresh = true;
      this.host.log(`Could not resume ${agentId}, starting a new conversation`);
      const agent = await this.agents.openAgent(spec);
      this.agent = agent;
      this.host.setSessionId(agent.agentId);
      this.host.log(`Session started ${agent.agentId}`);
      return agent;
    }
  }

  private compose(text: string): string {
    const body = [...this.notices.splice(0), text].join('\n\n');
    if (!this.fresh) return body;
    this.fresh = false;
    const intro = persona({
      name: this.host.employee.name,
      company: this.host.companyName,
      block: this.host.block.name,
      role: this.host.employee.role,
      digest: this.host.memoryDigest(),
      rules: this.host.rules(),
    });
    return `${intro}\n\n${body}`;
  }
}

export const createCursorSession: SessionFactory = (host) => new CursorSession(host);
