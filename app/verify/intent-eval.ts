// Confusion matrix of the candidates that tell a question from a work order, on the fixed sets in owner-messages.ts.
// h = the offline text rules (src/main/office/owner-intent.ts). l = a haiku call with thinking off, like the acknowledgement's.
// Run from app/: node verify/intent-eval.ts [--set A|B|AB] [--cand h,l] [--n 3] [--par 6]
// A "work order called a question" is the dangerous cell: it would settle without files. A "question called work" is the
// status quo (a good answer tagged blocked).
import { tmpdir } from 'node:os';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PushQueue, claudeCodeExecutable, sessionEnv } from '../src/main/office/adapters/claude.ts';
import { ownerIntent } from '../src/main/office/owner-intent.ts';
import { SET_A, type Kind, type Labeled } from './owner-messages.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const which = arg('set', 'A');
const cands = arg('cand', 'h,l').split(',');
const N = Number(arg('n', '3'));
const PAR = Number(arg('par', '6'));
const MODEL = process.env.OFFICE_ACK_MODEL ?? 'claude-haiku-4-5-20251001';

const sets: Record<string, readonly Labeled[]> = { A: SET_A };
if (which.includes('B')) sets.B = (await import('./owner-messages.ts')).SET_B;
const items = [...(which.includes('A') ? SET_A.map((m) => ({ ...m, set: 'A' })) : []), ...(which.includes('B') ? (sets.B ?? []).map((m) => ({ ...m, set: 'B' })) : [])];

const SYSTEM = `You sort a boss's message to a team member into one of two kinds.
QUESTION: the boss only wants information. A complete answer is words, and no file in the project has to be made or changed.
WORK: the boss wants something made or changed in the project (code, tests, docs, configuration), including a polite order phrased as a question ("can you add ...?") and a question that also orders a change.
The message may be in any language. When unsure, answer WORK.
Reply with exactly one word: QUESTION or WORK.`;

type Call = { kind: Kind | 'none'; ms: number };

// One process answers one message, started ahead of time like the acknowledger's spare, so the time is the call and not the start.
const askModel = async (text: string): Promise<Call> => {
  const inbox = new PushQueue<SDKUserMessage>();
  const executable = claudeCodeExecutable();
  const q = query({
    prompt: inbox,
    options: {
      cwd: tmpdir(),
      ...(executable && { pathToClaudeCodeExecutable: executable }),
      model: MODEL,
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
  const result = new Promise<string | undefined>((resolve) => {
    void (async () => {
      try {
        for await (const m of q as AsyncIterable<SDKMessage>) if (m.type === 'result') return resolve(m.subtype === 'success' && !m.is_error ? m.result.trim() : undefined);
      } catch {}
      resolve(undefined);
    })();
  });
  await new Promise((r) => setTimeout(r, 6000));
  const t0 = performance.now();
  inbox.push({ type: 'user', message: { role: 'user', content: `The boss wrote:\n"""\n${text}\n"""` }, parent_tool_use_id: null });
  const out = await Promise.race([result, new Promise<undefined>((r) => setTimeout(() => r(undefined), 30_000))]);
  const ms = performance.now() - t0;
  inbox.close();
  q.close();
  const kind = /^QUESTION\b/i.test(out ?? '') ? 'question' : /^WORK\b/i.test(out ?? '') ? 'work' : 'none';
  return { kind, ms };
};

const pool = async <T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < xs.length) { const i = next++; out[i] = await f(xs[i]!); } }));
  return out;
};

type Row = { text: string; is: Kind; set: string; said: (Kind | 'none')[]; ms: number[] };

const matrix = (rows: Row[]) => {
  // Rows are the truth, columns what the candidate said. A call that failed to answer counts as work, the safe default.
  const m = { question: { question: 0, work: 0 }, work: { question: 0, work: 0 } };
  for (const r of rows) for (const s of r.said) m[r.is][s === 'question' ? 'question' : 'work']++;
  return m;
};

const show = (name: string, rows: Row[]) => {
  const m = matrix(rows);
  console.log(`\n${name}`);
  console.log('                     said question   said work');
  console.log(`  is question        ${String(m.question.question).padStart(8)}   ${String(m.question.work).padStart(8)}   <- the work column is the status quo (answered, tagged blocked)`);
  console.log(`  is work            ${String(m.work.question).padStart(8)}   ${String(m.work.work).padStart(8)}   <- the question column must be 0 (settles with no files)`);
  for (const r of rows) {
    const wrong = r.said.filter((s) => (s === 'question') !== (r.is === 'question')).length;
    if (wrong) console.log(`  WRONG ${wrong}/${r.said.length} (is ${r.is}, said ${r.said.join('/')}) [${r.set}] ${r.text}`);
  }
  const ms = rows.flatMap((r) => r.ms).sort((a, b) => a - b);
  if (ms.length) console.log(`  latency ms: p50 ${ms[Math.floor(ms.length * 0.5)]!.toFixed(0)}  p95 ${ms[Math.floor(ms.length * 0.95)]!.toFixed(0)}  max ${ms.at(-1)!.toFixed(0)}`);
};

for (const set of which.split('').filter((c) => c === 'A' || c === 'B')) {
  const mine = items.filter((i) => i.set === set);
  if (cands.includes('h')) {
    const t0 = performance.now();
    const rows = mine.map((i) => ({ ...i, said: [ownerIntent(i.text) === 'help' ? 'question' : 'work'] as Kind[], ms: [] }));
    show(`h on set ${set} (${mine.length} messages, ${(performance.now() - t0).toFixed(1)} ms total)`, rows);
  }
  if (cands.includes('l')) {
    const jobs = mine.flatMap((i) => Array.from({ length: N }, () => i));
    const calls = await pool(jobs, PAR, (i) => askModel(i.text));
    const rows: Row[] = mine.map((i) => {
      const mineCalls = calls.filter((_, k) => jobs[k] === i);
      return { ...i, said: mineCalls.map((c) => c.kind), ms: mineCalls.map((c) => c.ms) };
    });
    show(`l (${MODEL}) on set ${set} (${mine.length} messages x ${N})`, rows);
    const none = rows.flatMap((r) => r.said).filter((s) => s === 'none').length;
    if (none) console.log(`  ${none} calls gave no usable answer (counted as work)`);
  }
}
process.exit(0);
