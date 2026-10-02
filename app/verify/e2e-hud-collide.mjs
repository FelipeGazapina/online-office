// Proves a HUD panel can never be dropped, or grown, onto another panel so that it hides it: the drop lands on the
// nearest free spot, a dashed slot shows it mid-drag, and a lifted panel stays inside the window.
// Run: OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-hud-collide.mjs
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert } from './lib.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'online-office-hud-collide-'));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3' };

const CLOCK = '.clock-bar';
const METER = '.waiting';
const BAR = '.bottom';
const TOASTS = '.toasts';
const rect = (s, selector) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const gripAt = (s, kind, label) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(`[aria-label="${kind} ${label}"]`)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const gripState = (s, label) => s.eval(`document.querySelector('[aria-label="Move ${label}"]')?.dataset.moveState`);
const waitGrip = (s, label, state) => s.waitFor(`document.querySelector('[aria-label="Move ${label}"]')?.dataset.moveState === ${JSON.stringify(state)}`, 4000);
const settle = (s) => s.waitFor(`!document.querySelector('.hud-moving-target, .hud-settling-target')`, 4000);
const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const overlaps = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
const within = (r, vw, vh, slack = 0) => r.left >= -slack && r.top >= -slack && r.right <= vw + slack && r.bottom <= vh + slack;
// The panel's own pixels answer at its centre: nothing else sits on top of it.
const reachable = (s, selector) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); const pts = [[.5,.5],[.15,.5],[.85,.5],[.5,.2],[.5,.8]]; return pts.filter(([a, b]) => { const t = document.elementFromPoint(r.left + r.width * a, r.top + r.height * b); return t && (e.contains(t) || t.closest('.hud-resizable') === e.closest('.hud-resizable')); }).length; })()`);

async function reach(s, label, panel) {
  const box = await rect(s, panel);
  await s.mouse('mouseMoved', box.left + box.width / 2, box.top + box.height / 2);
  await waitGrip(s, label, 'peek');
  const at = await gripAt(s, 'Move', label);
  await s.mouse('mouseMoved', at.x, at.y);
  await s.waitFor(`getComputedStyle(document.querySelector('[aria-label="Move ${label}"]')).opacity === '1'`, 4000);
  return at;
}

async function dragBy(s, from, dx, dy, steps = 12) {
  await s.mouse('mousePressed', from.x, from.y, 1);
  for (let i = 1; i <= steps; i += 1) await s.mouse('mouseMoved', from.x + (dx * i) / steps, from.y + (dy * i) / steps, 1);
  await s.mouse('mouseReleased', from.x + dx, from.y + dy);
  await settle(s);
}

// Moves a panel so its centre lands on a point, by its grip.
async function dropOn(s, label, panel, point) {
  const at = await reach(s, label, panel);
  const c = center(await rect(s, panel));
  await dragBy(s, at, point.x - c.x, point.y - c.y);
}

const noneOverlap = (boxes) => boxes.every((a, i) => boxes.every((b, j) => i >= j || !overlaps(a, b)));

export default async (s, { launch }) => {
  await s.waitFor('__office.store.getState().company !== null');
  await s.waitFor(`document.querySelector('[aria-label="Move Waiting meter"]') !== null && document.querySelector('[aria-label="Move Conversation bar"]') !== null`);
  const { vw, vh } = await s.eval('({ vw: innerWidth, vh: innerHeight })');
  const homes = { clock: await rect(s, CLOCK), meter: await rect(s, METER), bar: await rect(s, BAR), toasts: await rect(s, TOASTS) };

  // The repro: the conversation bar at 1.6x, then the waiting meter dropped squarely onto it.
  await s.eval(`document.querySelector('[aria-label="Resize Conversation bar"]').focus()`);
  for (let i = 0; i < 32; i += 1) await s.press('ArrowRight');
  await s.waitFor(`JSON.parse(localStorage.getItem('online-office.hud-scales') || '{}')['bottom-talk'] >= 1.59`, 4000);
  await s.sleep(300);
  const bigBar = await rect(s, BAR);
  assert(bigBar.width > homes.bar.width * 1.4, `the conversation bar is at its largest scale (${bigBar.width.toFixed(0)}px)`);
  const meterAt = await reach(s, 'Waiting meter', METER);
  const target = center(bigBar);
  const meterC = center(await rect(s, METER));

  // While the drag hovers over the bar, a dashed slot shows where the drop will land, and nothing leaves the window.
  await s.mouse('mousePressed', meterAt.x, meterAt.y, 1);
  const steps = 14;
  for (let i = 1; i <= steps; i += 1) await s.mouse('mouseMoved', meterAt.x + ((target.x - meterC.x) * i) / steps, meterAt.y + ((target.y - meterC.y) * i) / steps, 1);
  await waitGrip(s, 'Waiting meter', 'moving');
  await s.sleep(250);
  const slot = await s.eval(`(() => { const g = document.querySelector('.hud-drop-ghost'); if (!g) return null; const r = g.getBoundingClientRect(); const c = getComputedStyle(g); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, opacity: c.opacity, borderStyle: c.borderStyle }; })()`);
  assert(slot && slot.opacity === '1' && slot.borderStyle === 'dashed', 'a dashed slot shows where a drop on top of another panel will land');
  assert(!overlaps(slot, await rect(s, BAR)), 'the slot sits clear of the panel it would have covered');
  await s.shot('hud-collide-slot');
  await s.mouse('mouseReleased', target.x, target.y);
  await settle(s);
  assert((await s.eval(`document.querySelectorAll('.hud-drop-ghost').length`)) === 0, 'the slot goes away when the drag ends');
  const meter1 = await rect(s, METER);
  const bar1 = await rect(s, BAR);
  assert(!overlaps(meter1, bar1), `the waiting meter dropped onto the 1.6x conversation bar lands beside it (meter ${meter1.left.toFixed(0)},${meter1.top.toFixed(0)} bar ${bar1.left.toFixed(0)},${bar1.top.toFixed(0)})`);
  assert(within(meter1, vw, vh) && within(bar1, vw, vh), 'both panels stay inside the window');
  assert((await reachable(s, METER)) === 5, 'every sample point on the dropped meter is reachable');
  await s.shot('hud-collide-meter-on-bar');

  // The clock dropped on the notifications corner does not hide it either.
  const toasts0 = await rect(s, TOASTS);
  await dropOn(s, 'World clock', CLOCK, center(toasts0));
  const clock1 = await rect(s, CLOCK);
  const toasts1 = await rect(s, TOASTS);
  assert(!overlaps(clock1, toasts1), 'the clock dropped on the notifications lands clear of them');
  assert((await reachable(s, CLOCK)) === 5, 'the clock keeps every sample point reachable');

  // All three bottom-left panels sent to the same corner do not stack.
  await dropOn(s, 'Waiting meter', METER, { x: 120, y: vh - 40 });
  await dropOn(s, 'World clock', CLOCK, { x: 120, y: vh - 40 });
  const stack = [await rect(s, CLOCK), await rect(s, METER), await rect(s, TOASTS), await rect(s, BAR)];
  assert(noneOverlap(stack), `clock, waiting meter, notifications and conversation bar sent to one corner stay apart ${JSON.stringify(stack.map((r) => [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]))}`);
  assert(stack.every((r) => within(r, vw, vh)), 'all four stay inside the window');
  for (const [i, selector] of [CLOCK, METER, BAR].entries()) assert((await reachable(s, selector)) === 5, `panel ${i} stays fully reachable in the stack`);
  await s.shot('hud-collide-corner');

  // A lifted panel never pokes outside the window, even a scaled one dragged past the left edge.
  const barGrip = await reach(s, 'Conversation bar', BAR);
  await s.mouse('mousePressed', barGrip.x, barGrip.y, 1);
  let worst = Infinity;
  for (let i = 1; i <= 16; i += 1) {
    await s.mouse('mouseMoved', barGrip.x - (900 * i) / 16, barGrip.y - (60 * i) / 16, 1);
    const r = await rect(s, BAR);
    worst = Math.min(worst, r.left, r.top, vw - r.right, vh - r.bottom);
  }
  assert(worst >= 7, `the lifted conversation bar never leaves the window while dragging (closest edge ${worst.toFixed(1)}px)`);
  await s.press('Escape');
  await settle(s);
  assert((await s.eval(`document.querySelectorAll('.hud-drop-ghost').length`)) === 0, 'Escape removes the slot');
  await s.mouse('mouseReleased', barGrip.x - 900, barGrip.y - 60);
  await settle(s);
  assert(noneOverlap([await rect(s, CLOCK), await rect(s, METER), await rect(s, TOASTS), await rect(s, BAR)]), 'Escape leaves the stack as it was');

  // Persistence: the resolved places survive a restart.
  const placed = [await rect(s, CLOCK), await rect(s, METER), await rect(s, BAR)];
  await s.close();
  const again = await launch({ env });
  await again.waitFor('__office.store.getState().company !== null');
  await again.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null`);
  await again.sleep(500);
  const back = [await rect(again, CLOCK), await rect(again, METER), await rect(again, BAR)];
  assert(back.every((r, i) => Math.abs(r.left - placed[i].left) < 2 && Math.abs(r.top - placed[i].top) < 2), `the free spots survive an app restart (${JSON.stringify(placed.map((r) => [Math.round(r.left), Math.round(r.top)]))} vs ${JSON.stringify(back.map((r) => [Math.round(r.left), Math.round(r.top)]))}, stored ${await again.eval("localStorage.getItem('online-office.hud-offsets')")})`);
  assert(noneOverlap([...back, await rect(again, TOASTS)]), 'nothing overlaps after the restart');

  // Growing a panel over a neighbour moves it off, the same way a drop does.
  await again.eval(`localStorage.removeItem('online-office.hud-offsets'); localStorage.removeItem('online-office.hud-scales')`);
  await again.close();
  const fresh = await launch({ env });
  await fresh.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null`);
  await fresh.sleep(500);
  const meter = await rect(fresh, METER);
  const clock = await rect(fresh, CLOCK);
  await dropOn(fresh, 'World clock', CLOCK, { x: meter.left - 20 - clock.width / 2, y: meter.top + meter.height / 2 });
  const nextTo = await rect(fresh, CLOCK);
  const meterNow = await rect(fresh, METER);
  assert(!overlaps(nextTo, meterNow) && meterNow.left - nextTo.right < 40, 'the clock sits right beside the meter before it grows');
  const corner = await gripAt(fresh, 'Resize', 'World clock');
  await fresh.mouse('mouseMoved', corner.x, corner.y);
  await fresh.waitFor(`document.querySelector('[aria-label="Resize World clock"]')?.dataset.resizeState === 'hover'`, 4000);
  await dragBy(fresh, corner, 260, 100);
  await fresh.waitFor(`document.querySelector('[aria-label="Resize World clock"]')?.dataset.resizeState === 'idle'`, 4000);
  await fresh.sleep(300);
  const grown = await rect(fresh, CLOCK);
  assert(grown.width > nextTo.width * 1.2, `the clock grew (${nextTo.width.toFixed(0)} to ${grown.width.toFixed(0)}px)`);
  assert(!overlaps(grown, await rect(fresh, METER)), 'a panel grown over its neighbour is moved clear of it');
  assert(within(grown, 1280, 800), 'the grown panel stays inside the window');
  await fresh.shot('hud-collide-grown');
};
