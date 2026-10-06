// Helpers the end-to-end scripts share. They drive the built app through the CDP driver in cdp.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HAIKU = 'claude-haiku-4-5-20251001';

export const company = '__office.store.getState().company';
export const claude = `${company}.employees.find(e => e.provider === 'claude-code')`;
export const status = `${claude}.status`;
export const text = (sel) => `document.querySelector(${JSON.stringify(sel)})?.innerText.replace(/\\n+/g, ' | ')`;

export const assert = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log('ok:', msg);
};

// The first seconds of a page hold main-thread stalls of up to two seconds while the scene builds. A stall holds input back,
// and a screenshot taken inside one moves the pointer to twice its place for as long as it lasts, so a script that
// checks hover or timing starts after the last one. The owner stands at the origin until the first frame places them.
export async function sceneReady(s, quietMs = 2500) {
  await s.eval(`(() => {
    if (window.__lastStall !== undefined) return;
    window.__lastStall = 0;
    const seen = (list) => list.forEach((e) => (window.__lastStall = Math.max(window.__lastStall, e.startTime + e.duration)));
    const observer = new PerformanceObserver((list) => seen(list.getEntries()));
    observer.observe({ type: 'longtask', buffered: true });
    seen(observer.takeRecords());
  })()`);
  await s.waitFor(`performance.now() - window.__lastStall > ${quietMs} && (__office.state().owner.x !== 0 || __office.state().owner.z !== 0)`, 30000);
}

// A click acts on the first clickable thing at its pixel (a desk top, the new-project lot, a sign), so a hard-coded world
// point can sit under one and start no walk. This returns the floor point nearest the screen center whose pixel and the four
// pixels half a meter around it all raycast to bare floor, so a small camera shift keeps it floor. `min` and `max` bound the
// distance from the owner, `bends` the waypoints of the route to it, `margin` how far inside the viewport the pixel is.
export async function findFloorClick(s, { min = 0, max = 10, bends = 1, margin = 60 } = {}) {
  const found = await s.eval(`(() => {
    const { owner } = __office.state();
    const y = owner.floor * 3.2;
    const w = innerWidth;
    const h = innerHeight;
    const floorAt = (x, z) => {
      const at = __office.project(x, y, z);
      if (at.x < ${margin} || at.y < ${margin} || at.x > w - ${margin} || at.y > h - ${margin}) return null;
      if (document.elementFromPoint(at.x, at.y)?.tagName !== 'CANVAS') return null;
      const hit = __office.pick(at.x, at.y);
      if (hit.kind !== 'floor' || Math.hypot(hit.point.x - x, hit.point.z - z) > 0.25 || !hit.walk) return null;
      return { at, hit };
    };
    let best = null;
    for (let dx = -${max}; dx <= ${max}; dx += 0.5) {
      for (let dz = -${max}; dz <= ${max}; dz += 0.5) {
        const away = Math.hypot(dx, dz);
        if (away < ${min} || away > ${max}) continue;
        const x = owner.x + dx;
        const z = owner.z + dz;
        const here = floorAt(x, z);
        if (!here || here.hit.walk.waypoints < ${bends}) continue;
        if (![[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].every(([ax, az]) => floorAt(x + ax, z + az))) continue;
        const off = Math.hypot(here.at.x - w / 2, here.at.y - h / 2);
        if (!best || off < best.off) best = { x, z, off, away, waypoints: here.hit.walk.waypoints };
      }
    }
    return best;
  })()`);
  if (!found) throw new Error(`no floor point to click: none within ${min} to ${max} m of the owner is clear floor in the viewport with a route of ${bends} waypoints or more`);
  return found;
}

// A data dir for the app and a git repo for the block. realpath so the path equals the canonical one the app stores
// (macOS tmp is a symlink).
export function scratch() {
  const dataDir = mkdtempSync(join(tmpdir(), 'office-data-'));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'office-repo-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  return { dataDir, repo };
}

// The world only advances on animation frames, which stop while the window is hidden, so tests step it by hand.
export async function stepUntil(s, expr, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await s.eval(expr).catch(() => false)) return;
    await s.eval('__office.step(1)');
    await s.sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

export async function walkUpToClaude(s) {
  const id = await s.eval(`${claude}.id`);
  const a = await s.eval(`__office.state().avatars.find(a => a.id === '${id}')`);
  await s.eval(`__office.teleport(${a.x}, ${a.z + 1.1}, 0); __office.step(0.5)`);
  await s.sleep(300);
  const talkingTo = await s.eval('__office.state().talkingTo');
  if (talkingTo !== id) console.log('walk-up failed:', JSON.stringify({ wanted: id, talkingTo, owner: await s.eval('__office.state().owner'), avatar: a }));
  return talkingTo === id;
}

export async function typeToNearest(s, message) {
  await s.press('Enter');
  await s.type(message);
  await s.press('Enter');
}

// Block and hire go through the same message the UI sends. e2e-real.mjs covers the buttons and the folder picker.
export async function hireClaudeInBlock(s, repo) {
  await s.waitFor(`!!${company}`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${company}.blocks.length === 1`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${company}.blocks[0].id })`);
  await s.waitFor(`!!${claude}`);
  await s.eval('__office.step(25)');
}

// What the employee has said or done, oldest first, as the log panel shows it.
export const logLines = (s) => s.eval(`(__office.store.getState().logs[${claude}.id] ?? []).map(l => l.line)`);

// Called by the driver when a step fails, so a timeout comes with the state that explains it.
export async function diagnoseClaude(s, shotName) {
  const state = await s.eval(`JSON.stringify({ status: ${status}, activity: ${claude}.activity, logs: (__office.store.getState().logs[${claude}.id] ?? []).slice(-8).map(l => l.line) }, null, 1)`);
  console.log('employee at failure:', state);
  await s.shot(shotName);
}

// What a person reading company.mail.jsonl would work out, with no code of the app: for every turn that was handed a message
// of these request chains, the time from its first delivery to its turn_end, per person. An open turn counts to now.
export function wallTime(ledgerFile, rootIds, now = Date.now()) {
  const lines = existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean) : [];
  const rootOf = new Map();
  const turns = new Map();
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.t === 'post') rootOf.set(e.msg.id, e.msg.rootId);
    else if (e.t === 'deliver') {
      const turn = turns.get(e.turn) ?? { to: e.to, start: e.at, end: null, roots: new Set() };
      turns.set(e.turn, turn);
      for (const id of e.ids) turn.roots.add(rootOf.get(id));
    } else if (e.t === 'turn_end') {
      const turn = turns.get(e.turn);
      if (turn && turn.end === null) turn.end = e.at;
    }
  }
  const total = {};
  for (const turn of turns.values()) {
    if (![...turn.roots].some((r) => rootIds.includes(r))) continue;
    total[turn.to] = (total[turn.to] ?? 0) + ((turn.end ?? now) - turn.start);
  }
  return total;
}
