import { homedir } from 'node:os';
import { isAllow } from '../../../shared/permissions.ts';
import type { InterruptStyle, ModelCatalog, ModelId, PermissionPolicy, QuestionBody } from '../../../shared/protocol.ts';
import { logger } from '../debug.ts';
import { persona } from '../persona.ts';
import {
  SANDBOX_POLICIES,
  CodexSetupError,
  RpcError,
  anything,
  changedPaths,
  commandBody,
  describeItem,
  inheritedPolicy,
  insideBlock,
  mcpStatuses,
  modelPage,
  ownerCodexHome,
  patchBody,
  policyFor,
  readOwnerConfig,
  short,
  subagentLabel,
  terminals,
  threadLoaded,
  turnStarted,
  type Item,
  type Policy,
  type RequestId,
  type ServerRequest,
  type ThreadEvent,
} from './codex-protocol.ts';
import { CodexPool, ServerGone, codexPaths, spawnCodex, type CodexServer, type CodexUser } from './codex-server.ts';
import type { EmployeeSession, SessionFactory, SessionHost } from './types.ts';

const debug = logger('codex');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Codex ends an MCP call that has not answered in 5 minutes, and an owner can take longer. A day, as for Claude.
const OFFICE_MCP_TIMEOUT_S = 24 * 60 * 60;

// How long the office tools get to connect to a new thread before the first turn goes ahead without them.
const OFFICE_CONNECT_MS = 10_000;

// How long a hard stop waits for the interrupted turn to report that it ended.
const INTERRUPT_WAIT_MS = 5000;

// What Codex starts a new employee on until the office has asked it for the list and seen which model it marks as default.
const KNOWN_DEFAULT_MODEL = 'gpt-6-astra';

// Reasoning effort is the model's own unless this is set. It exists so a test can spend less of the ChatGPT plan.
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const configuredEffort = (): string | undefined => {
  const effort = process.env.OFFICE_CODEX_EFFORT;
  return effort && EFFORTS.has(effort) ? effort : undefined;
};

const RESTARTED = '[The office restarted the program that runs you, and it stopped what you were doing. Carry on with the task you were on.]';

// A bare "no" carries nothing to tell the model. Anything more the boss said does.
const BARE_NO = /^\s*(deny|no|n|nope|não|nao)\s*$/i;

// The office server every Codex thread connects to, named as host.mcp names it.
const officeServer = (mcp: SessionHost['mcp']) => ({
  mcp_servers: { [mcp.name]: { url: mcp.url, tool_timeout_sec: OFFICE_MCP_TIMEOUT_S, default_tools_approval_mode: 'approve' } },
});

const text = (t: string) => [{ type: 'text', text: t, text_elements: [] }];

export class CodexSession implements EmployeeSession, CodexUser {
  private readonly host: SessionHost;
  private readonly pool: CodexPool;
  private stopped = false;
  // Ends with the session, so a permission question left open is withdrawn from the owner's desk.
  private readonly life = new AbortController();
  // One operation at a time, in the order the owner asked for them. What Codex reports never waits in it.
  private chain: Promise<void> = Promise.resolve();

  // The thread this employee works in and the server it is loaded on. Unset before the first task, and after the server dies.
  private thread: { id: string; server: CodexServer } | undefined;
  // The turn Codex is running for this thread. Its id is known from the answer to turn/start or from the turn/started event.
  private turn: { id: string | undefined } | undefined;
  // Set while a hard stop waits for the turn it interrupted to report that it ended.
  private stopping: (() => void) | undefined;
  private task = '';
  private startedAt = 0;
  private lastSaid = '';
  // Codex streams assistant text as deltas before the complete item arrives. Keep the partial text for the activity line;
  // the complete item is still the single spoken/chat message so a sentence is not read aloud once per delta.
  private readonly messageDeltas = new Map<string, string>();
  private lastModel = '';
  // Rule changes that arrived between tasks. They go in front of the next task.
  private notices: string[] = [];
  // The owner's own settings, read when a session that follows them starts and again when the owner switches to them.
  private inherited: Policy | undefined;

  // Subagents by their thread id, with the thread that spawned each (null for the employee's own thread).
  private readonly subagents = new Map<string, string | null>();
  // The turn each thread of this employee is running, for a hard stop. The employee's own is in `turn`.
  private readonly childTurns = new Map<string, string>();
  // The files each patch item is about, for the approval that follows it.
  private readonly patches = new Map<string, string[]>();
  // Approvals waiting on the owner, so Codex resolving one, or the turn ending, can withdraw its card.
  private readonly open = new Map<RequestId, AbortController>();

  constructor(host: SessionHost, pool: CodexPool) {
    this.host = host;
    this.pool = pool;
  }

  assign(task: string) {
    this.beginTask(task);
    this.enqueue(() => this.startTurn(task));
  }

  interject(text: string, style: InterruptStyle) {
    const framed = `[Your boss walked over to your desk and said out loud]: ${text}`;
    const { kind } = this.host.employee.status;
    this.host.log(`Boss said: ${text}`);
    if (kind === 'idle' || kind === 'error') {
      this.beginTask(short(text, 80));
      this.enqueue(() => this.startTurn(framed));
    } else if (style === 'now') {
      this.enqueue(() => this.interruptThenSend(framed));
    } else {
      this.enqueue(() => this.steer(framed));
    }
  }

  // Every turn says which model and which permissions it runs on, so a change made between turns is in force from the next.
  setModel(model: ModelId) {
    debug(`model ${model} from the next turn`);
  }

  // The owner's settings are read again when the mode goes back to following them.
  permissionsChanged(_policy: PermissionPolicy) {
    this.inherited = undefined;
  }

  // A thread that is not loaded reads the rules when it is (resumed on the next task).
  rulesChanged(text: string) {
    if (!this.thread) return;
    const notice = `[Your boss changed the rules you work by. Acknowledge it in one sentence, then follow it]: ${text}`;
    const { kind } = this.host.employee.status;
    if (kind === 'idle' || kind === 'error') this.notices.push(notice);
    else this.enqueue(() => this.steer(notice));
  }

  private withNotices(text: string): string {
    const notices = this.notices.splice(0);
    return notices.length ? `${notices.join('\n\n')}\n\n${text}` : text;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.life.abort();
    this.abortApprovals();
    const { thread } = this;
    if (!thread || (!this.turn && !this.subagents.size)) return this.pool.release(this);
    // Something is still running for this employee. Stop it while the server is there to be told, then let go of the server.
    void this.abandon(thread).finally(() => this.pool.release(this));
  }

  private async abandon({ id, server }: { id: string; server: CodexServer }) {
    const stopThread = async (threadId: string, turnId: string | undefined) => {
      if (turnId) await server.call('turn/interrupt', { threadId, turnId }, anything).catch(() => undefined);
      await this.endTerminals(server, threadId);
    };
    const all = [stopThread(id, this.turn?.id), ...[...this.childTurns].map(([threadId, turnId]) => stopThread(threadId, turnId))];
    await Promise.race([Promise.allSettled(all), sleep(2000)]);
  }

  private beginTask(task: string) {
    this.task = task;
    this.startedAt = Date.now();
    this.host.setStatus({ kind: 'working', task, startedAt: this.startedAt });
    this.host.setActivity('Getting started');
  }

  // Runs an operation after the ones before it. If the server dies under it, it runs once more against the next one.
  private enqueue(operation: () => Promise<void>) {
    const attempt = async () => {
      try {
        await operation();
      } catch (e) {
        if (!(e instanceof ServerGone) || this.stopped) throw e;
        await operation();
      }
    };
    this.chain = this.chain.then(attempt).catch((e: unknown) => this.fail(e));
  }

  private policy(): Policy {
    return policyFor(this.host.permissions.mode, () => (this.inherited ??= inheritedPolicy(readOwnerConfig(this.pool.ownerHome))));
  }

  // The server with this employee's thread loaded on it: started, resumed or created as needed.
  private async ready(): Promise<{ server: CodexServer; threadId: string }> {
    const server = await this.pool.acquire(this);
    if (this.stopped) {
      this.pool.release(this);
      throw new Error('The session ended');
    }
    if (this.thread?.server === server) return { server, threadId: this.thread.id };
    return { server, threadId: await this.loadThread(server) };
  }

  private async loadThread(server: CodexServer): Promise<string> {
    const { employee, block, companyName, mcp } = this.host;
    const policy = this.policy();
    const inherit = this.host.permissions.mode === 'inherit';
    // What a thread is started with, and again whenever it is resumed: Codex does not keep the sandbox or the office server.
    const common = { cwd: block.cwd, model: this.host.model, approvalPolicy: policy.approval, sandbox: policy.sandbox, config: officeServer(mcp) };
    let id: string | undefined;
    if (employee.sessionId) {
      try {
        await this.pool.loadThread(inherit, () => server.call('thread/resume', { threadId: employee.sessionId, excludeTurns: true, ...common }, anything));
        id = employee.sessionId;
        // A resumed thread keeps the persona it started with, and with it the rules of that day.
        const rules = this.host.rules();
        if (rules) this.notices.push(`[These are the rules your boss has set for you now. They replace any earlier ones]:\n\n${rules}`);
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        this.host.log(`Could not pick up the earlier conversation (${e.message}). Starting a new one.`);
      }
    }
    if (!id) {
      // Read once per thread: a note saved while it runs shows up in the next one, and the persona stays put.
      const digest = this.host.memoryDigest();
      const rules = this.host.rules();
      debug(`thread start for ${employee.name}, memory digest:\n${digest || '(no notes yet)'}`);
      const developerInstructions = persona({ name: employee.name, company: companyName, block: block.name, digest, rules });
      const started = await this.pool.loadThread(inherit, () => server.call('thread/start', { developerInstructions, ...common }, threadLoaded));
      id = started.thread.id;
      this.host.setSessionId(id);
      debug(`thread ${id} instruction sources: ${JSON.stringify(started.instructionSources ?? [])}`);
    }
    this.thread = { id, server };
    this.pool.route(id, this);
    await this.waitForOffice(server, id);
    return id;
  }

  // The first turn should find ask_owner. Codex connects a thread's MCP servers after the thread starts.
  private async waitForOffice(server: CodexServer, threadId: string) {
    const { name } = this.host.mcp;
    const deadline = Date.now() + OFFICE_CONNECT_MS;
    for (;;) {
      const { data } = await server.call('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' }, mcpStatuses);
      debug(`thread ${threadId} mcp servers: ${data.map((s) => `${s.name}=${s.runtimeStatus}`).join(', ') || '(none)'}`);
      const status = data.find((s) => s.name === name)?.runtimeStatus;
      if (status === 'connected') return;
      if (status === 'failed' || status === 'authenticationRequired' || status === 'cancelled' || status === 'disabled') {
        throw new Error(`Codex could not connect to the office tools (${status})`);
      }
      if (Date.now() > deadline) {
        if (!status) throw new Error('Codex did not load the office tools');
        return this.host.log('The office tools were slow to connect, going ahead anyway');
      }
      await sleep(100);
    }
  }

  // Model and permissions go with every turn. A turn that overrides them keeps the override for the ones after it.
  private turnParams(threadId: string, message: string) {
    const policy = this.policy();
    const effort = configuredEffort();
    return {
      threadId,
      input: text(message),
      model: this.host.model,
      approvalPolicy: policy.approval,
      sandboxPolicy: SANDBOX_POLICIES[policy.sandbox],
      ...(effort ? { effort } : {}),
    };
  }

  private async startTurn(message: string) {
    const { server, threadId } = await this.ready();
    message = this.withNotices(message);
    this.lastSaid = '';
    // Set before the request goes out: a turn that fails at once can end before this function is resumed.
    this.turn = { id: undefined };
    const started = await server.call('turn/start', this.turnParams(threadId, message), turnStarted);
    if (this.turn) this.turn.id ??= started.turn.id;
  }

  // Codex takes the message at its next step, up to about half a minute later while a command runs. If the turn ended in the
  // meantime there is nothing to steer, so the message starts one.
  private async steer(message: string) {
    const { server, threadId } = await this.ready();
    if (this.turn?.id) {
      try {
        await server.call('turn/steer', { threadId, expectedTurnId: this.turn.id, input: text(message) }, anything);
        return;
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        debug(`steer refused (${e.message}), starting a turn instead`);
      }
    }
    if (this.host.employee.status.kind !== 'working') this.beginTask(short(message, 80));
    await this.startTurn(message);
  }

  // turn/interrupt ends the turn but not the commands it started, so those are ended too. Only then does the boss's message go in.
  private async interruptThenSend(message: string) {
    const { server, threadId } = await this.ready();
    if (this.turn?.id) {
      const ended = new Promise<void>((resolve) => (this.stopping = resolve));
      const running: [string, string][] = [[threadId, this.turn.id], ...this.childTurns];
      const results = await Promise.allSettled(running.map(([thread, turn]) => server.call('turn/interrupt', { threadId: thread, turnId: turn }, anything)));
      if (results.some((r) => r.status === 'fulfilled')) await Promise.race([ended, sleep(INTERRUPT_WAIT_MS)]);
      this.stopping = undefined;
    }
    for (const thread of [threadId, ...this.subagents.keys()]) await this.endTerminals(server, thread);
    this.turn = undefined;
    await this.startTurn(message);
  }

  private async endTerminals(server: CodexServer, threadId: string) {
    const listed = await server.call('thread/backgroundTerminals/list', { threadId }, terminals).catch(() => undefined);
    for (const t of listed?.data ?? []) {
      await server.call('thread/backgroundTerminals/terminate', { threadId, processId: t.processId }, anything).catch(() => undefined);
    }
  }

  // ---- what Codex reports

  onEvent(event: ThreadEvent) {
    if (this.stopped) return;
    const own = event.threadId === this.thread?.id;
    switch (event.method) {
      case 'turn/started':
        if (own) this.onTurnStarted(event.turn.id);
        else this.childTurns.set(event.threadId, event.turn.id);
        return;
      case 'item/agentMessage/delta':
        if (own) this.onAgentMessageDelta(event.itemId, event.delta);
        return;
      case 'turn/completed':
        if (own) this.onTurnCompleted(event.turn);
        else this.childTurns.delete(event.threadId);
        return;
      case 'item/started':
        return this.onItemStarted(event.threadId, event.item, own);
      case 'item/completed':
        return this.onItemCompleted(event.item, own);
      case 'thread/settings/updated': {
        const { model, effort } = event.threadSettings;
        if (own && model !== this.lastModel) {
          this.lastModel = model;
          this.host.log(`Model: ${model}${effort ? `, ${effort} effort` : ''}`);
        }
        return;
      }
      case 'thread/closed':
        return this.endSubagent(event.threadId);
      case 'serverRequest/resolved':
        this.open.get(event.requestId)?.abort();
        return;
      case 'error':
        debug(`error on ${event.threadId}: ${event.error.message}${event.willRetry ? ' (retrying)' : ''}`);
        return;
    }
  }

  private onTurnStarted(turnId: string) {
    // A turn that started on its own reopens the desk.
    if (this.host.employee.status.kind === 'idle') this.host.setStatus({ kind: 'working', task: this.task, startedAt: this.startedAt });
    this.turn ??= { id: undefined };
    this.turn.id ??= turnId;
  }

  private onTurnCompleted(turn: Extract<ThreadEvent, { method: 'turn/completed' }>['turn']) {
    const { host } = this;
    if (this.turn?.id && turn.id !== this.turn.id) return;
    this.turn = undefined;
    this.abortApprovals();
    // Interrupted on purpose: the boss's message starts the next turn, so this one ends nothing.
    if (this.stopping) {
      this.stopping();
      this.stopping = undefined;
      return;
    }
    switch (turn.status) {
      case 'completed': {
        const message = (turn.items ?? []).findLast((i): i is Extract<Item, { type: 'agentMessage' }> => i.type === 'agentMessage')?.text.trim() ?? this.lastSaid;
        host.taskCompleted();
        host.setActivity(short(message, 120) || 'Finished the task');
        host.setStatus({ kind: 'idle' });
        // The last message was already said when it completed. Do not say it twice.
        if (message && message !== this.lastSaid) host.said(short(message, 200));
        host.log(`Finished: ${short(message, 200) || this.task}`);
        return;
      }
      case 'failed':
        return this.reportError(turn.error?.message ?? 'The turn failed');
      case 'interrupted':
        host.setActivity('Stopped');
        host.setStatus({ kind: 'idle' });
        host.log('Stopped');
        return;
      case 'inProgress':
        return;
    }
  }

  private onItemStarted(threadId: string, item: Item, own: boolean) {
    const { host } = this;
    if (item.type === 'fileChange') this.patches.set(item.id, changedPaths(item));
    if (item.type === 'subAgentActivity') return this.onSubagentActivity(threadId, item, own);
    const line = describeItem(item, host.block.cwd);
    if (!line) return;
    host.setActivity(line);
    if (line !== 'Asking the boss') host.log(line); // the office logs the question itself
  }

  private onAgentMessageDelta(itemId: string, delta: string) {
    const text = (this.messageDeltas.get(itemId) ?? '') + delta;
    this.messageDeltas.set(itemId, text);
    if (text.trim()) this.host.setActivity(short(text, 120));
  }

  private onItemCompleted(item: Item, own: boolean) {
    if (item.type === 'fileChange') this.patches.delete(item.id);
    if (item.type === 'subAgentActivity') return;
    // What a subagent says is for its parent.
    if (item.type !== 'agentMessage' || !own) return;
    const message = item.text.trim();
    this.messageDeltas.delete(item.id);
    if (!message) return;
    this.lastSaid = message;
    this.host.said(message);
    this.host.log(`Said: ${message}`);
  }

  // The employee's own thread carries an item for each subagent it starts and one for the end of each. A subagent that starts
  // others carries theirs the same way, on its own thread, which is how one doll sits inside another.
  private onSubagentActivity(carrier: string, item: Extract<Item, { type: 'subAgentActivity' }>, own: boolean) {
    const id = item.agentThreadId;
    if (item.kind === 'started' && id !== this.thread?.id && !this.subagents.has(id)) {
      const parent = own ? null : carrier;
      this.subagents.set(id, parent);
      this.pool.route(id, this);
      this.host.subagentStarted({ id, parentId: parent, label: subagentLabel(item.agentPath), startedAt: Date.now() });
      this.host.setActivity('Briefing a helper');
      this.host.log('Briefing a helper');
    } else if ((item.kind === 'completed' || item.kind === 'interrupted') && this.subagents.has(id)) {
      this.endSubagent(id);
    }
  }

  // Ending a subagent ends everything it started, which is what the office does with the dolls.
  private endSubagent(id: string) {
    if (!this.subagents.has(id)) return;
    const ended = [id];
    for (const [child, parent] of this.subagents) if (parent !== null && ended.includes(parent)) ended.push(child);
    for (const gone of ended) {
      this.subagents.delete(gone);
      this.childTurns.delete(gone);
      this.pool.unroute(gone);
      this.host.subagentFinished(gone);
    }
  }

  private reportError(message: string) {
    debug('error:', message);
    this.host.setStatus({ kind: 'error', message });
    this.host.setActivity(`Something went wrong: ${short(message, 80)}`);
    this.host.log(`Error: ${message}`);
  }

  private fail(e: unknown) {
    if (this.stopped) return;
    const message = e instanceof Error ? e.message : String(e);
    this.turn = undefined;
    this.stopping?.();
    this.stopping = undefined;
    if (e instanceof CodexSetupError) this.host.said(message);
    this.reportError(message);
  }

  // The server died. What was loaded on it is gone, and so is every subagent. A turn that was running is picked up again
  // on the next one, from what the thread remembers of it.
  serverLost(reason: string) {
    if (this.stopped) return;
    this.thread = undefined;
    this.abortApprovals();
    for (const id of [...this.subagents.keys()]) this.endSubagent(id);
    this.childTurns.clear();
    this.patches.clear();
    if (!this.turn) return;
    this.turn = undefined;
    this.host.log(`${reason}. Starting it again to pick the task back up.`);
    this.enqueue(() => this.startTurn(RESTARTED));
  }

  notice(line: string) {
    this.host.log(line);
  }

  // ---- what Codex asks

  async onRequest(id: RequestId, request: ServerRequest): Promise<unknown> {
    const { host } = this;
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        return { decision: await this.decide(id, commandBody(request.command, request.reason, request.kind)) };
      case 'item/fileChange/requestApproval': {
        const paths = this.patches.get(request.itemId) ?? [];
        // A patch inside the block is what the employee is there to make. Ask mode still asks. So does a patch that wants more
        // than the sandbox gives it.
        if (host.permissions.mode !== 'ask' && !request.grantRoot && insideBlock(paths, host.block.cwd)) return { decision: 'accept' };
        return { decision: await this.decide(id, patchBody(paths, host.block.cwd, request.reason)) };
      }
      case 'mcpServer/elicitation/request':
        // The office's own tools are how the employee reaches the boss. They never ask, and nothing else is connected.
        return { action: request.serverName === host.mcp.name ? 'accept' : 'decline', content: null, _meta: null };
    }
  }

  private async decide(id: RequestId, body: QuestionBody): Promise<'accept' | 'decline'> {
    const controller = new AbortController();
    this.open.set(id, controller);
    let answer: string;
    try {
      answer = await this.host.ask(body, AbortSignal.any([controller.signal, this.life.signal]));
    } finally {
      this.open.delete(id);
    }
    if (isAllow(answer)) return 'accept';
    // Codex has nowhere to put the boss's reason, so it goes to the model as a message of its own.
    if (answer && !BARE_NO.test(answer)) this.enqueue(() => this.steer(`[Your boss did not allow that. They said]: ${answer}`));
    return 'decline';
  }

  private abortApprovals() {
    for (const controller of this.open.values()) controller.abort();
    this.open.clear();
  }
}

// ---- the office's one Codex

let root: string | undefined;

// The folder in the app's data folder where the office keeps everything Codex writes: its home, and the empty home.
export function setCodexRoot(dir: string) {
  root = dir;
}

let shared: CodexPool | undefined;

function sharedPool(): CodexPool {
  if (!root) throw new Error('The Codex folder is not set');
  const paths = codexPaths(root);
  shared ??= new CodexPool({ spawn: () => spawnCodex(paths, homedir()), home: paths.home, ownerHome: ownerCodexHome(process.env, homedir()) });
  return shared;
}

export const createCodexSession: SessionFactory = (host) => new CodexSession(host, sharedPool());

let listedDefault: ModelId | undefined;

// A new employee starts on what Codex marks as its default. Until the office has asked for the list, that is the default
// it had when this was written.
export const codexDefaultModel = (): ModelId => listedDefault ?? (KNOWN_DEFAULT_MODEL as ModelId);

export async function listModels(pool: CodexPool): Promise<ModelCatalog> {
  const models: { id: ModelId; label: string }[] = [];
  let defaultModel: ModelId | undefined;
  await pool.with(async (server) => {
    for (let cursor: string | undefined; ; ) {
      const page = await server.call('model/list', { cursor: cursor ?? null, limit: 100 }, modelPage);
      for (const m of page.data.filter((m) => !m.hidden)) {
        models.push({ id: m.id as ModelId, label: m.displayName });
        if (m.isDefault) defaultModel = m.id as ModelId;
      }
      cursor = page.nextCursor ?? undefined;
      if (!cursor) return;
    }
  });
  if (!models.length) return { kind: 'error', message: 'Codex offered no models' };
  listedDefault = defaultModel ?? models[0]!.id;
  return { kind: 'ready', models, defaultModel: listedDefault };
}

export const listCodexModels = () => listModels(sharedPool());
