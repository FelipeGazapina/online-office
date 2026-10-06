import { tmpdir } from 'node:os';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PushQueue, claudeCodeExecutable, sessionEnv, type ClaudeRun } from './adapters/claude.ts';
import { trace } from './trace.ts';

// The first bubble. A turn on the real model thinks for seconds before its first `message` call, so a small tool-free
// call with thinking off says the acknowledgement while the real turn starts in parallel.

const ACK_MODEL = () => process.env.OFFICE_ACK_MODEL ?? 'claude-haiku-4-5-20251001';
const ACK_TIMEOUT_MS = 15_000;

const SYSTEM = `You are a person on a small team. Your boss has just handed you a request.
Say what you would say out loud at once: one or two short plain sentences, in the first person, that tell the boss what you will do first.
Be specific to the request. Do not answer it, do not claim anything is done, and ask nothing.
No markdown, no lists, no tools. Under 40 words.`;

export type AckInput = { who: string; name: string; role: string; company: string; block: string; teammates: readonly string[]; request: string };

const ROLE = {
  orchestrator: 'the PO. You lead: you split the work between your teammates and check what they hand back. You do not build or write anything yourself, so say you will split the work or hand it to a teammate, never that you will do it.',
  employee: 'an employee.',
};

const promptOf = (i: AckInput) =>
  `You are ${i.name}, ${i.role === 'orchestrator' ? ROLE.orchestrator : ROLE.employee} Your team is ${i.block} at ${i.company}. Your teammates: ${i.teammates.join(', ') || 'none yet'}.\n\nThe boss sent you this request:\n\"\"\"\n${i.request}\n\"\"\"\n\nSay your acknowledgement now.`;

// One process that answers exactly one request, started ahead of time so the answer does not pay for the start.
class AckProcess {
  private readonly inbox = new PushQueue<SDKUserMessage>();
  private readonly q: ReturnType<ClaudeRun>;
  private dead = false;
  private turn?: { onDelta(delta: string): void; resolve(text: string | undefined): void };

  constructor(run: ClaudeRun) {
    const executable = claudeCodeExecutable();
    this.q = run({
      prompt: this.inbox,
      options: {
        cwd: tmpdir(),
        ...(executable && { pathToClaudeCodeExecutable: executable }),
        model: ACK_MODEL(),
        includePartialMessages: true,
        settingSources: [],
        strictMcpConfig: true,
        tools: [],
        thinking: { type: 'disabled' },
        maxTurns: 1,
        persistSession: false,
        systemPrompt: SYSTEM,
        env: sessionEnv(),
      },
    });
    void this.pump();
  }

  private async pump() {
    try {
      for await (const m of this.q) this.onMessage(m);
    } catch {
      // The caller gets undefined and the real turn carries on without an acknowledgement.
    }
    this.dead = true;
    this.settle(undefined);
  }

  private onMessage(m: SDKMessage) {
    if (m.type === 'stream_event' && m.event.type === 'content_block_delta' && m.event.delta.type === 'text_delta') {
      this.turn?.onDelta(m.event.delta.text);
    } else if (m.type === 'result') {
      this.settle(m.subtype === 'success' && !m.is_error ? m.result.trim() : undefined);
    }
  }

  private settle(text: string | undefined) {
    const turn = this.turn;
    this.turn = undefined;
    turn?.resolve(text);
  }

  ask(input: AckInput, onDelta: (delta: string) => void): Promise<string | undefined> {
    if (this.dead) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(undefined), ACK_TIMEOUT_MS);
      let first = true;
      this.turn = {
        onDelta: (delta) => {
          if (first) trace(input.who, 'ack_first_delta');
          first = false;
          onDelta(delta);
        },
        resolve: (text) => (clearTimeout(timer), resolve(text)),
      };
      this.inbox.push({ type: 'user', message: { role: 'user', content: promptOf(input) }, parent_tool_use_id: null });
    });
  }

  close() {
    this.dead = true;
    this.inbox.close();
    this.q.close();
  }
}

export class Acknowledger {
  private spare?: AckProcess;
  private enabled = false;
  private readonly run: ClaudeRun;

  constructor(run: ClaudeRun) {
    this.run = run;
  }

  // Keeps one process ready. Only an office that runs Claude employees pays for it.
  warm() {
    if (process.env.OFFICE_ACK === '0') return;
    this.enabled = true;
    this.spare ??= new AckProcess(this.run);
  }

  // Undefined at once when acknowledging is off, so the caller does not tell the real turn that one is coming.
  ack(input: AckInput, onDelta: (delta: string) => void): Promise<string | undefined> | undefined {
    if (!this.enabled) return undefined;
    return this.answer(input, onDelta);
  }

  private async answer(input: AckInput, onDelta: (delta: string) => void) {
    const proc = this.spare ?? new AckProcess(this.run);
    this.spare = undefined;
    trace(input.who, 'ack_start');
    try {
      return await proc.ask(input, onDelta);
    } finally {
      proc.close();
      if (this.enabled) this.spare ??= new AckProcess(this.run);
    }
  }

  stop() {
    this.enabled = false;
    this.spare?.close();
    this.spare = undefined;
  }
}

export const createAcknowledger = () => new Acknowledger(query);
