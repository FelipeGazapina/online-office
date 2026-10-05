// The chat panel against a fixture conversation, so no real agent is involved. Real pointer and key input drive the panel.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9343 OFFICE_DATA_DIR=$(mktemp -d) node verify/cdp.mjs verify/e2e-chat.mjs
// OFFICE_CHAT_PERF=1 runs the frame-time check instead: 15 employees, the chat open, and a bubble streaming for 10 s.
import { copyFileSync, mkdirSync } from 'node:fs';
import { assert, scratch } from './lib.mjs';

const perf = process.env.OFFICE_CHAT_PERF === '1';
const SHOTS = '/Users/feliperico/.claude/orchestrate/online-office-game/shots';
const { dataDir } = scratch();

export const env = {
  OFFICE_DATA_DIR: process.env.OFFICE_DATA_DIR ?? dataDir,
  OFFICE_START_LEVEL: '3',
  ...(perf ? { OFFICE_TEST_RUN: '' } : {}),
};

const q = (s, expr) => s.eval(expr);
const texts = (s, sel) => q(s, `[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText)`);
const count = (s, sel) => q(s, `document.querySelectorAll(${JSON.stringify(sel)}).length`);
const sent = (s) => q(s, 'window.__sent');
const selected = (s) => q(s, '__office.store.getState().selectedId');

async function keep(s, name) {
  const from = await s.shot(name);
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(from, `${SHOTS}/${name}.png`);
}

async function perfRun(s) {
  await s.waitFor('!!__office.store.getState().company');
  await s.resize(1440, 900);
  await s.eval('__office.injectFake(15)');
  await s.eval(`__office.set({ selectedId: 'fake-emp-0' })`);
  await s.waitFor(`!!document.querySelector('.cp-roster')`);
  await s.sleep(3000);
  // A live bubble: about 60 tokens a second for the whole measurement.
  await s.eval(`window.__tick = setInterval(() => __office.apply({ type: 'stream', employeeId: 'fake-emp-0', replyingTo: null, delta: 'word ' }), 16)`);
  const { deltas } = await s.eval('__office.measureFrames(10000)');
  await s.eval('clearInterval(window.__tick)');
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const long = deltas.filter((d) => d > 25).length / deltas.length;
  const result = { frames: deltas.length, fpsAvg: +(1000 / avg).toFixed(2), longFramePct: +(long * 100).toFixed(2) };
  console.log(JSON.stringify(result));
  assert(result.fpsAvg >= 59.5, `fpsAvg ${result.fpsAvg} >= 59.5 with 15 employees, the chat open and a bubble streaming`);
  assert(result.longFramePct <= 1, `${result.longFramePct}% of frames over 25 ms (limit 1%)`);
}

export default async (s) => {
  if (perf) return perfRun(s);
  await s.waitFor('!!__office.store.getState().company');
  await s.resize(1440, 900);
  // The driver cannot be a real owner here: record what the panel sends instead of letting main answer for fake people.
  await s.eval(`window.__sent = []; __office.tapSend((m) => window.__sent.push(m))`);
  const F = await s.eval('__office.loadMailFixture()');
  await s.waitFor(`!!document.querySelector('.cp-roster')`);
  await s.sleep(500);

  // Roster
  const rows = await texts(s, '.cp-person');
  assert(rows.length === 4, `the roster lists the PO and 3 employees (${rows.length})`);
  const row = (name) => rows.find((r) => r.split('\n')[1] === name);
  assert(rows[0].split('\n')[1] === 'Maya' && rows[0].includes('PO'), 'the PO is pinned first with a PO badge');
  assert(row('Ana').includes('typing…'), 'Ana shows typing… while her bubble streams');
  assert(row('Bruno').includes('idle'), 'Bruno shows idle');
  assert(/working on Round 2|working on /.test(row('Caio')), 'Caio shows what he works on');
  assert(row('Caio').includes('3 queued'), 'Caio shows how many wait behind his turn');
  assert(/Bump the lint rules/.test(rows[0]) && /\d\d:\d\d/.test(rows[0]), 'the PO row shows a last message preview and its time');
  assert((await count(s, '.cp-av')) >= 4, 'each row has an avatar color dot');

  // The PO thread
  assert((await texts(s, '.thread .msg.owner')).some((t) => t.includes('Add CSV export to the reports page')), 'the owner request is a right-hand bubble');
  assert((await texts(s, '.thread .msg.employee')).some((t) => t.startsWith('On it.')), 'the PO acknowledgement is a bubble');
  assert((await count(s, '.cp-card[data-req="fx-m3"] .cp-live.streaming')) === 1, 'the live delegation card has a streaming live dot');
  assert((await texts(s, '.cp-card[data-req="fx-m4"]'))[0].includes('done') && (await count(s, '.cp-card[data-req="fx-m4"] .cp-live')) === 0, 'the finished delegation card shows done and no live dot');
  assert((await count(s, '.cp-card:not(.cp-gauntlet)')) === 2, 'two delegation cards');
  assert((await texts(s, '.cp-note')).some((t) => t.includes('Maya hired Bruno')), 'the hire is a centered system line');
  const tracker = (await texts(s, '.cp-gauntlet'))[0];
  assert(/Round 2 of 6/.test(tracker) && /Critic failed it, 2 findings/.test(tracker), `the gauntlet tracker shows round 2 and the critic verdict (${tracker.replace(/\n+/g, ' | ')})`);
  assert((await count(s, '.cp-pip.fail')) === 1 && (await count(s, '.cp-pip.run')) === 1, 'with one failed and one running round pip');
  await keep(s, 'w2-roster');

  // Sub-threads
  await s.clickOn('.cp-card[data-req="fx-m4"]', 'UI: Export button');
  await s.waitFor(`!!document.querySelector('.cp-back')`);
  assert((await texts(s, '.thread .msg.employee')).some((t) => t.includes('Button is on /reports')), 'the done card opens its sub-thread with the reply');
  assert((await count(s, '.cp-auto')) === 1, 'an auto-settled reply carries a subtle auto tag');
  await s.clickOn('.cp-back', '');
  await s.waitFor(`!document.querySelector('.cp-back')`);
  await s.clickOn('.cp-card[data-req="fx-m3"]', 'Backend');
  await s.waitFor(`!!document.querySelector('.cp-back')`);
  assert((await texts(s, '.thread .msg.employee')).some((t) => t.includes('Starting with the route handler')), 'clicking the live card opens its sub-thread');
  assert((await count(s, '.cp-streaming .cp-caret')) === 1 && (await texts(s, '.cp-streaming'))[0].includes('Writing the quoting test'), 'where the live reply streams with a typing caret');
  assert((await q(s, `document.querySelector('.cp-target b').innerText`)) === 'Ana', 'and the composer aims at the assignee');
  await keep(s, 'w2-subthread');
  await s.press('Escape');
  await s.waitFor(`!document.querySelector('.cp-back')`);
  assert((await selected(s)) === F.po, 'Esc in a sub-thread goes back one step');

  // Queued
  await s.clickOn('.cp-person', 'Caio');
  await s.waitFor(`document.querySelector('.cp-head h2')?.innerText === 'Caio'`);
  assert((await texts(s, '.cp-chip.queued')).includes('queued · 2 ahead'), 'a request to a busy person shows queued · 2 ahead');
  assert((await count(s, '.cp-undo')) === 1, 'with a way to cancel it');
  await keep(s, 'w2-thread');

  // Composer
  assert((await q(s, `document.activeElement?.id`)) === 'drawer-input', 'a thread opens with the composer focused');
  await s.type('Also mention the date format');
  await q(s, `window.__sent.length = 0`);
  await q(s, `(() => { const t = document.getElementById('drawer-input'); const e = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }); t.dispatchEvent(e); window.__shiftPrevented = e.defaultPrevented; })()`);
  assert(!(await q(s, 'window.__shiftPrevented')) && (await sent(s)).length === 0, 'Shift+Enter leaves the line break alone and sends nothing');
  await s.press('Enter');
  await s.waitFor(`window.__sent.length === 1`);
  const post = (await sent(s))[0];
  assert(post.type === 'post' && post.to === F.caio && post.as === 'request' && post.text === 'Also mention the date format' && post.clientId, `Enter posts to the selected person (${JSON.stringify(post)})`);
  assert((await q(s, `document.getElementById('drawer-input').value`)) === '', 'and clears the composer');
  assert((await texts(s, '.cp-chip.sending')).length === 1, 'the message shows at once as sending');
  assert((await texts(s, '.thread .msg.owner')).at(-1) === 'Also mention the date format', 'as the newest owner bubble');

  await s.clickOn('.cp-target', 'To');
  await s.waitFor(`document.querySelector('.cp-target b').innerText === 'PO'`);
  await s.type('Please re-plan the export');
  await s.press('Enter');
  await s.waitFor(`window.__sent.length === 2`);
  const toPo = (await sent(s))[1];
  assert(toPo.type === 'post' && toPo.to === 'po' && toPo.blockId === F.block && toPo.as === 'request', `one click on the target pill sends to the PO (${JSON.stringify(toPo)})`);

  // Keyboard
  await s.press('Escape');
  await s.waitFor(`__office.store.getState().selectedId === null`);
  assert(true, 'Esc closes the panel');
  await q(s, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true, cancelable: true }))`);
  await s.waitFor(`document.activeElement?.id === 'drawer-input'`);
  assert((await selected(s)) === F.po, 'Cmd+K opens the panel on the PO with the composer focused');
  await q(s, `document.activeElement.blur()`);
  await s.press('Enter');
  await s.waitFor(`document.activeElement?.id === 'drawer-input'`);
  assert(true, 'Enter from the scene focuses the thread composer');

  // Streaming
  const before = await q(s, 'JSON.stringify(__office.renders)');
  await q(s, `__office.apply({ type: 'stream', employeeId: '${F.po}', replyingTo: null, delta: 'x' })`);
  await s.sleep(300);
  const mid = JSON.parse(await q(s, 'JSON.stringify(__office.renders)'));
  const expected = 'x' + Array.from({ length: 199 }, (_, i) => `[${i}]`).join('');
  await q(s, `(() => { for (let i = 0; i < 199; i++) __office.apply({ type: 'stream', employeeId: '${F.po}', replyingTo: null, delta: '[' + i + ']' }); })()`);
  await s.sleep(300);
  const after = JSON.parse(await q(s, 'JSON.stringify(__office.renders)'));
  const live = (await texts(s, `.cp-streaming[data-stream="${F.po}"]`))[0];
  assert(live === expected, `200 deltas render in the live bubble (${live?.length} of ${expected.length} chars)`);
  const changed = Object.keys(after).filter((k) => after[k] !== mid[k]);
  assert(changed.length === 1 && changed[0] === 'stream', `and only the live bubble redrew while they streamed (${changed.join(', ') || 'nothing'}; ${after.stream - mid.stream} renders for 199 deltas)`);
  await q(s, `__office.apply({ type: 'stream', employeeId: '${F.po}', replyingTo: null, delta: '', done: true })`);
  await s.waitFor(`!document.querySelector('.cp-streaming[data-stream="${F.po}"]')`);
  assert(true, 'a closed stream leaves no bubble behind');
  void before;
};
