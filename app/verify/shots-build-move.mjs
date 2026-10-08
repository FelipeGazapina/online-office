// Pictures of the build entry, a piece in hand and a block mid-move, on a copy of a real company.json, for the Sims 4
// comparison panel. Reads the file named by OFFICE_SHOT_COMPANY, points every block at a scratch repo, and writes
// entry.png, carry.png and block.png at 1440x900 to OFFICE_SHOTS_DIR (the b2 folder unless set). Nothing it does touches
// the original file.
// Run: pnpm build:verify && OFFICE_SHOT_COMPANY=/path/to/company.json OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/shots-build-move.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockItems, cellBounds, checkOps, moveBlockOps, parseBuilding } from '../src/shared/space/index.ts';
import { assert, scratch } from './lib.mjs';

const source = process.env.OFFICE_SHOT_COMPANY;
if (!source) throw new Error('set OFFICE_SHOT_COMPANY to the company.json to photograph');
const SHOTS = process.env.OFFICE_SHOTS_DIR ?? '/Users/feliperico/.claude/orchestrate/online-office-game/shots/b2';
const BLOCK = process.env.OFFICE_SHOT_BLOCK ?? 'online-office';
const { dataDir, repo } = scratch();
const company = JSON.parse(readFileSync(source, 'utf8'));
for (const block of company.blocks) block.cwd = repo;
writeFileSync(join(dataDir, 'company.json'), JSON.stringify(company));

export const env = { OFFICE_DATA_DIR: dataDir };

const store = '__office.store.getState()';
const building = parseBuilding(company.building, () => {});
const ctx = {
  blocks: new Set(company.blocks.map((b) => b.id)),
  employees: new Map(company.employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.role === 'orchestrator' }])),
  seats: new Map(company.employees.filter((e) => e.seat).map((e) => [e.id, e.seat])),
};
const block = company.blocks.find((b) => b.name === BLOCK);
const story = building.stories[0];
const mine = blockItems(story, block.id);
const desk = mine.find((i) => i.def === 'bench_desk');
const deskAt = { x: desk.x / 2 + 0.75, z: desk.z / 2 + 0.5 };

// The nearest offsets in meters, between `min` and `max` away, where the move is legal.
function legal(min, max, step, op) {
  const found = [];
  for (let x = -max; x <= max; x += step) {
    for (let z = -max; z <= max; z += step) {
      const d = Math.hypot(x, z);
      if (d < min || d > max) continue;
      const moved = op(x, z);
      if (moved && checkOps(building, [moved], ctx).length === 0) found.push({ x, z, d });
    }
  }
  return found.sort((a, b) => a.d - b.d);
}
const box = cellBounds(mine);
const blockOffsets = legal(9, 24, 1, (x, z) => moveBlockOps(story, 0, block.id, { quarter: 0, origin: { x: box.x0 + x * 2, z: box.z0 + z * 2 } })[0]);
// The desk goes where it has the most air around it, so the picture shows one piece on open floor like the Sims placement shot.
const others = story.items.filter((i) => i.id !== desk.id);
const air = (o) => Math.min(...others.map((i) => Math.hypot(i.x / 2 - (desk.x / 2 + o.x), i.z / 2 - (desk.z / 2 + o.z))));
const deskOffsets = legal(4, 9, 0.5, (x, z) => ({ t: 'items', story: 0, put: [{ ...desk, x: desk.x + x * 2, z: desk.z + z * 2 }], del: [] })).sort((a, b) => air(b) - air(a));

async function save(s, name) {
  const path = await s.shot(name);
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(path, join(SHOTS, `${name}.png`));
}

export default async function (s) {
  assert(blockOffsets.length > 0 && deskOffsets.length > 0, `the office has free ground for the desk (${deskOffsets.length} spots) and the block (${blockOffsets.length} spots)`);
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  await s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);
  await s.sleep(900);

  const at = (x, z) => s.eval(`__office.project(${x}, 0, ${z})`);
  const hold = (code, key) => s.key('keyDown', code, key);
  const release = (code, key) => s.key('keyUp', code, key);
  const zoom = async (delta) => {
    await s.eval(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: ${delta}, bubbles: true }))`);
    await s.sleep(900);
  };
  // The camera eases after a key is released; a picture waits until it stands still.
  const still = async () => {
    let last = null;
    for (let i = 0; i < 30; i++) {
      const c = await s.eval('({ x: __officeCamera.x, z: __officeCamera.z, y: __officeCamera.y })');
      if (last && Math.hypot(c.x - last.x, c.z - last.z, c.y - last.y) < 0.005) return;
      last = c;
      await s.sleep(250);
    }
  };
  // Pans with the real keys until a point of the floor sits near the middle of the screen.
  const center = async (x, z) => {
    for (let i = 0; i < 40; i++) {
      const p = await at(x, z);
      const dx = p.x - 720;
      const dy = p.y - 380;
      const far = Math.abs(dx) > 110 ? Math.abs(dx) : Math.abs(dy) > 90 ? Math.abs(dy) : 0;
      if (!far) {
        await still();
        return at(x, z);
      }
      const key = far === Math.abs(dx) ? (dx > 0 ? ['KeyD', 'd'] : ['KeyA', 'a']) : dy > 0 ? ['KeyS', 's'] : ['KeyW', 'w'];
      await hold(...key);
      await s.sleep(Math.min(2200, 50 + far * 3.2));
      await release(...key);
      await s.sleep(600);
    }
    await still();
    return at(x, z);
  };

  await save(s, 'entry');
  await s.clickOn('[data-testid="build-enter"]');
  await s.waitFor(`!!${store}.build`, 4000);
  await s.sleep(600);

  // A piece in hand, close, so the footprint reads like the Sims placement picture.
  await zoom(-350);
  // Of the legal spots, the one with most air that lands a little below the desk on screen, so both fit above the hint bar.
  const home = await center(deskAt.x, deskAt.z);
  let spot = deskOffsets[0];
  for (const o of deskOffsets) {
    const p = await at(deskAt.x + o.x, deskAt.z + o.z);
    if (Math.abs(p.x - home.x) < 420 && p.y - home.y > 90 && p.y - home.y < 190) {
      spot = o;
      break;
    }
  }
  await center(deskAt.x + spot.x / 2, deskAt.z + spot.z / 2);
  const pick = await at(deskAt.x, deskAt.z);
  await s.click(pick.x, pick.y);
  await s.sleep(250);
  assert((await s.eval(`${store}.build.tool.carry`)) === desk.id, 'the desk is in hand');
  const drop = await at(deskAt.x + spot.x, deskAt.z + spot.z);
  await s.mouse('mouseMoved', drop.x - 3, drop.y);
  await s.mouse('mouseMoved', drop.x, drop.y);
  await s.sleep(350);
  assert((await s.eval(`__office.probe('footprint')`))[0]?.ok === true, 'the carried desk shows a green footprint');
  await save(s, 'carry');
  await s.press('Escape');

  // A block mid-move, wide, so the whole block and where it is going share the picture.
  await zoom(1000);
  await s.clickOn('[data-testid="mode-block"]');
  // Of the nearest legal spots, the one that puts the middle of the block right of center on screen, clear of the build bar.
  const heart = { x: (box.x0 + box.x1) / 4, z: (box.z0 + box.z1) / 4 };
  await center(heart.x, heart.z);
  let far = blockOffsets[0];
  let best = Infinity;
  for (const o of blockOffsets.slice(0, 60)) {
    const p = await at(heart.x + o.x, heart.z + o.z);
    const miss = Math.hypot(p.x - 1020, p.y - 420);
    if (miss < best) {
      best = miss;
      far = o;
    }
  }
  await center(heart.x + far.x / 2, heart.z + far.z / 2);
  const grab = await at(deskAt.x, deskAt.z);
  await s.mouse('mouseMoved', grab.x, grab.y);
  await s.sleep(300);
  assert((await s.eval(`__office.probe('block-select')`))[0]?.pieces === mine.length, 'the block is outlined before it is picked');
  await s.mouse('mousePressed', grab.x, grab.y, 1);
  await s.mouse('mouseReleased', grab.x, grab.y);
  await s.sleep(250);
  const target = await at(deskAt.x + far.x, deskAt.z + far.z);
  await s.mouse('mouseMoved', target.x - 3, target.y);
  await s.mouse('mouseMoved', target.x, target.y);
  await s.sleep(400);
  assert((await s.eval(`__office.probe('block-footprint')`))[0]?.ok === true, 'the moving block shows one green footprint');
  await save(s, 'block');
  await s.press('Escape');
}
