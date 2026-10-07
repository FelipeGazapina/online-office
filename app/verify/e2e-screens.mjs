// A desk's screens show what its sitter is doing: lit in the provider's colour while the sitter works, dim blue while idle and at a desk
// nobody sits at. Read from the colours the scene gives each screen, with fake employees in the three states.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/e2e-screens.mjs
import { assert, scratch } from './lib.mjs';

const { dataDir } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_TEST_RUN: '', OFFICE_START_LEVEL: '5' };

export default async function (s) {
  await s.waitFor('!!__office.store.getState().company');
  await s.eval('__office.injectFake(6, 1, 0)');
  await s.sleep(2500);
  const statusOf = await s.eval(`Object.fromEntries(__office.store.getState().company.employees.map((e) => [e.seat, e.status.kind]))`);
  const meshes = await s.eval(`__office.probe('screens')`);
  const lit = new Map();
  for (const m of meshes) m.desks.forEach((id, n) => lit.set(id, m.colors.slice(n * 3, n * 3 + 3)));
  const strength = (rgb) => Math.max(...rgb);
  const working = [...lit].filter(([id]) => statusOf[id] === 'working');
  const idle = [...lit].filter(([id]) => statusOf[id] === 'idle');
  const empty = [...lit].filter(([id]) => statusOf[id] === undefined);
  assert(working.length === 4 && idle.length === 2 && empty.length >= 1, `${working.length} working, ${idle.length} idle and ${empty.length} empty desks have a screen`);
  assert(meshes.length >= 2 && new Set(meshes.map((m) => m.setup)).size === meshes.length, `the screens are drawn by ${meshes.length} meshes, one per computer in use`);
  const min = (list) => Math.min(...list.map(([, rgb]) => strength(rgb)));
  const max = (list) => Math.max(...list.map(([, rgb]) => strength(rgb)));
  assert(min(working) > 0.5 && max(idle) < 0.35 && max(empty) < 0.35 && max(empty) <= max(idle) + 0.01, `working screens are bright (${min(working).toFixed(2)} or more), idle and empty ones dim (${max(idle).toFixed(2)}, ${max(empty).toFixed(2)})`);
  const before = JSON.stringify(working.map(([, rgb]) => rgb));
  await s.sleep(600);
  const after = (await s.eval(`__office.probe('screens')`)).flatMap((m) => m.desks.map((id, n) => [id, m.colors.slice(n * 3, n * 3 + 3)])).filter(([id]) => statusOf[id] === 'working');
  assert(after.length === working.length && JSON.stringify(after.map(([, rgb]) => rgb)) !== before, 'and a working screen keeps changing, so it is lit by the frame and not painted once');
}
