// How long the owner waits for the first visible bubble: ms from the post leaving the renderer to the first streamed token
// of the employee's answer in the store. Two people on one block with real Claude sessions: a warm employee and the PO.
// The PO's cold first message (right after hire) is reported apart from its warm trials. Each trial also prints the hops
// the main process traced (OFFICE_TRACE), as ms since the post, so the time can be placed. The window is hidden in a test
// run, so the paint after the store update is not measured.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9345 OFFICE_DATA_DIR=$(mktemp -d) OFFICE_CLAUDE_MODEL=claude-haiku-4-5-20251001 node verify/cdp.mjs verify/e2e-first-reply.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAIKU, assert, company } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'w4-data-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'w4-repo-')));
const git = (...args) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', ...args], { cwd: repo, stdio: 'pipe' });
git('init', '-q');
cpSync(join(HERE, 'fixtures', 'company-project'), repo, { recursive: true });
git('add', '-A');
git('commit', '-q', '-m', 'initial');

export const env = {
  OFFICE_DATA_DIR: process.env.OFFICE_DATA_DIR ?? dataDir,
  OFFICE_START_LEVEL: '3',
  OFFICE_TRACE: '1',
  OFFICE_CLAUDE_MODEL: process.env.OFFICE_CLAUDE_MODEL ?? HAIKU,
};

const TARGET_P50 = 2000;
const TARGET_MAX = 3000;
const TRIALS = 5;
const COLD_TRIALS = Number(process.env.FIRST_REPLY_COLD_TRIALS ?? 5);
// The owner takes a few seconds between a hire and the first message, and a session warmed at hire uses them.
const GOAL = 'Add a slugify(text) function in src/slug.js (ES module, named export) with tests in test/slug.test.js, and a "slugify" section in README.md documenting it. The bar: node --test passes and slugify handles accents, spaces, punctuation and empty input. Split the work between people, get the function reviewed against the bar, and tell me when it is all done.';
const HIRE_TO_FIRST_MESSAGE_MS = 8000;
const KEY_HOPS = ['post_received', 'deliver', 'ack_start', 'ack_first_delta', 'assign', 'spawn', 'push', 'system_init', 'event_message_start', 'first_delta', 'first_text'];

const p50 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

export default async (s) => {
  await s.waitFor(`!!${company}`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${company}.blocks.length === 1`);
  const blockId = await s.eval(`${company}.blocks[0].id`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Pia', role: 'orchestrator' })`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Eli' })`);
  await s.waitFor(`${company}.employees.length === 2`);
  await s.eval('__office.step(25)');
  await s.sleep(HIRE_TO_FIRST_MESSAGE_MS);
  const who = await s.eval(`${company}.employees.map((e) => ({ id: e.id, name: e.name }))`);
  const idOf = (name) => who.find((e) => e.name === name).id;

  await s.eval(`(() => {
    window.__firstReply = (id, text, clientId) => new Promise((resolve) => {
      let done = false;
      const finish = (kind) => { if (done) return; done = true; unsub(); resolve({ start: t0, end: performance.timeOrigin + performance.now(), kind }); };
      const st0 = __office.store.getState();
      const seen = new Set(st0.mail.tail.map((m) => m.id));
      const stale = st0.streams[id];
      const unsub = __office.store.subscribe((st) => {
        if (st.streams[id] && st.streams[id] !== stale) finish('stream');
        else if (st.mail.tail.some((m) => !seen.has(m.id) && m.from === id && m.kind === 'say')) finish('say');
      });
      const t0 = performance.timeOrigin + performance.now();
      window.office.send({ type: 'post', to: id, clientId, as: 'request', text });
      setTimeout(() => finish('timeout'), 60000);
    });
  })()`);

  const traces = () =>
    s.mainLogs
      .join('\n')
      .split('\n')
      .flatMap((l) => {
        const m = /^\[trace\] (\d+) (\S+) (\S+)$/.exec(l.trim());
        return m ? [{ at: Number(m[1]), who: m[2], hop: m[3] }] : [];
      });
  const idle = (id) => s.waitFor(`${company}.employees.find((e) => e.id === ${JSON.stringify(id)}).status.kind === 'idle' && __office.store.getState().mail.open.length === 0`, 180000);

  const trial = async (label, id, clientId, text, settle = true) => {
    const r = await s.eval(`window.__firstReply(${JSON.stringify(id)}, ${JSON.stringify(text)}, ${JSON.stringify(clientId)})`);
    const hops = new Map();
    for (const t of traces()) if ((t.who === id || t.who === clientId) && t.at >= r.start - 50 && !hops.has(t.hop)) hops.set(t.hop, t.at);
    const rel = KEY_HOPS.filter((h) => hops.has(h)).map((h) => `${h} ${Math.round(hops.get(h) - r.start)}`).join(', ');
    const ms = Math.round(r.end - r.start);
    console.log(`${label}: ${ms} ms to the first ${r.kind} | hops since post: ${rel}`);
    if (settle) await idle(id);
    return { ms, kind: r.kind };
  };

  const report = (label, trials) => {
    const ms = trials.map((t) => t.ms);
    console.log(`${label} first bubble ms ${JSON.stringify(ms)}: p50 ${p50(ms)}, max ${Math.max(...ms)} (target p50 < ${TARGET_P50}, max < ${TARGET_MAX})`);
    assert(trials.every((t) => t.kind !== 'timeout'), `${label}: every trial saw a bubble`);
  };

  const task = (i, who) => `Create a file named ${who}-${i}.txt in the project root containing the single word hello, then tell me it is done.`;
  const eli = idOf('Eli');
  const pia = idOf('Pia');
  // A cold trial is the first message of a brand-new session, the owner a few seconds after the hire or the fresh session.
  const cold = async (label, id, i, who) => {
    await s.eval(`window.office.send({ type: 'fresh_session', employeeId: ${JSON.stringify(id)} })`);
    await s.sleep(HIRE_TO_FIRST_MESSAGE_MS);
    return trial(label, id, `${who}-cold-${i}`, task(`cold${i}`, who));
  };
  const employeeCold = [];
  const employee = [];
  const poCold = [];
  const po = [];
  for (let i = 1; i <= COLD_TRIALS; i++) employeeCold.push(await cold(`employee cold ${i}`, eli, i, 'eli'));
  for (let i = 1; i <= TRIALS; i++) employee.push(await trial(`employee warm ${i}`, eli, `eli-${i}`, task(i, 'eli')));
  for (let i = 1; i <= COLD_TRIALS; i++) poCold.push(await cold(`PO cold ${i}`, pia, i, 'po'));
  for (let i = 1; i <= TRIALS; i++) po.push(await trial(`PO warm ${i}`, pia, `pia-${i}`, task(i, 'po')));
  // The company scenario's goal to a PO with a fresh session. Only the first bubble is timed, then both sessions restart.
  const poGoal = [];
  for (let i = 1; i <= COLD_TRIALS; i++) {
    await s.eval(`window.office.send({ type: 'fresh_session', employeeId: ${JSON.stringify(eli)} })`);
    await s.eval(`window.office.send({ type: 'fresh_session', employeeId: ${JSON.stringify(pia)} })`);
    await s.sleep(HIRE_TO_FIRST_MESSAGE_MS);
    poGoal.push(await trial(`PO goal cold ${i}`, pia, `pia-goal-${i}`, GOAL, false));
  }
  report('PO goal cold', poGoal);
  report('employee cold', employeeCold);
  report('employee warm', employee);
  report('PO cold', poCold);
  report('PO warm', po);
};
