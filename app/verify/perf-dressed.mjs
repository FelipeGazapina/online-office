// What a dressed office costs: the same fixture office measured as it opens (every desk already wears its own things, which are one draw call
// per story) and then with the huddle table, a table and a shelf dressed by the owner in many looks (one draw call per look, so this is the
// worst case for the number of draws). Shows the window, like e2e-perf.mjs.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/perf-dressed.mjs
// OFFICE_PERF_ASSERT=1 fails the run unless the dressed office keeps fpsAvg >= 59.5 with at most 1% of frames over 25 ms.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBuilding } from '../src/shared/space/index.ts';
import { assert, scratch } from './lib.mjs';
import { acceptedDressing } from './tabletop-dressing.mjs';

const { dataDir, repo } = scratch();
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_TEST_RUN: '', OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const file = join(dataDir, 'company.json');
const SECONDS = Number(process.env.OFFICE_PERF_SECONDS ?? 10);

const summary = (label, { deltas, drawCalls, triangles }) => {
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const slowPct = +((deltas.filter((d) => d > 25).length / deltas.length) * 100).toFixed(2);
  const result = { label, frames: deltas.length, fpsAvg: +(1000 / avg).toFixed(2), slowPct, drawCalls, triangles };
  console.log(JSON.stringify(result));
  return result;
};

export default async function (s) {
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.sleep(4000);
  const bare = summary('bare', await s.eval(`__office.measureFrames(${SECONDS * 1000})`));

  for (let i = 0; i < 50 && !JSON.parse(readFileSync(file, 'utf8')).building; i++) await s.sleep(200);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const ctx = { blocks: new Set(c.blocks.map((b) => b.id)), employees: new Map(c.employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.role === 'orchestrator' }])), seats: new Map(c.employees.filter((e) => e.seat).map((e) => [e.id, e.seat])) };
  const { ok, refused } = acceptedDressing(parseBuilding(c.building, () => {}), ctx);
  assert(refused.length === 0, `the dressing is accepted (${ok.length} things)`);
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify([{ t: 'items', story: 0, put: ok, del: [] }])} })`);
  await s.waitFor(`${store}.building.stories[0].items.filter((i) => i.on !== undefined).length === ${ok.length}`, 8000);
  await s.sleep(3000);
  const models = (await s.eval(`__office.probe('model')`)).filter((m) => ok.some((i) => i.def === m.def));
  console.log(`${ok.length} things drawn by ${models.length} models`);
  const dressed = summary('dressed', await s.eval(`__office.measureFrames(${SECONDS * 1000})`));
  console.log(`the dressing adds ${dressed.drawCalls - bare.drawCalls} draw calls`);
  if (process.env.OFFICE_PERF_ASSERT === '1') {
    if (dressed.fpsAvg < 59.5) throw new Error(`fpsAvg ${dressed.fpsAvg} is under 59.5`);
    if (dressed.slowPct > 1) throw new Error(`${dressed.slowPct}% of frames are over 25 ms, limit is 1%`);
  }
}
