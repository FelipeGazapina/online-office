// The shot of a desk row with several monitors showing live sessions: six real haiku employees, each at work on a few files, framed from the
// side their screens face. Writes monitors.png (1440x900) to OFFICE_SHOTS (default shots/m1 under the orchestration folder).
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/shots-terminal.mjs
import { copyFileSync, mkdirSync } from 'node:fs';
import { HAIKU, assert, scratch, stepUntil } from './lib.mjs';

const SHOTS = process.env.OFFICE_SHOTS ?? '/Users/feliperico/.claude/orchestrate/online-office-game/shots/m1';
const NAMES = ['Ana', 'Ben', 'Cleo', 'Dana', 'Eli', 'Fay'];
const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_TEST_RUN: '', OFFICE_CLAUDE_MODEL: HAIKU };

const state = '__office.store.getState()';

export default async function (s) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${state}.company`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${state}.company.blocks.length === 1`);
  for (const name of NAMES) await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${state}.company.blocks[0].id, name: ${JSON.stringify(name)} })`);
  await s.waitFor(`${state}.company.employees.length === ${NAMES.length}`);
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, name: e.name }))`);
  for (const p of people) await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(p.id)}, mode: 'yolo' })`);
  await stepUntil(s, `__office.state().avatars.filter((a) => a.seated).length === ${NAMES.length}`, 30000, 'everyone to sit');

  for (const p of people) {
    const text = `Create five small files ${p.name.toLowerCase()}1.txt to ${p.name.toLowerCase()}5.txt, each containing its own number, one Write call per file. Then use your Bash tool to run ls. Then say done.`;
    await s.eval(`window.office.send({ type: 'post', to: ${JSON.stringify(p.id)}, clientId: ${JSON.stringify(`shot-${p.name}`)}, as: 'request', text: ${JSON.stringify(text)} })`);
  }

  // Frame the row in first person: the owner stands behind the chairs, off to one side, and looks over the sitters at their screens.
  const all = await s.eval(`Object.values(__officeMonitors())`);
  // Desks face each other across the team's rug, so the row to shoot is the biggest group that faces one way.
  const unit = (v) => [v[0] / Math.hypot(v[0], v[2]), 0, v[2] / Math.hypot(v[0], v[2])];
  const groups = all.map((a) => all.filter((b) => unit(a.normal)[0] * unit(b.normal)[0] + unit(a.normal)[2] * unit(b.normal)[2] > 0.7));
  const poses = groups.sort((a, b) => b.length - a.length)[0];
  const mean = (i) => poses.reduce((n, p) => n + p.center[i], 0) / poses.length;
  const n0 = unit([0, 1, 2].map((i) => poses.reduce((n, p) => n + p.normal[i], 0) / poses.length));
  const normal = n0;
  const side = [normal[2], 0, -normal[0]];
  // The owner stands just past the end of the row on the sitters' side. The camera focuses on them, so the row is beside the middle of the frame.
  const row = side;
  const along = poses.map((p) => p.center[0] * row[0] + p.center[2] * row[2]);
  const end = Math.min(...along) - Number(process.env.SHOT_END ?? -0.4);
  const centerAlong = (Math.max(...along) + Math.min(...along)) / 2;
  const standAt = [mean(0) + row[0] * (end - centerAlong) + normal[0] * Number(process.env.SHOT_BACK ?? 2.5), mean(2) + row[2] * (end - centerAlong) + normal[2] * Number(process.env.SHOT_BACK ?? 2.5)];
  await s.eval(`__office.teleport(${standAt[0]}, ${standAt[1]}, 0)`);
  await s.eval(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: -${Number(process.env.SHOT_ZOOM ?? 560)} }))`);
  await s.sleep(1500);
  // Turn the overview in quarter turns to the one that shows the screens' faces.
  const facing = async () => {
    const cam = await s.eval('({ ...__officeCamera })');
    return poses.filter((p) => (cam.x - p.center[0]) * p.normal[0] + (cam.z - p.center[2]) * p.normal[2] > 0).length;
  };
  let best = { turns: 0, facing: await facing() };
  for (let turns = 1; turns <= 3; turns++) {
    await s.press('KeyQ', 'q');
    await s.sleep(1300);
    const n = await facing();
    if (n > best.facing) best = { turns, facing: n };
  }
  await s.press('KeyQ', 'q');
  for (let i = 0; i < best.turns; i++) await s.press('KeyQ', 'q');
  await s.sleep(1800);
  console.log(`${await facing()} of ${poses.length} screens face the camera`);

  if (process.env.SHOT_DEBUG) {
    console.log(JSON.stringify({ cam: await s.eval('({ ...__officeCamera })'), owner: await s.eval('__office.state().owner') }));
    await s.shot('terminal-debug');
    return;
  }
  // Wait until most of them show a call being made.
  const showing = () => s.eval(`Object.values(window.__officeTerminals()).filter((t) => t.rows.some((r) => /Write\\(/.test(r))).length`);
  const t0 = Date.now();
  while ((await showing()) < 3 && Date.now() - t0 < 120000) await s.sleep(300);
  await s.sleep(1500);
  assert((await showing()) >= 3, `${await showing()} monitors show a call as it is made`);
  await s.eval('document.activeElement?.blur()');
  const from = await s.shot('terminal-monitors');
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(from, `${SHOTS}/monitors.png`);
  console.log('rows on the first monitor:\n' + Object.values(await s.eval('window.__officeTerminals()'))[0].rows.join('\n'));
}
