// Build mode as a session in the real app: the essentials checklist, Clear all, a Save that refuses an incomplete office,
// Discard, and a whole office built from an empty lot and saved. Buttons, catalog and floor clicks are real pointer
// input; the bulk of the furniture goes through the same `build` message the scene sends. The checks read company.json.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9343 node verify/cdp.mjs verify/e2e-build-session.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drawRoom } from '../src/shared/space/index.ts';
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
mkdirSync(join(repo, 'b'));
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const file = join(dataDir, 'company.json');
const disk = () => JSON.parse(readFileSync(file, 'utf8'));
const allItems = (b) => b.stories.flatMap((s) => s.items);
const essentials = (s) => s.eval(`(() => { const p = document.querySelector('[data-testid=build-essentials]'); return p && { missing: Number(p.dataset.missing), head: p.querySelector('b').innerText, rows: Object.fromEntries([...p.querySelectorAll('li')].map((li) => [li.dataset.essential, { ok: li.dataset.ok === 'true', text: li.innerText }])) }; })()`);
const toasts = (s) => s.eval(`${store}.toasts.map((t) => t.text)`);
const shot = async (s, name) => process.env.OFFICE_SHOTS_DIR && (await s.shot(name));

export default async function (s) {
  await s.waitFor(`!!window.__office && !!${store}.building && !!${store}.company`, 20000);
  await s.resize(1440, 900);
  await s.sleep(800);
  const savedAtStart = JSON.stringify(disk().building);
  const itemsAtStart = await s.eval(`${store}.building.stories.flatMap((st) => st.items).length`);

  await s.press('KeyB', 'b');
  await s.waitFor(`${store}.build !== null`, 4000);
  let panel = await essentials(s);
  assert(panel && panel.missing === 0 && panel.head.includes('Ready to save'), `the existing office opens in build mode as ready to save (${panel?.head})`);
  assert(['entrance', 'owner', 'reach'].every((k) => panel.rows[k]?.ok) && Object.keys(panel.rows).length === 3 + 2 * 3, 'the checklist has the door, your desk, reach, and desks, whiteboard and computer for each of the two teams');
  for (const def of ['owner_desk', 'whiteboard', 'board_terminal']) assert(await s.eval(`!!document.querySelector('[data-entry=${def}]')`), `the catalog offers ${def}`);

  await s.clickOn('[data-testid=build-clear]');
  assert((await s.eval(`document.querySelector('[data-testid=build-clear]').innerText`)).includes('Really'), 'one click on Clear all only asks again');
  assert((await s.eval(`${store}.building.stories.flatMap((st) => st.items).length`)) === itemsAtStart, 'and clears nothing yet');
  await s.clickOn('[data-testid=build-clear]');
  await s.waitFor(`${store}.building.stories.every((st) => st.items.length === 0 && st.walls.length === 0)`, 4000);
  assert(true, 'the second click empties the lot: no furniture, no walls');
  assert(JSON.stringify(disk().building) === savedAtStart, 'company.json still holds the old office while the draft is open');
  await s.sleep(300);
  panel = await essentials(s);
  assert(panel.missing === 8 && !panel.rows.entrance.ok && !panel.rows.owner.ok, `the checklist now lists 8 things missing, the door and your desk among them (${panel.missing})`);
  assert(panel.rows['blk-a:desks'].text.includes('1 more PO desk') && panel.rows['blk-a:desks'].text.includes('2 more team desks'), `it says how many desks a team still needs: ${panel.rows['blk-a:desks'].text.replace(/\n/g, ' ')}`);
  await shot(s, 'build-session-empty');

  await s.clickOn('[data-testid=build-save]');
  await s.sleep(300);
  assert((await s.eval(`${store}.build !== null`)) && (await toasts(s)).some((t) => t.includes('cannot be saved yet')), 'Save on the empty lot stays in build mode and says why');
  await s.press('KeyB', 'b');
  await s.sleep(300);
  assert(await s.eval(`${store}.build !== null`), 'B on the empty lot does not leave either');
  assert(JSON.stringify(disk().building) === savedAtStart, 'nothing was written');

  await s.clickOn('[data-testid=build-discard]');
  await s.waitFor(`${store}.build === null`, 4000);
  await s.waitFor(`${store}.building.stories.flatMap((st) => st.items).length === ${itemsAtStart}`, 4000);
  assert(true, 'Discard leaves build mode with the office back as it was');
  assert(JSON.stringify(disk().building) === savedAtStart, 'and company.json is untouched');

  const lot = await s.eval(`${store}.building.lot`);
  const room = { x: lot.x0 + 2, z: lot.z0 + lot.h - 16, w: 30, h: 16 };
  await s.eval(`__office.teleport(${room.x + 24}, ${room.z + 6})`);
  await s.press('KeyB', 'b');
  await s.waitFor(`${store}.build !== null`, 4000);
  await s.clickOn('[data-testid=build-clear]');
  await s.clickOn('[data-testid=build-clear]');
  await s.waitFor(`${store}.building.stories.every((st) => st.items.length === 0)`, 4000);
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify(drawRoom(0, room, { paint: 1 }))} })`);
  await s.waitFor(`${store}.building.stories[0].walls.length > 0`, 4000);
  await s.sleep(1200);

  await s.clickOn('[data-entry=owner_desk]');
  const at = await s.eval(`__office.project(${room.x + 24}, 0, ${room.z + 9})`);
  assert(await s.eval(`document.elementFromPoint(${at.x}, ${at.y})?.tagName === 'CANVAS'`), 'the floor spot for your desk is not under the HUD');
  await s.mouse('mouseMoved', at.x - 4, at.y);
  await s.sleep(150);
  await s.click(at.x, at.y);
  await s.waitFor(`${store}.building.stories[0].items.some((i) => i.def === 'owner_desk')`, 4000);
  assert(true, 'your desk goes down with a real click from the catalog');
  await s.press('Escape');
  await s.sleep(300);
  panel = await essentials(s);
  assert(panel.rows.owner.ok && !panel.rows.entrance.ok, 'the checklist ticks your desk and still wants a door');

  const cx = room.x * 2;
  const cz = room.z * 2;
  const people = await s.eval(`${store}.company.employees.map((e) => ({ role: e.role, blockId: e.blockId }))`);
  let n = 0;
  const piece = (def, x, z, blockId) => ({ id: `${blockId ?? 'office'}:${def}:${50 + n++}`, def, x, z, rot: 0, ...(blockId && { blockId }) });
  const desks = people.map((e, i) => piece(e.role === 'orchestrator' ? 'po_desk' : 'bench_desk', cx + 4 + i * 6, cz + 8, e.blockId));
  const boards = ['blk-a', 'blk-b'].flatMap((b, i) => [piece('whiteboard', cx + 4 + i * 22, cz + 18, b), piece('board_terminal', cx + 16 + i * 22, cz + 18, b)]);
  const door = { x: room.x + 4, z: room.z + room.h, d: 'e', style: 0, open: 'door' };
  await s.eval(`window.office.send({ type: 'build', ops: [{ t: 'items', story: 0, put: ${JSON.stringify([...desks, ...boards])}, del: [] }, { t: 'walls', story: 0, put: [${JSON.stringify(door)}], del: [] }] })`);
  await s.waitFor(`${store}.building.stories[0].items.length === ${desks.length + boards.length + 1}`, 4000);
  await s.sleep(400);
  panel = await essentials(s);
  assert(panel.missing === 0 && panel.head.includes('Ready to save'), `with a door, your desk, four desks and both teams' boards the checklist reads ready (${panel.head})`);
  await shot(s, 'build-session-ready');

  await s.press('KeyB', 'b');
  await s.waitFor(`${store}.build === null`, 4000);
  await s.sleep(500);
  const saved = disk();
  const savedIds = new Set(allItems(saved.building).map((i) => i.id));
  assert(allItems(saved.building).length === desks.length + boards.length + 1 && [...desks, ...boards].every((i) => savedIds.has(i.id)), 'B saves: company.json holds exactly the office that was built');
  assert(saved.employees.every((e) => desks.some((d) => d.id === e.seat)), 'and everyone sits at one of the new desks');
  assert(saved.building.bare === true, 'and the stock lobby and facilities are gone from it');
  await shot(s, 'build-session-saved');
}
