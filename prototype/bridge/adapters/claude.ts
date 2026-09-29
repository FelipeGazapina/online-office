import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { InterruptStyle, Question, QuestionId } from '../../shared/protocol.ts';
import type { EmployeeSession, SessionFactory, SessionHost } from './types.ts';

const debug = (...a: unknown[]) => {
  if (process.env.OFFICE_DEBUG) console.log('[claude]', ...a);
};

const short = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');

// Tools that can never hurt anything, so the boss is not bothered.
const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent']);

// "Yes", "sim, pode fazer", "OK go" all count. Anything else is a no and the text goes back to the agent.
const ALLOW_WORDS = /^\s*(allow|yes|y|sure|ok|okay|sim|pode)\b/i;

const persona = (name: string, company: string, block: string) => `
You are ${name}, an employee at ${company} on the ${block} team. The owner of the company is your boss. You work in a shared office and your working directory is the ${block} project folder.

When you need a decision or are unsure about direction, call the ask_owner tool. You will physically walk over to the boss's desk and ask out loud. Keep the question short and easy to say aloud, and offer 2 to 4 options when that fits. Never use AskUserQuestion.

Your text replies are read aloud by text to speech. Keep conversational replies to 1 to 3 plain sentences with no markdown, lists, or code fences.

When you explain a design or a plan, draw it on the team whiteboard with the draw_diagram tool (mermaid) instead of describing it at length.

If the boss walks over and says something in the middle of your task, acknowledge it in one sentence and adapt.
`.trim();

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
    case 'mcp__office__ask_owner':
      return 'Asking the boss';
    case 'mcp__office__draw_diagram':
      return 'Drawing on the whiteboard';
    default:
      return `Using ${name}`;
  }
}

function permissionQuestion(name: string, input: Record<string, unknown>, cwd: string): string {
  if (name === 'Bash') return `Can I run \`${short(str(input.command), 120)}\`?`;
  const target = targetOf(input, cwd);
  return `Can I use ${name}${target ? ` on ${target}` : ''}?`;
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
  private pending?: { question: Question; resumeActivity: string; resolve(text: string): void };
  // Questions queue up: the status can only carry one at a time.
  private asking: Promise<unknown> = Promise.resolve();

  constructor(private host: SessionHost) {}

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

  answer(questionId: QuestionId, text: string) {
    const p = this.pending;
    if (p?.question.id !== questionId) return;
    this.pending = undefined;
    this.host.setStatus({ kind: 'working', task: this.task, startedAt: this.startedAt });
    this.host.setActivity(p.resumeActivity);
    p.resolve(text);
  }

  stop() {
    this.stopped = true;
    this.pending?.resolve('');
    this.pending = undefined;
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
    const { employee, block, companyName } = this.host;
    this.inbox = new PushQueue();
    this.gotInit = false;
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: block.cwd,
        model: process.env.OFFICE_CLAUDE_MODEL ?? 'claude-sonnet-5-5',
        // 'project' only: the boss's global plugins and hooks must not leak into employees.
        settingSources: ['project'],
        permissionMode: 'acceptEdits',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: persona(employee.name, companyName, block.name) },
        mcpServers: { office: this.officeServer() },
        // Without this the boss's claude.ai connectors (Gmail, Drive, Figma...) load into every employee.
        strictMcpConfig: true,
        // ask_owner is the only way to reach the boss; the built-in question tool would go nowhere.
        disallowedTools: ['AskUserQuestion'],
        canUseTool: this.canUseTool,
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
    this.pending?.resolve('');
    this.pending = undefined;
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
        if (block.name !== 'mcp__office__ask_owner') host.log(line); // askNow logs the question itself
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

  private canUseTool: CanUseTool = async (toolName, input) => {
    if (process.env.OFFICE_BASH === 'allow' || AUTO_ALLOW.has(toolName) || toolName.startsWith('mcp__office__')) {
      return { behavior: 'allow', updatedInput: input };
    }
    const { cwd } = this.host.block;
    const answer = await this.ask(permissionQuestion(toolName, input, cwd), ['Allow', 'Deny'], describeTool(toolName, input, cwd));
    if (ALLOW_WORDS.test(answer)) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: `The boss did not allow this. They said: ${answer || 'no'}` };
  };

  private ask(text: string, options?: string[], resumeActivity = 'Got the answer, back to work'): Promise<string> {
    const run = this.asking.then(() => this.askNow(text, options, resumeActivity));
    this.asking = run.catch(() => undefined);
    return run;
  }

  private askNow(text: string, options: string[] | undefined, resumeActivity: string): Promise<string> {
    if (this.stopped) return Promise.resolve('');
    const question: Question = { id: randomUUID() as QuestionId, text, options, askedAt: Date.now() };
    return new Promise((resolve) => {
      this.pending = { question, resumeActivity, resolve };
      this.host.setStatus({ kind: 'blocked_on_owner', task: this.task, question });
      this.host.setActivity('Asking the boss');
      this.host.log(`Asking the boss: ${text}${options ? ` [${options.join(' / ')}]` : ''}`);
    });
  }

  private officeServer() {
    return createSdkMcpServer({
      name: 'office',
      alwaysLoad: true,
      tools: [
        tool(
          'ask_owner',
          "Walk to the boss's desk and ask them a question out loud. Use it whenever you need a decision or are unsure about direction. Returns the boss's answer.",
          {
            question: z.string().describe('A short question that is easy to say aloud'),
            options: z.array(z.string()).max(4).optional().describe('2 to 4 short answers the boss can pick from'),
          },
          async ({ question, options }) => ({ content: [{ type: 'text', text: await this.ask(question, options) }] }),
        ),
        tool(
          'draw_diagram',
          'Draw a mermaid diagram on the team whiteboard so the boss and coworkers can see a design or plan.',
          {
            title: z.string().describe('Short title shown above the diagram'),
            mermaid: z.string().describe('Mermaid source, for example a flowchart'),
          },
          async ({ title, mermaid }) => {
            this.host.drawWhiteboard(title, mermaid);
            return { content: [{ type: 'text', text: 'Drawn on the whiteboard.' }] };
          },
        ),
      ],
    });
  }
}

export const createClaudeSession: SessionFactory = (host) => new ClaudeSession(host);
