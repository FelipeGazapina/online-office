// Measures frame pacing with rAF timestamps: idle, then while a HUD panel is dragged (4 and 10 pointermoves a frame).
// Run: OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-hud-frames.mjs
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert } from './lib.mjs';

export const env = { OFFICE_DATA_DIR: mkdtempSync(join(tmpdir(), 'online-office-hud-frames-')), OFFICE_START_LEVEL: '3' };
const BUDGET = 16.7;

const startRecording = (s) => s.eval(`(() => { window.__ft = []; window.__ftOn = true; let last = 0; const tick = (t) => { if (last) window.__ft.push(t - last); last = t; if (window.__ftOn) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
const stopRecording = async (s) => {
  const times = await s.eval(`(() => { window.__ftOn = false; return window.__ft; })()`);
  const sorted = [...times].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { n: sorted.length, mean: times.reduce((a, b) => a + b, 0) / times.length, p95: q(0.95), max: sorted.at(-1) };
};
const fmt = (r) => `n=${r.n} mean=${r.mean.toFixed(2)} p95=${r.p95.toFixed(2)} max=${r.max.toFixed(2)}`;

export default async (s) => {
  await s.waitFor('__office.store.getState().company !== null');
  await s.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null`);
  await s.sleep(1500);
  await startRecording(s);
  await s.sleep(2000);
  const idle = await stopRecording(s);
  console.log('idle', fmt(idle));

  const box = await s.eval(`(() => { const r = document.querySelector('.clock-bar').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await s.mouse('mouseMoved', box.x, box.y);
  await s.waitFor(`document.querySelector('[aria-label="Move World clock"]')?.dataset.moveState === 'peek'`);
  const g = await s.eval(`(() => { const r = document.querySelector('[aria-label="Move World clock"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await s.mouse('mouseMoved', g.x, g.y);
  await s.sleep(250);

  const run = async (label, pause) => {
    await s.mouse('mousePressed', g.x, g.y, 1);
    await s.mouse('mouseMoved', g.x + 8, g.y + 8, 1);
    await s.sleep(300);
    await startRecording(s);
    const steps = 240;
    for (let i = 1; i <= steps; i += 1) {
      await s.mouse('mouseMoved', g.x + (i / steps) * 420, g.y + 120 + Math.sin(i / 12) * 90, 1);
      if (pause) await s.sleep(pause);
    }
    const result = await stopRecording(s);
    await s.mouse('mouseReleased', g.x + 420, g.y + 120);
    await s.waitFor(`!document.querySelector('.hud-moving-target, .hud-settling-target')`, 4000);
    console.log(label, fmt(result));
    return result;
  };
  const paced = await run('drag (one move a frame)', 8);
  const flood = await run('drag (moves as fast as they arrive)', 0);

  // The display's own frame timestamps wobble by about 2ms on this machine (a blank page measures the same), so
  // what the app owns is: no slower than idle, and no dropped frame while it carries a panel.
  for (const [label, r] of [['paced', paced], ['flood', flood]]) {
    assert(r.p95 <= idle.p95 + 0.6, `${label} drag frame p95 ${r.p95.toFixed(2)}ms is no worse than idle ${idle.p95.toFixed(2)}ms`);
    assert(r.max < 25, `${label} drag never drops a frame (max ${r.max.toFixed(2)}ms)`);
    assert(r.mean <= BUDGET + 0.4, `${label} drag holds 60fps on average (${r.mean.toFixed(2)}ms)`);
  }

  await s.sleep(300);
  await startRecording(s);
  await s.sleep(1500);
  const after = await stopRecording(s);
  console.log('after', fmt(after));
  assert(await s.eval(`!document.body.classList.contains('hud-moving')`), 'the world is back to normal after the drop');
};
