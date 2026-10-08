// In the overview, a click on a staircase takes the owner to the floor it leads to: up from below, down from above.
// Real pointer events on the built app.
// Run: pnpm build && OFFICE_CDP_PORT=9348 node verify/cdp.mjs verify/e2e-stairs-click.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
mkdirSync(join(repo, 'b'));
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const state = (s) => s.eval('__office.state()');
const rect = { x: 5, z: 2, w: 8, h: 6 };
const buildOps = [
  { t: 'stories', count: 2 },
  { t: 'floor', story: 1, cells: Array.from({ length: rect.w * rect.h }, (_, i) => ({ x: rect.x + (i % rect.w), z: rect.z + Math.floor(i / rect.w), half: 0, paint: 2 })) },
  { t: 'items', story: 0, put: [{ id: 'stairs:00', def: 'stairs', x: 16, z: 4, rot: 0 }], del: [] },
];

// A screen pixel whose click lands on the staircase, found through the same raycast a real click takes. From above only
// a sliver of it shows through the stairwell, so the whole view is searched and the middle hit is used.
async function stairsPixel(s) {
  const hits = await s.eval(`(() => { const out = []; for (let x = 0; x < innerWidth; x += 6) for (let y = 30; y < innerHeight - 50; y += 6) if (__office.pick(x, y).what === 'stairs stairs:00') out.push({ x, y }); return out; })()`);
  if (hits.length === 0) throw new Error('no pixel of the overview lands on the stairs');
  return hits[Math.floor(hits.length / 2)];
}

async function walkOut(s) {
  for (let i = 0; i < 200 && (await state(s)).intent.kind === 'walk'; i++) await s.eval('__office.step(0.25)');
  await s.eval('__office.step(0.6)');
  await s.sleep(800);
  return state(s);
}

export default async (s) => {
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(4)');
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify(buildOps)} })`);
  await s.waitFor(`${store}.building.stories.length === 2`);
  await s.press('Digit2', '2');
  await s.waitFor(`${store}.camera === 'iso'`);
  await s.eval('__office.ownerTo(0, 4, 6); __office.step(1)');
  await s.sleep(1500);

  const up = await stairsPixel(s);
  await s.click(up.x, up.y);
  const climb = (await state(s)).intent;
  assert(climb.kind === 'walk' && climb.floor === 1 && climb.legs === 2, `a click on the stairs from story 0 starts a walk up them to story 1 (${JSON.stringify(climb)})`);
  const top = await walkOut(s);
  assert(top.intent.kind === 'keys' && top.owner.floor === 1, `the owner arrives on story 1 (floor ${top.owner.floor})`);
  assert(Math.abs(top.owner.y - 3.2) < 0.05, `at the height of story 1 (${top.owner.y.toFixed(2)} m)`);
  assert((await s.eval(`${store}.story`)) === 1, 'and the overview draws story 1');
  await s.shot('stairs-up');

  const down = await stairsPixel(s);
  await s.click(down.x, down.y);
  const descent = (await state(s)).intent;
  assert(descent.kind === 'walk' && descent.floor === 0 && descent.legs === 2, `a click on the stairs from story 1 starts a walk down them to story 0 (${JSON.stringify(descent)})`);
  const bottom = await walkOut(s);
  assert(bottom.intent.kind === 'keys' && bottom.owner.floor === 0 && Math.abs(bottom.owner.y) < 0.05, `the owner arrives back on story 0 (floor ${bottom.owner.floor}, y ${bottom.owner.y.toFixed(2)})`);
  await s.shot('stairs-down');

  const spot = await s.eval('__office.project(4, 0, 6)');
  const hit = await s.eval(`__office.pick(${spot.x}, ${spot.y})`);
  assert(hit.kind === 'floor', `a pixel off the stairs lands on the floor (${hit.what})`);
  await s.click(spot.x, spot.y);
  const walk = (await state(s)).intent;
  assert(walk.kind === 'walk' && walk.floor === 0 && walk.legs === 1, `a floor click still walks on the same story (${JSON.stringify(walk)})`);
};
