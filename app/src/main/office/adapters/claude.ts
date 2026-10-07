import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode as SdkPermissionMode,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { SHELL_TOOL, isAllow } from '../../../shared/permissions.ts';
import type { InterruptStyle, ModelCatalog, ModelId, ModelOption, PermissionMode, PermissionPolicy, QuestionBody } from '../../../shared/protocol.ts';
import type { TermEvent } from '../../../shared/terminal.ts';
import { logger } from '../debug.ts';
import { persona } from '../persona.ts';
import { trace } from '../trace.ts';
import type { EmployeeSession, SessionFactory, SessionHost } from './types.ts';

const debug = logger('claude');

const claudeDefaultModel = () => (process.env.OFFICE_CLAUDE_MODEL ?? 'claude-sonnet-5-5') as ModelId;

const nodeRequire = createRequire(import.meta.url);

// Electron's ASAR resolver returns a virtual path for the SDK's native binary. Native child processes need the unpacked file.
export function claudeCodeExecutable(): string | undefined {
  try {
    const packageName = `claude-agent-sdk-${process.platform}-${process.arch}`;
    // The platform package is an optional dependency nested under the SDK. It
    // is not hoisted in the pnpm development install, so resolve it relative
    // to the SDK package instead of asking Node to resolve it from this file.
    const sdk = nodeRequire.resolve('@anthropic-ai/claude-agent-sdk') as string;
    let root = dirname(sdk);
    let resolved: string | undefined;
    for (let i = 0; i < 8 && root; i += 1) {
      const candidate = join(root, 'node_modules', '@anthropic-ai', packageName, 'claude');
      try {
        accessSync(candidate, constants.X_OK);
        resolved = candidate;
        break;
      } catch {
        const parent = dirname(root);
        if (parent === root) break;
        root = parent;
      }
    }
    if (!resolved) return undefined;
    const virtual = `${sep}app.asar${sep}`;
    const unpacked = resolved.includes(virtual) ? resolved.replace(virtual, `${sep}app.asar.unpacked${sep}`) : resolved;
    accessSync(unpacked, constants.X_OK);
    return unpacked;
  } catch {
    return undefined;
  }
}

// Claude's model list is part of the SDK initialization response. Use a short-lived
// query so opening the hire dialog does not create an employee session.
export async function listClaudeModels(): Promise<ModelCatalog> {
  const executable = claudeCodeExecutable();
  const q = query({ prompt: '', options: { cwd: process.cwd(), ...(executable && { pathToClaudeCodeExecutable: executable }) } });
  try {
    const models = await q.supportedModels();
    // The SDK includes aliases (for example `sonnet`) alongside their canonical
    // cloud model ids. Persist and send the canonical id so a newly introduced
    // model such as Sonnet 5.5 is selectable instead of being hidden behind an
    // alias, and avoid showing the same model twice.
    const options = new Map<string, { option: ModelOption; rank: number }>();
    for (const m of models) {
      const value = m.value.trim();
      const id = m.resolvedModel?.trim() || value;
      if (!id) continue;
      // `default` and named aliases can resolve to the same model. Prefer a
      // named alias (Opus 5.5) over the generic Default row, and an explicit
      // canonical id over either alias.
      const rank = value === id ? 3 : value === 'default' ? 1 : 2;
      const current = options.get(id);
      if (!current || rank > current.rank) options.set(id, { option: { id: id as ModelId, label: m.displayName || id }, rank });
    }
    const listed = [...options.values()].map(({ option }) => option);
    const defaultModel = claudeDefaultModel();
    const listedDefault = models.find((m) => m.value === defaultModel || m.resolvedModel === defaultModel)?.resolvedModel;
    const selectedDefault = listedDefault ?? (listed.some((m) => m.id === defaultModel) ? defaultModel : listed[0]?.id ?? defaultModel);
    return { kind: 'ready', models: listed, defaultModel: selectedDefault as ModelId };
  } finally {
    q.close();
  }
}

const short = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');

// The decoded value of the "text" argument in a tool input that is still being generated, so far. The JSON is cut
// anywhere, including inside an escape.
export function partialText(json: string): string {
  const start = /"text"\s*:\s*"/.exec(json);
  if (!start) return '';
  const body = json.slice(start.index + start[0].length);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"') break;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) break;
    if (n === 'u') {
      const hex = body.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 5;
    } else {
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      i++;
    }
  }
  return out;
}

// Permission policy. Everything that decides whether a tool asks the boss is in this block, so it can be swapped
// for the owner's own settings in one place. Every question still goes out through `host.ask` in `canUseTool`.
// docs/beta-plan.md maps each mode onto Claude's. Inherit keeps acceptEdits until the owner's own settings are read.
const MODES: Record<PermissionMode, SdkPermissionMode> = {
  inherit: 'acceptEdits',
  ask: 'default',
  auto: 'auto',
  yolo: 'bypassPermissions',
};

// Tools that can never hurt anything, so the boss is not bothered.
const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent']);

// The tools that start a subagent. Claude runs them in the background unless told otherwise: the tool_result of the call
// is then a "launched" placeholder, and only a task_notification says the subagent is done.
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

// The office's own tools are how an employee reaches the boss, so they never ask.
const OFFICE_TOOL_PREFIX = 'mcp__office__';

// The office tools whose `text` argument is a bubble the owner reads. Their arguments stream while the model writes them.
const BUBBLE_TOOLS = new Set([`${OFFICE_TOOL_PREFIX}message`, `${OFFICE_TOOL_PREFIX}reply`]);

// OFFICE_BASH=allow skips the question for shell commands and everything else that would ask.
const runsUnasked = (toolName: string) =>
  process.env.OFFICE_BASH === 'allow' || AUTO_ALLOW.has(toolName) || toolName.startsWith(OFFICE_TOOL_PREFIX);

// Claude Code aborts an HTTP MCP call that has sent no response or progress for 5 minutes, and an owner can take longer
// than that to answer. Only a per-server `timeout` lifts that limit: MCP_TOOL_TIMEOUT alone does not (verify/claude-timeout-probe.ts).
// So the office server gets a day. The in-process SDK server this replaced was exempt from the limit.
const OFFICE_MCP_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// What the session runs with. `env` replaces the environment, so it is spread over the app's own.
// - The office keeps the notes, per employee and per block. Claude's per-repo memory would be shared with the boss's own
//   sessions and with every other employee in the folder.
// - If the boss's shell exports CLAUDE_AUTO_BACKGROUND_TASKS, Claude moves any MCP call that runs past 2 minutes to a
//   background task and hands the model a placeholder instead of the answer. 0 turns that off.
export const sessionEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
});

function targetOf(input: Record<string, unknown>, cwd: string): string {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (!file || !isAbsolute(file)) return file;
  const rel = relative(cwd, file);
  return rel.startsWith('..') ? file : rel;
}

function describeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const target = targetOf(input, cwd);
  switch (name) {
    case 'Read':
      return `Reading ${target}`;
    case 'Write':
      return `Writing ${target}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${target}`;
    case 'Bash':
      return `Running ${short(str(input.command), 50)}`;
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'Searching the codebase';
    case 'WebSearch':
    case 'WebFetch':
      return 'Looking something up online';
    case 'TodoWrite':
      return 'Planning the steps';
    case 'Task':
    case 'Agent':
      return 'Briefing a helper';
    case `${OFFICE_TOOL_PREFIX}ask_owner`:
      return 'Asking the boss';
    case `${OFFICE_TOOL_PREFIX}draw_diagram`:
      return 'Drawing on the whiteboard';
    case `${OFFICE_TOOL_PREFIX}message`:
    case `${OFFICE_TOOL_PREFIX}reply`:
      return 'Writing a message';
    case `${OFFICE_TOOL_PREFIX}request`:
    case `${OFFICE_TOOL_PREFIX}requestGauntlet`:
      return 'Delegating work';
    case `${OFFICE_TOOL_PREFIX}awaitReplies`:
      return 'Waiting on a teammate';
    case `${OFFICE_TOOL_PREFIX}hireTeammate`:
      return 'Hiring';
    case `${OFFICE_TOOL_PREFIX}remember`:
      return 'Writing a note';
    case `${OFFICE_TOOL_PREFIX}recall`:
    case `${OFFICE_TOOL_PREFIX}forget`:
      return 'Checking my notes';
    default:
      return `Using ${name}`;
  }
}

// What the card shows next to Allow / Deny: the shell command, or the file the tool wants to touch. The office matches
// Always allow rules against `tool` and `detail`, so a shell command must go out as SHELL_TOOL with the bare command.
function permissionBody(name: string, input: Record<string, unknown>, cwd: string): QuestionBody {
  const target = targetOf(input, cwd);
  const shell = name === 'Bash';
  return {
    kind: 'permission',
    text: shell ? 'Can I run a shell command?' : `Can I use ${name}?`,
    tool: shell ? SHELL_TOOL : name,
    detail: shell ? str(input.command).trim() : target || short(JSON.stringify(input), 200),
  };
}

// The part of the SDK's Query that a session uses, so a check can stand in for the SDK.
type Live = AsyncIterable<SDKMessage> & Pick<Query, 'interrupt' | 'setModel' | 'setPermissionMode' | 'close'>;
export type ClaudeRun = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Live;

// The SDK's streaming input takes an async iterable. This is the smallest one we can push into.
export class PushQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting?: (r: IteratorResult<T>) => void;
  private closed = false;

  push(item: T) {
    if (this.waiting) {
      this.waiting({ value: item, done: false });
      this.waiting = undefined;
    } else this.items.push(item);
  }

  close() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export class ClaudeSession implements EmployeeSession {
  private q?: Live;
  private inbox = new PushQueue<SDKUserMessage>();
  private stopped = false;
  private gotInit = false;
  // Set from the moment we interrupt until the next turn starts, so the aborted turn's result is not read as a failure.
  private interrupting = false;
  private task = '';
  private startedAt = 0;
  private lastSaid = '';
  // Bubble tool calls being generated, by content block index: the JSON so far and how much of its text went out.
  private bubbles = new Map<number, { json: string; sent: number }>();
  // Ends with the process, so a permission question left open by a dead process is withdrawn from the owner's desk.
  private life = new AbortController();
  // Set from the moment the owner presses Esc until the turn it stopped reports that it ended.
  private ownerInterrupt = false;
  // What the terminal shows of the message being written: the API message, and for each block the text or thinking so far.
  private messageId = '';
  private blocks = new Map<number, { id: string; kind: 'text' | 'thinking'; text: string; since: number }>();
  // Output tokens of the turn: what finished messages wrote, and what the one in flight has written so far.
  private tokensDone = 0;
  private tokensLive = 0;

  // What the last `permissionsChanged` said. The next process starts on it.
  private policy: PermissionPolicy;
  // The subagents this process has started and not seen end. The office keeps the list the owner sees.
  private subagents = new Set<string>();
  // Rule changes that arrived between tasks. They go in front of the next task.
  private notices: string[] = [];

  private readonly host: SessionHost;
  private readonly run: ClaudeRun;

  constructor(host: SessionHost, run: ClaudeRun) {
    this.host = host;
    this.run = run;
    this.policy = host.permissions;
  }

  assign(task: string, title?: string, shown?: string) {
    this.beginTask(title ?? task);
    this.send(this.withNotices(task), undefined, shown ?? title ?? task);
  }

  interject(text: string, style: InterruptStyle) {
    const framed = `[Your boss walked over to your desk and said out loud]: ${text}`;
    const { kind } = this.host.employee.status;
    this.host.log(`Boss said: ${text}`);
    if (kind === 'idle' || kind === 'error') {
      this.beginTask(short(text, 80));
      this.send(this.withNotices(framed), undefined, text);
    } else if (style === 'now') {
      void this.interruptThenSend(framed, text);
    } else {
      this.send(framed, 'next', text);
    }
  }

  // Esc on the terminal: the same hard stop as `now`, with no message after it. The turn ends when the SDK reports the abort.
  interrupt() {
    if (!this.q) return;
    this.ownerInterrupt = true;
    this.q.interrupt().catch((e: unknown) => {
      debug('interrupt failed:', e);
      this.ownerInterrupt = false;
    });
  }

  // priority 'now' alone only aborts at the next tool boundary: a Bash that is already running finishes first.
  // interrupt() kills the running step, so we do both to honour "drop the current step and listen".
  private async interruptThenSend(text: string, shown: string) {
    this.interrupting = true;
    try {
      await this.q?.interrupt();
    } catch (e) {
      debug('interrupt failed:', e);
    }
    if (this.stopped) return;
    this.host.terminal({ k: 'end', how: 'interrupted' });
    this.send(text, 'now', shown);
  }

  // A live session switches models for its next turn. Without one, the next start reads `host.model`. The SDK refuses an
  // id its bundled Claude Code does not describe, even one that works as a start option, so the owner is told.
  setModel(model: ModelId) {
    this.q?.setModel(model).then(
      () => debug(`model switched to ${model}`),
      (e: unknown) => this.host.log(`Could not switch to ${model}, still on the previous model: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  // A live session switches mode at once. Without one, the next start reads `this.policy`.
  permissionsChanged(policy: PermissionPolicy) {
    const changed = policy.mode !== this.policy.mode;
    this.policy = policy;
    if (!changed) return;
    const mode = MODES[policy.mode];
    this.q?.setPermissionMode(mode).then(
      () => debug(`permission mode switched to ${mode}`),
      (e: unknown) => this.host.log(`Could not switch to ${policy.mode}, still on the previous mode: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  // A process that is not running reads the rules when it starts.
  rulesChanged(text: string) {
    if (!this.q) return;
    const notice = `[Your boss changed the rules you work by. Acknowledge it in one sentence, then follow it]: ${text}`;
    const { kind } = this.host.employee.status;
    if (kind === 'idle' || kind === 'error') this.notices.push(notice);
    else this.send(notice, 'next');
  }

  private withNotices(text: string): string {
    const notices = this.notices.splice(0);
    return notices.length ? `${notices.join('\n\n')}\n\n${text}` : text;
  }

  stop() {
    this.stopped = true;
    this.life.abort();
    this.inbox.close();
    this.q?.close();
  }

  private beginTask(task: string) {
    this.task = task;
    this.startedAt = Date.now();
    this.host.setStatus({ kind: 'working', task, startedAt: this.startedAt });
    this.host.setActivity('Getting started');
  }

  // Hops already traced since the last message went in.
  private hops = new Set<string>();
  private hop(name: string) {
    if (this.hops.has(name)) return;
    this.hops.add(name);
    trace(this.host.employee.id, name);
  }

  // True from `warm` until the first message goes in.
  private warming = false;

  warm() {
    if (this.q || this.stopped) return;
    this.warming = true;
    this.start();
  }

  private send(text: string, priority?: InterruptStyle, shown?: string) {
    this.warming = false;
    this.hops.clear();
    if (!this.q) this.start();
    this.hop('push');
    if (shown !== undefined) this.host.terminal({ k: 'prompt', text: shown });
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
    });
  }

  private start() {
    const { employee, block, companyName, mcp } = this.host;
    this.inbox = new PushQueue();
    this.gotInit = false;
    this.life = new AbortController();
    // Read once per session: a note saved while the session runs shows up in the next one, and the prompt stays put.
    const digest = this.host.memoryDigest();
    const rules = this.host.rules();
    const executable = claudeCodeExecutable();
    debug(`session start for ${employee.name}, memory digest:\n${digest || '(no notes yet)'}`);
    this.hop('spawn');
    this.q = this.run({
      prompt: this.inbox,
      options: {
        cwd: block.cwd,
        ...(executable && { pathToClaudeCodeExecutable: executable }),
        model: this.host.model,
        includePartialMessages: true,
        // 'project' only: the boss's global plugins and hooks must not leak into employees.
        settingSources: ['project'],
        permissionMode: MODES[this.policy.mode],
        // Lets a live session switch to yolo later. It bypasses nothing by itself.
        allowDangerouslySkipPermissions: true,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: persona({ name: employee.name, company: companyName, block: block.name, role: employee.role, branch: employee.workspace?.branch, digest, rules }),
        },
        // The office server every harness shares. alwaysLoad keeps ask_owner in the prompt instead of behind tool search.
        mcpServers: { [mcp.name]: { type: 'http', url: mcp.url, timeout: OFFICE_MCP_TIMEOUT_MS, alwaysLoad: true } },
        // Without this the boss's claude.ai connectors (Gmail, Drive, Figma...) load into every employee.
        strictMcpConfig: true,
        // ask_owner is the only way to reach the boss; the built-in question tool would go nowhere.
        disallowedTools: ['AskUserQuestion'],
        canUseTool: this.canUseTool,
        env: sessionEnv(),
        ...(employee.sessionId ? { resume: employee.sessionId } : {}),
      },
    });
    void this.pump(this.q);
  }

  private async pump(q: Live) {
    try {
      for await (const m of q) this.onMessage(m);
      if (!this.stopped) this.fail('The session ended unexpectedly');
    } catch (e) {
      if (!this.stopped) this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  // The process is gone, and its subagents with it. The next assign starts a new one, resuming the stored session.
  private fail(message: string) {
    const quiet = this.warming;
    // A resume that dies before init means the stored session is gone. Start clean next time.
    if (!this.gotInit) this.host.setSessionId('');
    this.q?.close();
    this.q = undefined;
    this.life.abort();
    for (const id of this.subagents) this.host.subagentFinished(id);
    this.subagents.clear();
    // A bubble the dead process was still writing never gets its closing event.
    if (this.bubbles.size) this.host.streamed?.('', true);
    this.bubbles.clear();
    // The next process reads the rules as they are then.
    this.notices = [];
    this.warming = false;
    if (quiet) debug(`warm process ended: ${message}`);
    else this.reportError(message);
  }

  // This turn failed but the process is fine, so the conversation carries on with the next message.
  private reportError(message: string) {
    debug('error:', message);
    this.host.terminal({ k: 'end', how: 'error', message });
    this.host.setStatus({ kind: 'error', message });
    this.host.setActivity(`Something went wrong: ${short(message, 80)}`);
    this.host.log(`Error: ${message}`);
  }

  private onMessage(m: SDKMessage) {
    const { host } = this;
    this.hop(m.type === 'stream_event' ? `event_${m.event.type}` : m.type === 'system' ? `system_${m.subtype}` : m.type);
    if (m.type === 'system' && m.subtype === 'init') {
      this.gotInit = true;
      this.interrupting = false;
      if (host.employee.sessionId !== m.session_id) host.setSessionId(m.session_id);
      host.terminal({ k: 'banner', title: `Claude Code v${m.claude_code_version}`, model: m.model, cwd: m.cwd });
      debug(
        `init model=${m.model} tools=${m.tools.length} skills=${m.skills.length} plugins=${m.plugins.map((p) => p.name)} mcp=${m.mcp_servers.map((s) => `${s.name}:${s.status}`)}`,
      );
    } else if (m.type === 'stream_event') {
      this.onStream(m);
    } else if (m.type === 'assistant') {
      this.onAssistant(m);
    } else if (m.type === 'system' && m.subtype === 'task_notification') {
      this.subagentEnded(m.tool_use_id);
    } else if (m.type === 'user') {
      this.onUser(m);
    } else if (m.type === 'result') {
      this.onResult(m);
    }
  }

  private onStream(m: Extract<SDKMessage, { type: 'stream_event' }>) {
    if (m.parent_tool_use_id !== null) return;
    this.streamToTerminal(m.event);
    this.streamBubbles(m.event);
  }

  // What the terminal shows while the model writes: its text as it comes, a marker while it thinks, the tokens so far.
  private streamToTerminal(event: Extract<SDKMessage, { type: 'stream_event' }>['event']) {
    const { host } = this;
    switch (event.type) {
      case 'message_start':
        this.messageId = event.message.id;
        this.blocks.clear();
        this.tokensLive = 0;
        return;
      case 'content_block_start': {
        const kind = event.content_block.type;
        if (kind !== 'text' && kind !== 'thinking') return;
        const block = { id: `${this.messageId}:${event.index}`, kind, text: '', since: Date.now() };
        this.blocks.set(event.index, block);
        if (kind === 'thinking') host.terminal({ k: 'thinking', id: block.id });
        return;
      }
      case 'content_block_delta': {
        const block = this.blocks.get(event.index);
        if (block?.kind !== 'text' || event.delta.type !== 'text_delta') return;
        block.text += event.delta.text;
        host.terminal({ k: 'text', id: block.id, text: block.text });
        return;
      }
      case 'content_block_stop': {
        const block = this.blocks.get(event.index);
        if (block?.kind === 'thinking') host.terminal({ k: 'thinking', id: block.id, secs: (Date.now() - block.since) / 1000 });
        return;
      }
      case 'message_delta':
        this.tokensLive = event.usage.output_tokens ?? this.tokensLive;
        host.terminal({ k: 'tokens', out: this.tokensDone + this.tokensLive });
        return;
      case 'message_stop':
        this.tokensDone += this.tokensLive;
        this.tokensLive = 0;
        return;
    }
  }

  // Streams the text of a `message` or `reply` call as the model writes it, so the first bubble shows within the first tokens.
  private streamBubbles(event: Extract<SDKMessage, { type: 'stream_event' }>['event']) {
    if (!this.host.streamed) return;
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use' && BUBBLE_TOOLS.has(event.content_block.name)) {
      this.bubbles.set(event.index, { json: '', sent: 0 });
    } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      const bubble = this.bubbles.get(event.index);
      if (!bubble) return;
      bubble.json += event.delta.partial_json;
      const text = partialText(bubble.json);
      if (text.length > bubble.sent) {
        this.hop('first_delta');
        this.host.streamed(text.slice(bubble.sent));
      }
      bubble.sent = Math.max(bubble.sent, text.length);
    } else if (event.type === 'content_block_stop' && this.bubbles.delete(event.index)) {
      this.host.streamed('', true);
    }
  }

  private subagentStarted(id: string, parentId: string | null, input: Record<string, unknown>) {
    this.subagents.add(id);
    this.host.subagentStarted({ id, parentId, label: short(str(input.description), 60) || 'Helper', startedAt: Date.now() });
  }

  private subagentEnded(id: string | undefined) {
    if (id && this.subagents.delete(id)) this.host.subagentFinished(id);
  }

  // A tool_result that is an error also ends the subagent: a launch that failed, or a run the owner interrupted.
  private onUser(m: SDKUserMessage) {
    const { content } = m.message;
    if (typeof content === 'string') return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      if (block.is_error) this.subagentEnded(block.tool_use_id);
      // What a subagent does inside stays inside: the terminal shows its call and its result, not each of its steps.
      if (m.parent_tool_use_id !== null) continue;
      const text = typeof block.content === 'string' ? block.content : (block.content ?? []).flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
      this.host.terminal({ k: 'result', id: block.tool_use_id, ok: !block.is_error, text, data: m.tool_use_result });
    }
  }

  private onAssistant(m: Extract<SDKMessage, { type: 'assistant' }>) {
    const { host } = this;
    // A turn that started on its own (a message queued behind the last one) reopens the desk.
    if (host.employee.status.kind === 'idle') {
      host.setStatus({ kind: 'working', task: this.task, startedAt: this.startedAt });
    }
    for (const block of m.message.content) {
      if (block.type === 'tool_use') {
        const input = block.input as Record<string, unknown>;
        if (SUBAGENT_TOOLS.has(block.name)) this.subagentStarted(block.id, m.parent_tool_use_id, input);
        const line = describeTool(block.name, input, host.block.cwd);
        host.setActivity(line);
        if (block.name !== `${OFFICE_TOOL_PREFIX}ask_owner`) host.log(line); // the office logs the question itself
        if (m.parent_tool_use_id === null) host.terminal({ k: 'tool', id: block.id, name: block.name, input });
      } else if (block.type === 'text' && m.parent_tool_use_id === null) {
        const text = block.text.trim();
        if (!text) continue;
        this.hop('first_text');
        this.lastSaid = text;
        host.said(text);
        host.log(`Said: ${text}`);
        // The text was on the terminal as it streamed. Whole again here, under the same id, it corrects anything the stream missed.
        const streamed = [...this.blocks.values()].find((b) => b.kind === 'text' && b.text.trim() === text);
        host.terminal({ k: 'text', id: streamed?.id ?? `${m.uuid}:${text.length}`, text });
      }
    }
  }

  private onResult(m: SDKResultMessage) {
    const { host } = this;
    // An aborted turn is followed at once by the turn that handles the interjection. Its result looks like
    // a success with empty text, so only terminal_reason tells it apart from a finished task.
    const aborted = m.terminal_reason === 'aborted_tools' || m.terminal_reason === 'aborted_streaming';
    if (aborted || (this.interrupting && m.subtype !== 'success')) {
      this.tokensDone = 0;
      if (!this.ownerInterrupt) return debug('turn aborted, next turn incoming');
      // The owner pressed Esc and nothing follows: the turn is over.
      this.ownerInterrupt = false;
      this.interrupting = false;
      host.terminal({ k: 'end', how: 'interrupted' });
      return host.taskInterrupted();
    }
    this.ownerInterrupt = false;
    this.tokensDone = 0;
    if (m.subtype !== 'success' || m.is_error) {
      return this.reportError(('errors' in m && m.errors.join('; ')) || ('result' in m && m.result) || m.subtype);
    }
    const text = m.result.trim();
    host.terminal({ k: 'end', how: 'done' });
    host.taskCompleted(text);
    host.setActivity(short(text, 120) || 'Finished the task');
    host.setStatus({ kind: 'idle' });
    // The last assistant text block usually is the result. Do not say it twice.
    if (text && text !== this.lastSaid) host.said(short(text, 200));
    host.log(`Finished: ${short(text, 200) || this.task}`);
  }

  private canUseTool: CanUseTool = async (toolName, input, { signal }) => {
    // bypassPermissions still asks about a few protected paths, and YOLO bypasses every check.
    if (this.policy.mode === 'yolo' || runsUnasked(toolName)) return { behavior: 'allow', updatedInput: input };
    const { cwd } = this.host.block;
    const answer = await this.host.ask(permissionBody(toolName, input, cwd), AbortSignal.any([signal, this.life.signal]));
    if (isAllow(answer)) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: `The boss did not allow this. They said: ${answer || 'no'}` };
  };
}

export const createClaudeSession: SessionFactory = (host) => new ClaudeSession(host, query);
