import type { InterruptStyle, QuestionId } from '../../shared/protocol.ts';
import type { EmployeeSession, SessionFactory, SessionHost } from './types.ts';

// Fake worker for providers without a real adapter. Same contract, no tokens spent.

const ACTIVITIES = [
  'Reading the codebase',
  'Sketching the data model',
  'Editing files',
  'Running tests',
  'Checking the docs',
  'Refactoring a helper',
  'Wiring things together',
];
const CHATTER = ['Making progress.', 'Found something interesting in here.', 'This is coming together.', 'Almost there on this part.'];

const QUESTIONS = [
  (t: string) => ({ text: `For ${t}, do you want it quick and scrappy or polished?`, options: ['Quick and scrappy', 'Polished'] }),
  (t: string) => ({ text: `On ${t}, is it ok if I touch shared files?`, options: ['Go ahead', 'Keep it isolated'] }),
  (t: string) => ({ text: `Should I add tests for ${t}?`, options: ['Yes', 'No'] }),
];

const short = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      reject(new Error('stopped'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', done);
      resolve();
    }, ms);
    signal.addEventListener('abort', done, { once: true });
  });

const flowchart = (task: string) => {
  const label = short(task, 40).replace(/["[\]{}()<>]/g, "'");
  return [
    'flowchart TD',
    `  A["Understand: ${label}"] --> B["Sketch the approach"]`,
    '  B --> C["Build it"]',
    '  C --> D["Run tests"]',
    '  D --> E["Ship it"]',
  ].join('\n');
};

class SimulatedSession implements EmployeeSession {
  private run?: AbortController;
  private pending?: { id: QuestionId; resolve(text: string): void };
  private tick = 0;

  constructor(private host: SessionHost) {}

  assign(task: string) {
    this.run?.abort();
    const run = new AbortController();
    this.run = run;
    this.work(task, run.signal).catch((e: unknown) => {
      if (!run.signal.aborted) this.host.setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  }

  interject(text: string, _style: InterruptStyle) {
    const { kind } = this.host.employee.status;
    if (kind === 'idle' || kind === 'error') return this.assign(text);
    const trimmed = short(text, 50).replace(/[.!?]+$/, '');
    const gist = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
    this.host.said(`Got it, ${gist}. Adjusting.`);
    this.host.log(`Boss said: ${text}`);
    this.host.setActivity('Adjusting to what the boss said');
  }

  answer(questionId: QuestionId, text: string) {
    if (this.pending?.id !== questionId) return;
    const { resolve } = this.pending;
    this.pending = undefined;
    resolve(text);
  }

  stop() {
    this.run?.abort();
  }

  private async work(task: string, signal: AbortSignal) {
    const { host } = this;
    const startedAt = Date.now();
    const label = `'${short(task, 40)}'`;
    host.setStatus({ kind: 'working', task, startedAt });
    host.log(`Picked up ${label}`);

    await this.busy(15_000, signal);

    const pick = [...task].reduce((n, c) => n + c.charCodeAt(0), 0) % QUESTIONS.length;
    const { text, options } = QUESTIONS[pick]!(label);
    const answer = await this.ask(text, options, task, startedAt, signal);
    host.said(`Thanks, ${short(answer, 40)} it is.`);
    host.log(`Boss answered: ${answer}`);

    await this.busy(10_000, signal);

    host.drawWhiteboard(`Plan: ${short(task, 40)}`, flowchart(task));
    host.setActivity('Drawing on the whiteboard');
    host.log('Drew the plan on the whiteboard');
    await sleep(2_000, signal);

    host.taskCompleted();
    host.setActivity(`Finished ${label}`);
    host.setStatus({ kind: 'idle' });
    host.said(`Finished ${label}.`);
    host.log(`Finished ${label}`);
  }

  // Cycles activity lines every 3 to 5 seconds, chattering out loud now and then.
  private async busy(ms: number, signal: AbortSignal) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const line = ACTIVITIES[this.tick % ACTIVITIES.length]!;
      this.host.setActivity(line);
      this.host.log(line);
      if (this.tick % 3 === 2) this.host.said(CHATTER[Math.floor(this.tick / 3) % CHATTER.length]!);
      this.tick++;
      await sleep(3_000 + Math.random() * 2_000, signal);
    }
  }

  private ask(text: string, options: string[], task: string, startedAt: number, signal: AbortSignal) {
    const question = { id: crypto.randomUUID() as QuestionId, text, options, askedAt: Date.now() };
    this.host.setActivity('Asking the boss');
    this.host.log(`Asking: ${text}`);
    this.host.setStatus({ kind: 'blocked_on_owner', task, question });
    return new Promise<string>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      this.pending = {
        id: question.id,
        resolve: (answer) => {
          this.host.setStatus({ kind: 'working', task, startedAt });
          resolve(answer);
        },
      };
    });
  }
}

export const createSimulatedSession: SessionFactory = (host) => new SimulatedSession(host);
