// Runs e2e-startup-stalls.mjs several times per fixture and prints one table per build of every task over 50 ms, with the totals.
// Run from app/: OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/run-startup-stalls.mjs
// OFFICE_STALLS_RUNS=5       cold starts per fixture and build.   OFFICE_STALLS_FIXTURES=default,floors3   which fixtures.
// OFFICE_STALLS_BUILDS=out/baseline,out/verify   compares builds. The runs alternate between them, so a busy machine slows
//                            every build alike, which a table of one build after the other cannot promise. The first build is
//                            the reference: every other run's settled scene is diffed against its first run.
// OFFICE_STALLS_WARMUP=1     rounds run first and not reported. The operating system keeps the GPU's compiled shaders between
//                            launches, so a build's first launch after a change to its shaders is slower than its later ones.
// OFFICE_STALLS_VISIBLE=1 and OFFICE_STALLS_TAG pass through. Without a reference build, a fixture's first run is the reference.
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runs = Number(process.env.OFFICE_STALLS_RUNS ?? 5);
const warmup = Number(process.env.OFFICE_STALLS_WARMUP ?? 0);
const fixtures = (process.env.OFFICE_STALLS_FIXTURES ?? 'default,floors3').split(',');
const builds = (process.env.OFFICE_STALLS_BUILDS ?? process.env.OFFICE_OUT_DIR ?? '').split(',');
const tag = process.env.OFFICE_STALLS_TAG ?? 'run';
const shots = '/tmp/office-shots';
const pad = (v, n) => String(v).padStart(n);
const shotOf = (fixture, build, i) => `${shots}/stalls-${fixture}-${tag}-${basename(build) || 'main'}-${i}.png`;

let failed = false;
for (const fixture of fixtures) {
  const rows = new Map(builds.map((b) => [b, []]));
  for (let round = 1 - warmup; round <= runs; round++) {
    // Each round starts with a different build, so no build always runs right after the same neighbour.
    const i = Math.max(round, 0);
    for (const build of builds.map((_, k) => builds[(k + round + warmup - 1) % builds.length])) {
      const reference = round < 1 ? undefined : process.env.OFFICE_STALLS_REF ?? (build === builds[0] && i === 1 ? undefined : shotOf(fixture, builds[0], 1));
      const run = spawnSync('node', [join(here, 'cdp.mjs'), join(here, 'e2e-startup-stalls.mjs')], {
        env: { ...process.env, ...(build ? { OFFICE_OUT_DIR: build } : {}), OFFICE_STALLS_FIXTURE: fixture, OFFICE_STALLS_TAG: `${tag}-${basename(build) || 'main'}-${i}`, ...(reference ? { OFFICE_STALLS_REF: reference } : {}) },
        encoding: 'utf8',
      });
      if (round < 1) continue;
      const line = run.stdout.split('\n').find((l) => l.startsWith('{"fixture"'));
      const diff = run.stdout.split('\n').find((l) => l.startsWith('screenshot diff'));
      if (!line) {
        failed = true;
        console.log(`${fixture} ${build} run ${i}: no result\n${run.stdout}\n${run.stderr}`);
        continue;
      }
      rows.get(build).push({ ...JSON.parse(line), diff: diff?.replace(/^.*: /, '') ?? '' });
    }
  }
  for (const [build, list] of rows) {
    console.log(`\n${fixture} on ${build || 'the default build'}: ${list.length} cold starts${list[0]?.visible ? ', window shown' : ', window hidden'}`);
    console.log('run  load1  firstFrame  tasks  max ms  total ms  tasks (start+duration ms)');
    list.forEach((r, i) => console.log(`${pad(i + 1, 3)}  ${pad(r.load1, 5)}  ${pad(r.firstFrameMs, 10)}  ${pad(r.tasks, 5)}  ${pad(r.maxMs, 6)}  ${pad(r.totalMs, 8)}  ${r.tasksMs.join(' ')}`));
    const sum = (k) => list.reduce((a, r) => a + r[k], 0);
    const mean = (k) => (list.length ? Math.round(sum(k) / list.length) : 0);
    console.log(`mean total ${mean('totalMs')} ms, mean max ${mean('maxMs')} ms, worst task ${Math.max(0, ...list.map((r) => r.maxMs))} ms, mean load1 ${(sum('load1') / Math.max(1, list.length)).toFixed(1)}`);
    for (const [i, r] of list.entries()) if (r.diff) console.log(`run ${i + 1} screenshot diff vs the reference: ${r.diff}`);
  }
}
process.exit(failed ? 1 : 0);
