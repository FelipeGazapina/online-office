// The owner builds the office the way Sims 4 build mode works, with real pointer and keyboard input: enter build mode,
// draw a 5 x 4 room with the room tool, paint its floor, put a door in its wall, place a desk, try a second one on top
// of it, rotate and move the desk, delete a plant, undo and redo, add a floor, climb to it by new stairs, turn the walls
// up / cutaway / down, and leave. After each step the test reads the building main holds, not what the screen shows.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 OFFICE_DATA_DIR=$(mktemp -d) node verify/cdp.mjs verify/e2e-build.mjs
// OFFICE_PERF_ASSERT=1 also fails the run when the build mode frame times miss the standing bar.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, scratch } from './lib.mjs';

const SHOTS = '/Users/feliperico/.claude/orchestrate/online-office-game/shots';
const { dataDir, repo } = scratch();
mkdirSync(join(repo, 'b'));
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const STORY_H = 3.2;
// Footprints in cells of the defs the fixture office holds, for finding free ground.
const FOOT = { bench_desk: [3, 2], po_desk: [3, 2], owner_desk: [3, 2], board_terminal: [2, 1], whiteboard: [9, 1], team_sign: [2, 1], plant: [1, 1], chair: [1, 1], meeting_table: [6, 3], sofa: [4, 2], rug: [6, 4], bookshelf: [4, 1], coffee_machine: [1, 1], stairs: [2, 8] };

async function save(s, name) {
  mkdirSync('/tmp/office-shots', { recursive: true });
  const path = await s.shot(name);
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(path, join(SHOTS, `${name}.png`));
}

const building = (s) => s.eval(`${store}.building`);
const ui = (s) => s.eval(`(() => { const b = ${store}.build; return b && { tool: b.tool, level: b.level, wallsMode: b.wallsMode, tab: b.tab, paint: b.paint }; })()`);
const cursor = (s) => s.eval(`${store}.buildCursor`);
const wallAt = (b, story, d, x, z) => b.stories[story].walls.find((w) => w.d === d && w.x === x && w.z === z);
const itemsOf = (b, story, def) => b.stories[story].items.filter((i) => i.def === def);

export default async function (s) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  await s.sleep(800);
  const seated = async () => (await s.eval('__office.state()')).avatars.filter((a) => a.seated).length;
  assert((await seated()) === 4, 'all four employees are at their desks before building');

  const at = (x, z, level = 0) => s.eval(`__office.project(${x}, ${level * STORY_H}, ${z})`);
  const hover = async (x, z, level = 0) => {
    const p = await at(x, z, level);
    await s.mouse('mouseMoved', p.x, p.y);
    await s.sleep(80);
    return p;
  };
  const clickAt = async (x, z, level = 0) => {
    const p = await at(x, z, level);
    await s.click(p.x, p.y);
    await s.sleep(250);
    return p;
  };
  const dragTo = async (a, b, level = 0, hold) => {
    const pa = await at(a.x, a.z, level);
    const pb = await at(b.x, b.z, level);
    await s.mouse('mouseMoved', pa.x, pa.y);
    await s.mouse('mousePressed', pa.x, pa.y, 1);
    for (let i = 1; i <= 12; i++) await s.mouse('mouseMoved', pa.x + ((pb.x - pa.x) * i) / 12, pa.y + ((pb.y - pa.y) * i) / 12, 1);
    await s.sleep(120);
    await hold?.();
    await s.mouse('mouseReleased', pb.x, pb.y);
    await s.sleep(300);
  };
  const clickSel = async (selector) => {
    const p = await s.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ inline: 'center', block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!p) throw new Error(`nothing to click for ${selector}`);
    await s.click(p.x, p.y);
    await s.sleep(250);
  };
  const choose = async (tab, entry) => {
    await clickSel(`[data-tab="${tab}"]`);
    await clickSel(`[data-entry="${entry}"]`);
  };
  const hold = (code, key) => s.key('keyDown', code, key);
  const release = (code, key) => s.key('keyUp', code, key);
  const waitBuilding = (expr, label) => s.waitFor(`(() => { const b = ${store}.building; return ${expr}; })()`, 5000).catch(async () => {
    throw new Error(`${label}; the screen said: ${(await s.eval('document.querySelector(".toasts")?.innerText ?? ""')).slice(0, 200)}`);
  });

  // ---- free ground near the camera, so every gesture lands where the mouse can reach it
  const b0 = await building(s);
  const owner = (await s.eval('__office.state()')).owner;
  const solids = b0.stories[0].items.filter((i) => !['rug'].includes(i.def)).map((i) => {
    const [w, d] = FOOT[i.def] ?? [1, 1];
    const [fw, fd] = i.rot % 2 === 0 ? [w, d] : [d, w];
    return { x0: i.x / 2, z0: i.z / 2, x1: i.x / 2 + fw / 2, z1: i.z / 2 + fd / 2 };
  });
  const paintIndex = (b, story, x, z) => (z - b.lot.z0) * b.lot.w + (x - b.lot.x0);
  const floorOf = async (story = 0) => s.eval(`Array.from(${store}.building.stories[${story}].paint)`);
  const paint0 = await floorOf(0);
  const hasFloor = (x, z) => x >= b0.lot.x0 && z >= b0.lot.z0 && x < b0.lot.x0 + b0.lot.w && z < b0.lot.z0 + b0.lot.h && paint0[paintIndex(b0, 0, x, z)] > 0;
  const freeBox = (x0, z0, w, h, margin) => {
    for (let z = z0 - margin; z < z0 + h + margin; z++) for (let x = x0 - margin; x < x0 + w + margin; x++) if (!hasFloor(x, z)) return false;
    const r = { x0: x0 - margin, z0: z0 - margin, x1: x0 + w + margin, z1: z0 + h + margin };
    if (solids.some((o) => o.x0 < r.x1 && o.x1 > r.x0 && o.z0 < r.z1 && o.z1 > r.z0)) return false;
    return !b0.stories[0].walls.some((w2) => w2.x >= r.x0 - 1 && w2.x <= r.x1 && w2.z >= r.z0 - 1 && w2.z <= r.z1);
  };
  // Pans the build camera with the real WASD keys until a point of the office sits in the middle of the screen.
  const bring = async (x, z, level = 0) => {
    for (let i = 0; i < 40; i++) {
      const p = await at(x, z, level);
      const key = p.x > 1000 ? ['KeyD', 'd'] : p.x < 300 ? ['KeyA', 'a'] : p.y > 500 ? ['KeyS', 's'] : p.y < 200 ? ['KeyW', 'w'] : null;
      if (!key) return p;
      await hold(...key);
      await s.sleep(Math.min(400, 120 + Math.abs(p.x > 1000 || p.x < 300 ? p.x - 650 : p.y - 350) / 3));
      await release(...key);
      await s.sleep(350);
    }
    throw new Error(`could not bring ${x}, ${z} into view`);
  };
  const findFree = async (w, h, margin, not = []) => {
    const cand = [];
    for (let z = b0.lot.z0; z < b0.lot.z0 + b0.lot.h - h; z++) {
      for (let x = b0.lot.x0; x < b0.lot.x0 + b0.lot.w - w; x++) {
        if (not.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && z < r.z + r.h + 2 && z + h + 2 > r.z)) continue;
        if (freeBox(x, z, w, h, margin)) cand.push({ x, z, d: Math.hypot(x + w / 2 - owner.x, z + h / 2 - owner.z) });
      }
    }
    cand.sort((a, c) => a.d - c.d);
    if (!cand.length) throw new Error(`no free ${w} x ${h} ground`);
    await bring(cand[0].x + w / 2, cand[0].z + h / 2);
    return { x: cand[0].x, z: cand[0].z, w, h };
  };

  // ---- enter build mode
  await s.press('KeyB', 'b');
  await s.waitFor(`!!${store}.build`, 4000);
  assert((await ui(s)).tool.kind === 'select', 'B enters build mode with nothing in hand');
  assert(await s.eval(`!!document.querySelector('.bh-dock') && !!document.querySelector('.bh-top') && !!document.querySelector('.bh-levels')`), 'the build bar, the catalog and the level widget are on screen');
  assert(await s.eval(`document.querySelector('.bottom') === null || getComputedStyle(document.querySelector('.bottom')).display === 'none'`), 'the conversation bar steps aside');
  await s.sleep(1200);
  await save(s, 's3-catalog');
  const cardCount = await s.eval(`document.querySelectorAll('.bh-card').length`);
  assert(cardCount >= 2, `the catalog lists its desks (${cardCount} cards)`);
  assert(await s.eval(`[...document.querySelectorAll('.bh-card img')].every((i) => i.src.startsWith('data:image/png'))`), 'every furniture card shows a rendered thumbnail');
  await clickSel('.bh-search input');
  await s.type('pla');
  await s.sleep(250);
  const found = await s.eval(`[...document.querySelectorAll('.bh-card')].map((c) => c.dataset.entry)`);
  assert(found.includes('plant') && !found.includes('sofa'), `the search box narrows the catalog to plants (${found.join(', ')})`);
  await s.eval(`document.querySelector('.bh-search input').blur()`);
  await clickSel('.bh-clear');
  await s.press('Escape');
  assert((await s.eval(`${store}.build.search`)) === '', 'and the clear button empties the search');

  // ---- the camera pans on its own while building
  const cam0 = await s.eval('({ x: __officeCamera.x, z: __officeCamera.z })');
  await hold('KeyD', 'd');
  await s.sleep(700);
  await release('KeyD', 'd');
  await s.sleep(500);
  const cam1 = await s.eval('({ x: __officeCamera.x, z: __officeCamera.z })');
  assert(Math.hypot(cam1.x - cam0.x, cam1.z - cam0.z) > 1, `WASD pans the build camera (${Math.hypot(cam1.x - cam0.x, cam1.z - cam0.z).toFixed(1)} m)`);
  assert(Math.hypot((await s.eval('__office.state()')).owner.x - owner.x, (await s.eval('__office.state()')).owner.z - owner.z) < 0.05, 'and the owner stays where they stood');
  await hold('KeyA', 'a');
  await s.sleep(700);
  await release('KeyA', 'a');
  await s.sleep(900);

  // ---- room tool: a 5 x 4 room
  const room = await findFree(5, 4, 2);
  const rv = { a: { x: room.x, z: room.z }, b: { x: room.x + 5, z: room.z + 4 } };
  const before = await building(s);
  await clickSel('[data-tab="walls"]');
  await clickSel('[data-entry="room"]');
  assert((await ui(s)).tool.kind === 'room', 'the Room card puts the room tool in hand');
  await dragTo(rv.a, rv.b, 0, async () => {
    const c = await cursor(s);
    assert(c.readout?.text === '5 × 4 m', `mid-drag the cursor reads the room size (${c.readout?.text})`);
    await save(s, 's3-room-drag');
  });
  await waitBuilding(`b.stories[0].walls.length === ${before.stories[0].walls.length + 18}`, 'the room did not arrive');
  const after = await building(s);
  assert(after.stories[0].walls.length - before.stories[0].walls.length === 18, '18 wall segments were added for the 5 x 4 room');
  const floorsIn = [];
  for (let z = room.z; z < room.z + 4; z++) for (let x = room.x; x < room.x + 5; x++) floorsIn.push(after.stories[0].paint[paintIndex(after, 0, x, z)]);
  assert(floorsIn.every((p) => p > 0), 'and every tile inside it has a floor');
  const doorRef = { d: 'e', x: room.x + 2, z: room.z + 4 };
  assert(wallAt(after, 0, 'e', room.x, room.z) && wallAt(after, 0, 's', room.x + 5, room.z + 3), 'with walls on its north and east sides');

  // ---- paint the floor: Shift fills the whole room
  await clickSel('[data-tab="floors"]');
  await clickSel('[data-entry="floor:6"]');
  assert((await ui(s)).tool.kind === 'floor' && (await ui(s)).paint === 6, 'a floor swatch puts the paint tool in hand');
  await hold('ShiftLeft', 'Shift');
  await hover(room.x + 2.5, room.z + 2.5);
  const fill = await cursor(s);
  assert(fill.readout?.text === '20 m²', `with Shift held the ghost covers the room (${fill.readout?.text})`);
  await save(s, 's3-paint');
  await clickAt(room.x + 2.5, room.z + 2.5);
  await release('ShiftLeft', 'Shift');
  await waitBuilding(`b.stories[0].paint[${paintIndex(b0, 0, room.x + 2, room.z + 2)}] === 6`, 'the floor paint did not arrive');
  const painted = await building(s);
  const inside = [];
  for (let z = room.z; z < room.z + 4; z++) for (let x = room.x; x < room.x + 5; x++) inside.push(painted.stories[0].paint[paintIndex(painted, 0, x, z)]);
  assert(inside.every((p) => p === 6), 'all 20 tiles of the room are carpet');
  assert(painted.stories[0].paint[paintIndex(painted, 0, room.x - 1, room.z - 1)] === after.stories[0].paint[paintIndex(after, 0, room.x - 1, room.z - 1)], 'and the ground outside kept its floor');

  // ---- a door on one of its walls
  await choose('openings', 'door');
  await hover(doorRef.x + 0.5, doorRef.z);
  assert((await cursor(s)).verdict?.ok === true, 'the door ghost is green on a wall');
  await clickAt(doorRef.x + 0.5, doorRef.z);
  await waitBuilding(`b.stories[0].walls.some((w) => w.d === 'e' && w.x === ${doorRef.x} && w.z === ${doorRef.z} && w.open === 'door')`, 'the door did not arrive');
  assert(true, `the south wall of the room has a door at x ${doorRef.x}`);

  // ---- a window, then paint the walls: one wall, then the whole room with Shift
  await choose('openings', 'window');
  await clickAt(room.x + 2.5, room.z);
  await waitBuilding(`b.stories[0].walls.some((w) => w.d === 'e' && w.x === ${room.x + 2} && w.z === ${room.z} && w.open === 'window')`, 'the window did not arrive');
  assert(true, 'a window went into the north wall');
  await choose('walls', 'style:1');
  await clickAt(room.x + 5, room.z + 1.5);
  await waitBuilding(`b.stories[0].walls.find((w) => w.d === 's' && w.x === ${room.x + 5} && w.z === ${room.z + 1})?.style === 1`, 'the wall paint did not arrive');
  const styled = (await building(s)).stories[0].walls.filter((w) => w.style === 1);
  assert(styled.length === 1, 'a click paints one wall segment brick');
  await choose('walls', 'style:3');
  await hold('ShiftLeft', 'Shift');
  await clickAt(room.x + 5, room.z + 1.5);
  await release('ShiftLeft', 'Shift');
  await waitBuilding(`b.stories[0].walls.filter((w) => w.style === 3).length === 18`, 'the room walls were not all painted');
  const ring = (await building(s)).stories[0].walls.filter((w) => w.style === 3);
  assert(ring.some((w) => w.open === 'door') && ring.some((w) => w.open === 'window'), 'Shift paints all 18 walls of the room, doors and windows included');

  // ---- the wall tool: a 4 m wall with its readout, then Ctrl-drag takes it away
  await choose('walls', 'wall');
  const wallsBefore = (await building(s)).stories[0].walls.length;
  await dragTo({ x: room.x - 2, z: room.z - 1 }, { x: room.x + 2, z: room.z - 1 }, 0, async () => {
    assert((await cursor(s)).readout?.text === '4 m', 'mid-drag the wall tool reads its length: 4 m');
  });
  await waitBuilding(`b.stories[0].walls.length === ${wallsBefore + 4}`, 'the wall did not arrive');
  assert(true, 'releasing the drag built four wall segments');
  await hold('ControlLeft', 'Control');
  await dragTo({ x: room.x - 2, z: room.z - 1 }, { x: room.x + 2, z: room.z - 1 }, 0, async () => {
    assert((await cursor(s)).readout?.text === 'Delete 4 m', 'Ctrl-drag reads Delete 4 m');
  });
  await release('ControlLeft', 'Control');
  await waitBuilding(`b.stories[0].walls.length === ${wallsBefore}`, 'the wall was not deleted');
  assert(true, 'and Ctrl-drag over it took the walls away again');

  // ---- furniture: a desk inside, then one on top of it
  await choose('desks', 'bench_desk');
  assert((await ui(s)).tool.kind === 'item' && (await ui(s)).tool.blockId, 'the desk is in hand, meant for a team');
  const deskAt = { x: room.x + 2.5, z: room.z + 2 };
  await hover(room.x - 1.6, room.z + 2);
  assert((await cursor(s)).verdict?.ok === true, 'the desk ghost is green on bare floor beside the room');
  await save(s, 's3-ghost-green');
  await hover(room.x - 0.4, room.z + 2);
  const wallRed = await cursor(s);
  assert(wallRed.verdict?.ok === false && wallRed.readout?.bad, `and red across the new wall, with the reason (${wallRed.verdict?.text})`);
  await save(s, 's3-ghost-red');
  const desksBefore = itemsOf(await building(s), 0, 'bench_desk').length;
  await hover(deskAt.x, deskAt.z);
  const green = await cursor(s);
  assert(green.verdict?.ok === true, 'the desk ghost is green on bare floor inside the room');
  await clickAt(deskAt.x, deskAt.z);
  await waitBuilding(`b.stories[0].items.filter((i) => i.def === 'bench_desk').length === ${desksBefore + 1}`, 'the desk did not arrive');
  const placed = itemsOf(await building(s), 0, 'bench_desk').find((i) => !before.stories[0].items.some((o) => o.id === i.id));
  assert(placed && placed.blockId, `the desk stands in the room (${placed.id} at ${placed.x / 2}, ${placed.z / 2}) and belongs to a team`);
  assert((await ui(s)).tool.kind === 'item', 'the tool stays in hand to place more');

  await hover(deskAt.x + 0.5, deskAt.z);
  const red = await cursor(s);
  assert(red.verdict?.ok === false && red.readout?.bad === true, `a second desk overlapping it is red and says why (${red.verdict?.text})`);
  await clickAt(deskAt.x + 0.5, deskAt.z);
  await s.sleep(400);
  assert(itemsOf(await building(s), 0, 'bench_desk').length === desksBefore + 1, 'and clicking it adds nothing');

  // ---- rotate and move the desk
  await s.press('Escape');
  assert((await ui(s)).tool.kind === 'select', 'Escape puts the tool down');
  await clickAt(placed.x / 2 + 0.75, placed.z / 2 + 0.5);
  const carried = await ui(s);
  assert(carried.tool.kind === 'item' && carried.tool.carry === placed.id, 'clicking the desk picks it up');
  await s.press('Period', '.');
  assert((await ui(s)).tool.rot === 1, 'the period key turns it');
  const moveTo = { x: room.x + 1.5, z: room.z + 1.5 };
  await hover(moveTo.x, moveTo.z);
  assert((await cursor(s)).verdict?.ok === true, 'the turned desk fits at the room corner');
  await clickAt(moveTo.x, moveTo.z);
  await waitBuilding(`b.stories[0].items.some((i) => i.id === ${JSON.stringify(placed.id)} && i.rot === 1 && i.x !== ${placed.x})`, 'the desk did not move');
  const moved = (await building(s)).stories[0].items.find((i) => i.id === placed.id);
  assert(moved.rot === 1 && moved.blockId === placed.blockId, `the desk was turned and moved (${moved.x / 2}, ${moved.z / 2}) and kept its team`);
  assert(itemsOf(await building(s), 0, 'bench_desk').length === desksBefore + 1, 'one desk, not two');

  // ---- the eyedropper copies what is under the cursor, and Shift + wheel turns what is in hand
  await s.press('Escape');
  await hover(moveTo.x, moveTo.z);
  await s.press('KeyE', 'e');
  const dropped = await ui(s);
  assert(dropped.tool.kind === 'item' && dropped.tool.def === 'bench_desk' && dropped.tool.carry === null && dropped.tool.rot === 1, 'E copies the desk under the cursor, turned the same way');
  await s.eval(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, shiftKey: true, bubbles: true, cancelable: true }))`);
  assert((await ui(s)).tool.rot === 2, 'Shift + wheel turns it');
  await s.press('Escape');

  // ---- delete a plant
  const plants = itemsOf(await building(s), 0, 'plant');
  const target = plants[0];
  await bring(target.x / 2 + 0.25, target.z / 2 + 0.25);
  await hover(target.x / 2 + 0.25, target.z / 2 + 0.25);
  const hov = await cursor(s);
  assert(hov.hover === target.id, `the cursor knows the plant is under it (${hov.hover} vs ${target.id} at ${target.x},${target.z})`);
  await s.press('Delete');
  await waitBuilding(`!b.stories[0].items.some((i) => i.id === ${JSON.stringify(target.id)})`, 'the plant was not deleted');
  assert(itemsOf(await building(s), 0, 'plant').length === plants.length - 1, `Delete removed ${target.id}`);

  // ---- undo twice, redo once
  const preUndo = await building(s);
  await clickSel('[aria-label="Undo"]');
  await clickSel('[aria-label="Undo"]');
  await waitBuilding(`b.stories[0].items.some((i) => i.id === ${JSON.stringify(target.id)})`, 'undo did not bring the plant back');
  const undone = await building(s);
  const deskNow = undone.stories[0].items.find((i) => i.id === placed.id);
  assert(undone.stories[0].items.some((i) => i.id === target.id), 'undo brought the plant back');
  assert(deskNow.rot === placed.rot && deskNow.x === placed.x && deskNow.z === placed.z, 'and the second undo put the desk where and how it was placed');
  await hold('ControlLeft', 'Control');
  await hold('ShiftLeft', 'Shift');
  await s.press('KeyZ', 'z');
  await release('ShiftLeft', 'Shift');
  await release('ControlLeft', 'Control');
  await waitBuilding(`b.stories[0].items.some((i) => i.id === ${JSON.stringify(placed.id)} && i.rot === 1)`, 'redo did not move the desk again');
  const redone = await building(s);
  assert(redone.stories[0].items.some((i) => i.id === target.id), 'Ctrl+Shift+Z redid one step: the desk moved again and the plant stayed');
  assert(redone.stories[0].items.length === preUndo.stories[0].items.length + 1, 'one more item than before the undos: the plant, and not a second copy of anything');

  // ---- a second floor, and stairs up to it
  await clickSel('.bh-add');
  await waitBuilding('b.stories.length === 2', 'the floor was not added');
  await s.waitFor(`${store}.build.level === 1 && ${store}.story === 1`, 4000);
  assert(true, 'Add floor adds floor 2 and switches to it');
  await s.sleep(1400);
  const stairs = await findFree(7, 8, 0, [room]);
  const hole = { x: stairs.x, z: stairs.z };
  // The run is four tiles from the base at +z, the first three open the stairwell, the fourth is the landing.
  const landing = { x: hole.x, z: hole.z + 3 };
  await bring(landing.x + 3, landing.z + 2, 1);
  await choose('walls', 'room');
  await dragTo({ x: landing.x, z: landing.z }, { x: landing.x + 6, z: landing.z + 4 }, 1);
  await waitBuilding(`b.stories[1].walls.length === 20 && b.stories[1].paint.filter((p) => p > 0).length === 24`, 'the room on floor 2 did not arrive');
  assert(true, 'floor 2 holds a 6 x 4 room whose corner is the stairs landing');
  await clickSel('[aria-label="Floor down"]');
  await s.waitFor(`${store}.build.level === 0`, 4000);
  await s.sleep(1200);
  await choose('stairs', 'stairs');
  await hover(hole.x + 0.5, hole.z + 2);
  const stairGhost = await cursor(s);
  assert(stairGhost.verdict?.ok === true, `the stairs ghost is green at ${hole.x}, ${hole.z} (${stairGhost.verdict?.text})`);
  await clickAt(hole.x + 0.5, hole.z + 2);
  await waitBuilding(`b.stories[0].items.some((i) => i.def === 'stairs')`, 'the stairs did not arrive');
  const stairsItem = (await building(s)).stories[0].items.find((i) => i.def === 'stairs');
  assert(stairsItem.x % 2 === 0 && stairsItem.z % 2 === 0, `the stairs sit on whole tiles (${stairsItem.x / 2}, ${stairsItem.z / 2})`);
  await s.press('Escape');
  await s.eval(`__office.walkTo(1, ${landing.x + 0.5}, ${landing.z + 1.5})`);
  const walk = (await s.eval('__office.state()')).intent;
  assert(walk.kind === 'walk' && walk.legs === 2 && walk.floor === 1, `a route from the ground floor up the new stairs exists (${walk.legs} legs)`);
  await s.eval('__office.teleport(' + owner.x + ', ' + owner.z + ')');
  await s.press('PageUp');
  await s.waitFor(`${store}.build.level === 1 && ${store}.story === 1`, 4000);
  await bring(landing.x + 3, landing.z + 2, 1);
  await s.sleep(900);
  await save(s, 's3-levels');

  // ---- walls up, cutaway, down
  await s.sleep(500);
  const stat = async () => s.eval('__office.wallStats()');
  const setWalls = async (label) => {
    await clickSel(`[aria-label="${label}"]`);
    await s.sleep(500);
    return stat();
  };
  const up = await setWalls('Walls up');
  assert(up.curbs === 0 && up.hidden === 0 && up.full > 0, `walls up: every wall stands (${up.full} full)`);
  const down = await setWalls('Walls down');
  assert(down.full === 0 && down.curbs > 0, `walls down: every wall is a curb (${down.curbs} curbs)`);
  const cut = await setWalls('Cutaway');
  assert(cut.full > 0 && cut.curbs > 0, `cutaway: the walls facing the camera drop (${cut.full} full, ${cut.curbs} curbs)`);

  // ---- leave
  await clickSel('.bh-done');
  await s.waitFor(`${store}.build === null`, 4000);
  assert(true, 'Done leaves build mode');
  await s.eval('__office.step(10)');
  await s.sleep(500);
  assert((await seated()) === 4, 'everyone is back at their desks after building');
  assert((await s.eval(`${store}.story`)) === 0, 'and the scene is back on the owner\'s own floor');
  const foot = { x: stairsItem.x / 2 + 0.5, z: stairsItem.z / 2 + 0.5 - 1.1 };
  await s.eval(`__office.teleport(${foot.x}, ${foot.z}); __office.hold('KeyS', true); __office.step(8)`);
  await s.eval(`__office.hold('KeyS', false)`);
  const climbed = (await s.eval('__office.state()')).owner;
  assert(climbed.floor === 1 && Math.abs(climbed.y - 3.2) < 0.05, `walking into the foot of the new stairs with the keys climbs them (floor ${climbed.floor}, ${climbed.y.toFixed(2)} m)`);
  await s.eval(`__office.walkTo(0, ${owner.x}, ${owner.z})`);
  for (let i = 0; i < 200 && (await s.eval('__office.state()')).owner.floor !== 0; i++) await s.eval('__office.step(0.5)');
  assert((await s.eval('__office.state()')).owner.floor === 0, 'and the owner walks back down them');
  const rooms = (await building(s)).stories[0].walls.length;
  assert(rooms === after.stories[0].walls.length, 'the saved building kept the room');
  const saved = JSON.parse(readFileSync(join(dataDir, 'company.json'), 'utf8'));
  assert(saved.building.stories.length === 2, 'main saved the two floors');

  // ---- the standing perf bar with fifteen people, building
  const people = 15;
  await s.eval(`__office.injectFake(${people})`);
  await s.press('KeyB', 'b');
  await s.waitFor(`!!${store}.build`, 4000);
  await s.sleep(2500);
  const { deltas, drawCalls } = await s.eval('__office.measureFrames(6000)');
  const avg = deltas.reduce((a, c) => a + c, 0) / deltas.length;
  const slow = (deltas.filter((d) => d > 25).length / deltas.length) * 100;
  console.log(JSON.stringify({ perf: 'build mode', employees: people, frames: deltas.length, fpsAvg: +(1000 / avg).toFixed(1), slowPct: +slow.toFixed(2), drawCalls }));
  if (process.env.OFFICE_PERF_ASSERT === '1') assert(1000 / avg >= 59.5 && slow <= 1, 'build mode keeps 60 fps with 15 people');
}
