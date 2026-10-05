// Fixed-camera shots of the office at 1440x900: the overview, first person down the main room, and a two-story building.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 OFFICE_DATA_DIR=$(mktemp -d) node verify/cdp.mjs verify/e2e-visual.mjs
// OFFICE_SHOT_PREFIX names the files (default "v1-"), so a before run can save "v1-before-".
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './lib.mjs';

const PREFIX = process.env.OFFICE_SHOT_PREFIX ?? 'v1-';
const SHOTS = '/Users/feliperico/.claude/orchestrate/online-office-game/shots';
const { dataDir, repo } = scratch();
mkdirSync(join(repo, 'b'));
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
async function save(s, name) {
  const path = await s.shot(name);
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(path, join(SHOTS, `${PREFIX}${name}.png`));
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
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  await s.sleep(1500);
  await save(s, 'iso');

  await s.eval('__office.teleport(-5, 7, Math.PI)');
  await s.press('Tab');
  await s.waitFor('window.__officeCamera && window.__officeCamera.blend >= 0.999', 10000);
  await s.eval('__office.step(0.2)');
  await s.sleep(1200);
  await save(s, 'first');
  await s.press('Tab');
  await s.waitFor('window.__officeCamera && window.__officeCamera.blend <= 0.001', 10000);

  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify(buildOps())} })`);
  await s.waitFor(`${store}.building.stories.length === 2`);
  await s.eval('__office.walkTo(1, 9.5, 6.5)');
  for (let i = 0; i < 400 && (await s.eval('__office.state().intent.kind')) === 'walk'; i++) await s.eval('__office.step(0.25)');
  await s.eval('__office.step(0.6)');
  await s.sleep(1500);
  await save(s, 'upper');
};
