// Frame-time baseline of the built office with N fake employees on screen.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 OFFICE_DATA_DIR=$(mktemp -d) OFFICE_PERF_EMPLOYEES=15 node verify/cdp.mjs verify/e2e-perf.mjs
// OFFICE_PERF_ASSERT=1 fails the run when p95 frame time is over 16.7 ms.
// Hidden windows stop requestAnimationFrame, so this scenario shows the window (OFFICE_TEST_RUN empty) and measures
// real frames. The window is visible while it runs, and the figure depends on the machine's display refresh rate.
import { scratch } from './lib.mjs';

const employees = Number(process.env.OFFICE_PERF_EMPLOYEES ?? 15);
const seconds = Number(process.env.OFFICE_PERF_SECONDS ?? 10);
const { dataDir } = scratch();

export const env = {
  OFFICE_DATA_DIR: process.env.OFFICE_DATA_DIR ?? dataDir,
  OFFICE_TEST_RUN: '',
  OFFICE_START_LEVEL: '5',
};

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];

export default async function (s) {
  await s.waitFor('!!__office.store.getState().company');
  await s.eval(`__office.injectFake(${employees})`);
  // Let the avatars seat and the camera settle on the overview before measuring.
  await s.sleep(3000);
  const { deltas, drawCalls, triangles } = await s.eval(`__office.measureFrames(${seconds * 1000})`);
  const sorted = [...deltas].sort((a, b) => a - b);
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const r = (n) => +n.toFixed(2);
  const result = { employees, frames: deltas.length, p50ms: r(pct(sorted, 50)), p95ms: r(pct(sorted, 95)), p99ms: r(pct(sorted, 99)), fpsAvg: r(1000 / avg), drawCalls, triangles };
  console.log(JSON.stringify(result));
  if (process.env.OFFICE_PERF_ASSERT === '1' && result.p95ms > 16.7) throw new Error(`p95 ${result.p95ms} ms is over 16.7 ms`);
}
