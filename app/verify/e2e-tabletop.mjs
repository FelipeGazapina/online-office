// Small items on top of desks, tables and shelves. The owner puts a lamp, a laptop, books, a mug and the rest on a surface and
// they stay there when the furniture moves, turns, goes to another floor with its block, is deleted (and undone) or the app
// restarts. Real mouse and key events through the DevTools protocol; the checks read the building main holds and the
// instances the scene draws.
// Set OFFICE_SHOTS_DIR to also write place.png, decorated.png and close.png (1440x900) there.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/e2e-tabletop.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, blockItems, cellBounds, checkOps, floorItems, footprint, hostToWorld, ITEM_DEFS, moveBlockOps, parseBuilding, seatPose, topPose, validate } from '../src/shared/space/index.ts';
import { itemOrigin } from '../src/shared/space/buildersGesture.ts';
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
const SHOTS = process.env.OFFICE_SHOTS_DIR;
const company = JSON.parse(readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
writeFileSync(join(dataDir, 'company.json'), JSON.stringify(company));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const file = join(dataDir, 'company.json');
const STORY = 3.2;
const GREEN = '#2fe06a';
const BLOCK = 'blk-a';
const BLOCK_TOPS = 16;
const TABLE = 'meeting_table:00';
const SHELF = 'bookshelf:50';
const HUDDLE = 'blk-a:pod_huddle_table:00';

const disk = () => JSON.parse(readFileSync(file, 'utf8'));
const allItems = (b) => b.stories.flatMap((s) => s.items);
const tops = (b) => allItems(b).filter((i) => i.on !== undefined);
const onHost = (b, id) => tops(b).filter((i) => i.on === id);
const hostIn = (b, id, story = 0) => floorItems(b.stories[story]).find((i) => i.id === id);
const spot = (i) => JSON.stringify({ id: i.id, def: i.def, on: i.on, u: i.u, v: i.v, rot: i.rot });
const poseOf = (b, it, story = 0) => {
  const host = hostIn(b, it.on, story);
  return topPose(host, ITEM_DEFS[host.def], it, ITEM_DEFS[it.def]);
};
const ctxOf = (c) => ({
  blocks: new Set(c.blocks.map((b) => b.id)),
  employees: new Map(c.employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.role === 'orchestrator' }])),
  seats: new Map(c.employees.filter((e) => e.seat).map((e) => [e.id, e.seat])),
});

export async function diagnose(s) {
  console.log('tops at failure:', JSON.stringify(await s.eval(`${store}.building.stories.flatMap((st) => st.items.filter((i) => i.on !== undefined))`)));
  console.log('tool:', JSON.stringify(await s.eval(`${store}.build?.tool`)), JSON.stringify(await s.eval(`${store}.buildCursor`)));
  await s.shot('tabletop-failure');
}

export default async function (s, { launch }) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  if (SHOTS) await s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);
  await s.sleep(800);

  const at = (x, y, z) => s.eval(`__office.project(${x}, ${y}, ${z})`);
  const hold = (code, key) => s.key('keyDown', code, key);
  const release = (code, key) => s.key('keyUp', code, key);
  const building = () => s.eval(`${store}.building`);
  const tool = () => s.eval(`${store}.build?.tool ?? null`);
  const level = () => s.eval(`${store}.build?.level ?? 0`);
  const verdict = () => s.eval(`${store}.buildCursor.verdict`);
  const waitBuilding = (expr, label, ms = 6000) => s.waitFor(`(() => { const b = ${store}.building; return ${expr}; })()`, ms).catch(() => {
    throw new Error(label);
  });
  const park = () => s.mouse('mouseMoved', 720, 20);
  const still = async () => {
    let last = null;
    for (let i = 0; i < 40; i++) {
      const c = await s.eval('({ x: __officeCamera.x, z: __officeCamera.z, y: __officeCamera.y })');
      if (last && Math.hypot(c.x - last.x, c.z - last.z, c.y - last.y) < 0.004) return;
      last = c;
      await s.sleep(200);
    }
  };
  const bring = async (x, y, z) => {
    for (let i = 0; i < 80; i++) {
      const p = await at(x, y, z);
      const key = p.x > 1000 ? ['KeyD', 'd'] : p.x < 440 ? ['KeyA', 'a'] : p.y > 560 ? ['KeyS', 's'] : p.y < 260 ? ['KeyW', 'w'] : null;
      if (!key) {
        await still();
        return at(x, y, z);
      }
      await hold(...key);
      await s.sleep(Math.min(400, 120 + Math.abs(p.x > 1000 || p.x < 440 ? p.x - 720 : p.y - 400) / 3));
      await release(...key);
      await s.sleep(350);
    }
    throw new Error(`could not bring ${x}, ${y}, ${z} into view`);
  };
  const hoverPx = async (p) => {
    await s.mouse('mouseMoved', p.x - 2, p.y);
    await s.mouse('mouseMoved', p.x, p.y);
    await s.sleep(160);
  };
  const probeOf = async (name) => {
    for (let i = 0; i < 15; i++) {
      const [found] = await s.eval(`__office.probe('${name}')`);
      if (found) return found;
      await s.sleep(80);
    }
    return undefined;
  };
  const waitProbe = async (name, at) => {
    let last;
    for (let i = 0; i < 25; i++) {
      last = await probeOf(name);
      if (last && at(last)) return last;
      await s.sleep(80);
    }
    return last;
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

  const centerOf = (b, hostId, def, u, v, rel, story = 0) => poseOf(b, { id: 'probe', def, on: hostId, u, v, rot: rel }, story);
  const choose = async (entry, tab = 'tabletop') => {
    await s.clickOn(`[data-tab="${tab}"]`);
    await s.eval(`document.querySelector('[data-entry="${entry}"]').scrollIntoView({ inline: 'center', block: 'nearest' })`);
    await s.sleep(120);
    await s.clickOn(`[data-entry="${entry}"]`);
    await s.sleep(120);
  };
  const turnTo = async (world) => {
    const now = (await tool()).rot;
    for (let n = 0; n < (((world - now) % 4) + 4) % 4; n++) await s.press('Period');
  };
  const rev = (b) => JSON.stringify(b.stories.map((st) => st.rev));
  const unchanged = (before, after) => rev(before) === rev(after);

  async function pointAt(hostId, def, u, v, rel, story = 0) {
    const b = await building();
    const host = hostIn(b, hostId, story);
    const pose = centerOf(b, hostId, def, u, v, rel, story);
    const px = await bring(pose.x, pose.y + story * STORY, pose.z);
    await turnTo((host.rot + rel) % 4);
    await hoverPx(px);
    return { px, host, pose };
  }
  async function put(entry, def, hostId, u, v, rel = 0, story = 0) {
    await choose(entry);
    const { px, pose } = await pointAt(hostId, def, u, v, rel, story);
    const ghost = await waitProbe('top-footprint', (g) => Math.abs(g.x0 - pose.box.x0) < 0.01 && Math.abs(g.z0 - pose.box.z0) < 0.01);
    assert(ghost?.ok === true && ghost.host === hostId && ghost.color === GREEN, `${def} at ${u},${v} on ${hostId.split(':')[0]}: one green footprint on the top`);
    await s.click(px.x, px.y);
    await waitBuilding(`b.stories[${story}].items.some((i) => i.def === ${JSON.stringify(def)} && i.on === ${JSON.stringify(hostId)} && i.u === ${u} && i.v === ${v} && i.rot === ${rel})`, `${def} did not arrive on ${hostId}`);
    return (await building()).stories[story].items.filter((i) => i.def === def && i.on === hostId && i.u === u && i.v === v).at(-1);
  }
  async function refuse(entry, def, hostId, u, v, text, kind = 'top-footprint') {
    await choose(entry);
    const b = await building();
    const host = hostIn(b, hostId);
    const w = hostToWorld(host, ITEM_DEFS[host.def], u, v);
    const px = await bring(w.x, ITEM_DEFS[host.def].surface.height, w.z);
    await hoverPx(px);
    const ghost = await probeOf(kind);
    const said = await verdict();
    assert(ghost?.ok === false && said?.ok === false && said.text === text, `${text}: the ${def} footprint is red`, JSON.stringify({ ghost, said }));
    await s.click(px.x, px.y);
    await s.sleep(300);
    assert(unchanged(b, await building()), 'and a click there changes nothing');
    await s.press('Escape');
  }

  const b0 = await building();
  const taken = new Set(await s.eval(`${store}.company.employees.map((e) => e.seat)`));
  const benches = blockItems(b0.stories[0], BLOCK).filter((i) => i.def === 'bench_desk');
  const free = benches.filter((i) => !taken.has(i.id));
  const DA = free[0]?.id;
  const DB = free[1]?.id;
  const DC = floorItems(b0.stories[0]).find((i) => i.def === 'bench_desk' && taken.has(i.id))?.id;
  for (const id of [DA, DB, DC, TABLE, HUDDLE, SHELF]) assert(!!id && !!hostIn(b0, id), `${id} is in the building`);
  assert(tops(b0).length === 0 && ITEM_DEFS.bench_desk.surface && ITEM_DEFS.meeting_table.surface && ITEM_DEFS.bookshelf.surface, 'nothing stands on anything yet, and desks, tables and shelves have tops');
  await enterBuild();
  await s.clickOn('[data-tab="tabletop"]');
  const cards = await s.eval(`[...document.querySelectorAll('.bh-card')].map((c) => c.dataset.entry)`);
  assert(cards.length >= 12 && ['laptop', 'books', 'mug', 'picture_frame', 'vase', 'pen_cup', 'desk_clock', 'trophy', 'papers', 'tabletop:lamp_desk', 'tabletop:plant_small'].every((e) => cards.includes(e)), `the Tabletop tab lists ${cards.length} things to put on a surface`);
  assert(await s.eval(`[...document.querySelectorAll('.bh-card img')].every((i) => i.src.startsWith('data:image/png') && i.src.length > 1000)`), 'each with a rendered thumbnail');

  await zoom(-800);
  await choose('tabletop:lamp_desk');
  {
    const host = hostIn(await building(), DA);
    const w = hostToWorld(host, ITEM_DEFS[host.def], 3, 4);
    for (let i = 0; i < 6; i++) {
      const p = await at(w.x, ITEM_DEFS[host.def].surface.height, w.z);
      if (Math.hypot(p.x - 720, p.y - 400) < 90) break;
      const key = Math.abs(p.x - 720) > 90 ? (p.x > 720 ? ['KeyD', 'd'] : ['KeyA', 'a']) : p.y > 400 ? ['KeyS', 's'] : ['KeyW', 'w'];
      await hold(...key);
      await s.sleep(Math.min(350, 80 + Math.max(Math.abs(p.x - 720), Math.abs(p.y - 400)) / 2.5));
      await release(...key);
      await s.sleep(450);
    }
    await still();
  }
  await pointAt(DA, 'lamp_desk', 0, 0, 0);
  await s.sleep(300);
  const lampGhost = await probeOf('top-footprint');
  assert(lampGhost?.ok === true && lampGhost.y > 0.7 && lampGhost.y < 0.76 && (await probeOf('surface'))?.y === lampGhost.y, `the lamp's green footprint lies on the desk top, ${lampGhost?.y} m up, inside the outline of the usable top`);
  await shotTo('place');
  await s.press('Escape');
  await park();
  await zoom(800);

  const placed = [];
  const add = async (...args) => placed.push(await put(...args));
  await add('tabletop:lamp_desk', 'lamp_desk', DA, 0, 0, 0);
  await add('laptop', 'laptop', DA, 0, 3, 2);
  await add('books', 'books', DA, 0, 5, 0);
  await add('mug', 'mug', DA, 10, 1, 0);
  await add('pen_cup', 'pen_cup', DA, 11, 2, 0);
  await add('desk_clock', 'desk_clock', DA, 10, 4, 2);
  await add('vase', 'vase', DA, 4, 6, 0);
  await add('picture_frame', 'picture_frame', DA, 7, 6, 2);
  await add('trophy', 'trophy', DB, 0, 0, 0);
  await add('papers', 'papers', DB, 0, 3, 0);
  await add('tabletop:plant_small', 'plant_small', DB, 0, 5, 0);
  await add('laptop', 'laptop', DC, 0, 3, 2);
  await add('mug', 'mug', DC, 10, 1, 0);
  await add('tabletop:plant_cactus', 'plant_cactus', TABLE, 4, 2, 0);
  await add('books', 'books', TABLE, 10, 4, 1);
  await add('laptop', 'laptop', TABLE, 14, 3, 0);
  await add('tabletop:plant_small', 'plant_small', HUDDLE, 3, 2, 0);
  await add('books', 'books', HUDDLE, 7, 1, 1);
  await add('laptop', 'laptop', HUDDLE, 3, 6, 0);
  await add('vase', 'vase', SHELF, 2, 0, 0);
  await add('tabletop:plant_small', 'plant_small', SHELF, 8, 0, 0);
  const afterPlacing = await building();
  assert(placed.length === 21 && tops(afterPlacing).length === 21, `${placed.length} items were placed with the mouse`);
  assert(onHost(afterPlacing, DA).length === 8 && onHost(afterPlacing, DB).length === 3 && onHost(afterPlacing, DC).length === 2 && onHost(afterPlacing, TABLE).length === 3 && onHost(afterPlacing, HUDDLE).length === 3 && onHost(afterPlacing, SHELF).length === 2, 'on three desks, two tables and a shelf');
  assert(tops(afterPlacing).every((i) => i.x === undefined && i.z === undefined && i.blockId === undefined), 'each records its host and its place on it, and no floor cell');
  assert(validate(parseBuilding(disk().building, () => {}), ctxOf(disk())).filter((v) => v.kind !== 'story_unreachable').length === 0 && tops(parseBuilding(disk().building, () => {})).length === 21, 'company.json holds all of them and the building is valid');
  const drawn = async (def) => s.eval(`__office.instances(${JSON.stringify(def)})`);
  const heightsOk = async (b) => {
    for (const it of tops(b)) {
      const pose = poseOf(b, it);
      const near = (await drawn(it.def)).some((d) => Math.hypot(d.x - pose.x, d.z - pose.z) < 0.02 && Math.abs(d.y - pose.y) < 0.02);
      if (!near) return `${it.def} on ${it.on}`;
    }
    return null;
  };
  assert((await heightsOk(afterPlacing)) === null, 'the scene draws every one at the height of its desk, table or shelf top');
  const laptops = await drawn('laptop');
  assert(laptops.some((d) => Math.abs(d.y - ITEM_DEFS.bench_desk.surface.height) < 0.02) && laptops.some((d) => Math.abs(d.y - ITEM_DEFS.meeting_table.surface.height) < 0.02) && (await drawn('vase')).some((d) => Math.abs(d.y - ITEM_DEFS.bookshelf.surface.height) < 0.02), 'a laptop at desk height and one at table height, a vase 2 m up on the bookshelf');

  await refuse('picture_frame', 'picture_frame', DA, 11.9, 6.5, 'It would hang over the edge');
  await refuse('mug', 'mug', DA, 10.5, 1.5, 'Something is in the way');
  await refuse('mug', 'mug', DA, 6, 5.5, 'Something is in the way');
  await refuse('vase', 'vase', SHELF, 14.9, 1, 'It would hang over the edge');
  {
    await choose('mug');
    const host = hostIn(await building(), DA);
    const bare = hostToWorld(host, ITEM_DEFS[host.def], 6, 4);
    const floor = await bring(bare.x + 4.5, 0, bare.z + 4.5);
    await hoverPx(floor);
    const ghost = await probeOf('footprint');
    const said = await verdict();
    const before = await building();
    assert(ghost?.ok === false && said?.text === 'Put it on a desk, table or shelf', `a mug held over bare floor is red: "${said?.text}"`);
    await s.click(floor.x, floor.y);
    await s.sleep(300);
    assert(unchanged(before, await building()), 'and a click on the floor places nothing');
    await s.press('Escape');
  }
  const stillMug = (await building()).stories[0].items.filter((i) => i.def === 'mug' && i.on === DA);
  assert(stillMug.length === 1, 'none of the refused spots left an item behind');

  await exitBuild();
  const middleOf = (id) => {
    const h = hostIn(afterPlacing, id);
    const f = footprint(ITEM_DEFS[h.def], h.rot);
    return { x: (h.x + f.w / 2) / 2, z: (h.z + f.d / 2) / 2 };
  };
  const [rowAt, tableAt] = [middleOf(DA), middleOf(HUDDLE)];
  await s.eval(`__office.teleport(${(rowAt.x + tableAt.x) / 2 - 0.9}, ${(rowAt.z + tableAt.z) / 2 + 1.0}, Math.PI)`);
  await s.sleep(1500);
  await zoom(-500);
  await shotTo('decorated');
  await zoom(500);
  const deskPose = seatPose(afterPlacing, DA);
  const eye = { x: deskPose.chair.x, z: deskPose.chair.z };
  await s.press('Tab');
  await s.waitFor('window.__officeCamera && Math.abs(window.__officeCamera.blend - 1) < 0.001', 10000);
  await s.eval(`__office.teleport(${eye.x}, ${eye.z}, ${deskPose.yaw})`);
  await s.sleep(500);
  await s.drag({ x: 700, y: 360 }, { x: 700, y: 560 });
  await s.sleep(600);
  await shotTo('close');
  await s.press('Tab');
  await s.waitFor('window.__officeCamera && Math.abs(window.__officeCamera.blend) < 0.001', 10000);
  await s.eval(`__office.teleport(${tableAt.x}, ${tableAt.z + 2.8}, Math.PI)`);
  await s.sleep(600);
  await enterBuild();

  let now = await building();
  const topsOfD0 = onHost(now, DA).map(spot).sort();
  const desk0 = hostIn(now, DA);
  // The pointer has to land on bare desk, not on a thing standing on it, so the desk is the one picked: try points of its footprint until it is the one hovered.
  const grabDesk = async (id, story = 0) => {
    const b = await building();
    const host = hostIn(b, id, story);
    const def = ITEM_DEFS[host.def];
    for (let gv = 7; gv >= 1; gv -= 2) {
      for (let gu = 1; gu < def.w * 4; gu += 2) {
        const w = hostToWorld(host, def, gu, gv);
        const px = await bring(w.x, story * STORY, w.z);
        await hoverPx(px);
        if ((await s.eval(`${store}.buildCursor.hover`)) === id) {
          await s.mouse('mousePressed', px.x, px.y, 1);
          await s.mouse('mouseReleased', px.x, px.y);
          await s.sleep(250);
          return px;
        }
      }
    }
    throw new Error(`no bare point of ${id} to pick it by`);
  };
  await s.clickOn('[data-testid="mode-piece"]');
  await grabDesk(DA);
  assert((await tool()).carry === DA, 'one click on the desk picks the desk up, with its things on it');
  await s.press('Period');
  assert((await tool()).rot === (desk0.rot + 1) % 4, 'the key turns the desk a quarter');
  // The desk is held by its middle, so the pointer goes where the middle of the turned desk should land.
  const turnedRot = (desk0.rot + 1) % 4;
  const middle = (h) => {
    const f = footprint(ITEM_DEFS[h.def], h.rot);
    return { x: (h.x + f.w / 2) / 2, z: (h.z + f.d / 2) / 2 };
  };
  let dropAt = null;
  for (const [dx, dz] of [[0, 5], [0, -5], [5, 0], [-5, 0], [5, 5], [-5, -5]]) {
    const goal = { x: middle(desk0).x + dx, z: middle(desk0).z + dz };
    const origin = itemOrigin(desk0.def, turnedRot, goal);
    if (checkOps(parseBuilding(disk().building, () => {}), [{ t: 'items', story: 0, put: [{ ...desk0, ...origin, rot: turnedRot }], del: [] }], ctxOf(disk())).length === 0) {
      dropAt = { dx, dz, goal };
      break;
    }
  }
  assert(!!dropAt, 'there is free floor for the turned desk');
  const target = dropAt.goal;
  const dropPx = await bring(target.x, 0, target.z);
  await hoverPx(dropPx);
  assert((await probeOf('footprint'))?.ok === true, 'the carried desk shows a green footprint at the new place');
  await s.click(dropPx.x, dropPx.y);
  await waitBuilding(`b.stories[0].items.find((i) => i.id === ${JSON.stringify(DA)}).x !== ${desk0.x} || b.stories[0].items.find((i) => i.id === ${JSON.stringify(DA)}).z !== ${desk0.z}`, 'the desk did not move');
  now = await building();
  const desk0b = hostIn(now, DA);
  assert(desk0b.rot === (desk0.rot + 1) % 4, `the desk moved by ${dropAt.dx} m, ${dropAt.dz} m and turned a quarter`);
  assert(JSON.stringify(onHost(now, DA).map(spot).sort()) === JSON.stringify(topsOfD0) && onHost(now, DA).length === 8, 'its eight things are the same eight, with the same places on it: nothing was edited');
  await s.sleep(400);
  assert((await heightsOk(now)) === null, 'and the scene draws all of them on the desk where it stands now');
  await s.clickOn('[aria-label="Undo"]');
  await waitBuilding(`b.stories[0].items.find((i) => i.id === ${JSON.stringify(DA)}).x === ${desk0.x}`, 'undo did not bring the desk back');
  now = await building();
  assert(hostIn(now, DA).rot === desk0.rot && (await heightsOk(now)) === null && onHost(now, DA).length === 8, 'undo puts the desk and everything on it back');
  await park();

  {
    const mug = onHost(now, DA).find((i) => i.def === 'mug');
    const pose = poseOf(now, mug);
    const px = await bring(pose.x, pose.y + 0.04, pose.z);
    await hoverPx(px);
    assert((await s.eval(`${store}.buildCursor.hover`)) === mug.id, 'pointing at the mug on the desk hovers the mug, not the desk');
    await s.mouse('mousePressed', px.x, px.y, 1);
    await s.mouse('mouseReleased', px.x, px.y);
    await s.sleep(250);
    assert((await tool()).carry === mug.id && (await tool()).def === 'mug', 'one click picks the mug up alone');
    const d1 = hostIn(now, DB);
    const w = hostToWorld(d1, ITEM_DEFS[d1.def], 11, 2);
    const to = await bring(w.x, ITEM_DEFS[d1.def].surface.height, w.z);
    await hoverPx(to);
    assert((await probeOf('top-footprint'))?.ok === true, 'carried over the other desk, its footprint is green');
    await s.click(to.x, to.y);
    await waitBuilding(`b.stories[0].items.find((i) => i.id === ${JSON.stringify(mug.id)}).on === ${JSON.stringify(DB)}`, 'the mug did not move to the other desk');
    const moved = (await building()).stories[0].items.find((i) => i.id === mug.id);
    assert(moved.on === DB && Math.abs(poseOf(await building(), moved).x - w.x) < 0.07 && onHost(await building(), DA).length === 7, 'the same mug now stands on the other desk, and the first desk has seven');
    await s.clickOn('[aria-label="Undo"]');
    await waitBuilding(`b.stories[0].items.find((i) => i.id === ${JSON.stringify(mug.id)}).on === ${JSON.stringify(DA)}`, 'undo did not put the mug back');
    now = await building();
    assert(onHost(now, DA).length === 8, 'and undo puts it back on the first');
    await park();
  }

  const saved = parseBuilding(disk().building, () => {});
  const lot = saved.lot;
  const floorUp = [{ t: 'stories', count: 2 }, { t: 'floor', story: 1, cells: Array.from({ length: lot.w * lot.h }, (_, i) => ({ x: lot.x0 + (i % lot.w), z: lot.z0 + Math.floor(i / lot.w), half: 0, paint: 1 })) }];
  const withFloor = applyOps(saved, floorUp, ctxOf(disk()));
  assert(withFloor.ok, 'floor 2 can be laid over the lot');
  let stairs = null;
  // Stairs open a hole in floor 2 and are the way up for everyone, so they go where the block can land upstairs with its people still able to reach their desks.
  const blockBox = cellBounds(blockItems(saved.stories[0], BLOCK));
  const sameSpot = { quarter: 0, origin: { x: blockBox.x0, z: blockBox.z0 } };
  for (let tz = -9; tz < 6 && !stairs; tz++) {
    for (let tx = -17; tx < 17 && !stairs; tx++) {
      const it = { id: 'stairs:tt', def: 'stairs', x: tx * 2, z: tz * 2, rot: 0 };
      const staged = applyOps(withFloor.building, [{ t: 'items', story: 0, put: [it], del: [] }], ctxOf(disk()));
      if (!staged.ok) continue;
      if (checkOps(staged.building, moveBlockOps(staged.building.stories[0], 0, BLOCK, sameSpot, 1), ctxOf(disk())).length === 0) stairs = it;
    }
  }
  assert(!!stairs, 'there is room for stairs');
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify([...floorUp, { t: 'items', story: 0, put: [stairs], del: [] }])} })`);
  await waitBuilding('b.stories.length === 2 && b.stories[0].items.some((i) => i.def === "stairs")', 'the second floor and its stairs did not arrive');
  now = await building();
  const mover = blockItems(now.stories[0], BLOCK);
  const carriedTops = mover.flatMap((h) => onHost(now, h.id)).map(spot).sort();
  assert(carriedTops.length === BLOCK_TOPS, `team ${BLOCK} has ${carriedTops.length} things standing on its desks`);
  await s.clickOn('[data-testid="mode-block"]');
  const rug = mover.find((i) => i.def === 'pod_rug');
  const rugCenter = { x: rug.x / 2 + 4, z: rug.z / 2 + 3.5 };
  const grabPx = await bring(rugCenter.x, 0, rugCenter.z);
  await hoverPx(grabPx);
  await s.mouse('mousePressed', grabPx.x, grabPx.y, 1);
  await s.mouse('mouseReleased', grabPx.x, grabPx.y);
  await s.sleep(250);
  assert((await tool()).carry?.blockId === BLOCK, 'a click on the team rug picks the whole block up');
  await s.press('PageUp');
  await still();
  assert((await level()) === 1, 'PageUp takes it to floor 2');
  await bring(rugCenter.x, STORY, rugCenter.z);
  const up = await at(rugCenter.x, STORY, rugCenter.z);
  await hoverPx(up);
  const pad = await probeOf('block-footprint');
  assert(pad?.ok === true && pad.color === GREEN, 'on floor 2 the block has one green footprint');
  await s.click(up.x, up.y);
  await waitBuilding(`b.stories[1].items.some((i) => i.blockId === ${JSON.stringify(BLOCK)})`, 'the block did not arrive on floor 2');
  now = await building();
  assert(JSON.stringify(mover.flatMap((h) => onHost(now, h.id)).map(spot).sort()) === JSON.stringify(carriedTops) && now.stories[1].items.filter((i) => i.on !== undefined).length === BLOCK_TOPS && now.stories[0].items.filter((i) => i.on !== undefined && mover.some((h) => h.id === i.on)).length === 0, `all ${BLOCK_TOPS} things went to floor 2 with the desks they stand on, with the same places on them`);
  assert(validate(now, ctxOf(disk())).filter((v) => v.kind !== 'story_unreachable').length === 0, 'and the building is valid');
  await s.sleep(400);
  const drawnUp = async () => {
    for (const it of now.stories[1].items.filter((i) => i.on !== undefined)) {
      const pose = poseOf(now, it, 1);
      const ok = (await drawn(it.def)).some((d) => Math.hypot(d.x - pose.x, d.z - pose.z) < 0.02 && Math.abs(d.y - (pose.y + STORY)) < 0.02);
      if (!ok) return `${it.def} on ${it.on}`;
    }
    return null;
  };
  assert((await drawnUp()) === null, 'floor 2 draws them 3.2 m up, on the desks');
  await s.clickOn('[aria-label="Undo"]');
  await waitBuilding(`b.stories[0].items.some((i) => i.blockId === ${JSON.stringify(BLOCK)}) && !b.stories[1].items.some((i) => i.blockId === ${JSON.stringify(BLOCK)})`, 'undo did not bring the block down');
  now = await building();
  assert(JSON.stringify(mover.flatMap((h) => onHost(now, h.id)).map(spot).sort()) === JSON.stringify(carriedTops) && now.stories[1].items.every((i) => i.on === undefined), `one undo brings the block and all ${BLOCK_TOPS} things back to floor 1`);
  await s.clickOn('[aria-label="Redo"]');
  await waitBuilding(`b.stories[1].items.some((i) => i.blockId === ${JSON.stringify(BLOCK)})`, 'redo did not send the block up');
  await s.clickOn('[aria-label="Undo"]');
  await waitBuilding(`!b.stories[1].items.some((i) => i.blockId === ${JSON.stringify(BLOCK)})`, 'the second undo did not bring the block down');
  await park();
  if ((await level()) === 1) {
    await s.press('PageDown');
    await still();
  }
  assert((await level()) === 0, 'back on floor 1');
  now = await building();
  const hereBox = cellBounds(blockItems(now.stories[0], BLOCK));
  let clear = null;
  for (let r = 2; r <= 40 && !clear; r += 2) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
      const ops = moveBlockOps(now.stories[0], 0, BLOCK, { quarter: 3, origin: { x: hereBox.x0 + dx * 2, z: hereBox.z0 + dz * 2 } });
      if (ops.length && Math.max(Math.abs(dx * 2), Math.abs(dz * 2)) >= hereBox.x1 - hereBox.x0 && checkOps(parseBuilding(disk().building, () => {}), ops, ctxOf(disk())).length === 0) {
        clear = { dx, dz, ops };
        break;
      }
    }
  }
  assert(!!clear && clear.ops.every((o) => o.t !== 'items' || o.put.every((i) => i.on === undefined)), 'moving and turning a block on its floor writes only floor items: nothing of what stands on them');
  await s.clickOn('[data-testid="mode-block"]');
  const grab2 = await bring(rugCenter.x, 0, rugCenter.z);
  await hoverPx(grab2);
  await s.mouse('mousePressed', grab2.x, grab2.y, 1);
  await s.mouse('mouseReleased', grab2.x, grab2.y);
  await s.sleep(250);
  assert((await tool()).carry?.blockId === BLOCK, 'the block is in hand again');
  for (let n = 0; n < 3; n++) await s.press('Period');
  const goal = { x: rugCenter.x + clear.dx, z: rugCenter.z + clear.dz };
  const goalPx = await bring(goal.x, 0, goal.z);
  await hoverPx(goalPx);
  await s.click(goalPx.x, goalPx.y);
  await waitBuilding(`b.stories[0].items.filter((i) => i.blockId === ${JSON.stringify(BLOCK)}).some((i) => i.x !== ${mover[0].x} || i.z !== ${mover[0].z})`, 'the block did not move');
  now = await building();
  assert(JSON.stringify(mover.flatMap((h) => onHost(now, h.id)).map(spot).sort()) === JSON.stringify(carriedTops), 'after moving and turning a block three quarters, every thing is on its desk with the same place on it');
  await s.sleep(400);
  assert((await heightsOk(now)) === null, 'and the scene draws every one of them on the desk where it stands now');
  await park();

  await s.clickOn('[data-testid="mode-piece"]');
  const beforeDelete = await building();
  const onD1 = onHost(beforeDelete, DB).length;
  await grabDesk(DB);
  assert((await tool()).carry === DB, 'the second desk is in hand');
  await s.press('Delete');
  await waitBuilding(`!b.stories[0].items.some((i) => i.id === ${JSON.stringify(DB)})`, 'the desk was not deleted');
  now = await building();
  assert(onD1 >= 3 && !now.stories[0].items.some((i) => i.on === DB) && allItems(now).length === allItems(beforeDelete).length - 1 - onD1, `Delete took the desk and the ${onD1} things on it, and nothing else`);
  assert((await drawn('trophy')).length === 0, 'the scene no longer draws them');
  await s.chord('z', 2);
  await waitBuilding(`b.stories[0].items.some((i) => i.id === ${JSON.stringify(DB)})`, 'undo did not bring the desk back');
  now = await building();
  assert(JSON.stringify(allItems(now).map(spot)) === JSON.stringify(allItems(beforeDelete).map(spot)) && rev(now) === rev(beforeDelete), 'undo puts the desk and everything on it back exactly, the whole building equal to before');
  assert((await heightsOk(now)) === null, 'and the scene draws them on the desk again');
  await park();
  await exitBuild();

  const seated = await s.eval(`(() => { const mine = ${store}.company.employees.filter((e) => e.seat).map((e) => e.id); return __office.state().avatars.filter((a) => mine.includes(a.id)).every((a) => a.seated) && mine.length; })()`);
  assert(seated >= 3, `the people at their desks (${seated}) are still sitting there`);

  const expected = tops(parseBuilding(disk().building, () => {})).map(spot).sort();
  assert(expected.length === 21, 'company.json holds the 21 things');
  await s.close();
  const app = await launch({ env });
  await app.waitFor('!!window.__office && !!window.office');
  await app.waitFor(`!!${store}.building && !!${store}.company`);
  await app.eval('__office.step(2)');
  await app.sleep(800);
  const reopened = await app.eval(`${store}.building`);
  assert(JSON.stringify(tops(reopened).map(spot).sort()) === JSON.stringify(expected), 'after a restart every thing is on the same host at the same place');
  const lamp = tops(reopened).find((i) => i.def === 'laptop' && i.on === TABLE);
  const pose = poseOf(reopened, lamp);
  assert((await app.eval(`__office.instances('laptop')`)).some((d) => Math.hypot(d.x - pose.x, d.z - pose.z) < 0.02 && Math.abs(d.y - pose.y) < 0.02), 'and the scene draws them there');
  await app.eval(`window.office.send({ type: 'remove_block', blockId: ${JSON.stringify(BLOCK)} })`);
  await app.waitFor(`!${store}.company.blocks.some((b) => b.id === ${JSON.stringify(BLOCK)})`, 8000);
  await app.waitFor(`${store}.building.stories[0].items.every((i) => i.blockId !== ${JSON.stringify(BLOCK)})`, 8000);
  const after = await app.eval(`${store}.building`);
  assert(tops(after).length === 5 && tops(after).every((i) => !!hostIn(after, i.on)), 'removing the team takes what stood on its desks and its huddle table; the 5 on the meeting table and the shelf stay, each on a host that is still there');
  await app.close();
}
