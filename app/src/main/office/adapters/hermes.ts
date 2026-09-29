import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { SHELL_TOOL, isAllow } from '../../../shared/permissions.ts';
import type { Employee, InterruptStyle, ModelCatalog, ModelId, PermissionPolicy, QuestionBody } from '../../../shared/protocol.ts';
import { logger } from '../debug.ts';
import { persona } from '../persona.ts';
import { launchHermes, type HermesProcess, type Launch } from './hermes-process.ts';
import { ASK_HOOK_PREFIX, CATALOG_PROFILE, MODES, applyMode, defaultModel, employeeProfile, ensureProfile, hermes, removeProfile, type Hermes } from './hermes-profile.ts';
import type { EmployeeSession, SessionFactory, SessionHost } from './types.ts';

const debug = logger('hermes');

const short = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms));

// The office's own tools are how an employee reaches the boss, so they never ask, and Hermes does not ask about them.
const OFFICE_TOOL_PREFIX = 'mcp__office__';

// Hermes answers a prompt sent during a turn with one of these and carries the text into the turn. They are its words,
// not the employee's.
const STEER_ACK = /^(Redirected the active turn with your correction\.|Queued for the next turn\. \(\d+ queued\)|⏩ Steer queued.*)$/s;

type AcpMode = 'default' | 'accept_edits' | 'dont_ask';

// One `hermes acp` process and the session on it. An employee has at most one, and it is replaced when Hermes has to read
// something at start that changed.
type Link = {
  readonly proc: HermesProcess;
  readonly agent: acp.ClientContext;
  sessionId: string;
  // False until the process has answered `initialize` and a session is open.
  up: boolean;
  // What the session runs on and how it treats edits now. `settle` moves them to what the owner has picked.
  model: string;
  acpMode: AcpMode;
  // Hermes reads its hooks once, when it starts.
  readonly hooked: boolean;
  // The persona goes out with the first prompt of a process. A resumed conversation gets it again, because the owner's
  // rules or the notes may have changed while the app was closed.
  introduced: boolean;
  resumed: boolean;
  // session/load replays the transcript, and none of it is news.
  replaying: boolean;
  // The office ended this process on purpose, so its exit is not something to report.
  retired: boolean;
};

// The prompt that carries a task, from the moment the task starts until Hermes ends the turn.
type Turn = {
  // False while the process is still starting. What the boss says then goes out with the first prompt.
  prompted: boolean;
  // What the boss said when he cut the turn short: the turn that follows it.
  followUp?: string;
};

// The two answers that arrive as JSON without a type: Hermes puts `models` in `session/new`, and answers `session/load` of
// a conversation it does not have with an empty object instead of an error.
const opened = z.object({ sessionId: z.string(), models: z.object({ currentModelId: z.string() }).optional() });
const loaded = z.object({ modes: z.unknown().optional(), models: z.object({ currentModelId: z.string() }).optional() });
const listed = z.object({
  sessionId: z.string(),
  models: z.object({ availableModels: z.array(z.object({ modelId: z.string(), name: z.string() })), currentModelId: z.string() }),
});

const whileAlive = <T>(proc: HermesProcess, work: Promise<T>): Promise<T> => {
  work.catch(() => {});
  return Promise.race([
    work,
    proc.exited.then((why): never => {
      throw new Error(why);
    }),
  ]);
};

const textOf = (content: readonly acp.ToolCallContent[] | null | undefined): string =>
  (content ?? []).map((c) => (c.type === 'content' && c.content.type === 'text' ? c.content.text : '')).join('');

// A tool call's title is `terminal: date -u`, `write_file: /path/to/file` or, for a tool from an MCP server, its whole name.
const toolName = (title: string | null | undefined) => (title ?? '').split(':')[0]!.trim();

function pathOf(update: { locations?: readonly { path: string }[] | null; title?: string | null }, cwd: string): string {
  const path = update.locations?.[0]?.path ?? (update.title ?? '').split(': ').slice(1).join(': ');
  if (!path || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel.startsWith('..') ? path : rel;
}

function describeTool(name: string, update: { content?: readonly acp.ToolCallContent[] | null; locations?: readonly { path: string }[] | null; title?: string | null }, cwd: string): string {
  switch (name) {
    case 'terminal':
      return `Running ${short(textOf(update.content).replace(/^\$ /, '') || (update.title ?? '').slice('terminal: '.length), 50)}`;
    case 'execute_code':
      return 'Running a script';
    case 'process_manage':
      return 'Managing a process';
    case 'read_file':
      return `Reading ${pathOf(update, cwd)}`;
    case 'write_file':
      return `Writing ${pathOf(update, cwd)}`;
    case 'patch':
      return `Editing ${pathOf(update, cwd)}`;
    case 'search_files':
      return 'Searching the codebase';
    case 'web_search':
    case 'web_extract':
      return 'Looking something up online';
    case 'todo':
      return 'Planning the steps';
    case 'delegate_task':
      return 'Briefing a helper';
    case `${OFFICE_TOOL_PREFIX}ask_owner`:
      return 'Asking the boss';
    case `${OFFICE_TOOL_PREFIX}draw_diagram`:
      return 'Drawing on the whiteboard';
    case `${OFFICE_TOOL_PREFIX}remember`:
      return 'Writing a note';
    case `${OFFICE_TOOL_PREFIX}recall`:
    case `${OFFICE_TOOL_PREFIX}forget`:
      return 'Checking my notes';
    default:
      return `Using ${name}`;
  }
}

// What the card shows next to Allow / Deny. The office matches Always allow rules against `tool` and `detail`, so a shell
// command goes out as SHELL_TOOL with the bare command, and any other tool under its own name.
export function permissionBody(params: acp.RequestPermissionRequest, cwd: string): QuestionBody {
  const raw = object(params.toolCall.rawInput);
  const shell = (detail: string): QuestionBody => ({ kind: 'permission', text: 'Can I run a shell command?', tool: SHELL_TOOL, detail: detail.trim() });
  const other = (tool: string, detail: string): QuestionBody => ({ kind: 'permission', text: `Can I use ${tool}?`, tool, detail });
  const hooked = str(raw.description);
  if (hooked.startsWith(ASK_HOOK_PREFIX)) {
    const [tool = 'tool', ...rest] = hooked.slice(ASK_HOOK_PREFIX.length).split('\n');
    const detail = rest.join('\n');
    return tool === 'terminal' ? shell(detail) : other(tool, short(detail, 200));
  }
  // A command Hermes itself finds dangerous.
  if (typeof raw.command === 'string') return shell(raw.command);
  const name = toolName(params.toolCall.title);
  if (params.toolCall.kind === 'edit') return other(str(raw.tool) || name || 'edit', pathOf(params.toolCall, cwd) || short(params.toolCall.title ?? '', 200));
  return other(name || params.toolCall.kind || 'tool', short(params.toolCall.title ?? '', 200));
}

const optionFor = (params: acp.RequestPermissionRequest, kind: 'allow_once' | 'reject_once') => params.options.find((o) => o.kind === kind)?.optionId;

// What `delegate_task` answers when it starts subagents. Hermes runs them in the background of the process and, over ACP,
// nothing tells the client when they end.
const dispatch = z.object({ status: z.literal('dispatched'), delegation_id: z.string(), subagent_ids: z.array(z.string()), goals: z.array(z.string()).optional() });
// Hermes keeps a manifest of every delegation in its profile, and marks each task as it finishes: the one completion
// signal a client can read.
const manifest = z.object({ tasks: z.array(z.object({ index: z.number(), status: z.string() })) });
const WATCH_MS = 1000;
const MANIFEST_WAIT_MS = 15_000;

export class HermesSession implements EmployeeSession {
  private link?: Link;
  private starting?: Promise<Link>;
  private turn?: Turn;
  private home?: string;
  private stopped = false;
  // Ends with the session, so a card left open by a stopped session is withdrawn from the owner's desk.
  private life = new AbortController();
  private policy: PermissionPolicy;
  // Set when the mode changed to or from ask while a process runs: the hook is read at start, so the next task starts a new process.
  private restart = false;
  private task = '';
  private startedAt = 0;
  // The message the employee is saying now. It is spoken once it is over, so a turn that failed can be told apart from one
  // that ended with words.
  private open?: { id: string | null | undefined; text: string };
  // Prompts sent to steer a running turn that Hermes has not answered yet.
  private steering = 0;
  // What the boss said, or the rules that changed, with no prompt to carry it. It goes in front of the next one.
  private notices: string[] = [];
  private steers: string[] = [];
  private delegateCalls = new Set<string>();
  private subagents = new Set<string>();
  private watchers = new Set<NodeJS.Timeout>();

  private readonly host: SessionHost;
  private readonly hermes: Hermes;
  private readonly launch: Launch;

  constructor(host: SessionHost, h: Hermes, launch: Launch) {
    this.host = host;
    this.hermes = h;
    this.launch = launch;
    this.policy = host.permissions;
  }

  assign(task: string) {
    this.beginTask(task);
    void this.runTurns(task);
  }

  interject(text: string, style: InterruptStyle) {
    const framed = `[Your boss walked over to your desk and said out loud]: ${text}`;
    const { kind } = this.host.employee.status;
    this.host.log(`Boss said: ${text}`);
    if (kind === 'idle' || kind === 'error') {
      this.beginTask(short(text, 80));
      void this.runTurns(framed);
    } else if (style === 'now') {
      this.interruptThenRun(framed);
    } else {
      this.steer(framed);
    }
  }

  // The turn stops where it is: Hermes kills the command it was running and answers `cancelled`. The instruction then goes
  // as the next turn, and Hermes carries the stopped request into it.
  private interruptThenRun(text: string) {
    const { turn, link } = this;
    if (!turn?.prompted || !link) return this.steer(text);
    turn.followUp = text;
    void link.agent.notify(acp.methods.agent.session.cancel, { sessionId: link.sessionId });
  }

  // A prompt sent during a turn is not a new turn: Hermes says it took it and the model reads it at its next step.
  private steer(text: string) {
    const { turn, link } = this;
    if (!turn?.prompted || !link) return void this.steers.push(text);
    this.steering++;
    link.agent
      .request(acp.methods.agent.session.prompt, { sessionId: link.sessionId, prompt: [{ type: 'text', text }] })
      .then(
        // A prompt that arrived just as the turn ended is a turn of its own, and comes back with usage.
        (res) => res.usage && this.closeMessage(),
        (e: unknown) => debug('steer failed:', message(e)),
      )
      .finally(() => this.steering--);
  }

  // A live session switches models between turns. A turn that is running finishes on the model it started with, and the
  // next one switches first (`settle`). Hermes does not check the id: a model it cannot reach fails the next turn.
  setModel(_model: ModelId) {
    const { link } = this;
    if (!link?.up || this.turn) return;
    this.settle(link).catch((e: unknown) => this.host.log(message(e)));
  }

  // Hermes checks approvals.* at every tool call, so a change there reaches a running process at its next command. The ask
  // hook it reads when it starts, so a change to or from ask takes a new process, which the next task starts.
  permissionsChanged(policy: PermissionPolicy) {
    const before = this.policy.mode;
    this.policy = policy;
    if (policy.mode === before || !this.home) return;
    try {
      applyMode(this.hermes, employeeProfile(this.host.employee.id), policy.mode);
    } catch (e) {
      return this.host.log(`Could not write ${policy.mode} into Hermes's config: ${message(e)}`);
    }
    const { link } = this;
    if (!link) return;
    if (MODES[policy.mode].askHook !== link.hooked) {
      this.restart = true;
      this.host.log(`Hermes reads its shell hook when it starts, so ${policy.mode} applies from the next task`);
    }
    if (link.up) void this.setAcpMode(link, MODES[policy.mode].acpMode).catch((e: unknown) => debug('set_mode failed:', message(e)));
  }

  // A process that is not running reads the rules when it starts.
  rulesChanged(text: string) {
    if (!this.link) return;
    const notice = `[Your boss changed the rules you work by. Acknowledge it in one sentence, then follow it]: ${text}`;
    if (this.turn) this.steer(notice);
    else this.notices.push(notice);
  }

  stop() {
    this.stopped = true;
    this.life.abort();
    this.dropSubagents();
    if (this.link) this.retire(this.link);
  }

  private beginTask(task: string) {
    this.task = task;
    this.startedAt = Date.now();
    this.host.setStatus({ kind: 'working', task, startedAt: this.startedAt });
    this.host.setActivity('Getting started');
  }

  // Turns run one after another. A turn the boss cuts short hands over to the next while the desk stays busy.
  private async runTurns(first: string) {
    let next: string | undefined = first;
    while (next !== undefined && !this.stopped) next = await this.oneTurn(next);
    this.turn = undefined;
  }

  private async oneTurn(text: string): Promise<string | undefined> {
    const turn: Turn = { prompted: false };
    this.turn = turn;
    let link: Link | undefined;
    try {
      if (this.restart) await this.recycle();
      link = await this.ensureLink();
      await this.settle(link);
      const prompt = this.compose(link, text);
      if (this.stopped) return undefined;
      turn.prompted = true;
      const res = await link.agent.request(acp.methods.agent.session.prompt, { sessionId: link.sessionId, prompt: [{ type: 'text', text: prompt }] });
      return this.turnEnded(turn, res);
    } catch (e) {
      if (this.stopped) return undefined;
      // A process that died mid-turn says why on its own a moment later.
      const why = link ? await Promise.race([link.proc.exited, sleep(300)]) : undefined;
      this.reportError(why ?? message(e));
      return undefined;
    }
  }

  // Hermes reports a rate limit or a bad model as an ordinary `end_turn` whose message is the error, and with no usage.
  private turnEnded(turn: Turn, res: { stopReason: string; usage?: unknown }): string | undefined {
    if (res.stopReason === 'cancelled') {
      this.closeMessage();
      if (turn.followUp !== undefined) return turn.followUp;
      this.host.setActivity('Stopped');
      this.host.setStatus({ kind: 'idle' });
      return undefined;
    }
    if (res.stopReason === 'refusal') {
      this.host.setSessionId('');
      this.reportError('Hermes no longer has this conversation');
      return undefined;
    }
    if (!res.usage) {
      const said = this.open?.text ?? '';
      this.open = undefined;
      this.reportError(short(said, 300) || 'Hermes ended the turn without an answer');
      return undefined;
    }
    const text = (this.open?.text ?? '').trim();
    this.closeMessage();
    this.host.taskCompleted();
    this.host.setActivity(short(text, 120) || 'Finished the task');
    this.host.setStatus({ kind: 'idle' });
    this.host.log(`Finished: ${short(text, 200) || this.task}`);
    return undefined;
  }

  // The persona goes out with the first prompt of a process. Rules that changed while the employee was idle, and what the
  // boss said before the process was up, go in front of every prompt.
  private compose(link: Link, text: string): string {
    const parts: string[] = [];
    if (!link.introduced) {
      link.introduced = true;
      const { employee, block, companyName } = this.host;
      // Read once per process: a note saved while it runs shows up in the next one.
      const digest = this.host.memoryDigest();
      debug(`session start for ${employee.name}, memory digest:\n${digest || '(no notes yet)'}`);
      const intro = persona({ name: employee.name, company: companyName, block: block.name, digest, rules: this.host.rules() });
      parts.push(link.resumed ? `[You are back at your desk after a break. Your standing instructions changed while you were away, and these replace the earlier ones]\n\n${intro}` : intro);
      // The persona has today's rules, so a notice about a change made before it is out of date.
      this.notices = [];
    }
    parts.push(...this.notices.splice(0), ...this.steers.splice(0), text);
    return parts.join('\n\n');
  }

  private async settle(link: Link) {
    const { model } = this.host;
    if (model !== link.model) {
      try {
        await link.agent.request('session/set_model', { sessionId: link.sessionId, modelId: model });
      } catch (e) {
        throw new Error(`Could not switch to ${model}, still on ${link.model}: ${message(e)}`);
      }
      link.model = model;
      this.host.log(`Model switched to ${model}`);
    }
    await this.setAcpMode(link, MODES[this.policy.mode].acpMode);
  }

  private async setAcpMode(link: Link, mode: AcpMode) {
    if (link.acpMode === mode) return;
    await link.agent.request(acp.methods.agent.session.setMode, { sessionId: link.sessionId, modeId: mode });
    link.acpMode = mode;
  }

  private ensureLink(): Promise<Link> {
    if (this.link?.up) return Promise.resolve(this.link);
    this.starting ??= this.start().finally(() => void (this.starting = undefined));
    return this.starting;
  }

  private async start(): Promise<Link> {
    const { employee, block, mcp } = this.host;
    if (!existsSync(block.cwd)) throw new Error(`The folder of ${block.name} is gone: ${block.cwd}`);
    const name = employeeProfile(employee.id);
    this.home = await ensureProfile(this.hermes, name, { kind: 'employee', employeeId: employee.id });
    const { askHook } = applyMode(this.hermes, name, this.policy.mode);
    if (this.stopped) throw new Error('The session ended');
    const proc = this.launch({ home: this.home, cwd: block.cwd });
    const connection = acp
      .client({ name: 'online-office' })
      .onRequest(acp.methods.client.session.requestPermission, (c) => this.onPermission(link, c.params, c.signal))
      .onNotification(acp.methods.client.session.update, (c) => this.onUpdate(link, c.params.update))
      .connect(proc.stream);
    const link: Link = { proc, agent: connection.agent, sessionId: '', up: false, model: '', acpMode: 'default', hooked: askHook, introduced: false, resumed: false, replaying: false, retired: false };
    this.link = link;
    void proc.exited.then((why) => this.onExit(link, why));
    try {
      await whileAlive(proc, link.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }));
      const mcpServers: acp.McpServer[] = [{ type: 'http', name: mcp.name, url: mcp.url, headers: [] }];
      if (employee.sessionId) await this.resume(link, employee.sessionId, block.cwd, mcpServers);
      if (!link.sessionId) {
        const created = opened.parse(await whileAlive(proc, link.agent.request(acp.methods.agent.session.new, { cwd: block.cwd, mcpServers })));
        link.sessionId = created.sessionId;
        link.model = created.models?.currentModelId ?? '';
        this.host.setSessionId(created.sessionId);
      }
      link.up = true;
      this.host.log(`Session ${link.resumed ? 'resumed' : 'started'} on ${link.model || this.host.model}`);
      return link;
    } catch (e) {
      this.retire(link);
      throw e;
    }
  }

  // Hermes keeps the conversation in the employee's profile, so it survives the app. The process it lives in does not:
  // the mode falls back to `default` and the office server has to be named again.
  private async resume(link: Link, sessionId: string, cwd: string, mcpServers: acp.McpServer[]) {
    link.replaying = true;
    try {
      const res = loaded.parse(await whileAlive(link.proc, link.agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers })));
      // A conversation Hermes never saved, or has lost, is not an error to it: the answer is an empty object.
      if (res.modes === undefined) {
        this.host.log('The earlier conversation is gone, so this is a new one');
        this.host.setSessionId('');
        return;
      }
      link.sessionId = sessionId;
      link.resumed = true;
      link.model = res.models?.currentModelId ?? '';
    } finally {
      link.replaying = false;
    }
  }

  private retire(link: Link) {
    link.retired = true;
    if (this.link === link) this.link = undefined;
    link.proc.kill();
  }

  private async recycle() {
    const { link } = this;
    this.restart = false;
    if (!link) return;
    this.retire(link);
    this.dropSubagents();
    // The next process reads the rules as they are then.
    this.notices = [];
    await link.proc.exited;
  }

  private onExit(link: Link, why: string) {
    if (link.retired || this.stopped) return;
    debug(`process gone: ${why}`);
    if (this.link === link) this.link = undefined;
    this.dropSubagents();
    this.notices = [];
    this.steers = [];
  }

  private reportError(text: string) {
    debug('error:', text);
    this.host.setStatus({ kind: 'error', message: text });
    this.host.setActivity(`Something went wrong: ${short(text, 80)}`);
    this.host.log(`Error: ${text}`);
  }

  private onUpdate(link: Link, update: acp.SessionUpdate) {
    if (link.replaying || link.retired) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') this.onChunk(update.content.text, update.messageId);
        break;
      case 'tool_call':
        this.onToolCall(update);
        break;
      case 'tool_call_update':
        this.onToolUpdate(update);
        break;
      default:
        // Thoughts, the plan, usage and the title are not the employee's to say or the office's to show.
        break;
    }
  }

  private onChunk(text: string, id: string | null | undefined) {
    if (this.steering > 0 && STEER_ACK.test(text.trim())) return;
    if (this.open && id !== this.open.id) this.closeMessage();
    this.open ??= { id, text: '' };
    this.open.text += text;
  }

  // The employee is done with what they were saying: a tool call is next, or another message, or the turn is over.
  private closeMessage() {
    const said = this.open?.text.trim();
    this.open = undefined;
    if (!said) return;
    this.host.said(said);
    this.host.log(`Said: ${said}`);
  }

  private onToolCall(call: acp.ToolCall) {
    this.closeMessage();
    const name = toolName(call.title);
    // A tool call after the turn ended is the next turn starting on its own.
    if (this.host.employee.status.kind === 'idle') this.host.setStatus({ kind: 'working', task: this.task, startedAt: this.startedAt });
    const line = describeTool(name, call, this.host.block.cwd);
    this.host.setActivity(line);
    // The office logs the question itself.
    if (name !== `${OFFICE_TOOL_PREFIX}ask_owner`) this.host.log(line);
    if (name === 'delegate_task') this.delegateCalls.add(call.toolCallId);
  }

  private onToolUpdate(update: acp.ToolCallUpdate) {
    if (!this.delegateCalls.delete(update.toolCallId) || update.status !== 'completed') return;
    let started: z.infer<typeof dispatch> | undefined;
    try {
      started = dispatch.parse(JSON.parse(textOf(update.content)));
    } catch {
      return;
    }
    started.subagent_ids.forEach((id, i) => {
      this.subagents.add(id);
      this.host.subagentStarted({ id, parentId: null, label: short(started.goals?.[i] ?? '', 60) || 'Helper', startedAt: Date.now() });
    });
    this.watchDelegation(started.delegation_id, started.subagent_ids);
  }

  // A subagent ends when Hermes marks its task in the manifest. A manifest that never shows up, or vanishes, means the
  // office cannot follow it, and its dolls go rather than stay for ever.
  private watchDelegation(delegationId: string, ids: string[]) {
    const file = join(this.home ?? '', 'cache', 'delegation', 'live', delegationId, 'manifest.json');
    const t0 = Date.now();
    let seen = false;
    const timer = setInterval(() => {
      let tasks: z.infer<typeof manifest>['tasks'] | undefined;
      try {
        tasks = manifest.parse(JSON.parse(readFileSync(file, 'utf8'))).tasks;
        seen = true;
      } catch {
        if (seen || Date.now() - t0 > MANIFEST_WAIT_MS) for (const id of ids) this.endSubagent(id);
      }
      for (const task of tasks ?? []) if (task.status !== 'running' && ids[task.index]) this.endSubagent(ids[task.index]!);
      if (ids.every((id) => !this.subagents.has(id))) {
        clearInterval(timer);
        this.watchers.delete(timer);
      }
    }, WATCH_MS);
    timer.unref();
    this.watchers.add(timer);
  }

  private endSubagent(id: string) {
    if (this.subagents.delete(id)) this.host.subagentFinished(id);
  }

  // Subagents run inside the process, so they end with it.
  private dropSubagents() {
    for (const timer of this.watchers) clearInterval(timer);
    this.watchers.clear();
    this.delegateCalls.clear();
    for (const id of this.subagents) this.endSubagent(id);
  }

  // Hermes asks about an edit outside the block folder, a shell command it finds dangerous and, under ask, every command.
  // The office answers: Allow is `allow_once`, and so is Always allow, because the rule lives in the office, so the answer to
  // Hermes must never write a rule of its own. A withdrawn card is a cancelled request.
  private async onPermission(link: Link, params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const cancelled = { outcome: { outcome: 'cancelled' as const } };
    if (link.retired) return cancelled;
    const withdrawn = AbortSignal.any([signal, this.life.signal]);
    const answer = await this.host.ask(permissionBody(params, this.host.block.cwd), withdrawn);
    if (withdrawn.aborted || answer === '') return cancelled;
    const allowed = isAllow(answer);
    // Hermes has nowhere to put the boss's words on a refusal, so they go as the next thing it reads.
    if (!allowed && !/^deny$/i.test(answer.trim())) this.steer(`[Your boss did not allow that, and said]: ${answer.trim()}`);
    const optionId = optionFor(params, allowed ? 'allow_once' : 'reject_once');
    return optionId ? { outcome: { outcome: 'selected', optionId } } : cancelled;
  }
}

export const createHermesSession: SessionFactory = (host) => new HermesSession(host, hermes, launchHermes);

// Hermes lists the models it can reach in the answer to `session/new`, so asking takes a process and a profile. The office
// makes one for the question and deletes it after, and remembers the answer, because the list hardly ever changes.
export function modelLister(h: Hermes, launch: Launch, ttlMs = 10 * 60 * 1000): () => Promise<ModelCatalog> {
  let cached: { at: number; catalog: ModelCatalog } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.catalog;
    const catalog = await fetchModels(h, launch);
    cached = catalog.kind === 'ready' ? { at: Date.now(), catalog } : undefined;
    return catalog;
  };
}

async function fetchModels(h: Hermes, launch: Launch): Promise<ModelCatalog> {
  let proc: HermesProcess | undefined;
  try {
    const home = await ensureProfile(h, CATALOG_PROFILE, { kind: 'catalog' });
    proc = launch({ home, cwd: home });
    const { agent } = acp.client({ name: 'online-office' }).connect(proc.stream);
    await whileAlive(proc, agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }));
    const { models } = listed.parse(await whileAlive(proc, agent.request(acp.methods.agent.session.new, { cwd: home, mcpServers: [] })));
    if (!models.availableModels.length) return { kind: 'error', message: 'Hermes lists no models. Is it signed in?' };
    const want = defaultModel(h);
    const ids = models.availableModels.map((m) => m.modelId);
    return {
      kind: 'ready',
      models: models.availableModels.map((m) => ({ id: m.modelId as ModelId, label: m.name })),
      defaultModel: (ids.includes(want) ? want : models.currentModelId) as ModelId,
    };
  } catch (e) {
    return { kind: 'error', message: `Could not ask Hermes for its models: ${message(e)}` };
  } finally {
    proc?.kill();
    await proc?.exited;
    await removeProfile(h, CATALOG_PROFILE).catch((e: unknown) => console.error('Could not delete the Hermes catalog profile:', e));
  }
}

export const listHermesModels = modelLister(hermes, launchHermes);
export const hermesDefaultModel = () => defaultModel(hermes);
// Firing an employee takes their profile with them. Sessions stop for other reasons too, and those keep it.
export const dismissHermesEmployee = (employee: Employee) => removeProfile(hermes, employeeProfile(employee.id));
