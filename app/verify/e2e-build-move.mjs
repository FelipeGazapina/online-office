// The owner enters build mode with the Build button, moves a desk with a seated employee and then a whole project block,
// all with real mouse and key events through the DevTools protocol. The test reads the building main holds, not the screen.
// It also shows why the B key alone failed: it is typed into the chat composer whenever a person is selected.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/e2e-build-move.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, scratch } from './lib.mjs';

const SHOTS = '/Users/feliperico/.claude/orchestrate/online-office-game/shots/b1';
const { dataDir, repo } = scratch();
mkdirSync(join(repo, 'b'));
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const GREEN = '#2fe06a';
const RED = '#ff4d4d';
const DESK = { w: 3, d: 2, chair: { x: 1.5, z: -0.8 } };
// Where the chair of a desk stands in meters, as rotateLocal in shared/space/catalog.ts puts it.
const chairOf = (item) => {
  const { x, z } = DESK.chair;
  const local = [{ x, z }, { x: DESK.d - z, z: x }, { x: DESK.w - x, z: DESK.d - z }, { x: z, z: DESK.w - x }][item.rot];
  return { x: (item.x + local.x) / 2, z: (item.z + local.z) / 2 };
};

async function save(s, name) {
  mkdirSync('/tmp/office-shots', { recursive: true });
  const path = await s.shot(name);
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(path, join(SHOTS, `${name}.png`));
}

// The test window says it is a test. The pictures for the panel show the office the way the owner sees it.
const dress = (s) => s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);

const building = (s) => s.eval(`${store}.building`);
const tool = (s) => s.eval(`${store}.build?.tool ?? null`);
const items = (b, blockId) => b.stories[0].items.filter((i) => i.blockId === blockId);
const byId = (b) => new Map(b.stories[0].items.map((i) => [i.id, i]));

export default async function (s, { launch }) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  await s.sleep(800);

  const at = (x, z) => s.eval(`__office.project(${x}, 0, ${z})`);
  const hold = (code, key) => s.key('keyDown', code, key);
  const release = (code, key) => s.key('keyUp', code, key);
  const waitBuilding = (expr, label) => s.waitFor(`(() => { const b = ${store}.building; return ${expr}; })()`, 5000).catch(() => {
    throw new Error(label);
  });
  const rect = (selector) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
  const enterByButton = async () => {
    await s.clickOn('[data-testid="build-enter"]');
    await s.waitFor(`!!${store}.build`, 4000);
    await s.sleep(500);
  };
  const leaveByButton = async () => {
    await s.clickOn('.bh-done');
    await s.waitFor(`${store}.build === null`, 4000);
  };
  // Pans the build camera with the real keys until a point of the office sits in the middle of the screen.
  const bring = async (x, z) => {
    for (let i = 0; i < 50; i++) {
      const p = await at(x, z);
      const key = p.x > 1000 ? ['KeyD', 'd'] : p.x < 300 ? ['KeyA', 'a'] : p.y > 560 ? ['KeyS', 's'] : p.y < 230 ? ['KeyW', 'w'] : null;
      if (!key) return p;
      await hold(...key);
      await s.sleep(Math.min(400, 120 + Math.abs(p.x > 1000 || p.x < 300 ? p.x - 650 : p.y - 350) / 3));
      await release(...key);
      await s.sleep(350);
    }
    throw new Error(`could not bring ${x}, ${z} into view`);
  };
  const hover = async (x, z) => {
    const p = await at(x, z);
    await s.mouse('mouseMoved', p.x, p.y);
    await s.sleep(120);
    return p;
  };
  const footprint = async (name) => (await s.eval(`__office.probe('${name}')`))[0];
  const deskPoint = (d) => ({ x: d.x / 2 + 0.75, z: d.z / 2 + 0.5 });

  // ---- the way in: a button in the top right, in every camera
  await dress(s);
  const vw = await s.eval('innerWidth');
  const button = await rect('[data-testid="build-enter"]');
  assert(!!button && button.right > vw - 40 && button.top < 60 && button.right <= vw, `a Build button sits in the top right (${Math.round(button.left)},${Math.round(button.top)} to ${Math.round(button.right)},${Math.round(button.bottom)})`);
  const crowd = await Promise.all(['.camera-toggle', '.clock-bar', '.waiting'].map(rect));
  assert(crowd.every((r) => !r || r.right <= button.left || r.left >= button.right || r.bottom <= button.top || r.top >= button.bottom), 'and it covers none of the other HUD controls');
  assert((await s.eval(`document.querySelector('[data-testid="build-enter"]').textContent`)).includes('Build'), 'it is labelled Build');
  await s.sleep(400);
  await save(s, 'entry');

  // B is typed into the composer while a person is selected: this is how the key alone failed.
  const dana = 'e4';
  await s.eval(`__office.store.setState({ selectedId: '${dana}' })`);
  await s.waitFor(`document.activeElement?.tagName === 'TEXTAREA'`, 4000);
  await s.press('KeyB', 'b');
  await s.sleep(300);
  assert((await s.eval(`${store}.build`)) === null, 'with the chat composer focused the B key does not enter build mode (the key alone cannot be relied on)');
  await enterByButton();
  assert((await s.eval(`${store}.build.tool.kind`)) === 'select', 'but the Build button does, with nothing in hand');
  assert(await s.eval(`!!document.querySelector('.bh-dock') && !!document.querySelector('.bh-top') && !!document.querySelector('[data-testid="build-enter"]') === false`), 'the build bar is up and the entry button gives way to it');
  await leaveByButton();
  assert(await s.eval(`!!document.querySelector('[data-testid="build-enter"]')`), 'Done leaves build mode and the Build button is back');
  await s.eval(`__office.store.setState({ selectedId: null })`);
  await s.eval(`document.activeElement?.blur()`);
  await s.press('KeyB', 'b');
  await s.waitFor(`!!${store}.build`, 3000);
  await s.press('KeyB', 'b');
  await s.waitFor(`${store}.build === null`, 3000);
  assert(true, 'B still enters and leaves build mode');

  await s.press('Tab');
  await s.waitFor(`${store}.camera === 'first'`, 4000);
  await s.sleep(600);
  assert(await s.eval(`!!document.querySelector('[data-testid="build-enter"]') && getComputedStyle(document.querySelector('[data-testid="build-enter"]')).display !== 'none'`), 'the Build button is on screen in first person');
  await enterByButton();
  assert((await s.eval(`${store}.camera`)) === 'iso', 'clicking it from first person switches to the overview');
  await leaveByButton();

  await s.eval(`__office.store.setState({ computerState: 'seated' })`);
  await enterByButton();
  assert((await s.eval(`${store}.computerState`)) === 'away', 'sitting at the owner computer does not refuse it: the owner gets up and builds');
  await leaveByButton();

  // ---- one desk, with a person sitting at it
  const b0 = await building(s);
  const desk0 = b0.stories[0].items.find((i) => i.id === 'blk-b:bench_desk:00');
  const chair0 = chairOf(desk0);
  const avatar = async (id) => (await s.eval('__office.state()')).avatars.find((a) => a.id === id);
  const near = (a, p) => !!a && Math.hypot(a.x - p.x, a.z - p.z) < 0.1;
  const seatOf = (id) => s.eval(`${store}.company.employees.find((e) => e.id === '${id}').seat`);
  assert(near(await avatar(dana), chair0) && (await avatar(dana)).seated, `Dana sits at her desk (${chair0.x}, ${chair0.z})`);
  await enterByButton();
  const goal = { x: 12, z: -3 };
  const p0 = await bring(deskPoint(desk0).x, deskPoint(desk0).z);
  await hover(deskPoint(desk0).x, deskPoint(desk0).z);
  assert((await s.eval(`${store}.buildCursor.hover`)) === desk0.id, 'the desk under the pointer is the one hovered');
  await s.click(p0.x, p0.y);
  await s.sleep(250);
  let held = await tool(s);
  assert(held.kind === 'item' && held.carry === desk0.id, 'one click on the desk picks it up, with Dana still sitting at it');
  await bring(goal.x, goal.z);
  await hover(goal.x, goal.z);
  const pad = await footprint('footprint');
  assert(pad?.ok === true && pad.color === GREEN && Math.abs(pad.w - 1.5) < 1e-6, 'it follows the pointer with a green footprint');
  await s.press('Escape');
  assert((await tool(s)).kind === 'select' && JSON.stringify(byId(await building(s)).get(desk0.id)) === JSON.stringify(desk0), 'Escape puts it back where it was');

  const pick = await bring(deskPoint(desk0).x, deskPoint(desk0).z);
  await s.click(pick.x, pick.y);
  await s.sleep(200);
  const clash = byId(b0).get('blk-a:bench_desk:01');
  await bring(deskPoint(clash).x, deskPoint(clash).z);
  await hover(deskPoint(clash).x, deskPoint(clash).z);
  const red = await footprint('footprint');
  assert(red?.ok === false && red.color === RED, 'over another desk the footprint is red');
  assert((await s.eval(`${store}.buildCursor.verdict.ok`)) === false, 'and the rules say it does not fit');
  const stuck = await at(deskPoint(clash).x, deskPoint(clash).z);
  await s.click(stuck.x, stuck.y);
  await s.sleep(300);
  assert(JSON.stringify(byId(await building(s)).get(desk0.id)) === JSON.stringify(desk0) && (await tool(s)).carry === desk0.id, 'clicking there refuses: the desk has not moved and is still in hand');
  await s.press('Escape');

  const pickAgain = await bring(deskPoint(desk0).x, deskPoint(desk0).z);
  await s.click(pickAgain.x, pickAgain.y);
  await s.sleep(200);
  await bring(goal.x, goal.z);
  await hover(goal.x, goal.z);
  await dress(s);
  await save(s, 'carry');
  const drop = await at(goal.x, goal.z);
  await s.click(drop.x, drop.y);
  await waitBuilding(`b.stories[0].items.some((i) => i.id === ${JSON.stringify(desk0.id)} && i.x !== ${desk0.x})`, 'the desk did not move');
  const desk1 = byId(await building(s)).get(desk0.id);
  assert(desk1.blockId === 'blk-b' && desk1.rot === desk0.rot && desk1.id === desk0.id, `the desk moved (${desk1.x / 2}, ${desk1.z / 2}) and kept its id and team`);
  assert((await seatOf(dana)) === desk0.id, 'Dana is still assigned to that desk');
  const chair1 = chairOf(desk1);
  await s.waitFor(`(() => { const a = __office.state().avatars.find((a) => a.id === '${dana}'); return Math.hypot(a.x - ${chair1.x}, a.z - ${chair1.z}) < 0.1 && a.seated; })()`, 4000);
  assert(true, `and she sits at its new chair (${chair1.x}, ${chair1.z}), not in the air where it was`);

  const dragFrom = await bring(deskPoint(desk1).x, deskPoint(desk1).z);
  const dragTo = await at(goal.x + 3, goal.z + 1);
  await s.drag({ x: dragFrom.x, y: dragFrom.y }, { x: dragTo.x, y: dragTo.y }, 14);
  await s.sleep(300);
  const desk2 = byId(await building(s)).get(desk0.id);
  assert(desk2.x !== desk1.x && (await tool(s)).kind === 'select', `dragging the desk moves it and lets go on release, with no second click (${desk2.x / 2}, ${desk2.z / 2})`);
  assert(near(await avatar(dana), chairOf(desk2)), 'Dana follows it again');

  const undoBtn = await s.center('[aria-label="Undo"]');
  await s.click(undoBtn.x, undoBtn.y);
  await s.click(undoBtn.x, undoBtn.y);
  await waitBuilding(`b.stories[0].items.find((i) => i.id === ${JSON.stringify(desk0.id)}).x === ${desk0.x}`, 'undo did not return the desk');
  assert(near(await avatar(dana), chair0), 'two undos put the desk back and Dana sits at her first chair again');
  const original = await building(s);

  // ---- a whole block
  const blockId = 'blk-b';
  const before = items(original, blockId);
  const anchor = before.find((i) => i.def === 'bench_desk');
  const grabAt = deskPoint(anchor);
  const seatsBefore = await s.eval(`${store}.company.employees.map((e) => [e.id, e.seat])`);
  const grabPx = await bring(grabAt.x, grabAt.z);
  await s.clickOn('[data-testid="mode-block"]');
  assert((await tool(s)).kind === 'block', 'the Block switch in the build bar picks the block tool');
  await hover(grabAt.x, grabAt.z);
  const sel = await footprint('block-select');
  assert(sel && sel.pieces === before.length, `hovering any piece outlines the whole block, all ${before.length} pieces`);
  await dress(s);
  await s.sleep(200);
  await save(s, 'block-hover');
  await s.mouse('mousePressed', grabPx.x, grabPx.y, 1);
  await s.mouse('mouseReleased', grabPx.x, grabPx.y);
  await s.sleep(250);
  held = await tool(s);
  assert(held.kind === 'block' && held.carry?.blockId === blockId, 'a click picks the block up');

  const shift = { x: 8, z: 0 };
  const half = { x: grabAt.x + 6, z: grabAt.z };
  await hover(half.x, half.z);
  await dress(s);
  await s.sleep(300);
  await save(s, 'block');
  const carry = await footprint('block-footprint');
  assert(carry?.pieces === before.length && carry.color === GREEN && carry.ok === true, `the block follows the pointer with one green footprint around all of it ${JSON.stringify(carry)} ${await s.eval(`JSON.stringify(${store}.buildCursor.verdict)`)}`);

  const west = byId(original).get('blk-a:bench_desk:01');
  await bring(deskPoint(west).x, deskPoint(west).z);
  await hover(deskPoint(west).x, deskPoint(west).z);
  const clashBlock = await footprint('block-footprint');
  assert(clashBlock?.ok === false && clashBlock.color === RED, 'over the other block the one footprint turns red');
  const refused = await at(deskPoint(west).x, deskPoint(west).z);
  await s.click(refused.x, refused.y);
  await s.sleep(300);
  assert(JSON.stringify(await building(s)) === JSON.stringify(original) && (await tool(s)).carry?.blockId === blockId, 'and a click there changes nothing');

  await bring(grabAt.x + shift.x, grabAt.z + shift.z);
  await hover(grabAt.x + shift.x, grabAt.z + shift.z);
  assert((await footprint('block-footprint'))?.ok === true, 'on free ground it is green again');
  const place = await at(grabAt.x + shift.x, grabAt.z + shift.z);
  await s.click(place.x, place.y);
  await waitBuilding(`b.stories[0].items.filter((i) => i.blockId === ${JSON.stringify(blockId)}).some((i) => i.x !== ${anchor.x})`, 'the block did not move');
  const after = items(await building(s), blockId);
  const dx = after[0].x - before[0].x;
  const dz = after[0].z - before[0].z;
  assert(after.length === before.length && after.every((i, n) => i.id === before[n].id && i.x - before[n].x === dx && i.z - before[n].z === dz && i.rot === before[n].rot), `every piece moved by the same ${dx / 2} m, ${dz / 2} m with its id and turn`);
  assert(Math.abs(dx - 16) <= 1 && Math.abs(dz) <= 1, 'which is the 8 m the pointer travelled');
  const others = (b) => b.stories[0].items.filter((i) => i.blockId !== blockId);
  assert(JSON.stringify(others(await building(s))) === JSON.stringify(others(original)), 'nothing outside the block moved');
  const seatsAfter = await s.eval(`${store}.company.employees.map((e) => [e.id, e.seat])`);
  assert(JSON.stringify(seatsAfter) === JSON.stringify(seatsBefore) && (await seatOf(dana)) === desk0.id, 'every employee keeps the same desk id');
  const movedDesk = byId(await building(s)).get(desk0.id);
  await s.waitFor(`(() => { const a = __office.state().avatars.find((a) => a.id === '${dana}'); return Math.hypot(a.x - ${chairOf(movedDesk).x}, a.z - ${chairOf(movedDesk).z}) < 0.1 && a.seated; })()`, 4000);
  assert(true, 'and the one sitting in this block went with it, seated at the new chair');
  assert(near(await avatar('e1'), chairOf(byId(await building(s)).get('blk-a:po_desk:00'))), 'while the other team did not move');

  // Shift-click picks a block from the furniture tool, and the turn keys turn the whole thing.
  await s.clickOn('[data-testid="mode-piece"]');
  const afterDesk = after.find((i) => i.def === 'bench_desk');
  const again = await bring(deskPoint(afterDesk).x, deskPoint(afterDesk).z);
  await hold('ShiftLeft', 'Shift');
  await s.mouse('mouseMoved', again.x, again.y);
  await s.sleep(200);
  assert((await footprint('block-select'))?.pieces === before.length, 'with Shift held the furniture tool outlines the block too');
  await s.mouse('mousePressed', again.x, again.y, 1);
  await s.mouse('mouseReleased', again.x, again.y);
  await release('ShiftLeft', 'Shift');
  await s.sleep(250);
  held = await tool(s);
  assert(held.kind === 'block' && held.carry?.blockId === blockId, 'Shift-click picks the whole block');
  await s.press('Period', '.');
  assert((await tool(s)).carry.quarter === 1, 'the period key turns the block a quarter');
  const target = { x: 11, z: 2 };
  await bring(target.x, target.z);
  await hover(target.x, target.z);
  const turnedPad = await footprint('block-footprint');
  assert(Math.abs(turnedPad.w - carry.d) < 1e-6 && Math.abs(turnedPad.d - carry.w) < 1e-6, `the one footprint turned too (${turnedPad.w} x ${turnedPad.d} m, was ${carry.w} x ${carry.d})`);
  assert(turnedPad.ok === true, 'and it fits on the free ground');
  const dropTurned = await at(target.x, target.z);
  await s.click(dropTurned.x, dropTurned.y);
  await waitBuilding(`b.stories[0].items.filter((i) => i.blockId === ${JSON.stringify(blockId)}).every((i, n) => i.rot === (${JSON.stringify(after.map((x) => x.rot))}[n] + 1) % 4)`, 'the block did not turn');
  const turned = items(await building(s), blockId);
  assert(turned.length === before.length && turned.every((i, n) => i.id === before[n].id), 'all pieces are still there with their ids');
  const spun = byId(await building(s)).get(desk0.id);
  assert((await seatOf(dana)) === desk0.id, 'Dana still has her desk');
  await s.waitFor(`(() => { const a = __office.state().avatars.find((a) => a.id === '${dana}'); return Math.hypot(a.x - ${chairOf(spun).x}, a.z - ${chairOf(spun).z}) < 0.1 && a.seated; })()`, 4000);
  assert(true, `and she sits at the turned desk's chair (${chairOf(spun).x}, ${chairOf(spun).z})`);
  const spunBuilding = await building(s);

  await s.clickOn('[aria-label="Undo"]');
  await s.clickOn('[aria-label="Undo"]');
  await waitBuilding(`JSON.stringify(b.stories[0].items) === ${JSON.stringify(JSON.stringify(original.stories[0].items))}`, 'two undos did not restore the building');
  assert(near(await avatar(dana), chair0), 'two undos bring the whole block back and Dana with it');
  await s.clickOn('[aria-label="Redo"]');
  await s.clickOn('[aria-label="Redo"]');
  await waitBuilding(`JSON.stringify(b.stories[0].items) === ${JSON.stringify(JSON.stringify(spunBuilding.stories[0].items))}`, 'two redos did not restore the turned block');
  assert(near(await avatar(dana), chairOf(spun)), 'two redos put it back turned');
  await leaveByButton();

  // ---- it all survives a restart
  const file = join(dataDir, 'company.json');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  const diskBlock = onDisk.building.stories[0].items.filter((i) => i.blockId === blockId);
  assert(diskBlock.length === before.length && diskBlock.every((i) => turned.some((t) => t.id === i.id && t.x === i.x && t.z === i.z && t.rot === i.rot)), 'company.json holds the turned block where it stands');
  await s.close();
  const app = await launch({ env });
  await app.waitFor('!!window.__office && !!window.office');
  await app.waitFor(`!!${store}.building && !!${store}.company`);
  await app.eval('__office.step(2)');
  await app.sleep(500);
  const reopened = await app.eval(`${store}.building`);
  const nowBlock = items(reopened, blockId);
  assert(nowBlock.length === before.length && nowBlock.every((i) => turned.some((t) => t.id === i.id && t.x === i.x && t.z === i.z && t.rot === i.rot)), 'after a restart the block stands where it was left, turned');
  const reSeats = await app.eval(`${store}.company.employees.map((e) => [e.id, e.seat])`);
  assert(JSON.stringify(reSeats) === JSON.stringify(seatsBefore), 'every employee has the same desk id');
  const danaAgain = (await app.eval('__office.state()')).avatars.find((a) => a.id === dana);
  assert(near(danaAgain, chairOf(byId(reopened).get(desk0.id))) && danaAgain.seated, 'and Dana is seated at the turned desk');
  await app.close();
}
