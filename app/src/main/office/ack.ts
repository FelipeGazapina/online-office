import { tmpdir } from 'node:os';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PushQueue, claudeCodeExecutable, sessionEnv, type ClaudeRun } from './adapters/claude.ts';
import type { OwnerIntent } from './owner-intent.ts';
import { trace } from './trace.ts';

// The first bubble. A turn on the real model thinks for seconds before its first `message` call, so a small tool-free
// call with thinking off says the acknowledgement while the real turn starts in parallel.
// The same call sorts the owner's message into a question or a work order (triage) before it is posted: it writes the sort
// word first and the acknowledgement after it, so one process does both and the sort costs no second start.
// Only a message the owner typed gets this call. A task the board hands out, an answer to a blocked person and every other
// request the office writes on the owner's behalf start a turn with no call and no process.

const ACK_MODEL = () => process.env.OFFICE_ACK_MODEL ?? 'claude-haiku-4-5-20251001';
const ACK_TIMEOUT_MS = 15_000;
// The sort holds the owner's post, so it gets a short leash. An answer that is late is no answer and the post goes as work.
const SORT_LEASH_MS = 2_500;
const CLIP = 2_000;
// Most processes alive at once: one answering and the spare started behind it. A cold start is 2 to 6 s on a busy machine,
// so a call cannot wait for a process to start, and a crowd of spares cannot be kept.
const MAX_LIVE = 2;
// A call nobody claimed, because its request is queued behind a long turn or was never posted, is let go after this.
const UNCLAIMED_MS = 20_000;

const SYSTEM = `You are a person on a small team. Your boss has just written to you. Reply in two parts.
Part one, alone on the first line, is one word that sorts the boss's message:
QUESTION: the boss only wants information. A complete answer is words, and no file in the project has to be made or changed.
WORK: the boss wants something made or changed in the project (code, tests, docs, configuration), including a polite order phrased as a question ("can you add ...?") and a question that also orders a change.
The message may be in any language. When unsure, write WORK.
Part two starts on the next line. It is what you would say out loud at once: one or two short plain sentences, in the first person, that tell the boss what you will do first.
Be specific to the message. Do not answer it, do not claim anything is done, and ask nothing.
No markdown, no lists, no tools. Under 40 words.`;

export type AckInput = { who: string; name: string; role: string; company: string; block: string; teammates: readonly string[]; request: string };

const ROLE = {
  orchestrator:
    'the PO. You lead: you split the work between your teammates and check what they hand back. You do not build or write anything yourself, so for work say you will split it or hand it to a teammate, never that you will do it. A question you look into yourself and answer, so for a question do not say you will hand it to a teammate or split it.',
  employee: 'an employee.',
};

const clip = (text: string) => (text.length > CLIP ? `${text.slice(0, CLIP / 2)}\n[...]\n${text.slice(-CLIP / 2)}` : text);

const promptOf = (i: AckInput) =>
  `You are ${i.name}, ${i.role === 'orchestrator' ? ROLE.orchestrator : ROLE.employee} Your team is ${i.block} at ${i.company}. Your teammates: ${i.teammates.join(', ') || 'none yet'}.\n\nThe boss wrote to you:\n"""\n${clip(i.request)}\n"""\n\nSort it, then say your acknowledgement.`;

// What a reply has said of its sort word so far. Undefined while the first word may still become one of the two. Case-blind, and
// "Question:" or "work." count. A reply that opens with anything else has no sort, and all of it is the acknowledgement.
const SORT_WORD = /^\s*(QUESTION|WORK)\b[\s:.,;-]*/i;
function readSort(text: string, ended: boolean): { intent?: OwnerIntent; words: string } | undefined {
  const m = SORT_WORD.exec(text);
  if (m) {
    if (!ended && m[0].trimStart().length === m[1]!.length) return undefined;
    return { intent: m[1]!.toUpperCase() === 'QUESTION' ? 'help' : 'work', words: text.slice(m[0].length) };
  }
  const head = text.trimStart().toUpperCase();
  if (!ended && (head === '' || 'QUESTION'.startsWith(head) || 'WORK'.startsWith(head))) return undefined;
  return { words: text };
}

// One process that answers exactly one prompt, started ahead of time so the answer does not pay for the start.
class OneShot {
  private readonly inbox = new PushQueue<SDKUserMessage>();
  private readonly q: ReturnType<ClaudeRun>;
  private gone = false;
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

  get dead() {
    return this.gone;
  }

  private async pump() {
    try {
      for await (const m of this.q) this.onMessage(m);
    } catch {
      // The caller gets undefined and the real turn carries on without an acknowledgement.
    }
    this.gone = true;
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

  ask(prompt: string, timeoutMs: number, onDelta: (delta: string) => void): Promise<string | undefined> {
    if (this.gone) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(undefined), timeoutMs);
      this.turn = { onDelta, resolve: (text) => (clearTimeout(timer), resolve(text)) };
      this.inbox.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
    });
  }

  close() {
    this.gone = true;
    this.inbox.close();
    this.q.close();
  }
}

// One owner message in flight: what the process has written of it so far, split into the sort and the acknowledgement.
class Call {
  // The sort, as soon as its word is read. Undefined when the leash runs out, the call fails or the reply names no sort.
  readonly sort: Promise<OwnerIntent | undefined>;
  // The whole acknowledgement once the process is done. Undefined when it failed or said nothing.
  readonly said: Promise<string | undefined>;
  private sortNow: (intent: OwnerIntent | undefined) => void = () => {};
  private saidNow: (text: string | undefined) => void = () => {};
  private readonly who: string;
  private read = '';
  private opened = false;
  private started = false;
  // Words written before anyone was listening, handed over whole when somebody is.
  private held = '';
  private sink?: (delta: string) => void;

  constructor(who: string, leashMs: number) {
    this.who = who;
    this.sort = new Promise((resolve) => (this.sortNow = resolve));
    this.said = new Promise((resolve) => (this.saidNow = resolve));
    const leash = setTimeout(() => this.sortNow(undefined), leashMs);
    void this.sort.then(() => clearTimeout(leash));
  }

  feed(delta: string) {
    if (this.opened) return this.say(delta);
    this.read += delta;
    const sorted = readSort(this.read, false);
    if (!sorted) return;
    this.opened = true;
    this.sortNow(sorted.intent);
    trace(this.who, 'sorted');
    this.say(sorted.words);
  }

  end(text: string | undefined) {
    const sorted = text === undefined ? undefined : readSort(text, true);
    this.sortNow(sorted?.intent);
    this.saidNow(sorted?.words.trim() || undefined);
  }

  listen(sink: (delta: string) => void) {
    this.sink = sink;
    if (this.held) sink(this.held);
    this.held = '';
  }

  private say(delta: string) {
    const words = this.started ? delta : delta.trimStart();
    if (!words) return;
    if (!this.started) trace(this.who, 'ack_first_delta');
    this.started = true;
    if (this.sink) this.sink(words);
    else this.held += words;
  }
}

export class Acknowledger {
  // The process kept ready for the next owner message, and every process not yet closed (the spare, the ones answering).
  private spare?: OneShot;
  private readonly live = new Set<OneShot>();
  // Owner messages in flight, by the key their request is posted under.
  private readonly calls = new Map<string, { call: Call; unclaimed: NodeJS.Timeout }>();
  private enabled = false;
  private readonly run: ClaudeRun;
  private readonly maxLive: number;
  private readonly unclaimedMs: number;

  constructor(run: ClaudeRun, options: { maxLive?: number; unclaimedMs?: number } = {}) {
    this.run = run;
    this.maxLive = options.maxLive ?? MAX_LIVE;
    this.unclaimedMs = options.unclaimedMs ?? UNCLAIMED_MS;
  }

  // Keeps a spare process ready. Only an office that runs Claude employees pays for it.
  warm() {
    if (process.env.OFFICE_ACK === '0') return;
    this.enabled = true;
    this.refill();
  }

  // The owner typed `input.request`, and the request will be posted under `key`. Starts the one call that sorts it and writes the
  // first words. Resolves with the sort, or undefined when the call fails, runs past the leash or does not name a sort, so the caller
  // treats the message as work, the kind that has to show files. Undefined at once when acknowledging is off or all the processes are
  // busy: the message is posted as work and its real turn says its own first words. `OFFICE_TRIAGE=0` ignores the sort.
  hear(key: string, input: AckInput, leashMs = SORT_LEASH_MS): Promise<OwnerIntent | undefined> | undefined {
    if (!this.enabled) return undefined;
    const known = this.calls.get(key);
    if (known) return known.call.sort;
    const proc = this.take();
    if (!proc) return undefined;
    trace(input.who, 'ack_start');
    const call = new Call(input.who, leashMs);
    const unclaimed = setTimeout(() => this.calls.delete(key), this.unclaimedMs);
    unclaimed.unref();
    this.calls.set(key, { call, unclaimed });
    void proc.ask(promptOf(input), ACK_TIMEOUT_MS, (delta) => call.feed(delta)).then((text) => {
      call.end(text);
      this.release(proc);
    });
    return process.env.OFFICE_TRIAGE === '0' ? Promise.resolve(undefined) : call.sort;
  }

  // The request posted under `key` has been delivered: hands over the first words, streaming what is still being written.
  // Undefined when the owner did not type it (nobody heard it), so no acknowledgement is spoken and the real turn says its own.
  ack(key: string | undefined, onDelta: (delta: string) => void): Promise<string | undefined> | undefined {
    const claimed = key === undefined ? undefined : this.calls.get(key);
    if (!claimed) return undefined;
    clearTimeout(claimed.unclaimed);
    this.calls.delete(key!);
    claimed.call.listen(onDelta);
    return claimed.call.said;
  }

  // A process to answer with: the spare, else a new one while there is room. Another spare is started behind it.
  private take(): OneShot | undefined {
    let proc = this.spare;
    this.spare = undefined;
    if (proc?.dead) {
      this.drop(proc);
      proc = undefined;
    }
    proc ??= this.live.size < this.maxLive ? this.spawn() : undefined;
    this.refill();
    return proc;
  }

  private spawn() {
    const proc = new OneShot(this.run);
    this.live.add(proc);
    trace('acker', `live_${this.live.size}`);
    return proc;
  }

  private refill() {
    if (this.enabled && !this.spare && this.live.size < this.maxLive) this.spare = this.spawn();
  }

  private drop(proc: OneShot) {
    proc.close();
    this.live.delete(proc);
  }

  private release(proc: OneShot) {
    this.drop(proc);
    this.refill();
  }

  stop() {
    this.enabled = false;
    for (const { unclaimed } of this.calls.values()) clearTimeout(unclaimed);
    this.calls.clear();
    for (const proc of this.live) proc.close();
    this.live.clear();
    this.spare = undefined;
  }
}

export const createAcknowledger = () => new Acknowledger(query);
