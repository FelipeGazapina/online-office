// Small items on top of desks, tables and shelves. The owner puts a lamp, a laptop, books, a mug and the rest on a surface and
// they stay there when the furniture moves, turns, goes to another floor with its block, is deleted (and undone) or the app
// restarts. Real mouse and key events through the DevTools protocol; the checks read the building main holds and the
// instances the scene draws.
// Small things come in looks, sit a few degrees off square, stack on flat ones, and the catalog folds out of the way while one is in hand.
// Set OFFICE_SHOTS_DIR to also write close.png (1440x900) there; place.png and decorated.png come from shots-tabletop.mjs.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/e2e-tabletop.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, blockItems, cellBounds, checkOps, floorItems, footprint, hostToWorld, ITEM_DEFS, liftOf, moveBlockOps, parseBuilding, seatPose, surfaceBox, topPose, validate, YAW } from '../src/shared/space/index.ts';
import { itemOrigin } from '../src/shared/space/buildersGesture.ts';
import { assert, scratch } from './lib.mjs';
import { drive } from './tabletop-drive.mjs';

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
const spot = (i) => JSON.stringify({ id: i.id, def: i.def, on: i.on, u: i.u, v: i.v, rot: i.rot, look: i.look ?? 0, ang: i.ang ?? 0, lvl: i.lvl ?? 0 });
const poseOf = (b, it, story = 0) => {
  const host = hostIn(b, it.on, story);
  return topPose(host, ITEM_DEFS[host.def], it, ITEM_DEFS[it.def], liftOf(it, ITEM_DEFS[it.def], b.stories[story].items));
};
const degrees = (rad) => ((((rad * 180) / Math.PI + 180) % 360) + 360) % 360 - 180;
const ctxOf = (c) => ({
  blocks: new Set(c.blocks.map((b) => b.id)),
  employees: new Map(c.employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.role === 'orchestrator' }])),
  seats: new Map(c.employees.filter((e) => e.seat).map((e) => [e.id, e.seat])),
});

export async function diagnose(s) {
  console.log('tops at failure:', JSON.stringify(await s.eval(`${store}.building.stories.flatMap((st) => st.items.filter((i) => i.on !== undefined))`)));
  console.log('tool:', JSON.stringify(await s.eval(`${store}.build?.tool`)), JSON.stringify(await s.eval(`${store}.buildCursor`)));
  console.log('models drawn:', JSON.stringify((await s.eval(`__office.probe('model')`)).filter((m) => ['mug', 'notebook'].includes(m.def))));
  await s.shot('tabletop-failure');
}

export default async function (s, { launch }) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  if (SHOTS) await s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);
  await s.sleep(800);

  const { at, building, tool, level, verdict, waitBuilding, park, still, bring, centerOn, hoverPx, probeOf, waitProbe, enterBuild, exitBuild, zoom, shotTo, choose, openCatalog, turnTo } = drive(s, { shots: SHOTS });
  const rev = (b) => JSON.stringify(b.stories.map((st) => st.rev));
  const unchanged = (before, after) => rev(before) === rev(after);
  const rectOf = (sel) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } : null; })()`);
  const hudRects = async () => (await Promise.all(['.bh-held', '.bh-hint', '.bh-panel', '.bh-top', '.bh-levels', '.bh-readout'].map(rectOf))).filter(Boolean);
  const meets = (p, q) => p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;
  // The screen rectangle that holds a host's usable top, through the camera as it is now.
  const topOnScreen = async (host) => {
    const box = surfaceBox(host, ITEM_DEFS[host.def]);
    const corners = await Promise.all([[box.x0, box.z0], [box.x1, box.z0], [box.x1, box.z1], [box.x0, box.z1]].map(([x, z]) => at(x, box.y, z)));
    return { x0: Math.min(...corners.map((c) => c.x)), y0: Math.min(...corners.map((c) => c.y)), x1: Math.max(...corners.map((c) => c.x)), y1: Math.max(...corners.map((c) => c.y)) };
  };

  const centerOf = (b, hostId, def, u, v, rel, story = 0) => poseOf(b, { id: 'probe', def, on: hostId, u, v, rot: rel }, story);

  async function pointAt(hostId, def, u, v, rel, story = 0) {
    const b = await building();
    const host = hostIn(b, hostId, story);
    const pose = centerOf(b, hostId, def, u, v, rel, story);
    const px = await bring(pose.x, pose.y + story * STORY, pose.z);
    await turnTo((host.rot + rel) % 4);
    await hoverPx(px);
    return { px, host, pose };
  }
  // `again` puts the next one of what is already in hand, without picking it from the catalog again.
  async function put(entry, def, hostId, u, v, rel = 0, story = 0, again = false) {
    if (!again) await choose(entry);
    const { px, pose } = await pointAt(hostId, def, u, v, rel, story);
    const ghost = await waitProbe('top-footprint', (g) => Math.abs(g.x0 - pose.box.x0) < 0.01 && Math.abs(g.z0 - pose.box.z0) < 0.01);
    assert(ghost?.ok === true && ghost.host === hostId && ghost.color === GREEN, `${def} at ${u},${v} on ${hostId.split(':')[0]}: one green footprint on the top`);
    const model = await probeOf('ghost-model');
    assert(model?.def === def && model.ok === true && Math.abs(model.y - pose.y) < 0.002 && Math.hypot(model.x - pose.x, model.z - pose.z) < 0.02, `${def}: and the piece itself stands there at the height of the top (${model?.y?.toFixed(3)} m)`);
    await s.click(px.x, px.y);
    await waitBuilding(`b.stories[${story}].items.some((i) => i.def === ${JSON.stringify(def)} && i.on === ${JSON.stringify(hostId)} && i.u === ${u} && i.v === ${v} && i.rot === ${rel})`, `${def} did not arrive on ${hostId}`);
    const landed = (await building()).stories[story].items.filter((i) => i.def === def && i.on === hostId && i.u === u && i.v === v).at(-1);
    const turn = degrees(model.yaw - YAW[(hostIn(await building(), hostId, story).rot + rel) % 4]);
    assert((landed.look ?? 0) === model.look && Math.abs(turn - (landed.ang ?? 0)) < 0.6 && Math.abs(landed.ang ?? 0) <= 12 && (landed.look ?? 0) < (ITEM_DEFS[def].looks ?? 1), `${def}: the piece that landed is the piece that was in hand (look ${landed.look ?? 0}, turned ${landed.ang ?? 0} degrees)`);
    return landed;
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
  assert(cards.length >= 38 && ['laptop', 'books', 'mug', 'picture_frame', 'vase', 'pen_cup', 'desk_clock', 'trophy', 'papers', 'tabletop:lamp_desk', 'tabletop:plant_small', 'notebook', 'headphones', 'water_bottle', 'succulent', 'cat_statue', 'sticky_notes'].every((e) => cards.includes(e)), `the Tabletop tab lists ${cards.length} things to put on a surface`);
  assert(await s.eval(`[...document.querySelectorAll('.bh-card img')].every((i) => i.src.startsWith('data:image/png') && i.src.length > 1000)`), 'each with a rendered thumbnail');
  assert((await rectOf('.bh-hint')) !== null && (await rectOf('.bh-held')) === null, 'with nothing in hand the catalog and its hint bar are whole');

  await zoom(-800);
  await choose('tabletop:lamp_desk');
  {
    const host = hostIn(await building(), DA);
    const w = hostToWorld(host, ITEM_DEFS[host.def], 3, 4);
    await centerOn(w.x, ITEM_DEFS[host.def].surface.height, w.z, 90);
  }
  await pointAt(DA, 'lamp_desk', 0, 0, 0);
  await s.sleep(300);
  const lampGhost = await probeOf('top-footprint');
  const topLit = await probeOf('surface');
  assert(lampGhost?.ok === true && lampGhost.y > 0.7 && lampGhost.y < 0.76 && topLit?.y === lampGhost.y && topLit.ok === true, `the lamp's green footprint lies on the desk top, ${lampGhost?.y} m up, inside the outline of the usable top, which is lit green too`);
  const lampModel = await probeOf('ghost-model');
  assert(lampModel?.def === 'lamp_desk' && lampModel.ok === true && Math.abs(lampModel.y - lampGhost.y) < 0.002, 'the lamp itself is drawn on the desk top under the pointer');
  {
    // The catalog folds to one bar while a thing for a desk is in hand, so what the pointer is on is never behind a panel.
    const bar = await rectOf('.bh-held');
    assert(!!bar && bar.y1 - bar.y0 < 80 && bar.y1 <= 900 && bar.x0 > 200 && bar.x1 < 1240, `the catalog folded into a bar ${Math.round(bar.x1 - bar.x0)} by ${Math.round(bar.y1 - bar.y0)} px at the bottom`);
    assert((await rectOf('.bh-panel')) === null && (await rectOf('.bh-hint')) === null, 'no panel and no second hint bar are left');
    const desk = hostIn(await building(), DA);
    const onScreen = await topOnScreen(desk);
    const covering = (await hudRects()).filter((r) => meets(r, onScreen));
    assert(onScreen.x1 - onScreen.x0 > 120 && covering.length === 0, `nothing of the HUD covers the desk top the pointer is on (${Math.round(onScreen.x1 - onScreen.x0)} by ${Math.round(onScreen.y1 - onScreen.y0)} px)`);
    const cancel = await rectOf('[data-testid="cancel-tool"]');
    assert(!!cancel && cancel.y0 >= bar.y0 && cancel.y1 <= bar.y1 && cancel.x1 - cancel.x0 > 60, 'Cancel (Esc) is a button on the bar');
    const said = await s.eval(`document.querySelector('[data-testid="held-bar"]').innerText`);
    assert(said.includes('Desk lamp') && said.includes('Cancel') && /Click\s*place/.test(said), `the bar names what is in hand and what a click does (${said.replace(/\s+/g, ' ')})`);
    await openCatalog();
    const open = await rectOf('.bh-panel');
    assert(!!open && open.y1 <= bar.y0 + 1 && (await s.eval(`document.querySelectorAll('.bh-card').length`)) >= 38, 'the pointer on the bar opens the whole catalog above it');
    await pointAt(DA, 'lamp_desk', 0, 0, 0);
    assert((await rectOf('.bh-panel')) === null && (await probeOf('top-footprint'))?.ok === true, 'and the pointer back on the desk folds it again, the green footprint with it');
    await s.clickOn('[data-testid="cancel-tool"]');
    assert((await tool()).kind === 'select', 'the Cancel button puts the lamp down');
    assert((await rectOf('.bh-hint')) !== null && (await rectOf('.bh-held')) === null, 'and the catalog and its hint bar come back whole');
  }
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
  // Where the scene draws a def: the baked props' meshes, and every look of a model built in code, read back from their instance matrices.
  const drawn = async (def) => {
    const baked = await s.eval(`__office.instances(${JSON.stringify(def)})`);
    const looks = (await s.eval(`__office.probe('model')`)).filter((m) => m.def === def).flatMap((m) => m.at.map(([x, y, z, yaw]) => ({ x, y, z, yaw, look: m.look })));
    return [...baked, ...looks];
  };
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

  // ---- dressing: looks, turns and stacks, by hand on the meeting table
  const dressing = [];
  const dress = async (...args) => dressing.push(await put(...args));
  await dress('mug', 'mug', TABLE, 3, 8, 0);
  await dress('mug', 'mug', TABLE, 6, 8, 0, 0, true);
  const [mugA, mugB] = dressing;
  assert((mugA.look ?? 0) !== (mugB.look ?? 0) && Math.max(Math.abs(mugA.ang ?? 0), Math.abs(mugB.ang ?? 0)) > 0, `two mugs put down one after the other differ: looks ${mugA.look ?? 0} and ${mugB.look ?? 0}, turned ${mugA.ang ?? 0} and ${mugB.ang ?? 0} degrees`);
  const looksDrawn = (await s.eval(`__office.probe('model')`)).filter((m) => m.def === 'mug' && m.count > 0);
  assert(looksDrawn.length >= 2 && looksDrawn.some((m) => m.look > 0), `the scene draws the mugs under ${looksDrawn.length} models, one per look`);
  const nb = await put('notebook', 'notebook', TABLE, 17, 7, 0);
  dressing.push(nb);
  // The mug is aimed at the middle of the notebook, which is not the table: it goes up a level, on the notebook.
  {
    await choose('mug');
    const b = await building();
    const pose = poseOf(b, nb);
    const px = await bring(pose.x, pose.y + ITEM_DEFS.notebook.height, pose.z);
    await hoverPx(px);
    const rest = await waitProbe('ghost-model', (g) => g.def === 'mug' && g.y > pose.y + 0.01);
    assert(rest?.ok === true && Math.abs(rest.y - (ITEM_DEFS.meeting_table.surface.height + ITEM_DEFS.notebook.height)) < 0.003, `a mug aimed at the notebook stands on it, ${(rest?.y ?? 0).toFixed(3)} m up: the table's ${ITEM_DEFS.meeting_table.surface.height} and the notebook's ${ITEM_DEFS.notebook.height}`);
    const foot = await probeOf('top-footprint');
    assert(foot?.ok === true && Math.abs(foot.y - rest.y) < 0.003, 'with its green footprint on the notebook');
    await s.click(px.x, px.y);
    await waitBuilding(`b.stories[0].items.some((i) => i.def === 'mug' && i.lvl === 1)`, 'the mug did not land on the notebook');
    const mugOn = (await building()).stories[0].items.find((i) => i.def === 'mug' && i.lvl === 1);
    dressing.push(mugOn);
    assert(mugOn.on === TABLE && mugOn.u >= nb.u - 1 && mugOn.u + 1 <= nb.u + 4 && mugOn.v >= nb.v - 1 && mugOn.v + 1 <= nb.v + 3, `the mug is stacked at level 1 on the table, over the notebook (${mugOn.u}, ${mugOn.v})`);
    await park();
    await s.sleep(300);
    const mugDrawn = (await drawn('mug')).filter((d) => Math.abs(d.y - rest.y) < 0.01);
    assert(mugDrawn.length === 1, 'the scene draws it on the notebook');
    const up0 = poseOf(await building(), mugOn);
    // The hand takes what is on top first: aimed at the bare end of the notebook, the thing to take is the mug that stands on it.
    await s.clickOn('[data-testid="mode-piece"]');
    const end = await bring(pose.box.x0 + 0.04, pose.y + ITEM_DEFS.notebook.height, pose.z);
    await hoverPx(end);
    assert((await s.eval(`${store}.buildCursor.hover`)) === mugOn.id, 'pointing at the end of the notebook with a mug on it hovers the mug, which has to come off first');
    await s.mouse('mousePressed', end.x, end.y, 1);
    await s.mouse('mouseReleased', end.x, end.y);
    await s.sleep(250);
    assert((await tool()).carry === mugOn.id, 'one click takes the mug, not the notebook under it');
    await s.press('Escape');
    // A second mug aimed at a bare end of the notebook (the end the first mug does not hide from the camera) stands on it too, beside the first.
    await choose('mug');
    let beside = null;
    for (const x of [pose.box.x0 + 0.04, pose.box.x1 - 0.04]) {
      const px2 = await bring(x, pose.y + ITEM_DEFS.notebook.height, pose.z);
      await hoverPx(px2);
      const g = await probeOf('ghost-model');
      if (g?.ok === true && Math.abs(g.y - rest.y) < 0.003 && Math.hypot(g.x - up0.x, g.z - up0.z) > 0.05) {
        beside = { g, px: px2 };
        break;
      }
    }
    assert(!!beside, 'a second mug aimed at a bare end of the notebook stands there at the same height, beside the first');
    await s.click(beside.px.x, beside.px.y);
    await waitBuilding(`b.stories[0].items.filter((i) => i.def === 'mug' && i.lvl === 1).length === 2`, 'the second mug did not land on the notebook');
    dressing.push((await building()).stories[0].items.find((i) => i.def === 'mug' && i.lvl === 1 && i.id !== mugOn.id));
    await s.press('Escape');
    await park();
  }
  // Books on books: the second set goes on the first, a little askew.
  const stackBase = await put('books', 'books', TABLE, 8, 8, 0);
  dressing.push(stackBase);
  {
    await choose('books');
    const b = await building();
    const pose = poseOf(b, stackBase);
    const px = await bring(pose.x, pose.y + ITEM_DEFS.books.height, pose.z);
    await hoverPx(px);
    const rest = await waitProbe('ghost-model', (g) => g.def === 'books' && g.y > pose.y + 0.01);
    assert(rest?.ok === true && Math.abs(rest.y - (ITEM_DEFS.meeting_table.surface.height + ITEM_DEFS.books.height)) < 0.003, 'books aimed at books stand on them');
    await s.click(px.x, px.y);
    await waitBuilding(`b.stories[0].items.some((i) => i.def === 'books' && i.lvl === 1)`, 'the second books did not land');
    dressing.push((await building()).stories[0].items.find((i) => i.def === 'books' && i.lvl === 1));
    await s.press('Escape');
    await park();
  }
  const dressed = await building();
  assert(validate(parseBuilding(disk().building, () => {}), ctxOf(disk())).filter((v) => v.kind !== 'story_unreachable').length === 0 && dressing.every((i) => onHost(dressed, TABLE).some((t) => t.id === i.id)), `company.json holds the ${dressing.length} things dressed by hand, and the building is valid`);
  assert((await heightsOk(dressed)) === null, 'and the scene draws every one of them, stacked ones included, where its data puts it');
  const turned = (await drawn('mug')).filter((d) => Math.abs(degrees(d.yaw) - Math.round(degrees(d.yaw) / 90) * 90) > 0.5);
  assert(turned.length >= 1, `at least one mug is drawn a few degrees off square (${turned.length})`);

  await exitBuild();
  const middleOf = (id) => {
    const h = hostIn(afterPlacing, id);
    const f = footprint(ITEM_DEFS[h.def], h.rot);
    return { x: (h.x + f.w / 2) / 2, z: (h.z + f.d / 2) / 2 };
  };
  const tableAt = middleOf(HUDDLE);
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
  const missingUp = await drawnUp();
  assert(missingUp === null, `floor 2 draws them 3.2 m up, on the desks${missingUp ? ` (not found: ${missingUp})` : ''}`);
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
  assert(expected.length === 21 + dressing.length, `company.json holds the ${21 + dressing.length} things`);
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
  assert(tops(after).length === 5 + dressing.length && tops(after).every((i) => !!hostIn(after, i.on)), `removing the team takes what stood on its desks and its huddle table; the ${5 + dressing.length} on the meeting table and the shelf stay, each on a host that is still there`);
  await app.close();
}
