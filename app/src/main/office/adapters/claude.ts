import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  query,
  type CanUseTool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { SHELL_TOOL, isAllow } from '../../../shared/permissions.ts';
import type { InterruptStyle, ModelCatalog, ModelId, ModelOption, PermissionPolicy, QuestionBody } from '../../../shared/protocol.ts';
import { logger } from '../debug.ts';
import { persona } from '../persona.ts';
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

// Permission policy. Everything that decides whether a tool asks the boss is in this block, so it can be swapped
// for the owner's own settings in one place. Every question still goes out through `host.ask` in `canUseTool`.
// F1 maps the four modes onto Claude's here. Until then every mode runs the way it always has.
const permissionModeFor = (_policy: PermissionPolicy) => 'acceptEdits' as const;

// Tools that can never hurt anything, so the boss is not bothered.
const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent']);

// The tools that start a subagent. Claude runs them in the background unless told otherwise: the tool_result of the call
// is then a "launched" placeholder, and only a task_notification says the subagent is done.
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

// The office's own tools are how an employee reaches the boss, so they never ask.
const OFFICE_TOOL_PREFIX = 'mcp__office__';

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
const sessionEnv = (): Record<string, string | undefined> => ({
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
type Live = AsyncIterable<SDKMessage> & Pick<Query, 'interrupt' | 'setModel' | 'close'>;
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
  // Ends with the process, so a permission question left open by a dead process is withdrawn from the owner's desk.
  private life = new AbortController();

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

  assign(task: string) {
    this.beginTask(task);
    this.send(this.withNotices(task));
  }

  interject(text: string, style: InterruptStyle) {
    const framed = `[Your boss walked over to your desk and said out loud]: ${text}`;
    const { kind } = this.host.employee.status;
    this.host.log(`Boss said: ${text}`);
    if (kind === 'idle' || kind === 'error') {
      this.beginTask(short(text, 80));
      this.send(this.withNotices(framed));
    } else if (style === 'now') {
      void this.interruptThenSend(framed);
    } else {
      this.send(framed, 'next');
    }
  }

  // priority 'now' alone only aborts at the next tool boundary: a Bash that is already running finishes first.
  // interrupt() kills the running step, so we do both to honour "drop the current step and listen".
  private async interruptThenSend(text: string) {
    this.interrupting = true;
    try {
      await this.q?.interrupt();
    } catch (e) {
      debug('interrupt failed:', e);
    }
    if (!this.stopped) this.send(text, 'now');
  }

  // A live session switches models for its next turn. Without one, the next start reads `host.model`. The SDK refuses an
  // id its bundled Claude Code does not describe, even one that works as a start option, so the owner is told.
  setModel(model: ModelId) {
    this.q?.setModel(model).then(
      () => debug(`model switched to ${model}`),
      (e: unknown) => this.host.log(`Could not switch to ${model}, still on the previous model: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  permissionsChanged(policy: PermissionPolicy) {
    this.policy = policy;
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

  private send(text: string, priority?: InterruptStyle) {
    if (!this.q) this.start();
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
    this.q = this.run({
      prompt: this.inbox,
      options: {
        cwd: block.cwd,
        ...(executable && { pathToClaudeCodeExecutable: executable }),
        model: this.host.model,
        // 'project' only: the boss's global plugins and hooks must not leak into employees.
        settingSources: ['project'],
        permissionMode: permissionModeFor(this.policy),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: persona({ name: employee.name, company: companyName, block: block.name, role: employee.role, digest, rules }),
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
    // A resume that dies before init means the stored session is gone. Start clean next time.
    if (!this.gotInit) this.host.setSessionId('');
    this.q?.close();
    this.q = undefined;
    this.life.abort();
    for (const id of this.subagents) this.host.subagentFinished(id);
    this.subagents.clear();
    // The next process reads the rules as they are then.
    this.notices = [];
    this.reportError(message);
  }

  // This turn failed but the process is fine, so the conversation carries on with the next message.
  private reportError(message: string) {
    debug('error:', message);
    this.host.setStatus({ kind: 'error', message });
    this.host.setActivity(`Something went wrong: ${short(message, 80)}`);
    this.host.log(`Error: ${message}`);
  }

  private onMessage(m: SDKMessage) {
    const { host } = this;
    if (m.type === 'system' && m.subtype === 'init') {
      this.gotInit = true;
      this.interrupting = false;
      if (host.employee.sessionId !== m.session_id) host.setSessionId(m.session_id);
      debug(
        `init model=${m.model} tools=${m.tools.length} skills=${m.skills.length} plugins=${m.plugins.map((p) => p.name)} mcp=${m.mcp_servers.map((s) => `${s.name}:${s.status}`)}`,
      );
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
    for (const block of content) if (block.type === 'tool_result' && block.is_error) this.subagentEnded(block.tool_use_id);
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
      } else if (block.type === 'text' && m.parent_tool_use_id === null) {
        const text = block.text.trim();
        if (!text) continue;
        this.lastSaid = text;
        host.said(text);
        host.log(`Said: ${text}`);
      }
    }
  }

  private onResult(m: SDKResultMessage) {
    const { host } = this;
    // An aborted turn is followed at once by the turn that handles the interjection. Its result looks like
    // a success with empty text, so only terminal_reason tells it apart from a finished task.
    const aborted = m.terminal_reason === 'aborted_tools' || m.terminal_reason === 'aborted_streaming';
    if (aborted || (this.interrupting && m.subtype !== 'success')) {
      debug('turn aborted, next turn incoming');
      return;
    }
    if (m.subtype !== 'success' || m.is_error) {
      return this.reportError(('errors' in m && m.errors.join('; ')) || ('result' in m && m.result) || m.subtype);
    }
    const text = m.result.trim();
    host.taskCompleted();
    host.setActivity(short(text, 120) || 'Finished the task');
    host.setStatus({ kind: 'idle' });
    // The last assistant text block usually is the result. Do not say it twice.
    if (text && text !== this.lastSaid) host.said(short(text, 200));
    host.log(`Finished: ${short(text, 200) || this.task}`);
  }

  private canUseTool: CanUseTool = async (toolName, input, { signal }) => {
    if (runsUnasked(toolName)) return { behavior: 'allow', updatedInput: input };
    const { cwd } = this.host.block;
    const answer = await this.host.ask(permissionBody(toolName, input, cwd), AbortSignal.any([signal, this.life.signal]));
    if (isAllow(answer)) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: `The boss did not allow this. They said: ${answer || 'no'}` };
  };
}

export const createClaudeSession: SessionFactory = (host) => new ClaudeSession(host, query);
