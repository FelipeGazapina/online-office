// Helpers the end-to-end scripts share. They drive the built app through the CDP driver in cdp.mjs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
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
