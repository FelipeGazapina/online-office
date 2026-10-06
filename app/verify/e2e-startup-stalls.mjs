// Main-thread stalls in the first 10 s of one cold start of the built office, with the settled scene at 10 s as a screenshot.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/e2e-startup-stalls.mjs
// OFFICE_STALLS_FIXTURE=default|floors3   the empty office, or the e2e-perf building (15 employees, 3 stories) loaded from company.json.
// OFFICE_STALLS_VISIBLE=1                 show the window, so frames are composited the way the owner sees them.
// OFFICE_STALLS_DATA_DIR=<dir>            reuse a data folder, so the Chromium caches from an earlier launch are warm.
// OFFICE_STALLS_ASSERT=1                  fail when a task is longer than 200 ms.
// OFFICE_STALLS_TAG=<name>                names the screenshot, /tmp/office-shots/stalls-<fixture>-<tag>.png.
// OFFICE_STALLS_REF=<png>                 prints how far the settled scene is from this earlier screenshot.
// A load average above the machine's core count makes every figure here larger, so the line it prints carries the load.
import { loadavg } from 'node:os';
import { startupDataDir } from './startup-fixture.mjs';

const fixture = process.env.OFFICE_STALLS_FIXTURE ?? 'default';
const visible = process.env.OFFICE_STALLS_VISIBLE === '1';
const tag = process.env.OFFICE_STALLS_TAG ?? 'run';
const WINDOW_MS = 10_000;
const LIMIT_MS = 200;
const dataDir = process.env.OFFICE_STALLS_DATA_DIR ?? startupDataDir(fixture).dataDir;

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_ACK: '0', OFFICE_TEST_RUN: visible ? '' : '1' };

// The share of pixels that differ by more than 8 of 255 in some channel, and the mean difference per channel, between two PNGs.
const PIXEL_DIFF = `async (a, b) => {
  const bitmap = async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); return img; };
  const [x, y] = await Promise.all([bitmap(a), bitmap(b)]);
  if (x.naturalWidth !== y.naturalWidth || x.naturalHeight !== y.naturalHeight) return { sameSize: false };
  const read = (img) => { const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data; };
  const p = read(x), q = read(y);
  let over = 0, sum = 0;
  for (let i = 0; i < p.length; i += 4) {
    const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]));
    sum += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
    if (d > 8) over++;
  }
  return { sameSize: true, overPct: +(100 * over / (p.length / 4)).toFixed(3), meanDiff: +(sum / (p.length / 4 * 3)).toFixed(3) };
}`;

export default async function (s) {
  const load = loadavg();
  await s.eval(`window.__stalls = []; new PerformanceObserver((l) => window.__stalls.push(...l.getEntries().map((e) => [Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true })`);
  await s.waitFor(`performance.now() > ${WINDOW_MS + 500}`, 40_000);
  const { stalls, firstFrame, employees, stories } = await s.eval(`({
    stalls: window.__stalls,
    firstFrame: Math.round(performance.getEntriesByName('office-first-frame')[0]?.startTime ?? -1),
    employees: __office.store.getState().company.employees.length,
    stories: __office.store.getState().building.stories.length,
  })`);
  const want = fixture === 'floors3' ? { employees: 15, stories: 3 } : { employees: 0, stories: 1 };
  if (employees !== want.employees || stories !== want.stories) throw new Error(`the ${fixture} fixture did not load: ${employees} employees, ${stories} stories`);

  const within = stalls.filter(([start]) => start < WINDOW_MS);
  const totalMs = within.reduce((a, [, d]) => a + d, 0);
  const maxMs = Math.max(0, ...within.map(([, d]) => d));
  const shot = await s.shot(`stalls-${fixture}-${tag}`);
  const summary = { fixture, visible, load1: +load[0].toFixed(2), load5: +load[1].toFixed(2), firstFrameMs: firstFrame, tasks: within.length, maxMs, totalMs, tasksMs: within.map(([start, d]) => `${start}+${d}`) };
  console.log(JSON.stringify(summary));
  if (process.env.OFFICE_STALLS_REF) {
    const { readFileSync } = await import('node:fs');
    const diff = await s.eval(`(${PIXEL_DIFF})(${JSON.stringify(readFileSync(shot).toString('base64'))}, ${JSON.stringify(readFileSync(process.env.OFFICE_STALLS_REF).toString('base64'))})`);
    console.log(`screenshot diff against ${process.env.OFFICE_STALLS_REF}: ${JSON.stringify(diff)}`);
  }
  if (process.env.OFFICE_STALLS_ASSERT === '1' && maxMs > LIMIT_MS) throw new Error(`a task held the main thread for ${maxMs} ms, limit is ${LIMIT_MS} ms`);
}
