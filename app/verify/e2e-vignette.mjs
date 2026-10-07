// Sets on a table: one card of the Tabletop tab lands as several small things. The owner picks a set, sees it as one model over the table with
// one green footprint, clicks, and the members stand there as ordinary items: stacked on their tray, each picked up and moved alone, all
// of them undone in one step. A set that hangs over the edge is red and places nothing. Real mouse and key events through the DevTools protocol.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/e2e-vignette.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { floorItems, hostToWorld, ITEM_DEFS, liftOf, parseBuilding, topPose, validate, VIGNETTES, YAW } from '../src/shared/space/index.ts';
import { assert, scratch } from './lib.mjs';
import { drive } from './tabletop-drive.mjs';

const { dataDir, repo } = scratch();
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const file = join(dataDir, 'company.json');
const GREEN = '#2fe06a';
const TABLE = 'meeting_table:00';
const disk = () => JSON.parse(readFileSync(file, 'utf8'));
const tops = (b) => b.stories.flatMap((s) => s.items).filter((i) => i.on !== undefined);
const hostIn = (b, id) => floorItems(b.stories[0]).find((i) => i.id === id);

export default async function (s) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  await s.sleep(800);
  const { building, tool, verdict, waitBuilding, park, bring, hoverPx, probeOf, waitProbe, enterBuild, exitBuild, choose, turnTo } = drive(s, {});

  const b0 = await building();
  const host = hostIn(b0, TABLE);
  const hostDef = ITEM_DEFS[host.def];
  assert(!!host && tops(b0).length === 0, 'the meeting table is bare');
  await enterBuild();

  // The sets come first in the Tabletop tab, each a card with its piece count.
  await s.clickOn('[data-tab="tabletop"]');
  const cards = await s.eval(`[...document.querySelectorAll('.bh-card')].slice(0, ${VIGNETTES.length}).map((c) => ({ id: c.dataset.entry, badge: c.querySelector('[data-testid="footprint-badge"]')?.textContent }))`);
  assert(cards.map((c) => c.id).join() === VIGNETTES.map((v) => v.id).join() && cards.every((c, n) => c.badge === `${VIGNETTES[n].members.length} pieces`), `the first ${VIGNETTES.length} cards of the Tabletop tab are the sets, each with its piece count`, JSON.stringify(cards));

  // Where a set's top-left corner goes so the set sits in the middle of the long run of the table.
  const aim = async (id, u, v) => {
    const def = ITEM_DEFS[id];
    const w = hostToWorld(host, hostDef, u + def.top.w / 2, v + def.top.d / 2);
    const px = await bring(w.x, hostDef.surface.height, w.z);
    await hoverPx(px);
    return { px, w };
  };

  const SET = 'vg_coffee';
  const def = ITEM_DEFS[SET];
  await choose(SET);
  const { px, w } = await aim(SET, 5, 4);
  const foot = await waitProbe('top-footprint', (g) => g.ok === true);
  const model = await waitProbe('ghost-model', (g) => g.def === SET);
  assert(foot?.ok === true && foot.color === GREEN && foot.host === TABLE, 'a set held over the table has one green footprint on its top');
  assert(model?.def === SET && Math.abs(model.y - hostDef.surface.height) < 0.003 && Math.hypot(model.x - w.x, model.z - w.z) < 0.08, `and is drawn there as one model at the height of the top (${model?.y?.toFixed(3)} m)`);
  const held = (await tool()).def;
  await s.click(px.x, px.y);
  await waitBuilding(`b.stories[0].items.filter((i) => i.on === ${JSON.stringify(TABLE)}).length === ${def.group.length}`, 'the members of the set did not arrive');
  const placed = tops(await building());
  assert(placed.length === def.group.length && placed.every((i) => i.def !== SET && ITEM_DEFS[i.def]), `one click put down ${placed.length} items, and none of them is the set`);
  assert(placed.map((i) => i.def).sort().join() === def.group.map((m) => m.def).sort().join(), 'they are exactly the members of the set');
  const tray = placed.find((i) => i.def === 'tray');
  const mug = placed.find((i) => i.def === 'mug');
  const notebook = placed.find((i) => i.def === 'notebook');
  assert((tray.lvl ?? 0) === 0 && notebook.lvl === 1 && mug.lvl === 2, 'the tray is on the table, the notebook on the tray, the mug on the notebook');
  const bAfter = await building();
  const poseMug = topPose(hostIn(bAfter, TABLE), hostDef, mug, ITEM_DEFS.mug, liftOf(mug, ITEM_DEFS.mug, bAfter.stories[0].items));
  assert(Math.abs(poseMug.y - (hostDef.surface.height + ITEM_DEFS.tray.height + ITEM_DEFS.notebook.height)) < 0.002, `the mug stands ${poseMug.y.toFixed(3)} m up, on the tray and the notebook`);
  assert(validate(parseBuilding(disk().building, () => {}), { blocks: new Set(disk().blocks.map((b) => b.id)), employees: new Map(), seats: new Map() }).filter((v) => v.kind !== 'story_unreachable' && v.kind !== 'desk_wrong_block').length === 0 && (await tool()).def === held, 'the building on disk is valid and the same set is still in hand for the next one');
  const drawn = (await s.eval(`__office.probe('model')`)).filter((m) => ['tray', 'notebook', 'mug', 'takeaway_cup'].includes(m.def) && m.count > 0);
  assert(['tray', 'notebook', 'mug', 'takeaway_cup'].every((d) => drawn.some((m) => m.def === d)), 'the scene draws every member as its own model');

  // One member alone: pick the mug up, put it on the other end of the table.
  await s.press('Escape');
  await park();
  {
    const px2 = await bring(poseMug.x, poseMug.y + 0.04, poseMug.z);
    await hoverPx(px2);
    assert((await s.eval(`${store}.buildCursor.hover`)) === mug.id, 'pointing at the mug hovers the mug, not the table or the set');
    await s.mouse('mousePressed', px2.x, px2.y, 1);
    await s.mouse('mouseReleased', px2.x, px2.y);
    await s.sleep(250);
    assert((await tool()).carry === mug.id && (await tool()).def === 'mug', 'one click picks the mug up alone');
    const to = hostToWorld(host, hostDef, 20, 3);
    const at = await bring(to.x, hostDef.surface.height, to.z);
    await hoverPx(at);
    await s.click(at.x, at.y);
    await waitBuilding(`b.stories[0].items.find((i) => i.id === ${JSON.stringify(mug.id)}).u !== ${mug.u}`, 'the mug did not move');
    const now = await building();
    const moved = now.stories[0].items.find((i) => i.id === mug.id);
    const left = tops(now).filter((i) => i.id !== mug.id);
    assert(moved.on === TABLE && (moved.lvl ?? 0) === 0 && left.length === def.group.length - 1 && left.every((i) => placed.some((p) => p.id === i.id && p.u === i.u && p.v === i.v)), 'the mug stands on the bare table, and the rest of the set has not moved');
    await park();
  }

  // The whole set undone in one step, then back.
  await s.clickOn('[aria-label="Undo"]');
  await waitBuilding(`b.stories[0].items.find((i) => i.id === ${JSON.stringify(mug.id)}).lvl === 2`, 'undo did not put the mug back on the notebook');
  await s.clickOn('[aria-label="Undo"]');
  await waitBuilding(`b.stories[0].items.every((i) => i.on === undefined)`, 'a second undo did not take the whole set');
  assert(tops(await building()).length === 0, 'a second undo takes the whole set off the table, all members in one step');
  await s.clickOn('[aria-label="Redo"]');
  await waitBuilding(`b.stories[0].items.filter((i) => i.on === ${JSON.stringify(TABLE)}).length === ${def.group.length}`, 'redo did not bring the set back');
  assert(tops(await building()).length === def.group.length, 'and redo brings it back whole');

  // A set held so far over the edge that a member would hang off is red; a click places nothing.
  {
    await choose('vg_runner');
    const edge = hostToWorld(host, hostDef, 22, 6);
    const at = await bring(edge.x, hostDef.surface.height, edge.z);
    await hoverPx(at);
    const ghost = await probeOf('top-footprint');
    const said = await verdict();
    const before = await building();
    assert(ghost?.ok === false && said?.ok === false && said.text === 'It would hang over the edge', `a runner set over the edge of the table is red: "${said?.text}"`);
    await s.click(at.x, at.y);
    await s.sleep(300);
    assert(JSON.stringify((await building()).stories[0].items.map((i) => i.id)) === JSON.stringify(before.stories[0].items.map((i) => i.id)), 'and a click there changes nothing');
    await s.press('Escape');
  }

  // Turned a quarter, the set stands turned: its members turn with it and stay inside the table.
  {
    await choose('vg_stack');
    await turnTo(1);
    const { px: tp } = await aim('vg_stack', 14, 6);
    const ghost = await waitProbe('ghost-model', (g) => g.def === 'vg_stack');
    assert(Math.abs(ghost.yaw - YAW[(host.rot + 1) % 4]) < 0.05, 'a set turned a quarter shows turned');
    const had = new Set(tops(await building()).map((i) => i.id));
    await s.click(tp.x, tp.y);
    await waitBuilding(`b.stories[0].items.filter((i) => i.on === ${JSON.stringify(TABLE)}).length === ${had.size + ITEM_DEFS.vg_stack.group.length}`, 'the turned set did not arrive');
    const fresh = tops(await building()).filter((i) => !had.has(i.id));
    assert(fresh.length === 3 && fresh.every((i) => i.rot === 1), 'its three members were put down turned a quarter too');
    await s.press('Escape');
  }
  await park();
  await exitBuild();
}
