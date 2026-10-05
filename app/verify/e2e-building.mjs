// The office runs on the persisted building. A company.json from before the building migrates, a scripted build adds a
// second story with stairs and a room, and the owner walks up the stairs and arrives. Real Electron app over CDP.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 OFFICE_DATA_DIR=$(mktemp -d) node verify/cdp.mjs verify/e2e-building.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, scratch } from './lib.mjs';

const SHOTS = '/Users/feliperico/.claude/orchestrate/online-office-game/shots';
const { dataDir, repo } = scratch();
mkdirSync(join(repo, 'b'));
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const state = (s) => s.eval('__office.state()');
async function save(s, name) {
  const path = await s.shot(name);
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(path, join(SHOTS, `${name}.png`));
}

const rect = { x: 5, z: 2, w: 8, h: 6 };
const buildOps = () => [
  { t: 'stories', count: 2 },
  { t: 'floor', story: 1, cells: Array.from({ length: rect.w * rect.h }, (_, i) => ({ x: rect.x + (i % rect.w), z: rect.z + Math.floor(i / rect.w), half: 0, paint: 2 })) },
  {
    t: 'walls',
    story: 1,
    put: [
      ...Array.from({ length: rect.w }, (_, i) => [{ x: rect.x + i, z: rect.z, d: 'e', style: 2 }, { x: rect.x + i, z: rect.z + rect.h, d: 'e', style: 2, ...(i === 5 ? { open: 'door' } : {}) }]).flat(),
      ...Array.from({ length: rect.h }, (_, j) => [{ x: rect.x, z: rect.z + j, d: 's', style: 2 }, { x: rect.x + rect.w, z: rect.z + j, d: 's', style: 2, ...(j === 2 ? { open: 'window' } : {}) }]).flat(),
    ],
    del: [],
  },
  { t: 'items', story: 0, put: [{ id: 'stairs:00', def: 'stairs', x: 16, z: 4, rot: 0 }], del: [] },
  { t: 'items', story: 1, put: [{ id: 'plant:50', def: 'plant', x: 24, z: 12, rot: 0 }, { id: 'sofa:00', def: 'sofa', x: 20, z: 10, rot: 0 }], del: [] },
];

export default async (s) => {
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  const company = await s.eval(`${store}.company`);
  assert(company.employees.length === 4 && company.employees.every((e) => e.seat && !('desk' in e)), 'the migrated company has four employees, each on a desk item');
  const po = company.employees.find((e) => e.role === 'orchestrator');
  assert(po.seat.includes(':po_desk:'), `the orchestrator sits at its PO desk (${po.seat})`);
  const saved = JSON.parse(readFileSync(join(dataDir, 'company.json'), 'utf8'));
  assert(saved.building?.v === 1 && saved.employees.every((e) => e.seat), 'company.json now holds the building and every seat');

  await s.eval('__office.step(8)');
  await s.sleep(1500);
  const seated = (await state(s)).avatars.filter((a) => a.seated).length;
  assert(seated === 4, `all four employees are seated at their desks (${seated})`);
  const iso = await s.eval('__office.wallStats()');
  await save(s, 's2-overview');
  assert(iso.curbs > 0, `the overview cuts away the walls that face the camera (${iso.curbs} curbs, ${iso.full} full)`);

  const rev = await s.eval(`${store}.buildingRev`);
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify(buildOps())} })`);
  await s.waitFor(`${store}.building.stories.length === 2`).catch(async (e) => {
    throw new Error(`${e.message}; the screen said: ${(await s.eval('document.querySelector(".toasts")?.innerText ?? document.body.innerText')).slice(0, 300)}`);
  });
  assert((await s.eval(`${store}.buildingRev`)) > rev, 'the build bumped the building rev');
  const saved2 = JSON.parse(readFileSync(join(dataDir, 'company.json'), 'utf8'));
  assert(saved2.building.stories.length === 2, 'and main saved the second story');

  await s.eval(`window.office.send({ type: 'build', ops: [{ t: 'items', story: 0, put: [{ id: 'plant:99', def: 'plant', x: 16, z: 6, rot: 0 }], del: [] }] })`);
  await s.sleep(500);
  assert(!(await s.eval(`${store}.building.stories[0].items.some((i) => i.id === 'plant:99')`)), 'an illegal build (a plant on the stairs) changed nothing');
  assert((await s.eval('document.body.innerText')).includes('not allowed'), 'and the owner is told the change is not allowed');

  const start = await state(s);
  assert(start.owner.floor === 0, 'the owner starts on story 0');
  const target = { x: 9.5, z: 6.5 };
  await s.eval(`__office.walkTo(1, ${target.x}, ${target.z})`);
  const walk = (await state(s)).intent;
  assert(walk.kind === 'walk' && walk.legs === 2 && walk.floor === 1, `the walk is two legs, up the stairs and across story 1 (${walk.legs} legs)`);
  let climbed = false;
  for (let i = 0; i < 400 && (await state(s)).intent.kind === 'walk'; i++) {
    await s.eval('__office.step(0.25)');
    const o = (await state(s)).owner;
    if (o.floor === 0 && o.y > 0.5) climbed = true;
  }
  const end = await state(s);
  assert(climbed, 'the owner climbed the steps (height rose while still on story 0)');
  assert(end.intent.kind === 'keys' && end.owner.floor === 1, 'the walk ended with the owner on story 1');
  const gap = Math.hypot(end.owner.x - target.x, end.owner.z - target.z);
  assert(gap < 0.5, `and within 0.5 m of the target (${gap.toFixed(2)} m)`);
  assert(Math.abs(end.owner.y - 3.2) < 0.05, `at the height of story 1 (${end.owner.y.toFixed(2)} m)`);
  await s.eval('__office.step(0.6)');
  assert((await s.eval(`${store}.story`)) === 1, 'the scene now draws story 1');
  await s.sleep(1500);
  await save(s, 's2-story1');

  await s.press('Tab');
  await s.waitFor('window.__officeCamera && window.__officeCamera.blend >= 0.999', 10000);
  await s.eval('__office.step(0.2)');
  await s.sleep(1200);
  const first = await s.eval('__office.wallStats()');
  assert(first.curbs === 0 && first.hidden === 0, `first person shows every wall at full height (${first.full} walls, ${first.curbs} curbs)`);
  await save(s, 's2-first');
};
