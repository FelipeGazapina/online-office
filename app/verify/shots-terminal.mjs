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
  for (const p of people) {
    const text = `Create ten small files ${p.name.toLowerCase()}1.txt to ${p.name.toLowerCase()}10.txt, each containing its own number, one Write call per file, one file at a time. Then use your Bash tool to run ls. Then say done.`;
    await post(s, p.id, text, `m-${p.name}`);
  }
  await s.eval(`__office.store.setState({ selectedId: null })`);

  // Frame the row: the owner stands behind the chairs of the biggest group of desks that face one way, and looks at their screens.
  const all = await s.eval(`Object.values(__officeMonitors())`);
  const unit = (v) => [v[0] / Math.hypot(v[0], v[2]), 0, v[2] / Math.hypot(v[0], v[2])];
  const groups = all.map((a) => all.filter((b) => unit(a.normal)[0] * unit(b.normal)[0] + unit(a.normal)[2] * unit(b.normal)[2] > 0.7));
  const poses = groups.sort((a, b) => b.length - a.length)[0];
  const normal = unit([0, 1, 2].map((i) => poses.reduce((n, p) => n + p.normal[i], 0) / poses.length));
  const row = [normal[2], 0, -normal[0]];
  const along = (p) => p.center[0] * row[0] + p.center[2] * row[2];
  const sorted = [...poses].sort((a, b) => along(a) - along(b));
  const mid = [0, 2].map((i) => poses.reduce((n, p) => n + p.center[i], 0) / poses.length);
  const alongMid = (sorted.reduce((n, p) => n + along(p), 0) / sorted.length);
  const facing = async () => {
    const cam = await s.eval('({ ...__officeCamera })');
    return poses.filter((p) => (cam.x - p.center[0]) * p.normal[0] + (cam.z - p.center[2]) * p.normal[2] > 0).length;
  };
  const camera = () => s.eval(`${state}.camera`);
  const asFirst = async () => {
    if ((await camera()) !== 'first') await s.press('Tab', 'Tab');
  };
  const asIso = async () => {
    if ((await camera()) !== 'iso') await s.press('Tab', 'Tab');
  };
  // `where` is how far behind the screens, and how far along the row from its middle, the owner stands.
  const stand = async ({ back, side = 0, turn = 0 }) => {
    const at = [mid[0] + normal[0] * back + row[0] * side, mid[1] + normal[2] * back + row[2] * side];
    await s.eval(`__office.teleport(${at[0]}, ${at[1]}, ${Math.atan2(-normal[0], -normal[2]) + turn})`);
    return at;
  };
  const settle = async () => {
    await s.sleep(2200);
    // The chat that opened for the nearest sitter closes, and stays closed while the owner stands still.
    await s.eval(`__office.store.setState({ selectedId: null })`);
    await s.sleep(600);
  };
  const configs = [
    { name: 'first-between', cam: 'first', back: 2.3, side: (along(sorted[0]) + along(sorted[1])) / 2 - alongMid },
    { name: 'first-close', cam: 'first', back: 1.8, side: (along(sorted[1]) + along(sorted[2] ?? sorted[1])) / 2 - alongMid },
    { name: 'iso-near', cam: 'iso', back: 2.6, side: Math.min(...sorted.map(along)) - alongMid + 0.4, zoom: 560 },
    { name: 'iso-closer', cam: 'iso', back: 2.6, side: Math.min(...sorted.map(along)) - alongMid + 0.4, zoom: 1100 },
    { name: 'iso-centre', cam: 'iso', back: 3.2, side: 0, zoom: 1000 },
  ];
  const wanted = process.env.SHOT_CONFIG;
  const todo = process.env.SHOT_PROBE ? configs : [configs.find((c) => c.name === (wanted ?? 'first-between'))];
  for (const cfg of todo) {
    const at = await stand(cfg);
    if (cfg.cam === 'first') await asFirst();
    else {
      await asIso();
      await s.eval(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: -${cfg.zoom} }))`);
    }
    await settle();
    if (cfg.cam === 'iso') {
      // Turn the overview in quarter turns to the one that shows the screens' faces.
      let bestTurn = { turns: 0, facing: await facing() };
      for (let turns = 1; turns <= 3; turns++) {
        await s.press('KeyQ', 'q');
        await s.sleep(1300);
        const n = await facing();
        if (n > bestTurn.facing) bestTurn = { turns, facing: n };
      }
      await s.press('KeyQ', 'q');
      for (let i = 0; i < bestTurn.turns; i++) await s.press('KeyQ', 'q');
      await s.sleep(1800);
    }
    console.log(`${cfg.name}: ${poses.length} screens in the row, the owner at ${at.map((v) => v.toFixed(1))}, ${await facing()} face the camera`);
    if (process.env.SHOT_PROBE) {
      const showing = await s.eval(`Object.values(window.__officeTerminals()).filter((t) => t.rows.some((r) => /Write\\(/.test(r))).length`);
      console.log(`${showing} monitors show a call`);
      await s.eval('document.activeElement?.blur()');
      await keep(s, `monitors-${cfg.name}`);
    }
  }
  if (process.env.SHOT_PROBE) return;

  // Wait until most of them show a call being made.
  const showing = () => s.eval(`Object.values(window.__officeTerminals()).filter((t) => t.rows.some((r) => /Write\\(/.test(r))).length`);
  const t1 = Date.now();
  while ((await showing()) < 3 && Date.now() - t1 < 120000) await s.sleep(300);
  await s.sleep(1200);
  assert((await showing()) >= 3, `${await showing()} monitors show a call as it is made`);
  await s.eval('document.activeElement?.blur()');
  await keep(s, 'monitors');
  console.log('rows on the first monitor:\n' + Object.values(await s.eval('window.__officeTerminals()'))[0].rows.join('\n'));
}
