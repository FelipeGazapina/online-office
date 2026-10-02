// Drag polish: a 4px threshold before the lift, a readable lift (scale, light ring, origin slot, on top of every panel),
// keyboard pick-up with a live announcement and Escape, tooltip that never clips, Reset layout, first-run hint.
// Run: OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-hud-polish.mjs
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert } from './lib.mjs';

export const env = { OFFICE_DATA_DIR: mkdtempSync(join(tmpdir(), 'online-office-hud-polish-')), OFFICE_START_LEVEL: '3' };

const rect = (s, selector) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const gripAt = (s, label) => s.eval(`(() => { const r = document.querySelector('[aria-label="Move ${label}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const state = (s, label) => s.eval(`document.querySelector('[aria-label="Move ${label}"]')?.dataset.moveState`);
const settle = (s) => s.waitFor(`!document.querySelector('.hud-moving-target, .hud-settling-target')`, 4000);
const stored = (s, key) => s.eval(`JSON.parse(localStorage.getItem('online-office.hud-offsets') || '{}')[${JSON.stringify(key)}] ?? null`);
const world = (s) => s.eval('({ owner: __office.state().owner, camera: __office.state().camera })');
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

async function reach(s, label, panel) {
  const box = await rect(s, panel);
  await s.mouse('mouseMoved', box.left + box.width / 2, box.top + box.height / 2);
  await s.waitFor(`document.querySelector('[aria-label="Move ${label}"]')?.dataset.moveState === 'peek'`, 4000);
  const at = await gripAt(s, label);
  await s.mouse('mouseMoved', at.x, at.y);
  await s.waitFor(`getComputedStyle(document.querySelector('[aria-label="Move ${label}"]')).opacity === '1'`, 4000);
  return at;
}

async function release(s, label) {
  await s.mouse('mouseMoved', 640, 600);
  await s.waitFor(`document.querySelector('[aria-label="Move ${label}"]')?.dataset.moveState === 'idle'`, 4000);
}

export default async (s) => {
  await s.waitFor('__office.store.getState().company !== null');
  await s.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null`);
  await s.sleep(600);
  const before = await world(s);

  // A tap, or a 3px wiggle, is not a drag: nothing lifts, shifts or is saved.
  const clockHome = await rect(s, '.clock-bar');
  const at = await reach(s, 'World clock', '.clock-bar');
  await s.mouse('mousePressed', at.x, at.y, 1);
  await s.sleep(120);
  assert((await state(s, 'World clock')) !== 'moving' && !(await s.eval(`document.body.classList.contains('hud-moving')`)), 'pressing the grip without moving does not lift the panel');
  await s.mouse('mouseMoved', at.x + 3, at.y + 1, 1);
  await s.sleep(120);
  assert(!(await s.eval(`!!document.querySelector('.hud-moving-target')`)), 'a 3px wiggle does not lift the panel');
  await s.mouse('mouseReleased', at.x + 3, at.y + 1);
  await s.sleep(250);
  const afterTap = await rect(s, '.clock-bar');
  assert(near(afterTap.left, clockHome.left, 0.2) && near(afterTap.top, clockHome.top, 0.2) && near(afterTap.width, clockHome.width, 0.2), 'a tap leaves the panel exactly where and how big it was');
  assert((await stored(s, 'clock')) === null, 'a tap saves nothing');
  assert(!(await s.eval(`!!document.querySelector('.hud-origin-slot, .hud-drop-ghost')`)), 'a tap leaves no slot markers behind');

  // Past the threshold it lifts.
  await reach(s, 'World clock', '.clock-bar');
  await s.mouse('mousePressed', at.x, at.y, 1);
  await s.mouse('mouseMoved', at.x + 9, at.y + 6, 1);
  await s.waitFor(`document.querySelector('[aria-label="Move World clock"]')?.dataset.moveState === 'moving'`, 3000);
  await s.sleep(260);
  const lift = await s.eval(`(() => { const e = document.querySelector('.hud-moving-target'); const c = getComputedStyle(e); const slot = document.querySelector('.hud-origin-slot'); const sr = slot?.getBoundingClientRect(); return { scale: c.scale, shadow: c.boxShadow, z: c.zIndex, slot: slot ? { left: sr.left, top: sr.top, width: sr.width, height: sr.height } : null }; })()`);
  const liftScale = Number.parseFloat(lift.scale.split(' ')[0]);
  assert(liftScale >= 1.045 && liftScale <= 1.06, `the lift scales to about 1.05 (${lift.scale})`);
  assert(/255, 255, 255/.test(lift.shadow), `the lifted panel carries a light outer ring (${lift.shadow.slice(0, 60)})`);
  assert(lift.slot && near(lift.slot.left, clockHome.left, 1) && near(lift.slot.top, clockHome.top, 1) && near(lift.slot.width, clockHome.width, 1), 'a slot marks where the panel came from');
  await s.shot('hud-polish-lift');
  await s.mouse('mouseMoved', at.x + 200, at.y + 150, 1);
  await s.mouse('mouseReleased', at.x + 200, at.y + 150);
  await settle(s);
  assert(!(await s.eval(`!!document.querySelector('.hud-origin-slot')`)), 'the origin slot goes away on drop');
  const moved = await rect(s, '.clock-bar');
  assert(near(moved.left, clockHome.left + 200, 2) && near(moved.top, clockHome.top + 150, 2), 'a real drag still lands where the pointer let go');

  // The carried panel is drawn above every other panel.
  const barAt = await (async () => { await release(s, 'World clock'); return reach(s, 'Conversation bar', '[data-hud-resize-target="bottom-talk"]'); })();
  await s.mouse('mousePressed', barAt.x, barAt.y, 1);
  await s.mouse('mouseMoved', barAt.x + 10, barAt.y - 10, 1);
  await s.waitFor(`!!document.querySelector('.hud-moving-target')`, 3000);
  const z = await s.eval(`(() => { const z = (sel) => Number.parseInt(getComputedStyle(document.querySelector(sel)).zIndex) || 0; return { carried: z('.hud-moving-target'), others: [...document.querySelectorAll('.hud-resize-target:not(.hud-moving-target)')].map((e) => Number.parseInt(getComputedStyle(e).zIndex) || 0) }; })()`);
  assert(z.others.every((o) => o < z.carried), `the carried panel sits above every other panel (${z.carried} vs ${z.others})`);
  await s.press('Escape');
  await s.mouse('mouseReleased', barAt.x + 10, barAt.y - 10);
  await settle(s);

  // Tooltip near the bottom edge flips up so it is never cut off.
  await release(s, 'Conversation bar');
  for (const [label, panel] of [['Conversation bar', '[data-hud-resize-target="bottom-talk"]'], ['Notifications', '[data-hud-resize-target="toasts"]']]) {
    await reach(s, label, panel);
    await s.sleep(200);
    const tip = await s.eval(`(() => { const e = document.querySelector('[aria-label="Move ${label}"]'); const r = e.getBoundingClientRect(); const a = getComputedStyle(e, '::after'); const h = Number.parseFloat(a.height); return { side: e.dataset.side, up: e.hasAttribute('data-tip-up'), gripBottom: r.bottom, top: a.bottom, tipH: h, vh: innerHeight }; })()`);
    const ok = tip.side === 'top' || tip.side === 'bottom' || tip.up || tip.gripBottom + 6 + tip.tipH <= tip.vh;
    assert(ok, `the ${label} tooltip stays inside the window (${JSON.stringify(tip)})`);
    await release(s, label);
  }
  await s.shot('hud-polish-tooltip');

  // Keyboard pick-up: Space grabs, arrows carry, Escape puts it back; Space again keeps it.
  await s.eval(`document.querySelector('[aria-label="Move Waiting meter"]').focus()`);
  const meterHome = await rect(s, '.ticket');
  const meterStored = await stored(s, 'waiting-meter');
  await s.press('Space', ' ');
  await s.waitFor(`document.querySelector('[aria-label="Move Waiting meter"]')?.hasAttribute('data-grabbed')`, 2000);
  assert(/Picked up Waiting meter/.test(await s.eval(`[...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join(' | ')`)), 'picking up is announced');
  for (let i = 0; i < 4; i += 1) await s.press('ArrowRight');
  await s.sleep(250);
  const carried = await rect(s, '.ticket');
  assert(near(carried.left, meterHome.left + 32, 2), `arrows carry a picked-up panel (${(carried.left - meterHome.left).toFixed(1)})`);
  assert(JSON.stringify(await stored(s, 'waiting-meter')) === JSON.stringify(meterStored), 'a picked-up panel is not saved until dropped');
  const said = await s.eval(`[...document.querySelectorAll('[role=status]')].map((e) => e.textContent).filter(Boolean).join(' | ')`);
  assert(/moved to \d+ pixels from the left/.test(said), `the new place is announced (${said})`);
  await s.press('Escape');
  await s.sleep(300);
  const back = await rect(s, '.ticket');
  assert(near(back.left, meterHome.left, 1.5) && near(back.top, meterHome.top, 1.5), 'Escape puts a picked-up panel back');
  assert(!(await s.eval(`document.querySelector('[aria-label="Move Waiting meter"]').hasAttribute('data-grabbed')`)), 'Escape ends the pick-up');
  assert(JSON.stringify(await stored(s, 'waiting-meter')) === JSON.stringify(meterStored), 'Escape saves nothing');

  await s.press('Enter');
  await s.press('ArrowDown');
  await s.press('ArrowDown');
  await s.press('Enter');
  await s.sleep(300);
  const dropped = await rect(s, '.ticket');
  assert(near(dropped.top, meterHome.top + 16, 2), `Enter drops it where it was carried (${(dropped.top - meterHome.top).toFixed(1)})`);
  assert((await stored(s, 'waiting-meter'))?.y === 16, 'the drop is saved');

  // An ordinary arrow nudge can be undone with Escape too.
  await s.eval(`document.querySelector('[aria-label="Move Waiting meter"]').blur(); document.querySelector('[aria-label="Move Waiting meter"]').focus()`);
  await s.press('ArrowRight');
  await s.press('Escape');
  await s.sleep(300);
  const undone = await rect(s, '.ticket');
  assert(near(undone.left, dropped.left, 1.5), 'Escape undoes a plain arrow nudge');
  const after = await world(s);
  assert(after.camera === before.camera && Math.hypot(after.owner.x - before.owner.x, after.owner.z - before.owner.z) < 0.01, 'keyboard moves leave the player and camera alone');

  // First-run hint: grips show faintly while the hint class is on.
  await s.eval(`document.activeElement?.blur(); document.body.classList.add('hud-hint')`);
  await s.sleep(250);
  const hint = await s.eval(`getComputedStyle(document.querySelector('[aria-label="Move Conversation bar"]')).opacity`);
  assert(Number(hint) > 0.3 && Number(hint) < 0.7, `the first-run hint shows grips faintly (${hint})`);
  await s.eval(`document.body.classList.remove('hud-hint')`);

  // Reset layout: one visible control clears every moved and resized panel.
  await s.eval(`localStorage.setItem('online-office.hud-scales', JSON.stringify({ 'bottom-talk': 1.2 }))`);
  await s.eval(`__office.store.setState({ helpOpen: true })`);
  await s.waitFor(`!!document.querySelector('.hud-reset-layout')`, 3000);
  const clockMoved = await rect(s, '.clock-bar');
  assert(clockMoved.left > clockHome.left + 100, 'the clock is still moved before the reset');
  await s.shot('hud-polish-help');
  await s.clickOn('.hud-reset-layout');
  await s.sleep(500);
  await s.eval(`__office.store.setState({ helpOpen: false })`);
  await s.sleep(400);
  const clockReset = await rect(s, '.clock-bar');
  assert(near(clockReset.left, clockHome.left, 1.5) && near(clockReset.top, clockHome.top, 1.5), `Reset HUD layout brings the clock home (${clockReset.left.toFixed(1)},${clockReset.top.toFixed(1)})`);
  assert((await s.eval(`localStorage.getItem('online-office.hud-offsets')`)) === null || (await s.eval(`localStorage.getItem('online-office.hud-offsets')`)) === '{}', 'the saved places are cleared');
  assert((await s.eval(`localStorage.getItem('online-office.hud-scales')`)) === null || (await s.eval(`JSON.parse(localStorage.getItem('online-office.hud-scales'))['bottom-talk'] === undefined`).catch(() => true)), 'the saved sizes are cleared');
  await s.shot('hud-polish-reset');

  // A cold grab: the pointer jumps straight onto the hidden grip and presses with no dwell, and the panel still moves.
  await s.mouse('mouseMoved', 640, 600);
  await s.waitFor(`document.querySelector('[aria-label="Move World clock"]')?.dataset.moveState === 'idle'`, 4000);
  const coldHome = await rect(s, '.clock-bar');
  const cold = await gripAt(s, 'World clock');
  await s.mouse('mouseMoved', cold.x, cold.y);
  await s.mouse('mousePressed', cold.x, cold.y, 1);
  await s.mouse('mouseMoved', cold.x + 60, cold.y + 40, 1);
  await s.mouse('mouseMoved', cold.x + 120, cold.y + 80, 1);
  await s.mouse('mouseReleased', cold.x + 120, cold.y + 80);
  await settle(s);
  const coldDropped = await rect(s, '.clock-bar');
  assert(near(coldDropped.left - coldHome.left, 120, 2) && near(coldDropped.top - coldHome.top, 80, 2), `a press straight onto the hidden grip moves the panel (${(coldDropped.left - coldHome.left).toFixed(1)}, ${(coldDropped.top - coldHome.top).toFixed(1)})`);

  // The tooltip never runs off the bottom edge, even for the panels pinned there.
  for (const label of ['Conversation bar', 'Notifications']) {
    await release(s, label);
    const panel = label === 'Conversation bar' ? '[data-hud-resize-target="bottom-talk"]' : '[data-hud-resize-target="toasts"]';
    await reach(s, label, panel);
    await s.sleep(150);
    const tip = await s.eval(`(() => { const e = document.querySelector('[aria-label="Move ${label}"]'); const r = e.getBoundingClientRect(); const a = getComputedStyle(e, '::after'); const top = a.top === 'auto' ? r.height - parseFloat(a.bottom) - parseFloat(a.height) : parseFloat(a.top); return { bottom: r.top + top + parseFloat(a.height), opacity: a.opacity }; })()`);
    assert(tip.opacity === '1' && tip.bottom <= (await s.eval('innerHeight')), `the ${label} tooltip stays inside the window (bottom ${tip.bottom.toFixed(1)})`);
  }
};
