// What the acknowledger's call costs on this machine, measured with the real model: a process that has just been spawned (cold) against one
// that has been waiting a few seconds (warm), for a question and for a work order. Times are ms from the owner's message to the sort
// (what holds the post) and to the first word of the acknowledgement (the first bubble). Real haiku, no app.
// Run from app/: node verify/ack-probe.ts [trials]    (OFFICE_ACK_PROBE_WARM_MS sets the warm wait, default 5000)
import { loadavg } from 'node:os';
import { createAcknowledger } from '../src/main/office/ack.ts';

const TRIALS = Number(process.argv[2] ?? 5);
const WARM_MS = Number(process.env.OFFICE_ACK_PROBE_WARM_MS ?? 5000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const p50 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : NaN);
const REQUESTS = { question: 'Which file handles login, and what does it do when the token has expired?', work: 'Please add a retry with backoff to the fetch helper in src/http.js and cover it with a test.' };

type Row = { sort: number; first: number; whole: number };
async function once(request: string, waitMs: number): Promise<Row> {
  const desk = createAcknowledger();
  desk.warm();
  await sleep(waitMs);
  const t0 = Date.now();
  let first = -1;
  let sort = -1;
  const sorted = desk.hear('probe', { who: 'e1', name: 'Eli', role: 'employee', company: 'Acme', block: 'Web', teammates: ['Pia (orchestrator)'], request }, 30_000);
  void sorted?.then(() => (sort = Date.now() - t0));
  const said = desk.ack('probe', () => (first < 0 ? (first = Date.now() - t0) : 0));
  const text = await said;
  const whole = Date.now() - t0;
  desk.stop();
  return text ? { sort, first, whole } : { sort: -1, first: -1, whole: -1 };
}

console.log(`load average ${loadavg().map((n) => n.toFixed(1)).join(' ')}, ${TRIALS} trials`);
for (const [kind, request] of Object.entries(REQUESTS)) {
  for (const [label, wait] of [['cold (asked at once)', 0], [`warm (waited ${WARM_MS} ms)`, WARM_MS]] as const) {
    const rows: Row[] = [];
    for (let i = 0; i < TRIALS; i++) rows.push(await once(request, wait));
    const good = rows.filter((r) => r.first >= 0);
    const col = (k: keyof Row) => good.map((r) => r[k]);
    console.log(`${kind} ${label}: sort p50 ${p50(col('sort'))} ms, first word ${JSON.stringify(rows.map((r) => r.first))} p50 ${p50(col('first'))} ms, whole p50 ${p50(col('whole'))} ms, no answer ${rows.length - good.length}`);
  }
}
