// Runs e2e-startup-stalls.mjs several times per fixture and prints one table of every task over 50 ms, with the totals.
// Run from app/: OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/run-startup-stalls.mjs
// OFFICE_STALLS_RUNS=5   cold starts per fixture.   OFFICE_STALLS_FIXTURES=default,floors3   which fixtures.
// OFFICE_STALLS_VISIBLE=1 and OFFICE_STALLS_TAG pass through. A fixture's first run is also its screenshot reference for
// the diffs of the runs after it, unless OFFICE_STALLS_REF is set.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runs = Number(process.env.OFFICE_STALLS_RUNS ?? 5);
const fixtures = (process.env.OFFICE_STALLS_FIXTURES ?? 'default,floors3').split(',');
const tag = process.env.OFFICE_STALLS_TAG ?? 'run';
const shots = '/tmp/office-shots';
const pad = (v, n) => String(v).padStart(n);

let failed = false;
for (const fixture of fixtures) {
  const rows = [];
  for (let i = 1; i <= runs; i++) {
    const run = spawnSync('node', [join(here, 'cdp.mjs'), join(here, 'e2e-startup-stalls.mjs')], {
      env: { ...process.env, OFFICE_STALLS_FIXTURE: fixture, OFFICE_STALLS_TAG: `${tag}-${i}`, ...(process.env.OFFICE_STALLS_REF || i === 1 ? {} : { OFFICE_STALLS_REF: `${shots}/stalls-${fixture}-${tag}-1.png` }) },
      encoding: 'utf8',
    });
    const line = run.stdout.split('\n').find((l) => l.startsWith('{"fixture"'));
    const diff = run.stdout.split('\n').find((l) => l.startsWith('screenshot diff'));
    if (!line) {
      failed = true;
      console.log(`${fixture} run ${i}: no result\n${run.stdout}\n${run.stderr}`);
      continue;
    }
    rows.push({ ...JSON.parse(line), diff: diff?.replace(/^.*: /, '') ?? '' });
  }
  console.log(`\n${fixture}: ${rows.length} cold starts${rows[0]?.visible ? ', window shown' : ', window hidden'}`);
  console.log('run  load1  firstFrame  tasks  max ms  total ms  tasks (start+duration ms)');
  rows.forEach((r, i) => console.log(`${pad(i + 1, 3)}  ${pad(r.load1, 5)}  ${pad(r.firstFrameMs, 10)}  ${pad(r.tasks, 5)}  ${pad(r.maxMs, 6)}  ${pad(r.totalMs, 8)}  ${r.tasksMs.join(' ')}`));
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const mean = (k) => (rows.length ? Math.round(sum(k) / rows.length) : 0);
  console.log(`mean total ${mean('totalMs')} ms, mean max ${mean('maxMs')} ms, worst task ${Math.max(0, ...rows.map((r) => r.maxMs))} ms, mean load1 ${(sum('load1') / Math.max(1, rows.length)).toFixed(1)}`);
  for (const [i, r] of rows.entries()) if (r.diff) console.log(`run ${i + 1} screenshot diff vs run 1: ${r.diff}`);
}
process.exit(failed ? 1 : 0);
