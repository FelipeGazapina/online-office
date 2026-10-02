// Proves every grip stays reachable when the four fixed panels are packed into one corner: each grip is the
// topmost thing at its own centre once the pointer is on its panel, and a real drag from it moves the panel.
// Run: OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-hud-grips.mjs
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert } from './lib.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'online-office-hud-grips-'));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3' };

const PANELS = [
  ['World clock', '.clock-bar'],
  ['Waiting meter', '.waiting'],
  ['Conversation bar', '.bottom'],
  ['Notifications', '.toasts'],
];
const rect = (s, selector) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const gripCentre = (s, label) => s.eval(`(() => { const e = document.querySelector('[aria-label="Move ${label}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, side: e.dataset.side }; })()`);
const settle = (s) => s.waitFor(`!document.querySelector('.hud-moving-target, .hud-settling-target')`, 4000);
const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

// Pointer on the panel, then on its grip: the grip must wake up and be the element under the pointer.
async function reach(s, label, panel) {
  const box = await rect(s, panel);
  await s.mouse('mouseMoved', box.left + box.width / 2, box.top + box.height / 2);
  await s.waitFor(`document.querySelector('[aria-label="Move ${label}"]')?.dataset.moveState === 'peek'`, 4000);
  const g = await gripCentre(s, label);
  await s.mouse('mouseMoved', g.x, g.y);
  await s.sleep(250);
  const top = await s.eval(`(() => { const t = document.elementFromPoint(${g.x}, ${g.y}); return !!t && !!t.closest('[aria-label="Move ${label}"]'); })()`);
  const opacity = await s.eval(`getComputedStyle(document.querySelector('[aria-label="Move ${label}"]')).opacity`);
  return { g, top, opacity };
}

async function dragTo(s, label, panel, point) {
  const { g } = await reach(s, label, panel);
  const c = center(await rect(s, panel));
  await s.mouse('mousePressed', g.x, g.y, 1);
  for (let i = 1; i <= 12; i += 1) await s.mouse('mouseMoved', g.x + ((point.x - c.x) * i) / 12, g.y + ((point.y - c.y) * i) / 12, 1);
  await s.mouse('mouseReleased', g.x + point.x - c.x, g.y + point.y - c.y);
  await settle(s);
}

export default async (s) => {
  await s.waitFor('__office.store.getState().company !== null');
  await s.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null && document.querySelector('[aria-label="Move Notifications"]') !== null`);
  await s.resize(1024, 640);
  await s.waitFor('innerWidth === 1024', 4000);
  await s.sleep(400);

  // Pack all four into the top-left corner, one after another, as a user dragging them there would.
  for (const [label, panel] of PANELS) await dragTo(s, label, panel, { x: -3000, y: -3000 });
  await s.sleep(400);
  await s.shot('hud-grips-packed');

  // Every grip is reachable: topmost at its own centre, and visible.
  const sides = {};
  for (const [label, panel] of PANELS) {
    const { g, top, opacity } = await reach(s, label, panel);
    sides[label] = g.side;
    assert(top, `${label}: elementFromPoint at the grip centre is the grip (side ${g.side})`);
    assert(opacity === '1', `${label}: the grip is visible under the pointer`);
  }
  await s.shot('hud-grips-reach');

  // And a real drag from each grip moves its panel, wherever the grip ended up.
  const { vw, vh } = await s.eval('({ vw: innerWidth, vh: innerHeight })');
  let i = 0;
  for (const [label, panel] of PANELS) {
    const before = await rect(s, panel);
    const target = { x: vw - 200 - 120 * (i % 2), y: vh - 150 - 90 * Math.floor(i / 2) };
    i += 1;
    await dragTo(s, label, panel, target);
    const after = await rect(s, panel);
    assert(Math.hypot(after.left - before.left, after.top - before.top) > 100, `${label}: a real drag from its grip moved it (${before.left.toFixed(0)},${before.top.toFixed(0)} to ${after.left.toFixed(0)},${after.top.toFixed(0)})`);
  }
  await s.shot('hud-grips-moved');
  console.log('grip sides when packed', JSON.stringify(sides));
};
