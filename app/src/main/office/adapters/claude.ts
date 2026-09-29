import { isAbsolute, relative } from 'node:path';
import {
  query,
  type CanUseTool,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { SHELL_TOOL, isAllow } from '../../../shared/permissions.ts';
import type { InterruptStyle, QuestionBody } from '../../../shared/protocol.ts';
import { logger } from '../debug.ts';
import { persona } from '../persona.ts';
import type { EmployeeSession, SessionFactory, SessionHost } from './types.ts';

const debug = logger('claude');

const short = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');

// Permission policy. Everything that decides whether a tool asks the boss is in this block, so it can be swapped
// for the owner's own settings in one place. Every question still goes out through `host.ask` in `canUseTool`.
const PERMISSION_MODE = 'acceptEdits' as const;

// Tools that can never hurt anything, so the boss is not bothered.
const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent']);

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

// The SDK's streaming input takes an async iterable. This is the smallest one we can push into.
class PushQueue<T> implements AsyncIterable<T> {
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

class ClaudeSession implements EmployeeSession {
  private q?: Query;
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

  private readonly host: SessionHost;

  constructor(host: SessionHost) {
    this.host = host;
  }

  assign(task: string) {
    this.beginTask(task);
    this.send(task);
  }

  interject(text: string, style: InterruptStyle) {
    const framed = `[Your boss walked over to your desk and said out loud]: ${text}`;
    const { kind } = this.host.employee.status;
    this.host.log(`Boss said: ${text}`);
    if (kind === 'idle' || kind === 'error') {
      this.beginTask(short(text, 80));
      this.send(framed);
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
    debug(`session start for ${employee.name}, memory digest:\n${digest || '(no notes yet)'}`);
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: block.cwd,
        model: this.host.model,
        // 'project' only: the boss's global plugins and hooks must not leak into employees.
        settingSources: ['project'],
        permissionMode: PERMISSION_MODE,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: persona({ name: employee.name, company: companyName, block: block.name, digest }),
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

  private async pump(q: Query) {
    try {
      for await (const m of q) this.onMessage(m);
      if (!this.stopped) this.fail('The session ended unexpectedly');
    } catch (e) {
      if (!this.stopped) this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  // The process is gone. The next assign starts a new one, resuming the stored session.
  private fail(message: string) {
    // A resume that dies before init means the stored session is gone. Start clean next time.
    if (!this.gotInit) this.host.setSessionId('');
    this.q?.close();
    this.q = undefined;
    this.life.abort();
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
    } else if (m.type === 'result') {
      this.onResult(m);
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
        const line = describeTool(block.name, block.input as Record<string, unknown>, host.block.cwd);
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

export const createClaudeSession: SessionFactory = (host) => new ClaudeSession(host);
