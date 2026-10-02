// Proves a moved panel never ends up on top of another one when the window shrinks or the app restarts smaller,
// and that the Notifications grip sits next to the "H keys" chip it moves.
// Run: OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-hud-fit.mjs
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert } from './lib.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'online-office-hud-fit-'));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3' };

const CLOCK = '.clock-bar';
const CHIP = '.toasts .hint';
const TOASTS = '.toasts';
const rect = (s, selector) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const overlaps = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
const within = (r, vw, vh) => r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
const settle = (s) => s.waitFor(`!document.querySelector('.hud-moving-target, .hud-settling-target')`, 4000);
const gripBox = (s, label) => s.eval(`(() => { const e = document.querySelector('[aria-label="Move ${label}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, opacity: getComputedStyle(e).opacity }; })()`);
// The clock's time text answers at its centre and its grip is the topmost thing at its own centre.
const clearOf = (s, selector) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && e.contains(t); })()`);

async function dragTo(s, label, panel, point) {
  const box = await rect(s, panel);
  await s.mouse('mouseMoved', box.left + box.width / 2, box.top + box.height / 2);
  await s.waitFor(`document.querySelector('[aria-label="Move ${label}"]')?.dataset.moveState === 'peek'`, 4000);
  const g = center(await gripBox(s, label));
  await s.mouse('mouseMoved', g.x, g.y);
  await s.waitFor(`getComputedStyle(document.querySelector('[aria-label="Move ${label}"]')).opacity === '1'`, 4000);
  const c = center(await rect(s, panel));
  await s.mouse('mousePressed', g.x, g.y, 1);
  for (let i = 1; i <= 12; i += 1) await s.mouse('mouseMoved', g.x + ((point.x - c.x) * i) / 12, g.y + ((point.y - c.y) * i) / 12, 1);
  await s.mouse('mouseReleased', g.x + point.x - c.x, g.y + point.y - c.y);
  await settle(s);
}

async function check(s, vw, vh, what) {
  await s.waitFor(`innerWidth === ${vw}`, 4000);
  await s.sleep(500);
  const clock = await rect(s, CLOCK);
  const chip = await rect(s, CHIP);
  assert(within(clock, vw, vh), `${what}: the clock is inside the window`);
  assert(!overlaps(clock, chip), `${what}: the clock is clear of the H keys chip`);
  assert(await clearOf(s, CLOCK), `${what}: the clock's time is not covered`);
  const grip = await gripBox(s, 'World clock');
  assert(grip && !overlaps(grip, chip), `${what}: the clock's grip is not under the chip`);
}

export default async (s, { launch }) => {
  await s.waitFor('__office.store.getState().company !== null');
  await s.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null && document.querySelector('[aria-label="Move Notifications"]') !== null`);
  const { vw, vh } = await s.eval('({ vw: innerWidth, vh: innerHeight })');

  // The chip hugs its content, and the Notifications grip appears right beside it.
  const toasts = await rect(s, TOASTS);
  const chip0 = await rect(s, CHIP);
  assert(toasts.width <= chip0.width + 2, `the Notifications target is only as wide as the chip (${toasts.width.toFixed(0)}px vs ${chip0.width.toFixed(0)}px)`);
  const c0 = center(chip0);
  await s.mouse('mouseMoved', c0.x, c0.y);
  await s.waitFor(`getComputedStyle(document.querySelector('[aria-label="Move Notifications"]')).opacity !== '0'`, 4000);
  const g0 = await gripBox(s, 'Notifications');
  const gap = Math.min(Math.abs(g0.left - chip0.right), Math.abs(chip0.left - g0.right));
  assert(gap <= 24, `the Notifications grip sits next to the chip (${gap.toFixed(0)}px away)`);
  await s.shot('hud-fit-chip-grip');

  // Drop the clock at the bottom-left, clear of the chip at full size.
  const clock0 = await rect(s, CLOCK);
  await dragTo(s, 'World clock', CLOCK, { x: 22 + clock0.width / 2, y: vh - 8 - clock0.height / 2 - 20 });
  const placed = await rect(s, CLOCK);
  assert(placed.top > vh * 0.7 && placed.left < 120, `the clock sits at the bottom-left (${placed.left.toFixed(0)},${placed.top.toFixed(0)})`);
  const stored = await s.eval(`localStorage.getItem('online-office.hud-offsets')`);

  // Live shrink: the clamp pulls it up, and it must not land under the chip.
  await s.resize(1024, 640);
  await check(s, 1024, 640, 'live shrink to 1024x640');
  await s.shot('hud-fit-shrunk');
  assert((await s.eval(`localStorage.getItem('online-office.hud-offsets')`)) === stored, 'the shrink did not overwrite the saved place');
  await s.resize(vw, vh);
  await s.sleep(500);
  const regrown = await rect(s, CLOCK);
  assert(Math.abs(regrown.left - placed.left) < 2 && Math.abs(regrown.top - placed.top) < 2, 'growing the window back restores the saved place');
  await s.close();

  // Restart smaller: same resolution on load.
  const small = await launch({ env, width: 1024, height: 640 });
  await small.waitFor('__office.store.getState().company !== null');
  await small.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null`);
  await check(small, 1024, 640, 'restart at 1024x640');
  await small.shot('hud-fit-restart-small');
  await small.close();

  const tiny = await launch({ env, width: 800, height: 500 });
  await tiny.waitFor('__office.store.getState().company !== null');
  await tiny.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null`);
  await check(tiny, 800, 500, 'restart at 800x500');
  await tiny.close();

  const back = await launch({ env, width: vw, height: vh });
  await back.waitFor('__office.store.getState().company !== null');
  await back.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null`);
  await back.sleep(500);
  const again = await rect(back, CLOCK);
  assert(Math.abs(again.left - placed.left) < 2 && Math.abs(again.top - placed.top) < 2, 'relaunching at the original size restores the exact place');
};
