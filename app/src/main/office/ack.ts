import { tmpdir } from 'node:os';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PushQueue, claudeCodeExecutable, sessionEnv, type ClaudeRun } from './adapters/claude.ts';
import type { OwnerIntent } from './owner-intent.ts';
import { trace } from './trace.ts';

// The first bubble. A turn on the real model thinks for seconds before its first `message` call, so a small tool-free
// call with thinking off says the acknowledgement while the real turn starts in parallel.
// The same kind of call also sorts the owner's message into a question or a work order (triage), before it is posted.

const ACK_MODEL = () => process.env.OFFICE_ACK_MODEL ?? 'claude-haiku-4-5-20251001';
const ACK_TIMEOUT_MS = 15_000;
// Triage holds the owner's post, so it gets a short leash. An answer that is late is no answer and the post goes as work.
const TRIAGE_TIMEOUT_MS = 2_500;
const TRIAGE_CLIP = 2_000;

const ACK_SYSTEM = `You are a person on a small team. Your boss has just handed you a request.
Say what you would say out loud at once: one or two short plain sentences, in the first person, that tell the boss what you will do first.
Be specific to the request. Do not answer it, do not claim anything is done, and ask nothing.
No markdown, no lists, no tools. Under 40 words.`;

const TRIAGE_SYSTEM = `You sort a boss's message to a team member into one of two kinds.
QUESTION: the boss only wants information. A complete answer is words, and no file in the project has to be made or changed.
WORK: the boss wants something made or changed in the project (code, tests, docs, configuration), including a polite order phrased as a question ("can you add ...?") and a question that also orders a change.
The message may be in any language. When unsure, answer WORK.
Reply with exactly one word: QUESTION or WORK.`;

export type AckInput = { who: string; name: string; role: string; company: string; block: string; teammates: readonly string[]; request: string };

const ROLE = {
  orchestrator: 'the PO. You lead: you split the work between your teammates and check what they hand back. You do not build or write anything yourself, so say you will split the work or hand it to a teammate, never that you will do it.',
  employee: 'an employee.',
};

const promptOf = (i: AckInput) =>
  `You are ${i.name}, ${i.role === 'orchestrator' ? ROLE.orchestrator : ROLE.employee} Your team is ${i.block} at ${i.company}. Your teammates: ${i.teammates.join(', ') || 'none yet'}.\n\nThe boss sent you this request:\n\"\"\"\n${i.request}\n\"\"\"\n\nSay your acknowledgement now.`;

// One process that answers exactly one prompt, started ahead of time so the answer does not pay for the start.
class OneShot {
  private readonly inbox = new PushQueue<SDKUserMessage>();
  private readonly q: ReturnType<ClaudeRun>;
  private dead = false;
  private turn?: { onDelta(delta: string): void; resolve(text: string | undefined): void };

  constructor(run: ClaudeRun, system: string) {
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
        systemPrompt: system,
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

  ask(prompt: string, timeoutMs: number, onDelta: (delta: string) => void = () => {}): Promise<string | undefined> {
    if (this.dead) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(undefined), timeoutMs);
      this.turn = { onDelta, resolve: (text) => (clearTimeout(timer), resolve(text)) };
      this.inbox.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
    });
  }

  close() {
    this.dead = true;
    this.inbox.close();
    this.q.close();
  }
}

type Kind = 'ack' | 'triage';
const SYSTEMS: Record<Kind, string> = { ack: ACK_SYSTEM, triage: TRIAGE_SYSTEM };

const clip = (text: string) => (text.length > TRIAGE_CLIP ? `${text.slice(0, TRIAGE_CLIP / 2)}\n[...]\n${text.slice(-TRIAGE_CLIP / 2)}` : text);

export class Acknowledger {
  // One spare process per kind of call, replaced after each use.
  private spares = new Map<Kind, OneShot>();
  private enabled = false;
  private readonly run: ClaudeRun;

  constructor(run: ClaudeRun) {
    this.run = run;
  }

  // Keeps spare processes ready. Only an office that runs Claude employees pays for them.
  warm() {
    if (process.env.OFFICE_ACK === '0') return;
    this.enabled = true;
    this.refill('ack');
    this.refill('triage');
  }

  // Undefined at once when acknowledging is off, so the caller does not tell the real turn that one is coming.
  ack(input: AckInput, onDelta: (delta: string) => void): Promise<string | undefined> | undefined {
    if (!this.enabled) return undefined;
    trace(input.who, 'ack_start');
    let first = true;
    return this.answer('ack', promptOf(input), ACK_TIMEOUT_MS, (delta) => {
      if (first) trace(input.who, 'ack_first_delta');
      first = false;
      onDelta(delta);
    });
  }

  // Which kind of message the owner wrote. Undefined at once when triage is off, and undefined later when the call fails or
  // runs late, so the caller treats the message as work, the kind that has to show files.
  triage(text: string): Promise<OwnerIntent | undefined> | undefined {
    if (!this.enabled || process.env.OFFICE_TRIAGE === '0') return undefined;
    return this.answer('triage', `The boss wrote:\n"""\n${clip(text)}\n"""`, TRIAGE_TIMEOUT_MS).then((word) => (/^QUESTION\b/i.test(word ?? '') ? 'help' : /^WORK\b/i.test(word ?? '') ? 'work' : undefined));
  }

  private refill(kind: Kind) {
    if (!this.spares.has(kind)) this.spares.set(kind, new OneShot(this.run, SYSTEMS[kind]));
  }

  private async answer(kind: Kind, prompt: string, timeoutMs: number, onDelta?: (delta: string) => void) {
    const proc = this.spares.get(kind) ?? new OneShot(this.run, SYSTEMS[kind]);
    this.spares.delete(kind);
    try {
      return await proc.ask(prompt, timeoutMs, onDelta);
    } finally {
      proc.close();
      if (this.enabled) this.refill(kind);
    }
  }

  stop() {
    this.enabled = false;
    for (const spare of this.spares.values()) spare.close();
    this.spares.clear();
  }
}

export const createAcknowledger = () => new Acknowledger(query);
