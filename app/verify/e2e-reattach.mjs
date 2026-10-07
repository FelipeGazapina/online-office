// A real company.json is loaded by the real app, and every project block's pod (rug, boundary, decor, huddle) must stand with
// the block's desks, not at the slot spot the static pod was drawn at. Reads OFFICE_B3B_COMPANY, a copy of a company.json, and
// points every block at a scratch repo, so nothing it does touches the original. The state of the office it starts from:
//   OFFICE_B3B_STATE=fresh   the copy as it is (the default)
//   OFFICE_B3B_STATE=moved   each block's desks, board and sign first moved or turned as one unit by the block move (B1)
//   OFFICE_B3B_STATE=today   the pods first put at their slot spots by the migration of the build before this one, the desks where they are
//   OFFICE_B3B_STATE=moved-today   both of the above
// What it proves: the building the app holds equals the migration's result for that file, a block whose pod the rules refused
// says so in the main process log, nothing of a moved block's pod is left at its slot spot, the pod is around the desks that
// agree, and after a restart the building is the same and the migration does not run again.
// Set OFFICE_SHOTS_DIR (and OFFICE_SHOT_TAG) to write one wide and one close picture per block there.
// Run: pnpm build:verify && OFFICE_B3B_COMPANY=/path/company.json OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-reattach.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addShells, applyOps, blockCenter, blockItems, blockPose, cellBounds, encodeBuilding, footprint, ITEM_DEFS, makeStory, moveBlockOps, parseBuilding, shellItems } from '../src/shared/space/index.ts';
import { coreItems } from '../src/shared/space/kit.ts';
import { assert, scratch } from './lib.mjs';

const source = process.env.OFFICE_B3B_COMPANY;
if (!source) throw new Error('set OFFICE_B3B_COMPANY to a copy of the company.json to load');
const STATE = process.env.OFFICE_B3B_STATE ?? 'fresh';
const SHOTS = process.env.OFFICE_SHOTS_DIR;
const TAG = process.env.OFFICE_SHOT_TAG ?? STATE;
const { dataDir, repo } = scratch();
const company = JSON.parse(readFileSync(source, 'utf8'));
for (const block of company.blocks) block.cwd = repo;
const noSeats = { blocks: new Set(), employees: new Map(), seats: new Map() };
const blocks = company.blocks.map((b) => ({ id: b.id, slot: b.slot, name: b.name }));
const undone = parseBuilding(company.building, () => {});
assert(undone.shelled === undefined, 'the copy is an office whose pods were never made items');

const swapItems = (b, items) => {
  const ids = new Set(items.map((i) => i.id));
  const [ground, ...above] = b.stories;
  return { ...b, stories: [makeStory(ground.paint, ground.halfB, ground.walls, [...ground.items.filter((i) => !ids.has(i.id)), ...items].sort((p, q) => (p.id < q.id ? -1 : 1))), ...above] };
};

// The block move of the build before this one: only the desks, board, terminal and sign moved, since the pod was not items yet.
// Each block is turned a different way and goes to the first spot (slot spots first, then a grid over the lot) where the desks
// pass the rules and the pod would too.
function moveEach(b) {
  const turns = [1, 2, 3, 1];
  const spots = [...Array.from({ length: 9 }, (_, slot) => blockCenter(slot)).filter((_, slot) => !blocks.some((k) => k.slot === slot))];
  for (let z = b.lot.z0 + 5; z < b.lot.z0 + b.lot.h - 4; z += 2) for (let x = b.lot.x0 + 6; x < b.lot.x0 + b.lot.w - 5; x += 2) spots.push({ x, z });
  let cur = b;
  blocks.forEach((block, n) => {
    for (const c of spots) {
      const quarter = turns[n % turns.length];
      const ops = moveBlockOps(cur.stories[0], 0, block.id, blockPose(blockItems(cur.stories[0], block.id), quarter, { x: c.x * 2, z: c.z * 2 }));
      const applied = ops.length ? applyOps(cur, ops, noSeats) : null;
      if (!applied?.ok) continue;
      const trial = [];
      addShells(applied.building, [...blocks.slice(0, n), block], (o) => trial.push(o));
      if (trial.length !== n + 1 || trial.some((o) => o.kind !== 'placed')) continue;
      console.log(`moved ${block.name} to ${c.x}, ${c.z} m, turned ${quarter * 90} degrees`);
      cur = applied.building;
      return;
    }
    throw new Error(`no free spot where ${block.name} and its pod fit`);
  });
  return cur;
}

// The migration of the build before this one: the pod at its slot spot whatever the desks did. Run on the desks at their slots, then the desks put back.
function podsAtSlot(b) {
  const slotCores = blocks.flatMap((k) => coreItems(k.id, k.slot));
  const mine = new Set(slotCores.map((i) => i.id));
  const original = b.stories[0].items.filter((i) => mine.has(i.id));
  return { ...swapItems(addShells(swapItems(b, slotCores), blocks), original), shelled: 1 };
}

let input = undone;
if (STATE.startsWith('moved')) input = moveEach(input);
if (STATE.endsWith('today')) input = podsAtSlot(input);
const seen = [];
const expected = addShells(input, blocks, (o) => seen.push(o));
company.building = encodeBuilding(input);
writeFileSync(join(dataDir, 'company.json'), JSON.stringify(company));
console.log(`state ${STATE}: ${seen.map((o) => `${o.block.name} ${o.kind === 'placed' ? `placed (${o.agree} of ${o.of} agree, turn ${o.pose.quarter}, shift ${o.pose.dx},${o.pose.dz})` : `fell back (${o.why})`}`).join('; ')}`);

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const key = (i) => `${i.id}|${i.def}|${i.x}|${i.z}|${i.rot}|${i.blockId ?? ''}|${i.tint ?? ''}`;
const sameItems = (a, b) => {
  const left = a.stories.flatMap((s, n) => s.items.map((i) => `${n}|${key(i)}`)).sort();
  const right = b.stories.flatMap((s, n) => s.items.map((i) => `${n}|${key(i)}`)).sort();
  return left.length === right.length && left.every((k, n) => k === right[n]);
};
const podBox = (items) => cellBounds(items);
const inside = (box, item) => {
  const f = footprint(ITEM_DEFS[item.def], item.rot);
  return item.x >= box.x0 && item.z >= box.z0 && item.x + f.w <= box.x1 && item.z + f.d <= box.z1;
};

export default async function (s, { launch }) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.setCamera()');
  await s.eval('__office.step(8)');
  if (SHOTS) await s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);
  await s.sleep(900);

  const held = await s.eval(`${store}.building`);
  assert(held.shelled === 2, 'the app holds the office with every pod migrated');
  assert(sameItems(held, expected), 'and it is the one the migration gives for this file, piece for piece');
  const mainOut = s.mainLogs.join('\n');
  for (const o of seen) {
    const warned = mainOut.includes(`the pod of ${o.block.name} stays where the static pod stood`);
    assert(warned === (o.kind === 'fell_back'), o.kind === 'fell_back' ? `${o.block.name}'s pod was turned away and the log says why: ${o.why}` : `${o.block.name}'s pod was placed with no warning in the log`);
  }

  for (const o of seen) {
    const mine = held.stories.flatMap((st) => st.items).filter((i) => i.blockId === o.block.id);
    const pod = mine.filter((i) => shellItems(o.block.id, o.block.slot).some((p) => p.id === i.id));
    const cores = mine.filter((i) => coreItems(o.block.id, o.block.slot).some((p) => p.id === i.id));
    if (o.kind === 'fell_back') {
      const atSlot = pod.filter((i) => shellItems(o.block.id, o.block.slot).some((p) => p.id === i.id && p.x === i.x && p.z === i.z && p.rot === i.rot));
      assert(atSlot.length === pod.length, `${o.block.name}: the refused pod stands whole at the slot spot (${pod.length} pieces)`);
      continue;
    }
    const box = podBox(pod);
    const around = cores.filter((c) => inside(box, c)).length;
    assert(around >= o.agree, `${o.block.name}: at least the ${o.agree} desks, board or signs that agree on the pose stand inside its pod (${around} of ${cores.length} do)`);
    const moved = o.pose.quarter !== 0 || o.pose.dx !== 0 || o.pose.dz !== 0;
    const left = pod.filter((i) => shellItems(o.block.id, o.block.slot).some((p) => p.id === i.id && p.x === i.x && p.z === i.z && p.rot === i.rot));
    assert(!moved || left.length === 0, `${o.block.name}: ${moved ? 'no piece of its pod is left at the old slot spot' : 'it stands at its slot, so its pod does too'}`);
  }

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
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
    const frame = async (name, items) => {
      const box = cellBounds(items);
      await s.eval(`__office.teleport(${(box.x0 + box.x1) / 4}, ${(box.z0 + box.z1) / 4})`);
      await s.eval('__office.step(0.5)');
      await still();
      copyFileSync(await s.shot(`${TAG}-${name}`), join(SHOTS, `${TAG}-${name}.png`));
      await zoom(-300);
      await still();
      copyFileSync(await s.shot(`${TAG}-${name}-close`), join(SHOTS, `${TAG}-${name}-close.png`));
      await zoom(300);
      await still();
    };
    const items = held.stories[0].items;
    for (const o of seen) {
      const mine = items.filter((i) => i.blockId === o.block.id);
      const podIds = new Set(shellItems(o.block.id, o.block.slot).map((p) => p.id));
      // A pod turned away stands far from its desks, so each gets its own picture.
      if (o.kind === 'fell_back') {
        await frame(`${o.block.name}-desks`, mine.filter((i) => !podIds.has(i.id)));
        await frame(`${o.block.name}-pod`, mine.filter((i) => podIds.has(i.id)));
      } else await frame(o.block.name, mine);
    }
  }

  // One edit makes the app save the office; then it is closed and opened again on the same folder.
  let spot = null;
  for (let z = expected.lot.z0 * 2; z < (expected.lot.z0 + expected.lot.h) * 2 && !spot; z += 2) {
    for (let x = expected.lot.x0 * 2; x < (expected.lot.x0 + expected.lot.w) * 2 && !spot; x += 2) {
      if (applyOps(expected, [{ t: 'items', story: 0, put: [{ id: 'plant:b3b', def: 'plant', x, z, rot: 0 }], del: [] }], noSeats).ok) spot = { x, z };
    }
  }
  assert(!!spot, 'there is a bare cell for a plant');
  const free = (id, put) => `window.office.send({ type: 'build', ops: [{ t: 'items', story: 0, put: ${put ? JSON.stringify([{ id, def: 'plant', x: spot.x, z: spot.z, rot: 0 }]) : '[]'}, del: ${put ? '[]' : JSON.stringify([id])} }] })`;
  await s.eval(free('plant:b3b', true));
  await s.waitFor(`${store}.building.stories[0].items.some((i) => i.id === 'plant:b3b')`, 6000).catch(() => {});
  await s.eval(free('plant:b3b', false));
  await s.waitFor(`!${store}.building.stories[0].items.some((i) => i.id === 'plant:b3b')`, 6000);
  await s.sleep(800);
  const onDisk = JSON.parse(readFileSync(join(dataDir, 'company.json'), 'utf8'));
  assert(onDisk.building.shelled === 2, 'the saved file says the pods are migrated');
  const before = await s.eval(`${store}.building`);
  await s.close();
  const app = await launch({ env });
  await app.waitFor('!!window.__office && !!window.office');
  await app.waitFor(`!!${store}.building && !!${store}.company`);
  await app.eval('__office.step(2)');
  const after = await app.eval(`${store}.building`);
  assert(after.shelled === 2 && sameItems(after, before), 'after a restart the building is the same, piece for piece');
  assert(!app.mainLogs.join('\n').includes('stays where the static pod stood'), 'and no block is turned away a second time: the migration did not run again');
  await app.close();
}
