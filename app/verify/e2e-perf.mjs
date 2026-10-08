// Frame-time baseline of the built office with N fake employees on screen.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 OFFICE_DATA_DIR=$(mktemp -d) OFFICE_PERF_EMPLOYEES=15 node verify/cdp.mjs verify/e2e-perf.mjs
// OFFICE_PERF_FLOORS=3 builds two extra stories (stairs, desks, decor) and seats the employees across them.
// OFFICE_PERF_TOPS=120 puts that many small items (lamps, laptops, books, mugs...) on the bench desks before measuring.
// OFFICE_PERF_CAMERA=first switches to first person before measuring.
// Draw calls and triangles read the highest frame of the window. The environment capture is one extra render taken a few frames after the scene is
// built, when the GPU has linked its programs; a window with it in reads about 95 calls and 250k triangles higher than one without, whatever the code.
// OFFICE_PERF_TERMINALS=1 makes every employee's terminal move for the whole window: ten pushes a second each, text growing, a call, its result,
// as main sends them, so the monitors redraw as often as they ever will.
// OFFICE_PERF_ASSERT=1 fails the run unless fpsAvg >= 59.5 and at most 1% of frames take longer than 25 ms (standing perf bar).
// Hidden windows stop requestAnimationFrame, so this scenario shows the window (OFFICE_TEST_RUN empty) and measures
// real frames. The window is visible while it runs, and the figure depends on the machine's display refresh rate.
import { TerminalBuffer } from '../src/shared/terminal.ts';
import { scratch } from './lib.mjs';

const employees = Number(process.env.OFFICE_PERF_EMPLOYEES ?? 15);
const floors = Number(process.env.OFFICE_PERF_FLOORS ?? 1);
const camera = process.env.OFFICE_PERF_CAMERA ?? 'iso';
const tops = Number(process.env.OFFICE_PERF_TOPS ?? 0);
const seconds = Number(process.env.OFFICE_PERF_SECONDS ?? 10);
const terminals = process.env.OFFICE_PERF_TERMINALS === '1';
const { dataDir } = scratch();

export const env = {
  OFFICE_DATA_DIR: process.env.OFFICE_DATA_DIR ?? dataDir,
  OFFICE_TEST_RUN: '',
  OFFICE_START_LEVEL: '5',
};

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];

export default async function (s) {
  await s.waitFor('!!__office.store.getState().company');
  await s.eval(`__office.injectFake(${employees}, ${floors}, ${tops})`);
  // The overview draws the stories up to the owner's, so the owner goes to the top one to put every story on screen.
  if (floors > 1) await s.eval(`__office.ownerTo(${floors - 1}, -10, 6)`);
  // Let the avatars seat and the camera settle on the overview before measuring.
  await s.sleep(3000);
  if (camera === 'first') await s.press('Tab');
  await s.sleep(1500);
  if (terminals) {
    // What main would push, a tenth of a second apart: each push is what changed since the one before.
    const steps = seconds * 10 + 20;
    const script = Array.from({ length: employees }, (_, e) => {
      const buffer = new TerminalBuffer('/work/repo', 'Claude Code', 'claude-haiku-4-5-20251001');
      const pushes = [{ ...buffer.take(), employeeId: `fake-emp-${e}`, type: 'terminal' }];
      for (let i = 0; i < steps; i++) {
        if (i % 25 === 0) buffer.apply({ k: 'tool', id: `t${i}`, name: 'Read', input: { file_path: `/work/repo/src/file${i}.ts` } });
        else if (i % 25 === 3) buffer.apply({ k: 'result', id: `t${i - 3}`, ok: true, text: 'x', data: { file: { numLines: 40 + i } } });
        else buffer.apply({ k: 'text', id: `m${Math.floor(i / 25)}`, text: `Reading the module and checking how the retry logic handles a failed request, step ${i}. `.repeat(1 + (i % 25)) });
        pushes.push({ ...buffer.take(), employeeId: `fake-emp-${e}`, type: 'terminal' });
      }
      return pushes;
    });
    await s.eval(`(() => { const script = ${JSON.stringify(script)}; let i = 0; window.__terminalTimer = setInterval(() => { for (const pushes of script) if (pushes[i]) __officeTerminalPush(pushes[i]); i++; }, 100); })()`);
    await s.sleep(500);
  }
  const { deltas, drawCalls, triangles, cpuMs, gpuMs } = await s.eval(`__office.measureFrames(${seconds * 1000})`);
  const sorted = [...deltas].sort((a, b) => a - b);
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const r = (n) => +n.toFixed(2);
  const result = { camera, floors, employees, tops, frames: deltas.length, p50ms: r(pct(sorted, 50)), p95ms: r(pct(sorted, 95)), p99ms: r(pct(sorted, 99)), slowPct: r((deltas.filter((d) => d > 25).length / deltas.length) * 100), fpsAvg: r(1000 / avg), drawCalls, triangles, renderCpuMs: cpuMs === null ? null : r(cpuMs), gpuMs: gpuMs === null ? null : r(gpuMs) };
  console.log(JSON.stringify(result));
  if (terminals) {
    const drawn = await s.eval(`Object.values(window.__officeTerminals?.() ?? {}).filter((t) => t.rows.some((r) => r.includes('Reading the module')) || t.rows.some((r) => r.includes('Read(src'))).length`);
    console.log(`${drawn} of ${employees} monitors showed live text`);
    if (drawn === 0) throw new Error('no monitor drew the streaming terminals, so the measurement says nothing');
  }
  if (process.env.OFFICE_PERF_ASSERT === '1') {
    if (result.fpsAvg < 59.5) throw new Error(`fpsAvg ${result.fpsAvg} is under 59.5`);
    if (result.slowPct > 1) throw new Error(`${result.slowPct}% of frames are over 25 ms, limit is 1%`);
  }
}
