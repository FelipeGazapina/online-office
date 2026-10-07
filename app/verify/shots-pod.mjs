// Photographs a copy of a real company.json from fixed spots, so two builds of the app can be compared pixel by pixel
// (verify/pod-diff.py does the comparing). Reads OFFICE_SHOT_COMPANY, points every block at a scratch repo, and writes one
// 1440x900 picture per spot to OFFICE_SHOTS_DIR as <OFFICE_SHOT_TAG>-<spot>.png. Nothing it does touches the original file.
// Run: OFFICE_SHOT_COMPANY=/path/company.json OFFICE_SHOTS_DIR=/tmp/pod OFFICE_SHOT_TAG=before OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/shots-pod.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockCenter } from '../src/shared/space/index.ts';
import { assert, scratch } from './lib.mjs';

const source = process.env.OFFICE_SHOT_COMPANY;
if (!source) throw new Error('set OFFICE_SHOT_COMPANY to the company.json to photograph');
const SHOTS = process.env.OFFICE_SHOTS_DIR ?? '/tmp/pod-shots';
const TAG = process.env.OFFICE_SHOT_TAG ?? 'now';
const { dataDir, repo } = scratch();
const company = JSON.parse(readFileSync(source, 'utf8'));
for (const block of company.blocks) block.cwd = repo;
writeFileSync(join(dataDir, 'company.json'), JSON.stringify(company));

export const env = { OFFICE_DATA_DIR: dataDir };

const store = '__office.store.getState()';

export default async function (s) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.setCamera()');
  await s.eval('__office.step(8)');
  await s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);
  await s.sleep(900);

  const still = async () => {
    let last = null;
    for (let i = 0; i < 40; i++) {
      const c = await s.eval('({ x: __officeCamera.x, z: __officeCamera.z, y: __officeCamera.y })');
      if (last && Math.hypot(c.x - last.x, c.z - last.z, c.y - last.y) < 0.003) return;
      last = c;
      await s.sleep(250);
    }
  };
  const zoom = async (delta) => {
    await s.eval(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: ${delta}, bubbles: true }))`);
    await s.sleep(700);
  };
  const spots = company.blocks.map((b) => ({ name: b.name, ...blockCenter(b.slot) }));
  const lot = company.building.lot;
  spots.push({ name: 'lot', x: lot.x0 + lot.w / 2, z: lot.z0 + lot.h / 2 - 4 });
  mkdirSync(SHOTS, { recursive: true });
  let n = 0;
  for (const spot of spots) {
    await s.eval(`__office.teleport(${spot.x}, ${spot.z})`);
    await s.eval('__office.step(0.5)');
    await still();
    const path = await s.shot(`${TAG}-${spot.name}`);
    copyFileSync(path, join(SHOTS, `${TAG}-${spot.name}.png`));
    n++;
    if (spot.name === 'lot') continue;
    await zoom(-300);
    await still();
    const close = await s.shot(`${TAG}-${spot.name}-close`);
    copyFileSync(close, join(SHOTS, `${TAG}-${spot.name}-close.png`));
    await zoom(300);
    await still();
  }
  assert(n === spots.length, `photographed ${n} spots`);
}
