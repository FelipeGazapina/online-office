// The three shots of the terminal, from real haiku employees: zoom.png (the zoomed terminal in the middle of a session, with older turns
// folded, calls on screen, the todo being done and the next one), permission.png (a Bash permission pending) and monitors.png (a row of
// desks with live sessions on their monitors, no chat panel over them). All 1440x900, written to OFFICE_SHOTS.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/shots-terminal.mjs
import { copyFileSync, mkdirSync } from 'node:fs';
import { HAIKU, assert, scratch, stepUntil } from './lib.mjs';

const SHOTS = process.env.OFFICE_SHOTS ?? '/Users/feliperico/.claude/orchestrate/online-office-game/shots/m1b';
const NAMES = ['Ana', 'Ben', 'Cleo', 'Dana', 'Eli', 'Fay'];
const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_TEST_RUN: '', OFFICE_CLAUDE_MODEL: HAIKU };

// SHOT_ONLY=monitors or SHOT_ONLY=zoom runs one half, for a retake.
const only = process.env.SHOT_ONLY ?? '';
const state = '__office.store.getState()';
const keep = async (s, name) => {
  const from = await s.shot(name);
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(from, `${SHOTS}/${name}.png`);
};
const post = (s, id, text, tag) => s.eval(`window.office.send({ type: 'post', to: ${JSON.stringify(id)}, clientId: ${JSON.stringify(`shot-${tag}`)}, as: 'request', text: ${JSON.stringify(text)} })`);

export default async function (s) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${state}.company`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${state}.company.blocks.length === 1`);
  for (const name of NAMES) await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${state}.company.blocks[0].id, name: ${JSON.stringify(name)} })`);
  await s.waitFor(`${state}.company.employees.length === ${NAMES.length}`);
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, name: e.name }))`);
  const mode = (id, m) => s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(id)}, mode: ${JSON.stringify(m)} })`);
  for (const p of people) await mode(p.id, 'yolo');
  await stepUntil(s, `__office.state().avatars.filter((a) => a.seated).length === ${NAMES.length}`, 30000, 'everyone to sit');
  // The terminal on the tallest screen is the one to zoom into, so the shot is not of a laptop or an ultrawide.
  const screens = await s.eval(`__officeMonitors()`);
  const bigId = Object.entries(screens).sort(([, a], [, b]) => b.h - a.h)[0][0];
  const ana = people.find((p) => p.id === bigId) ?? people[0];
  console.log(`zooming into ${ana.name}, whose screen is ${screens[ana.id].w.toFixed(2)} x ${screens[ana.id].h.toFixed(2)} m`);
  const status = () => s.eval(`${state}.company.employees.find((e) => e.id === ${JSON.stringify(ana.id)}).status.kind`);
  const idle = () => s.waitFor(`${state}.company.employees.find((e) => e.id === ${JSON.stringify(ana.id)}).status.kind === 'idle'`, 120000);

  // Two short turns first, so the session has a past to fold.
  if (only !== 'monitors') {
    await post(s, ana.id, 'Create a file named hello.txt containing exactly the word hi with your Write tool. Then say done in one short sentence.', 'a');
    await s.waitFor(`${state}.company.employees.find((e) => e.id === ${JSON.stringify(ana.id)}).status.kind === 'working'`, 30000);
    await idle();
    await post(s, ana.id, 'What word is written in hello.txt? Read it with your Read tool and answer with that word only.', 'b');
    await s.waitFor(`${state}.company.employees.find((e) => e.id === ${JSON.stringify(ana.id)}).status.kind === 'working'`, 30000);
    await idle();

    // The owner stands at her desk and opens her monitor.
    const at = await s.eval(`__office.state().avatars.find((a) => a.id === ${JSON.stringify(ana.id)})`);
    await s.eval(`__office.teleport(${at.x}, ${at.z + 1.4}, 0)`);
    await s.waitFor(`__officeMonitor.getState().near === ${JSON.stringify(ana.id)}`, 8000);
    await s.press('KeyF', 'f');
    await s.waitFor(`!!document.querySelector('.term-frame.ready')`, 6000);
    await s.sleep(500);

    // The session in the middle: she plans with a todo list and writes files one call at a time.
    await post(
      s,
      ana.id,
      'First use your TaskCreate tool four times, once per step, each with an activeForm: write a.txt, write b.txt, write c.txt, run ls. Then do the steps in order. Before each step set its task to in_progress with TaskUpdate, do it (one Write call per file containing its own letter, and your Bash tool for ls), then set the task to completed. Last, say done.',
      'c',
    );
    const live = `(() => {
      const scroll = document.querySelector('.term-scroll')?.innerText ?? '';
      const foot = document.querySelector('.term-foot')?.innerText ?? '';
      return { writes: (scroll.match(/Write\\(/g) ?? []).length, next: /Next:/.test(foot), working: ${state}.company.employees.find((e) => e.id === ${JSON.stringify(ana.id)}).status.kind === 'working' };
    })()`;
    const t0 = Date.now();
    let best = { writes: 0, next: false };
    while (Date.now() - t0 < 120000) {
      const now = await s.eval(live);
      if (now.working && now.writes >= 2 && now.next) {
        best = now;
        break;
      }
      if (now.working && now.writes >= 3 && Date.now() - t0 > 40000) {
        best = now;
        break;
      }
      await s.sleep(120);
    }
    await keep(s, 'zoom');
    console.log(`zoom shot: ${best.writes} writes on screen, next hint ${best.next}`);
    console.log('panel:\n' + (await s.eval(`document.querySelector('.term-frame').innerText`)));
    await idle();

    // A Bash command waiting on the owner.
    await mode(ana.id, 'ask');
    await s.waitFor(`${state}.company.employees.find((e) => e.id === ${JSON.stringify(ana.id)}).permissions.mode === 'ask'`, 5000);
    await post(s, ana.id, 'Use your Bash tool to run exactly this command: npm test. Give the call the description "Run the test suite".', 'd');
    await s.waitFor(`${state}.company.employees.find((e) => e.id === ${JSON.stringify(ana.id)}).status.kind === 'blocked_on_owner'`, 90000);
    await s.waitFor(`!!document.querySelector('.term-dialog')`, 5000);
    await s.sleep(400);
    await keep(s, 'permission');
    console.log('dialog:\n' + (await s.eval(`document.querySelector('.term-dialog').innerText`)));
    await s.press('3', '3');
    await s.waitFor(`!document.querySelector('.term-dialog')`, 5000);
    await idle();
    await mode(ana.id, 'yolo');
  }

  if (only === 'zoom') return;

  // Leave the monitor, and give everyone something to do.
  if (only !== 'monitors') {
    await s.press('Escape', 'Escape');
    await s.waitFor(`__officeMonitor.getState().open === null`, 3000);
  }
  await s.sleep(1500);
  // Frame the row. The screens of a desk face its sitter and the sitters block each other's view, and which desk gets which computer changes
  // from one run to the next, so the owner tries places to stand behind the chairs and keeps the one from which most terminals can be read.
  const all = await s.eval(`Object.values(__officeMonitors())`);
  const unit = (v) => [v[0] / Math.hypot(v[0], v[2]), 0, v[2] / Math.hypot(v[0], v[2])];
  const groups = all.map((a) => all.filter((b) => unit(a.normal)[0] * unit(b.normal)[0] + unit(a.normal)[2] * unit(b.normal)[2] > 0.7));
  const poses = groups.sort((a, b) => b.length - a.length)[0];
  const normal = unit([0, 1, 2].map((i) => poses.reduce((n, p) => n + p.normal[i], 0) / poses.length));
  const row = [normal[2], 0, -normal[0]];
  const centre = [0, 2].map((i) => poses.reduce((n, p) => n + p.center[i], 0) / poses.length);
  if ((await s.eval(`${state}.camera`)) !== 'first') await s.press('Tab', 'Tab');
  await s.sleep(1500);

  const candidates = [];
  for (const back of [1.3, 1.6, 1.9, 2.2, 2.6]) {
    for (const side of [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]) {
      const at = [centre[0] + normal[0] * back + row[0] * side, centre[1] + normal[2] * back + row[2] * side];
      for (const turn of [-0.4, -0.2, 0, 0.2, 0.4]) candidates.push({ at, yaw: Math.atan2(centre[0] - at[0], centre[1] - at[1]) + turn });
    }
  }
  // What a place to stand shows: for each screen, whether it is in the frame, faces the owner, is big enough to read, and has nothing in front of it.
  // A sitter's head filling the lower half of the frame costs as much as a screen is worth.
  const seen = (poses) => `(() => {
    const cam = __officeCamera;
    const W = innerWidth;
    const H = innerHeight;
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    const sizes = ${JSON.stringify(poses)}.map((p) => {
      const at = __office.project(p.center[0], p.center[1], p.center[2]);
      const d = Math.hypot(cam.x - p.center[0], cam.y - p.center[1], cam.z - p.center[2]);
      const face = ((cam.x - p.center[0]) * p.normal[0] + (cam.y - p.center[1]) * p.normal[1] + (cam.z - p.center[2]) * p.normal[2]) / d;
      const width = (p.w / (2 * d * tan)) * H;
      if (!at || at.x < 80 || at.x > W - 80 || at.y < 80 || at.y > H - 160 || face < 0.5 || width < 90) return 0;
      const hit = __office.pick(at.x, at.y);
      return hit?.point && Math.hypot(hit.point.x - p.center[0], hit.point.z - p.center[2]) < 0.35 ? Math.min(width, 380) : 0;
    });
    let near = 0;
    for (let i = 1; i <= 5; i++) {
      for (let j = 1; j <= 3; j++) {
        const hit = __office.pick((W * i) / 6, H * (0.45 + 0.15 * j));
        if (hit?.point && Math.hypot(hit.point.x - cam.x, hit.point.z - cam.z) < 1.1 && hit.point.y > 0.5) near++;
      }
    }
    return { sizes, near };
  })()`;
  let best = { score: -1, shown: 0 };
  for (const c of candidates) {
    await s.eval(`__office.teleport(${c.at[0]}, ${c.at[1]}, ${c.yaw})`);
    await s.sleep(200);
    const { sizes, near } = await s.eval(seen(poses));
    const shown = sizes.filter(Boolean).length;
    const score = sizes.reduce((n, w) => n + w, 0) + (shown >= 3 ? 400 : 0) - near * 60;
    if (score > best.score) best = { score, shown, c };
  }
  await s.eval(`__office.teleport(${best.c.at[0]}, ${best.c.at[1]}, ${best.c.yaw})`);
  await s.sleep(2200);
  // The chat that opened for the nearest sitter closes, and stays closed while the owner stands still.
  await s.eval(`__office.store.setState({ selectedId: null })`);
  await s.sleep(600);
  console.log(`the owner stands at ${best.c.at.map((v) => v.toFixed(1))}: ${best.shown} of ${poses.length} terminals in view, readable and unobstructed (score ${Math.round(best.score)})`);

  // Everyone gets a task once the owner is in place, so the screens show a session at work and not one that is over.
  for (const p of people) {
    const text = `Create ten small files ${p.name.toLowerCase()}1.txt to ${p.name.toLowerCase()}10.txt, each containing its own number, one Write call per file, one file at a time. Then use your Bash tool to run ls. Then say done.`;
    await post(s, p.id, text, `m-${p.name}`);
  }

  // Wait until most of them show a call being made.
  const showing = () => s.eval(`Object.values(window.__officeTerminals()).filter((t) => t.rows.filter((r) => /Write\\(/.test(r)).length >= 2).length`);
  const t1 = Date.now();
  while ((await showing()) < 3 && Date.now() - t1 < 120000) await s.sleep(300);
  await s.sleep(1200);
  assert((await showing()) >= 3, `${await showing()} monitors show a call as it is made`);
  await s.eval('document.activeElement?.blur()');
  await keep(s, 'monitors');
  console.log('rows on the first monitor:\n' + Object.values(await s.eval('window.__officeTerminals()'))[0].rows.join('\n'));
}
