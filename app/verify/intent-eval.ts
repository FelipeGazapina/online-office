// Confusion matrix of the candidates that tell a question from a work order, on the fixed sets in owner-messages.ts.
// The model call is the shipped one (ack.ts): the sort word comes first in the reply that also holds the acknowledgement.
// h = offline text rules, the rejected candidate (git show 6c099bd:app/src/main/office/owner-intent.ts). l = a haiku call with
// thinking off, like the acknowledgement's. q = the plain-order rule that skips the call (it only ever says work). ql = q, then l.
// Run from app/: node verify/intent-eval.ts [--set A|B|C|ABC] [--cand q,l,ql] [--n 3] [--par 6] [--probe texts.json]
// A "work order called a question" is the dangerous cell: it would settle without files. A "question called work" is the
// status quo (a good answer tagged blocked).
import { loadavg } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Acknowledger } from '../src/main/office/ack.ts';
import { isPlainOrder } from '../src/main/office/owner-intent.ts';
import { SET_A, SET_B, SET_C, type Kind, type Labeled } from './owner-messages.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const which = arg('set', 'A');
const cands = arg('cand', 'q,l,ql').split(',');
const N = Number(arg('n', '3'));
const PAR = Number(arg('par', '6'));
const PROBE = arg('probe', '');
const ROLE = arg('role', 'employee');
const LEASH_MS = 2500;
const MODEL = process.env.OFFICE_ACK_MODEL ?? 'claude-haiku-4-5-20251001';

const sets: Record<string, readonly Labeled[]> = { A: SET_A, B: SET_B, C: SET_C };
const items = Object.entries(sets).flatMap(([set, messages]) => (which.includes(set) ? messages.map((m) => ({ ...m, set })) : []));

type Call = { kind: Kind | 'none'; ms: number };

// The shipped path: an Acknowledger with its spare process already warm, so the time is the call and not the start. The sort comes
// from the same call that writes the acknowledgement, so the words are read as well and a reply that sorts but says nothing is a failure.
const askModel = async (text: string): Promise<Call> => {
  const desk = new Acknowledger(query);
  desk.warm();
  await new Promise((r) => setTimeout(r, 6000));
  const t0 = performance.now();
  // No leash here, so a slow call is still sorted. Whether it would have been in time is read off `ms` against LEASH.
  const said = await desk.hear('eval', { who: 'e1', name: 'Eli', role: ROLE, company: 'Acme', block: 'Web', teammates: ['Pia (orchestrator)'], request: text }, 30_000);
  const ms = performance.now() - t0;
  desk.stop();
  return { kind: said === 'help' ? 'question' : said === 'work' ? 'work' : 'none', ms };
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
  const late = rows.flatMap((r) => r.ms).filter((ms) => ms > LEASH_MS).length;
  console.log(`\n${name}`);
  console.log(`  load average at the start ${loadavg()[0]!.toFixed(1)}`);
  console.log('                     said question   said work');
  console.log(`  is question        ${String(m.question.question).padStart(8)}   ${String(m.question.work).padStart(8)}   <- the work column is the status quo (answered, tagged blocked)`);
  console.log(`  is work            ${String(m.work.question).padStart(8)}   ${String(m.work.work).padStart(8)}   <- the question column must be 0 (settles with no files)`);
  for (const r of rows) {
    const wrong = r.said.filter((s) => (s === 'question') !== (r.is === 'question')).length;
    if (wrong) console.log(`  WRONG ${wrong}/${r.said.length} (is ${r.is}, said ${r.said.join('/')}) [${r.set}] ${r.text}`);
  }
  const ms = rows.flatMap((r) => r.ms).sort((a, b) => a - b);
  if (ms.length) console.log(`  ${late} of ${ms.length} calls took over ${LEASH_MS} ms, so the shipped leash would have left them as work`);
  if (ms.length) console.log(`  latency ms: p50 ${ms[Math.floor(ms.length * 0.5)]!.toFixed(0)}  p95 ${ms[Math.floor(ms.length * 0.95)]!.toFixed(0)}  max ${ms.at(-1)!.toFixed(0)}`);
};

if (PROBE) {
  const { readFileSync } = await import('node:fs');
  const texts: string[] = JSON.parse(readFileSync(PROBE, 'utf8'));
  const jobs = texts.flatMap((t) => Array.from({ length: N }, () => t));
  const calls = await pool(jobs, PAR, (t) => askModel(t));
  for (const t of texts) {
    const mine = calls.filter((_, k) => jobs[k] === t);
    console.log(`${mine.map((c) => (c.kind === 'question' ? 'Q' : c.kind === 'work' ? 'W' : '?')).join('')}  ${t}`);
  }
  process.exit(0);
}
for (const set of which.split('').filter((c) => c in sets)) {
  const mine = items.filter((i) => i.set === set);
  if (cands.includes('q')) {
    const rows = mine.map((i) => ({ ...i, said: [isPlainOrder(i.text) ? 'work' : 'none'] as (Kind | 'none')[], ms: [] }));
    const caught = rows.filter((r) => r.said[0] === 'work');
    show(`q on set ${set}, caught ${caught.length} of ${mine.length} (the rest are not decided, counted as work here)`, rows);
  }
  if (cands.includes('l') || cands.includes('ql')) {
    const jobs = mine.flatMap((i) => Array.from({ length: N }, () => i));
    const calls = await pool(jobs, PAR, (i) => askModel(i.text));
    const rows: Row[] = mine.map((i) => {
      const mineCalls = calls.filter((_, k) => jobs[k] === i);
      return { ...i, said: mineCalls.map((c) => c.kind), ms: mineCalls.map((c) => c.ms) };
    });
    if (cands.includes('l')) show(`l (${MODEL}) on set ${set} (${mine.length} messages x ${N})`, rows);
    if (cands.includes('ql')) {
      // As shipped: a plain order never reaches the model, and an answer later than the leash is dropped, so it counts as work.
      const hybrid = rows.map((r) => (isPlainOrder(r.text) ? { ...r, said: r.said.map(() => 'work' as const), ms: [] } : { ...r, said: r.said.map((s, k) => (r.ms[k]! > LEASH_MS ? ('work' as const) : s)) }));
      show(`ql as shipped on set ${set}: ${hybrid.filter((r) => r.ms.length === 0).length} of ${mine.length} plain orders skip the call, a call over ${LEASH_MS} ms counts as work`, hybrid);
    }
    const none = rows.flatMap((r) => r.said).filter((s) => s === 'none').length;
    if (none) console.log(`  ${none} calls gave no usable answer (counted as work)`);
  }
}
process.exit(0);
