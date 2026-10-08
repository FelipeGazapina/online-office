// The owner's rule for the chat drawer near an employee, with real pointer and key events and no model. In the Overview
// it opens only after "Go to" or "Open chat", never when the owner just walks past. In first person it opens when the
// nearest employee in range is in view, and closes when the owner leaves.
// Run: pnpm build && node verify/cdp.mjs verify/e2e-proximity-chat.mjs
import { assert, scratch } from './lib.mjs';

const { dataDir } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3' };

const RANGE = 1.5;
const state = (s) => s.eval('__office.state()');
const store = (s) => s.eval('(({ selectedId, talkingTo, menu }) => ({ selectedId, talkingTo, menu }))(__office.store.getState())');
const drawerOpen = (s) => s.eval(`!!document.querySelector('.drawer')`);
const project = (s, x, y, z) => s.eval(`__office.project(${x}, ${y}, ${z})`);
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const menuOpen = `!!document.querySelector('.emp-menu')`;

async function overCanvas(s, at, what) {
  const tag = await s.eval(`document.elementFromPoint(${at.x}, ${at.y})?.tagName`);
  assert(tag === 'CANVAS', `${what} at ${at.x.toFixed(0)},${at.y.toFixed(0)} is a bare canvas pixel (${tag})`);
}

// The Overview camera eases after the owner; a click is aimed only once it stands still.
async function settle(s) {
  let prev = null;
  for (let i = 0; i < 40; i++) {
    const { owner } = await state(s);
    const p = await project(s, owner.x, 0, owner.z);
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.5) return;
    prev = p;
    await s.sleep(250);
  }
  throw new Error('the Overview camera never settled');
}

// Clear walkable floor at (x, z) that a click in the current view would reach.
const floorAt = (s, x, z) =>
  s.eval(`(() => {
    const at = __office.project(${x}, 0, ${z});
    if (at.x < 60 || at.y < 60 || at.x > innerWidth - 60 || at.y > innerHeight - 60) return null;
    if (document.elementFromPoint(at.x, at.y)?.tagName !== 'CANVAS') return null;
    const hit = __office.pick(at.x, at.y);
    if (hit.kind !== 'floor' || Math.hypot(hit.point.x - ${x}, hit.point.z - ${z}) > 0.25 || !hit.walk) return null;
    return at;
  })()`);

async function floorClick(s, p) {
  await settle(s);
  const at = await floorAt(s, p.x, p.z);
  assert(at, `the floor at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) is clickable`);
  await s.click(at.x, at.y);
  await s.waitFor(`__office.state().intent.kind === 'walk'`, 3000);
}

// Steps the world until the walk ends. Every change of talkingTo and selectedId is recorded by a store subscription, so
// a brief pass through someone's range is seen even between two samples, and the drawer is looked for on every sample.
async function walkAndWatch(s, seconds = 30) {
  await s.eval(`window.__seen = { talk: [], sel: [] };
    window.__unsub?.();
    window.__unsub = __office.store.subscribe((n, o) => {
      if (n.talkingTo && n.talkingTo !== o.talkingTo) __seen.talk.push(n.talkingTo);
      if (n.selectedId && n.selectedId !== o.selectedId) __seen.sel.push(n.selectedId);
    })`);
  let drawer = false;
  let last = null;
  for (let t = 0; t < seconds * 20; t++) {
    await s.eval('__office.step(0.05)');
    last = await state(s);
    if (await drawerOpen(s)) drawer = true;
    if (last.intent.kind === 'keys') break;
  }
  const seen = await s.eval('(window.__unsub(), window.__seen)');
  return { talkedTo: new Set(seen.talk), selected: new Set(seen.sel), drawer, last };
}

async function chestOf(s, id) {
  const a = (await state(s)).avatars.find((x) => x.id === id);
  return project(s, a.x, 0.95, a.z);
}

async function openMenu(s, id, name) {
  await settle(s);
  const at = await chestOf(s, id);
  await overCanvas(s, at, `${name}'s chest`);
  await s.click(at.x, at.y);
  await s.waitFor(menuOpen, 3000);
  await s.sleep(300);
}

const facing = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
const angleOff = (a, b) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);

export default async (s) => {
  await s.waitFor('!!__office.store.getState().company');
  await s.resize(1440, 900);
  // Fake people main never hears about, so no snapshot replaces them; the menu's messages go nowhere.
  await s.eval(`__office.tapSend(() => {})`);
  await s.eval('__office.injectFake(6)');
  for (let i = 0; i < 120; i++) {
    const { avatars: all } = await state(s);
    if (all.length === 6 && all.every((a) => a.seated)) break;
    await s.eval('__office.step(1)');
  }
  const avatars = (await state(s)).avatars;
  assert(avatars.length === 6 && avatars.every((a) => a.seated), `six fake employees sit at their desks (${avatars.length})`);

  await s.press('Digit2', '2');
  await s.waitFor(`__office.store.getState().camera === 'iso'`);
  await settle(s);

  // 1. Overview, passing by. A route through a floor point about 1 m beside a seated employee, from 2.5 m before it to 2.5 m after.
  let pass = null;
  for (const a of avatars) {
    for (let k = 0; k < 24 && !pass; k++) {
      for (const r of [1.0, 1.25]) {
        if (pass) break;
        const ang = (k / 24) * Math.PI * 2;
        const p = { x: a.x + r * Math.sin(ang), z: a.z + r * Math.cos(ang) };
        const d = { x: Math.cos(ang), z: -Math.sin(ang) };
        const from = { x: p.x - 2.5 * d.x, z: p.z - 2.5 * d.z };
        const to = { x: p.x + 2.5 * d.x, z: p.z + 2.5 * d.z };
        // Nobody else is nearer that point, so the passer-by is in earshot of this employee and not a neighbour.
        if (!avatars.every((o) => o.id === a.id || gap(o, p) > r + 0.4)) continue;
        if ((await floorAt(s, p.x, p.z)) && (await floorAt(s, from.x, from.z)) && (await floorAt(s, to.x, to.z))) pass = { a, p, from, to };
      }
    }
    if (pass) break;
  }
  assert(pass, 'an aisle runs past a seated employee, about 1 m from them, with clickable floor at both ends');
  const target = pass.a;
  const name = await s.eval(`__office.store.getState().company.employees.find((e) => e.id === '${target.id}').name`);
  console.log(`passing ${name} (${target.x}, ${target.z}) from (${pass.from.x.toFixed(2)}, ${pass.from.z.toFixed(2)}) to (${pass.to.x.toFixed(2)}, ${pass.to.z.toFixed(2)})`);

  await floorClick(s, pass.from);
  const toStart = await walkAndWatch(s);
  assert(!toStart.drawer, 'walking to the start of the aisle opens no drawer');
  await floorClick(s, pass.to);
  const by = await walkAndWatch(s);
  await s.shot('proximity-passby');
  assert(by.talkedTo.has(target.id), `walking past ${name} put them in earshot: talkingTo became them (${[...by.talkedTo].join(', ')})`);
  assert(!by.drawer && by.selected.size === 0, `an Overview walk past ${name} never opened the chat drawer (selected: ${[...by.selected].join(', ') || 'none'})`);
  assert(gap(by.last.owner, pass.to) < 0.6, `the walk carried on past ${name} to the click (${gap(by.last.owner, pass.to).toFixed(2)} m short)`);

  // 2. Overview, Go to: the drawer opens on arrival for that employee.
  await openMenu(s, target.id, name);
  await s.clickOn('.emp-menu button', 'Go to');
  await s.waitFor(`__office.state().intent.kind === 'walk'`, 3000);
  assert(!(await drawerOpen(s)), `"Go to ${name}" does not open the drawer before the owner arrives`);
  const went = await walkAndWatch(s);
  for (let i = 0; i < 20 && (await store(s)).selectedId !== target.id; i++) await s.eval('__office.step(0.1)');
  await s.sleep(300);
  assert(went.last.talkingTo === target.id || (await state(s)).talkingTo === target.id, `"Go to ${name}" ends in earshot of ${name}`);
  assert((await store(s)).selectedId === target.id && (await drawerOpen(s)), `"Go to ${name}" opens ${name}'s chat drawer on arrival`);
  await s.shot('proximity-goto');

  // 3. Esc closes it, and staying in range does not bring it back.
  await s.press('Escape');
  await s.sleep(200);
  assert(!(await drawerOpen(s)) && (await store(s)).selectedId === null, 'Esc closes the drawer');
  await s.eval('__office.step(3)');
  await s.sleep(300);
  assert((await state(s)).talkingTo === target.id, `the owner is still in earshot of ${name}`);
  assert(!(await drawerOpen(s)) && (await store(s)).selectedId === null, 'staying in range after Esc does not reopen the drawer');

  // 4. Overview, Open chat: the drawer opens at once.
  await openMenu(s, target.id, name);
  await s.clickOn('.emp-menu button', 'Open chat');
  await s.sleep(300);
  assert((await store(s)).selectedId === target.id && (await drawerOpen(s)), `"Open chat" opens ${name}'s drawer at once`);
  await s.press('Escape');
  await s.sleep(200);
  assert(!(await drawerOpen(s)), 'Esc closes it again');

  // 5. First person: back at the aisle point beside them, where nobody else is nearer, but facing away.
  // Tab is pressed out of everyone's range, so switching cameras next to Fake 0 cannot already put them in view.
  const clear = [pass.from, pass.to, ...[2.5, 3, 3.5, 4].flatMap((r) => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ x: target.x + r * Math.sin(k * Math.PI / 4), z: target.z + r * Math.cos(k * Math.PI / 4) })))]
    .find((q) => avatars.every((o) => gap(o, q) > 2));
  await s.eval(`__office.teleport(${clear.x}, ${clear.z})`);
  await s.eval('__office.step(0.5)');
  assert((await state(s)).talkingTo === null, 'the owner stands out of everyone\'s range before switching cameras');
  await s.press('Tab');
  await s.waitFor(`__office.store.getState().camera === 'first'`, 3000);
  const spot = pass.p;
  const away = facing(spot, target) + Math.PI;
  await s.eval(`__office.teleport(${spot.x}, ${spot.z}, ${away})`);
  await s.eval('__office.step(0.5)');
  await s.sleep(500);
  const back = await state(s);
  assert(gap(back.owner, target) < RANGE && back.talkingTo === target.id, `in first person the owner stands ${gap(back.owner, target).toFixed(2)} m from ${name}, in earshot (talkingTo ${back.talkingTo}, others ${JSON.stringify(back.avatars.map((o) => [o.id, gap(o, back.owner).toFixed(2)]))})`);
  assert(angleOff(back.view.yaw, facing(back.owner, target)) > Math.PI / 2, `and looks away from them (${angleOff(back.view.yaw, facing(back.owner, target)).toFixed(2)} rad off)`);
  assert(!(await drawerOpen(s)) && (await store(s)).selectedId === null, `facing away from ${name} in first person keeps the drawer closed`);

  // 6. Turning the head with Q until they are in view opens it.
  await s.key('keyDown', 'KeyQ', 'q');
  let opened = false;
  for (let i = 0; i < 80 && !opened; i++) {
    await s.sleep(100);
    opened = (await store(s)).selectedId === target.id;
  }
  await s.key('keyUp', 'KeyQ', 'q');
  const turned = await state(s);
  const off = angleOff(turned.view.yaw, facing(turned.owner, target));
  assert(opened && (await drawerOpen(s)), `turning with Q until ${name} is in view opens the drawer (${off.toFixed(2)} rad off the look)`);
  assert(off <= Math.PI / 4 + 0.15, `it opened only once ${name} was near the look direction (${off.toFixed(2)} rad off)`);
  await s.shot('proximity-firstperson');

  // 7. Walking away past 1.5 m closes it. The drawer that opened took the keyboard for its message box, and Esc there would
  // close the drawer, so a click on the scene hands the keys back to walking.
  const typing = await s.eval(`document.activeElement?.id ?? null`);
  if (typing === 'drawer-input') {
    // A pixel of the view with nothing clickable under it, so the click only takes the focus.
    const view = await s.eval(`(() => {
      for (let y = 80; y < innerHeight - 80; y += 40)
        for (let x = 80; x < innerWidth - 460; x += 40)
          if (document.elementFromPoint(x, y)?.tagName === 'CANVAS' && __office.pick(x, y).kind === 'nothing') return { x, y };
      return null;
    })()`);
    assert(view, 'part of the first-person view has nothing clickable under it');
    await s.click(view.x, view.y);
    await s.sleep(200);
  }
  assert(!(await s.eval(`['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)`)) && (await drawerOpen(s)) && (await s.eval('__office.store.getState().modal')) === null, 'the keys walk again, the drawer is still open and nothing else opened');
  await s.key('keyDown', 'KeyS', 's');
  let left = null;
  for (let i = 0; i < 60; i++) {
    await s.eval('__office.step(0.1)');
    left = await state(s);
    if (gap(left.owner, target) > RANGE + 0.3) break;
  }
  await s.key('keyUp', 'KeyS', 's');
  await s.eval('__office.step(0.3)');
  await s.sleep(300);
  assert(gap(left.owner, target) > RANGE, `walking backwards took the owner out of range (${gap(left.owner, target).toFixed(2)} m)`);
  assert(!(await drawerOpen(s)) && (await store(s)).selectedId === null, `leaving ${name}'s range closes the drawer`);
};
