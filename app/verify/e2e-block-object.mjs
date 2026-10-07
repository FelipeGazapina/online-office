// A project block is a set of ordinary items. The owner picks a whole block up and puts it down on the lot, on another
// floor, or deletes it with its people; each piece of it (rug, boundary, decor, huddle, board, desks) is also picked, moved
// and deleted alone. Real mouse and key events through the DevTools protocol; the checks read the building main holds.
// By default it runs on the verify fixture. Set OFFICE_B3_COMPANY to a copy of a real company.json to run it there: block
// cwds are pointed at a scratch repo first. Three blocks play a part: OFFICE_B3_MOVE is carried to floor 2 and across the lot and
// then removed, OFFICE_B3_PIECES keeps its block while its pieces are deleted one by one, OFFICE_B3_ASK is the one the owner
// is asked about. The block to move must sit above the lowest free slot, so its old spot is bare ground once it is removed.
// Set OFFICE_SHOTS_DIR to also write block-carry.png, old-spot.png and piece.png (1440x900) there.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/e2e-block-object.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOps, blockItems, cellBounds, checkOps, footprint, ITEM_DEFS, moveBlockOps, parseBuilding, shellItems } from '../src/shared/space/index.ts';
import { itemAt } from '../src/shared/space/buildersGesture.ts';
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
mkdirSync(join(repo, 'b'));
const source = process.env.OFFICE_B3_COMPANY;
const SHOTS = process.env.OFFICE_SHOTS_DIR;
const company = source ? JSON.parse(readFileSync(source, 'utf8')) : JSON.parse(readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
if (source) for (const block of company.blocks) block.cwd = repo;
writeFileSync(join(dataDir, 'company.json'), JSON.stringify(company));
const nameOf = (id) => company.blocks.find((b) => b.id === id)?.name ?? id;
const blockNames = [];
const MOVE = process.env.OFFICE_B3_MOVE ?? 'blk-b';
const ASK = process.env.OFFICE_B3_ASK ?? 'blk-a';
const PIECES = process.env.OFFICE_B3_PIECES;
const find = (key) => company.blocks.find((b) => b.id === key || b.name === key)?.id;
const moveId = find(MOVE);
const askId = find(ASK);
mkdirSync(join(repo, 'c'));

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const file = join(dataDir, 'company.json');
const GREEN = '#2fe06a';
const STORY = 3.2;
const POD = ['pod_rug', 'pod_rail_back', 'pod_rail_side', 'pod_glass_rail', 'pod_slat_wall', 'pod_credenza', 'pod_printer', 'pod_cooler', 'pod_bin', 'pod_shelf', 'pod_boxes', 'pod_pouf', 'pod_huddle_table', 'pod_daily_sign', 'chair', 'plant', 'lamp_floor'];
const centerOf = (i) => {
  const f = footprint(ITEM_DEFS[i.def], i.rot);
  return { x: i.x / 2 + f.w / 4, z: i.z / 2 + f.d / 4 };
};
const disk = () => JSON.parse(readFileSync(file, 'utf8'));
const allItems = (b) => b.stories.flatMap((s) => s.items);
const ofBlock = (b, id) => allItems(b).filter((i) => i.blockId === id);
const byId = (b) => new Map(allItems(b).map((i) => [i.id, i]));
const same = (a, b) => !!a && !!b && a.x === b.x && a.z === b.z && a.rot === b.rot && a.def === b.def && a.blockId === b.blockId;
// The story's items as the shared module reads them; paint and walls do not matter to picking.
const storyOf = (b, n) => ({ items: b.stories[n].items });

function ctxOf(c) {
  return {
    blocks: new Set(c.blocks.map((b) => b.id)),
    employees: new Map(c.employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.role === 'orchestrator' }])),
    seats: new Map(c.employees.filter((e) => e.seat).map((e) => [e.id, e.seat])),
  };
}

export default async function (s, { launch }) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  // The pictures are for people to read, so they carry no test banner.
  if (SHOTS) await s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);
  await s.sleep(800);
  assert(!!moveId && !!askId && moveId !== askId, `${nameOf(moveId)} is carried and removed, ${nameOf(askId)} is the one the owner is asked about`);
  // The team whose pieces are deleted one by one is a new one unless a real company names it.
  let piecesId = PIECES ? find(PIECES) : null;
  if (!piecesId) {
    await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(join(repo, 'c'))} })`);
    await s.waitFor(`${store}.company.blocks.some((b) => b.cwd === ${JSON.stringify(join(repo, 'c'))})`, 8000);
    piecesId = await s.eval(`${store}.company.blocks.find((b) => b.cwd === ${JSON.stringify(join(repo, 'c'))}).id`);
    await s.sleep(500);
  }
  assert(!!piecesId && ![moveId, askId].includes(piecesId), `${nameOf(piecesId) ?? 'a new team'} keeps its block while its pieces are deleted one by one`);

  const at = (x, z, level = 0) => s.eval(`__office.project(${x}, ${level * STORY}, ${z})`);
  const hold = (code, key) => s.key('keyDown', code, key);
  const release = (code, key) => s.key('keyUp', code, key);
  const building = () => s.eval(`${store}.building`);
  const tool = () => s.eval(`${store}.build?.tool ?? null`);
  const level = () => s.eval(`${store}.build?.level ?? 0`);
  const waitBuilding = (expr, label, ms = 6000) => s.waitFor(`(() => { const b = ${store}.building; return ${expr}; })()`, ms).catch(() => {
    throw new Error(label);
  });
  const still = async () => {
    let last = null;
    for (let i = 0; i < 40; i++) {
      const c = await s.eval('({ x: __officeCamera.x, z: __officeCamera.z, y: __officeCamera.y })');
      if (last && Math.hypot(c.x - last.x, c.z - last.z, c.y - last.y) < 0.004) return;
      last = c;
      await s.sleep(200);
    }
  };
  // Pans the build camera with the real keys until a point of the floor sits in the middle third of the screen.
  const bring = async (x, z, lv = 0) => {
    for (let i = 0; i < 60; i++) {
      const p = await at(x, z, lv);
      const key = p.x > 1000 ? ['KeyD', 'd'] : p.x < 300 ? ['KeyA', 'a'] : p.y > 560 ? ['KeyS', 's'] : p.y < 230 ? ['KeyW', 'w'] : null;
      if (!key) return p;
      await hold(...key);
      await s.sleep(Math.min(400, 120 + Math.abs(p.x > 1000 || p.x < 300 ? p.x - 650 : p.y - 350) / 3));
      await release(...key);
      await s.sleep(350);
    }
    throw new Error(`could not bring ${x}, ${z} into view`);
  };
  const hover = async (x, z, lv = 0) => {
    const p = await at(x, z, lv);
    await s.mouse('mouseMoved', p.x - 2, p.y);
    await s.mouse('mouseMoved', p.x, p.y);
    await s.sleep(160);
    return p;
  };
  const footprintProbe = async (name) => {
    for (let i = 0; i < 20; i++) {
      const [found] = await s.eval(`__office.probe('${name}')`);
      if (found) return found;
      await s.sleep(100);
    }
    return undefined;
  };
  const enterBuild = async () => {
    await s.clickOn('[data-testid="build-enter"]');
    await s.waitFor(`!!${store}.build`, 4000);
    await s.sleep(500);
  };
  const exitBuild = async () => {
    await s.clickOn('.bh-done');
    await s.waitFor(`${store}.build === null`, 4000);
  };
  const park = () => s.mouse('mouseMoved', 720, 20);
  const zoom = async (delta) => {
    await s.eval(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: ${delta}, bubbles: true }))`);
    await s.sleep(700);
    await still();
  };
  const shotTo = async (name) => {
    const path = await s.shot(name);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      copyFileSync(path, join(SHOTS, `${name}.png`));
    }
    return path;
  };

  // ---- every piece of every team is an item, from the first launch
  let b = await building();
  assert(b.shelled === true && disk().building.shelled === true, 'the building says the pods are items, in memory and on disk');
  for (const block of company.blocks) {
    const have = new Set(ofBlock(b, block.id).map((i) => i.def));
    const missing = POD.filter((d) => !have.has(d));
    assert(missing.length === 0 && ['whiteboard', 'board_terminal', 'team_sign', 'bench_desk', 'po_desk'].every((d) => have.has(d)), `${block.name} has its desks, board, sign and its whole pod as items${missing.length ? ` (missing ${missing})` : ''}`);
  }

  await enterBuild();

  // ---- each piece of a block alone: picked, moved, put back, deleted
  const pieceBlock = ofBlock(b, piecesId);
  const exposed = (item, b0) => {
    const f = footprint(ITEM_DEFS[item.def], item.rot);
    const st = storyOf(b0, 0);
    for (let cz = item.z; cz < item.z + f.d; cz++) {
      for (let cx = item.x; cx < item.x + f.w; cx++) {
        const p = { x: (cx + 0.5) / 2, z: (cz + 0.5) / 2 };
        if (itemAt(st, p)?.id === item.id) return p;
      }
    }
    return null;
  };
  const rug = pieceBlock.find((i) => i.def === 'pod_rug');
  const rugPoint = exposed(rug, b);
  assert(!!rugPoint, 'a bare patch of the rug can be pointed at');
  await s.clickOn('[data-testid="mode-piece"]');
  const here = await bring(rugPoint.x, rugPoint.z);
  await hover(rugPoint.x, rugPoint.z);
  assert((await s.eval(`${store}.buildCursor.hover`)) === rug.id, 'pointing at the bare rug hovers the rug');
  await s.mouse('mousePressed', here.x, here.y, 1);
  await s.mouse('mouseReleased', here.x, here.y);
  await s.sleep(250);
  const inHand = await tool();
  assert(inHand.kind === 'item' && inHand.carry === rug.id && inHand.def === 'pod_rug', 'one click picks the rug up alone');
  const ctx0 = ctxOf(company);
  const treeNow = parseBuilding(disk().building, () => {});
  // The nearest free ground for the rug alone, where it lies on no other floor item.
  let drop = null;
  for (let r = 4; r <= 40 && !drop; r += 2) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const moved = { ...rug, x: rug.x + dx, z: rug.z + dz };
      if (checkOps(treeNow, [{ t: 'items', story: 0, put: [moved], del: [] }], ctx0).length === 0) {
        drop = { dx, dz };
        break;
      }
    }
  }
  assert(!!drop, `there is ground where the rug fits alone (${drop?.dx / 2} m, ${drop?.dz / 2} m away)`);
  // A piece is held by its middle, so the pointer goes where the middle should land.
  const to = { x: centerOf(rug).x + drop.dx / 2, z: centerOf(rug).z + drop.dz / 2 };
  await bring(to.x, to.z);
  await hover(to.x, to.z);
  assert((await footprintProbe('footprint'))?.ok === true, 'the rug follows the pointer with a green footprint');
  const landing = await at(to.x, to.z);
  await s.click(landing.x, landing.y);
  await waitBuilding(`b.stories[0].items.find((i) => i.id === ${JSON.stringify(rug.id)}).x === ${rug.x + drop.dx}`, 'the rug did not move');
  const afterRug = await building();
  const changed = allItems(afterRug).filter((i) => !same(i, byId(b).get(i.id)));
  assert(changed.length === 1 && changed[0].id === rug.id, 'only the rug moved: the rest of the block stayed where it was');
  assert(allItems(afterRug).length === allItems(b).length, 'and nothing was added or lost');
  await s.clickOn('[aria-label="Undo"]');
  await waitBuilding(`b.stories[0].items.find((i) => i.id === ${JSON.stringify(rug.id)}).x === ${rug.x}`, 'undo did not bring the rug back');
  assert(allItems(await building()).every((i) => same(i, byId(b).get(i.id))), 'undo puts the rug back exactly');

  // One object of the pod in hand, on open ground beside the pod: the picture for a piece moved alone.
  const credenza = pieceBlock.find((i) => i.def === 'pod_credenza');
  const credenzaPoint = exposed(credenza, b);
  const credenzaAt = await bring(credenzaPoint.x, credenzaPoint.z);
  await hover(credenzaPoint.x, credenzaPoint.z);
  await s.mouse('mousePressed', credenzaAt.x, credenzaAt.y, 1);
  await s.mouse('mouseReleased', credenzaAt.x, credenzaAt.y);
  await s.sleep(250);
  assert((await tool()).carry === credenza.id, 'one click picks the credenza up alone');
  let nudge = null;
  for (let r = 4; r <= 24 && !nudge; r += 2) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      if (checkOps(treeNow, [{ t: 'items', story: 0, put: [{ ...credenza, x: credenza.x + dx, z: credenza.z + dz }], del: [] }], ctx0).length === 0) {
        nudge = { dx, dz };
        break;
      }
    }
  }
  assert(!!nudge, 'there is open floor within reach for it');
  const credenzaTo = { x: centerOf(credenza).x + nudge.dx / 2, z: centerOf(credenza).z + nudge.dz / 2 };
  await bring((credenzaTo.x + credenzaPoint.x) / 2, (credenzaTo.z + credenzaPoint.z) / 2);
  await hover(credenzaTo.x, credenzaTo.z);
  assert((await footprintProbe('footprint'))?.ok === true, 'the credenza follows the pointer with a green footprint');
  await zoom(-250);
  await hover(credenzaTo.x, credenzaTo.z);
  await shotTo('piece');
  await zoom(250);
  await s.press('Escape');
  assert((await tool()).kind === 'select' && allItems(await building()).every((i) => same(i, byId(b).get(i.id))), 'Esc puts it back');

  // Every kind of piece is deleted by itself with the Delete key, and each leaves the rest as it was.
  const taken = new Set(await s.eval(`${store}.company.employees.map((e) => e.seat)`));
  const unseated = pieceBlock.find((i) => i.def === 'bench_desk' && !taken.has(i.id));
  const kinds = [...POD, 'whiteboard', 'board_terminal', 'team_sign', 'bench_desk'];
  const victims = kinds.map((def) => (def === 'bench_desk' ? unseated : pieceBlock.find((i) => i.def === def && (def !== 'pod_rail_side' || i.rot === 1)))).filter(Boolean);
  assert(victims.length === kinds.length, `one of each of ${kinds.length} kinds is there to delete`);
  let current = await building();
  const gone = [];
  for (const victim of victims) {
    const p = exposed(victim, current);
    assert(!!p, `${victim.def} has a spot nothing stands on`);
    await bring(p.x, p.z);
    await hover(p.x, p.z);
    const hovered = await s.eval(`${store}.buildCursor.hover`);
    assert(hovered === victim.id, `pointing at the ${victim.def} hovers it`);
    await s.press('Delete');
    await waitBuilding(`!b.stories[0].items.some((i) => i.id === ${JSON.stringify(victim.id)})`, `${victim.def} was not deleted`);
    gone.push(victim.id);
    const next = await building();
    const lost = allItems(current).filter((i) => !byId(next).has(i.id));
    assert(lost.length === 1 && lost[0].id === victim.id && allItems(next).every((i) => same(i, byId(current).get(i.id))), `Delete took the ${victim.def} and nothing else`);
    current = next;
  }
  const afterPieces = current;
  await park();

  // ---- a whole block to another floor and back
  await exitBuild();
  const mover = ofBlock(afterPieces, moveId);
  const box = cellBounds(mover);
  const saved = parseBuilding(disk().building, () => {});
  const stairTry = (b0, c) => {
    for (let tz = -9; tz < 6; tz++) {
      for (let tx = -17; tx < 17; tx++) {
        const item = { id: 'stairs:b3', def: 'stairs', x: tx * 2, z: tz * 2, rot: 0 };
        if (checkOps(b0, [{ t: 'items', story: 0, put: [item], del: [] }], c).length === 0) return item;
      }
    }
    return null;
  };
  const lot = saved.lot;
  const floorUp = [{ t: 'stories', count: 2 }, { t: 'floor', story: 1, cells: Array.from({ length: lot.w * lot.h }, (_, i) => ({ x: lot.x0 + (i % lot.w), z: lot.z0 + Math.floor(i / lot.w), half: 0, paint: 1 })) }];
  const withFloor = applyOps(saved, floorUp, ctxOf(disk()));
  assert(withFloor.ok, 'floor 2 can be laid over the lot');
  const stairs = stairTry(withFloor.building, ctxOf(disk()));
  assert(!!stairs, 'there is room for stairs');
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify([...floorUp, { t: 'items', story: 0, put: [stairs], del: [] }])} })`);
  await waitBuilding('b.stories.length === 2 && b.stories[0].items.some((i) => i.def === "stairs")', 'the second floor and its stairs did not arrive');
  await enterBuild();

  const holdPoint = (items) => {
    const st = storyOf({ stories: [{ items }] }, 0);
    const rugItem = items.find((i) => i.def === 'pod_rug');
    return rugItem ? exposed(rugItem, { stories: [st] }) ?? centerOf(rugItem) : centerOf(items[0]);
  };
  const pick = async (items, lv) => {
    const p = holdPoint(items);
    const px = await bring(p.x, p.z, lv);
    await hover(p.x, p.z, lv);
    await s.mouse('mousePressed', px.x, px.y, 1);
    await s.mouse('mouseReleased', px.x, px.y);
    await s.sleep(250);
    return p;
  };
  await s.clickOn('[data-testid="mode-block"]');
  const grab = await pick(mover, 0);
  let held = await tool();
  assert(held.kind === 'block' && held.carry?.blockId === moveId, `a click on the ${nameOf(moveId)} rug picks the whole block up`);
  await s.press('PageUp');
  await waitBuilding(`${store}.build.level === 1`, 'PageUp did not change the floor').catch(() => {});
  await still();
  held = await tool();
  assert((await level()) === 1 && held.kind === 'block' && held.carry?.blockId === moveId, 'PageUp takes the block in hand up to floor 2');
  await bring(grab.x, grab.z, 1);
  await hover(grab.x, grab.z, 1);
  const upPad = await footprintProbe('block-footprint');
  assert(upPad?.ok === true && upPad.color === GREEN, 'on floor 2 the one footprint is green');
  const drop2 = await at(grab.x, grab.z, 1);
  await s.click(drop2.x, drop2.y);
  await waitBuilding(`b.stories[1].items.some((i) => i.blockId === ${JSON.stringify(moveId)})`, 'the block did not arrive on floor 2');
  const up = await building();
  assert(blockItems(up.stories[0], moveId).length === 0 && blockItems(up.stories[1], moveId).length === mover.length, `all ${mover.length} pieces are on floor 2 and none is left on floor 1`);
  assert(blockItems(up.stories[1], moveId).every((i) => same(i, mover.find((m) => m.id === i.id))), 'at the same place, on the other floor, with the same ids and turns');
  const seatsUp = await s.eval(`${store}.company.employees.filter((e) => e.blockId === ${JSON.stringify(moveId)}).map((e) => e.seat)`);
  assert(seatsUp.every((id) => !id || up.stories[1].items.some((i) => i.id === id)), 'the people of the block still hold desks, now upstairs');

  const upItems = blockItems(up.stories[1], moveId);
  const grab2 = await pick(upItems, 1);
  held = await tool();
  assert(held.kind === 'block' && held.carry?.blockId === moveId, 'on floor 2 a click picks it up again');
  await s.press('PageDown');
  await still();
  assert((await level()) === 0 && (await tool()).carry?.blockId === moveId, 'PageDown brings it back down in hand');
  await bring(grab2.x, grab2.z, 0);
  await hover(grab2.x, grab2.z, 0);
  const down = await at(grab2.x, grab2.z, 0);
  await s.click(down.x, down.y);
  await waitBuilding(`b.stories[0].items.some((i) => i.blockId === ${JSON.stringify(moveId)}) && !b.stories[1].items.some((i) => i.blockId === ${JSON.stringify(moveId)})`, 'the block did not come back to floor 1');
  const back = await building();
  assert(blockItems(back.stories[0], moveId).every((i) => same(i, mover.find((m) => m.id === i.id))), 'and it stands where it started, piece for piece');
  const onFloor = (n) => `b.stories[${n}].items.filter((i) => i.blockId === ${JSON.stringify(moveId)}).length === ${mover.length} && b.stories[${1 - n}].items.every((i) => i.blockId !== ${JSON.stringify(moveId)})`;
  await s.clickOn('[aria-label="Undo"]');
  await waitBuilding(onFloor(1), 'the first undo did not take the block back up');
  assert(true, 'one undo takes the whole block back up to floor 2');
  await s.clickOn('[aria-label="Undo"]');
  await waitBuilding(onFloor(0), 'the second undo did not bring it back down');
  assert(blockItems((await building()).stories[0], moveId).every((i) => same(i, mover.find((m) => m.id === i.id))), 'and the next one puts it on floor 1 where it began');
  await s.clickOn('[aria-label="Redo"]');
  await waitBuilding(onFloor(1), 'the first redo did not send the block up');
  await s.clickOn('[aria-label="Redo"]');
  await waitBuilding(onFloor(0), 'the second redo did not bring it down');
  assert(true, 'redo walks it up and down the same way');
  await park();

  // ---- deleting a block from build mode: a question that names the people, then everything goes
  const askItems = ofBlock(await building(), askId);
  const people = company.employees.filter((e) => e.blockId === askId).map((e) => e.name);
  await s.clickOn('[data-testid="mode-block"]');
  const askAt = holdPoint(askItems);
  const askPx = await bring(askAt.x, askAt.z);
  await hover(askAt.x, askAt.z);
  await s.mouse('mousePressed', askPx.x, askPx.y, 1);
  await s.mouse('mouseReleased', askPx.x, askPx.y);
  await s.sleep(250);
  assert((await tool()).carry?.blockId === askId, `${nameOf(askId)} is picked up to be deleted`);
  await s.press('Delete');
  await s.waitFor(`!!document.querySelector('[data-testid="remove-block-dialog"]')`, 3000);
  const asked = await s.eval(`document.querySelector('[data-testid="remove-block-people"]').textContent`);
  assert(people.every((name) => asked.includes(name)), `Delete asks first, naming ${people.join(', ') || 'nobody'}: "${asked}"`);
  assert((await s.eval(`${store}.company.blocks.some((b) => b.id === ${JSON.stringify(askId)})`)) === true && ofBlock(await building(), askId).length === askItems.length, 'and nothing is deleted while it waits');
  await s.press('Escape');
  await s.waitFor(`!document.querySelector('[data-testid="remove-block-dialog"]')`, 3000);
  assert(ofBlock(await building(), askId).length === askItems.length, 'Esc keeps the block, every piece of it');
  await s.press('Delete');
  await s.waitFor(`!!document.querySelector('[data-testid="remove-block-dialog"]')`, 3000);
  const before = allItems(await building()).filter((i) => i.blockId !== askId);
  await s.press('Enter');
  await waitBuilding(`!b.stories.some((st) => st.items.some((i) => i.blockId === ${JSON.stringify(askId)}))`, 'the block was not removed');
  const askGone = `!${store}.company.blocks.some((b) => b.id === ${JSON.stringify(askId)}) && !${store}.company.employees.some((e) => e.blockId === ${JSON.stringify(askId)})`;
  await s.waitFor(askGone, 5000).catch(() => {});
  assert(await s.eval(askGone), `Enter removes ${nameOf(askId)} and fires ${people.length} people with it`);
  const afterAsk = allItems(await building());
  const afterIds = byId(await building());
  assert(before.length === afterAsk.length && before.every((i) => same(i, afterIds.get(i.id))), 'and no other team lost or moved a piece');
  await park();

  // ---- a whole block across the lot leaves nothing behind
  const nowBuilding = await building();
  const parsed = parseBuilding(disk().building, () => {});
  const here0 = ofBlock(nowBuilding, moveId);
  const hbox = cellBounds(here0);
  // The nearest free ground, or the meters in OFFICE_B3_TARGET ("12,-10") when a picture wants the block somewhere in particular.
  let moveTo = null;
  const wanted = process.env.OFFICE_B3_TARGET?.split(',').map(Number);
  for (let r = 2; r <= 40 && !moveTo; r += 2) {
    for (const [dx, dz] of wanted ? [wanted] : [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const ops = moveBlockOps(parsed.stories[0], 0, moveId, { quarter: 0, origin: { x: hbox.x0 + dx * 2, z: hbox.z0 + dz * 2 } });
      const clear = Math.abs(dx * 2) >= hbox.x1 - hbox.x0 || Math.abs(dz * 2) >= hbox.z1 - hbox.z0;
      if (clear && ops.length && checkOps(parsed, ops, ctxOf(disk())).length === 0) {
        moveTo = { dx, dz };
        break;
      }
    }
  }
  assert(!!moveTo, `there is free ground for the block (${moveTo?.dx} m, ${moveTo?.dz} m away)`);
  const oldRect = { x0: hbox.x0 / 2, z0: hbox.z0 / 2, x1: hbox.x1 / 2, z1: hbox.z1 / 2 };
  const oldMiddle = { x: (oldRect.x0 + oldRect.x1) / 2, z: (oldRect.z0 + oldRect.z1) / 2 };
  const startAt = holdPoint(here0);
  const grabPx = await bring(startAt.x, startAt.z);
  await hover(startAt.x, startAt.z);
  await s.mouse('mousePressed', grabPx.x, grabPx.y, 1);
  await s.mouse('mouseReleased', grabPx.x, grabPx.y);
  await s.sleep(250);
  assert((await tool()).carry?.blockId === moveId, 'the block is in hand again');
  const goal = { x: startAt.x + moveTo.dx, z: startAt.z + moveTo.dz };
  await bring(goal.x, goal.z);
  await hover(goal.x, goal.z);
  await s.sleep(250);
  const carryPad = await footprintProbe('block-footprint');
  assert(carryPad?.ok === true && carryPad.pieces === here0.length, `one green footprint carries all ${here0.length} pieces, rug and boundary with the desks`);
  // Far enough out that the block where it stands and where it is going share the picture.
  await zoom(700);
  await bring((startAt.x + goal.x) / 2, (startAt.z + goal.z) / 2);
  await hover(goal.x, goal.z);
  await s.sleep(300);
  await shotTo('block-carry');
  await zoom(-700);
  await bring(goal.x, goal.z);
  await hover(goal.x, goal.z);
  const drop3 = await at(goal.x, goal.z);
  await s.click(drop3.x, drop3.y);
  await waitBuilding(`b.stories[0].items.filter((i) => i.blockId === ${JSON.stringify(moveId)}).some((i) => i.x !== ${here0[0].x})`, 'the block did not move');
  const moved = ofBlock(await building(), moveId);
  const dx = moved[0].x - here0[0].x;
  const dz = moved[0].z - here0[0].z;
  assert(moved.length === here0.length && moved.every((i) => { const o = here0.find((h) => h.id === i.id); return o && i.x - o.x === dx && i.z - o.z === dz && i.rot === o.rot; }), `every piece moved by the same ${dx / 2} m, ${dz / 2} m`);
  const stale = ofBlock(await building(), moveId).filter((i) => { const f = footprint(ITEM_DEFS[i.def], i.rot); return i.x < hbox.x1 && i.x + f.w > hbox.x0 && i.z < hbox.z1 && i.z + f.d > hbox.z0; });
  assert(stale.length === 0, 'no item of the block is left inside its old footprint');
  assert(allItems(await building()).filter((i) => i.blockId !== moveId).every((i) => same(i, byId(nowBuilding).get(i.id))), 'and nothing of another team moved');
  const nearChair = async () => {
    const mine = await s.eval(`${store}.company.employees.filter((e) => e.blockId === ${JSON.stringify(moveId)}).map((e) => e.id)`);
    const avatars = (await s.eval('__office.state()')).avatars.filter((a) => mine.includes(a.id));
    return avatars.every((a) => a.seated);
  };
  await s.waitFor('true');
  assert(await nearChair(), 'the people of the block sit at their desks in the new place');

  // The old spot, photographed with the block gone, and again once it is deleted: nothing of the block may be in the difference.
  await park();
  await bring(oldMiddle.x, oldMiddle.z);
  await still();
  await s.mouse('mouseMoved', 720, 20);
  await s.sleep(300);
  const quiet = await shotTo('old-spot');
  // The screen area the old footprint covers, up to a person's height above it, so a leftover standing there shows; and the
  // area of the new place, which is left out because the block is in it in one picture and gone in the other.
  const hullOf = async (rect) => {
    const pts = [];
    for (const [x, z] of [[rect.x0, rect.z0], [rect.x1, rect.z0], [rect.x0, rect.z1], [rect.x1, rect.z1]]) for (const y of [0, 3]) pts.push(await s.eval(`__office.project(${x}, ${y}, ${z})`));
    return pts.map((p) => [Math.round(p.x), Math.round(p.y)]);
  };
  const newBox = cellBounds(moved);
  const keep = await hullOf(oldRect);
  const skip = await hullOf({ x0: newBox.x0 / 2, z0: newBox.z0 / 2, x1: newBox.x1 / 2, z1: newBox.z1 / 2 });
  copyFileSync(quiet, '/tmp/b3-old-spot-moved.png');

  // The same camera, the same office, the block removed: what is left at the old spot must be what the old spot looked like.
  await s.eval(`window.office.send({ type: 'remove_block', blockId: ${JSON.stringify(moveId)} })`);
  await waitBuilding(`!b.stories.some((st) => st.items.some((i) => i.blockId === ${JSON.stringify(moveId)}))`, 'the carried block was not removed');
  await s.waitFor(`!${store}.company.blocks.some((b) => b.id === ${JSON.stringify(moveId)})`, 5000);
  await s.sleep(600);
  const empty = await s.shot('old-spot-empty');
  copyFileSync(empty, '/tmp/b3-old-spot-empty.png');
  const diff = JSON.parse(execFileSync('python3', [fileURLToPath(new URL('./region-diff.py', import.meta.url)), '/tmp/b3-old-spot-moved.png', '/tmp/b3-old-spot-empty.png', JSON.stringify(keep), JSON.stringify(skip)], { encoding: 'utf8' }));
  assert(diff.pixels > 20000 && diff.mean < 0.8 && diff.share < 1.5, `the old spot after the move looks like ground with no block at all: ${diff.mean}% mean, ${diff.share}% of ${diff.pixels} pixels over the noise`);
  await exitBuild();

  // ---- all of it survives a restart
  const onDisk = disk();
  const expected = allItems(parseBuilding(onDisk.building, () => {}));
  assert(gone.every((id) => !expected.some((i) => i.id === id)) && !expected.some((i) => i.blockId === moveId) && expected.some((i) => i.blockId === piecesId), 'company.json holds the building without the deleted pieces and without the deleted block');
  await s.close();
  const app = await launch({ env });
  await app.waitFor('!!window.__office && !!window.office');
  await app.waitFor(`!!${store}.building && !!${store}.company`);
  await app.eval('__office.step(2)');
  await app.sleep(500);
  const reopened = await app.eval(`${store}.building`);
  const reopenedItems = allItems(reopened);
  assert(reopenedItems.length === expected.length && reopenedItems.every((i) => same(i, expected.find((e) => e.id === i.id))), 'after a restart the building is the one left behind');
  assert(gone.every((id) => !reopenedItems.some((i) => i.id === id)), `the ${gone.length} deleted pieces are still gone`);
  assert(!reopenedItems.some((i) => i.blockId === moveId) && !(await app.eval(`${store}.company.blocks.some((b) => b.id === ${JSON.stringify(moveId)})`)), 'the deleted block is still gone, with its people');
  assert(reopened.shelled === true, 'and the migration did not run again');
  await app.close();
}
