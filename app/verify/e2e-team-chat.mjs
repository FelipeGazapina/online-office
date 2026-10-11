// The Chat app on the owner's Mac, at the desk and on the laptop. The conversations are what the real mailroom ended with in
// verify/team-chat-check.ts (verify/fixtures/team-chat.json): the owner gave the PO a goal, the PO split it over three teammates,
// two of them settled a detail between themselves, and the PO reported back. They reach the page through the renderer's own
// `mail` and `history` reducers. Real clicks and keys drive the app, and what it sends is tapped, so no agent runs.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-team-chat.mjs   Screenshots land in /tmp/office-shots.
import { readFileSync } from 'node:fs';
import { assert, sceneReady, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
// OFFICE_TEAM_CHAT_CLEAN=1 leaves the automated-test banner off the screenshots. The window still opens on a virtual display only.
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_TEST_PICK_FOLDER: repo, ...(process.env.OFFICE_TEAM_CHAT_CLEAN === '1' ? { OFFICE_TEST_RUN: '' } : {}) };

const fixture = JSON.parse(readFileSync(new URL('./fixtures/team-chat.json', import.meta.url), 'utf8'));
const store = (k) => `__office.store.getState().${k}`;
const laptop = (k) => `__officeLaptop.store.getState().${k}`;
const LONG = 120000;

const texts = (s, sel) => s.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`);
// A real click on an element that may sit outside the scrolled part of its list.
async function tap(s, selector, text = '') {
  await s.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.includes(${JSON.stringify(text)}))?.scrollIntoView({ block: 'center' })`);
  await s.sleep(100);
  return s.clickOn(selector, text);
}
const sent = (s, type) => s.eval(`window.__sent.filter((m) => m.type === ${JSON.stringify(type)})`);

// Two projects. Acme reports is the team of the fixture; Billing API has a team that has not talked yet.
const load = `(() => {
  const f = ${JSON.stringify(fixture)};
  const shift = Date.now() - 3 * 60_000 - f.generatedAt;
  const move = (m) => ({ ...m, at: m.at + shift });
  const now = Date.now();
  const block = (id, name, color, slot) => ({ id, name, cwd: '/tmp/' + id, color, slot });
  const person = (id, name, blockId, desk, status, role) => ({ id, name, provider: 'claude-code', role, blockId, seat: blockId + ':' + (role === 'orchestrator' ? 'po_desk' : 'bench_desk') + ':' + String(desk).padStart(2, '0'), status, activity: 'typing', model: 'claude-sonnet-5-5', permissions: { mode: 'inherit', alwaysAllow: [] }, subagents: [], hiredAt: now - 3600_000 });
  const ana = person('ana', 'Ana', 'b1', 1, { kind: 'working', task: 'PDF: render the report', startedAt: now - 120_000 });
  ana.subagents = [
    { id: 'sub-1', parentId: null, label: 'Read the report templates', startedAt: now - 90_000 },
    { id: 'sub-2', parentId: null, label: 'Write the PDF snapshot test', startedAt: now - 80_000 },
    { id: 'sub-3', parentId: 'sub-1', label: 'Measure rows per page', startedAt: now - 40_000 },
  ];
  const employees = [
    person('po', 'Pia', 'b1', 0, { kind: 'idle' }, 'orchestrator'), ana, person('bruno', 'Bruno', 'b1', 2, { kind: 'idle' }), person('cleo', 'Cleo', 'b1', 3, { kind: 'idle' }),
    person('zed', 'Zed', 'b2', 0, { kind: 'idle' }, 'orchestrator'), person('lia', 'Lia', 'b2', 1, { kind: 'idle' }),
  ];
  const company = __office.store.getState().company;
  __office.set({ company: { ...company, blocks: [block('b1', 'Acme reports', '#3d85c6', 0), block('b2', 'Billing API', '#81b29a', 1)], employees }, history: {}, pending: [], selectedId: null, chatSeen: {} });
  __office.apply({ type: 'mail', view: { ...f.view, tail: f.view.tail.map(move), open: f.view.open.map(move) } });
  for (const [convo, messages] of Object.entries(f.histories)) __office.apply({ type: 'history', convo, messages: messages.map(move), hasMore: false });
  return true;
})()`;

export default async (s) => {
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${store('company')}?.blocks.length === 1`);
  await sceneReady(s);
  await s.eval(`window.__sent = []; __office.tapSend((m) => window.__sent.push(m))`);
  await s.eval(load);

  // The desk: the owner sits at the Mac, and the desktop has a Chat tab and a Chat app.
  await s.eval('window.__office.teleport(-15.6, 5.2, Math.PI); window.__office.step(0.5)');
  assert(await s.eval(store('nearComputer')), 'the owner stands at the computer on their desk');
  await s.press('KeyF', 'f');
  await s.waitFor(store('portalMode'));
  const tabs = await texts(s, '.mac-tab');
  assert(tabs[0] === 'Home' && /^Chat\d+$/.test(tabs[1] ?? ''), `the desktop has a Home tab and a Chat tab carrying the unread count (${tabs.join(', ')})`);
  assert(await s.eval(`[...document.querySelectorAll('.mac-action b')].some((b) => b.innerText === 'Chat')`), 'Home has a Chat app');
  await s.shot('team-chat-0-desk-home');

  await s.clickOn('.mac-tab', 'Chat');
  await s.waitFor(`!!document.querySelector('.tc-app')`);
  assert((await texts(s, '.tc-ws')).join() === 'AC,BI', 'the rail lists both projects');
  assert((await texts(s, '.tc-side-head b'))[0] === 'Acme reports', 'the project whose team has talked opens first');
  const dms = await texts(s, '.tc-side .tc-row:not(.tc-pair) .tc-row-name');
  assert(dms.join() === 'Pia,Ana,Bruno,Cleo', `direct messages list the PO first, then the team by desk (${dms.join()})`);
  const pairs = await texts(s, '.tc-pair .tc-row-name');
  assert(pairs.length === 4 && ['Pia ↔ Ana', 'Pia ↔ Bruno', 'Pia ↔ Cleo', 'Ana ↔ Bruno'].every((p) => pairs.includes(p)), `each pair of teammates who talked has its own thread (${pairs.join(', ')})`);
  assert(!pairs.some((p) => p.includes('Cleo') && !p.includes('Pia')), 'pairs who never talked have no thread');
  assert((await s.eval(`document.querySelector('.tc-app').dataset.convo`)) === 'dm:po', 'the conversation with the PO is open first');
  const poFeed = await texts(s, '.tc-main .tc-msg');
  assert(poFeed[0]?.includes('You') && poFeed[0].includes('Add CSV export'), 'the owner\'s goal opens the thread with the PO');
  assert(poFeed.some((t) => /task for ana/i.test(t) && t.includes('API: GET /reports.csv')) && poFeed.some((t) => /task for bruno/i.test(t)) && poFeed.some((t) => /task for cleo/i.test(t)), `the pieces the PO handed out show as task cards, one per teammate (${poFeed.join(' || ')})`);
  assert(poFeed.some((t) => /task for ana/i.test(t) && t.includes('PDF: render the report') && t.includes('working')), 'the piece of the second goal is there too, still being worked on');
  assert(poFeed.some((t) => t.includes('CSV export shipped') && t.includes('done')), 'the PO\'s report back is there, settled done');
  assert(await s.eval(`!!document.querySelector('.tc-main #teamchat-input') && document.querySelector('#teamchat-input').placeholder === 'Give Pia a goal for the team'`), 'the composer gives the PO a goal for the team');
  assert(await s.eval(`document.querySelector('.tc-row[data-convo="dm:ana"] .tc-count')?.innerText === '1' && !document.querySelector('.tc-row[data-convo="dm:po"] .tc-count')`), 'Ana\'s unread line is counted, and the open conversation has none');
  assert(await s.eval(`document.querySelector('.tc-row[data-convo="dm:ana"] .tc-tag.sub')?.innerText === '⚡3'`), 'the sidebar shows Ana running three subagents');
  const loaded = (await sent(s, 'load_history')).map((m) => m.convo);
  assert(['dm:po', 'dm:ana', 'dm:bruno', 'dm:cleo', 'pair:ana:po', 'pair:ana:bruno', 'pair:bruno:cleo'].every((c) => loaded.includes(c)), 'opening the project loads every direct message and every pair thread of it');
  await s.shot('team-chat-1-desk-po');

  // The work under a task: the thread beside the conversation.
  await tap(s, '.tc-card', 'API: GET /reports.csv');
  await s.waitFor(`!!document.querySelector('.tc-thread')`);
  const chain = await texts(s, '.tc-thread .tc-msg');
  assert(chain[0]?.includes('API: GET /reports.csv') && chain.some((t) => t.includes('quoting test') && t.includes('done')), 'the thread of a task holds the request and the result');
  assert(chain.some((t) => t.includes('src/routes/reports.ts')), 'and the files the result names');
  const beside = await s.eval(`document.querySelector('.tc-thread').getBoundingClientRect().left >= document.querySelector('.tc-main').getBoundingClientRect().right - 1`);
  assert(beside, 'on the wide desk monitor the thread sits beside the conversation');
  await s.shot('team-chat-2-desk-thread');
  await s.clickOn('.tc-thread .tc-x');
  await s.waitFor(`!document.querySelector('.tc-thread')`);

  // A private thread between two teammates, which the owner reads along.
  await s.clickOn('.tc-pair', 'Ana ↔ Bruno');
  await s.waitFor(`document.querySelector('.tc-app').dataset.convo === 'pair:ana:bruno'`);
  const pairFeed = await texts(s, '.tc-main .tc-msg');
  const pairNames = await texts(s, '.tc-main .tc-msg-head b');
  assert(pairFeed.length === 4 && pairNames.length > 0 && pairNames.every((n) => n === 'Ana' || n === 'Bruno'), `the pair thread holds only what Ana and Bruno sent each other (${pairFeed.length} lines by ${pairNames.join(', ')})`);
  assert(pairFeed.some((t) => /question for bruno/i.test(t) && t.includes('Download file name')) && pairFeed.some((t) => t.includes('reports-YYYY-MM-DD.csv')), 'Ana\'s question and Bruno\'s answer are in it');
  assert(await s.eval(`!document.querySelector('.tc-main #teamchat-input') && !!document.querySelector('.tc-readonly')`), 'the owner reads along: no composer, a note, and a way to message either of them');
  await s.shot('team-chat-3-desk-pair');

  // A direct message to a teammate who is busy: the subagents they run, a queued message, then a steer.
  await s.clickOn('.tc-readonly .tc-btn', 'Message Ana');
  await s.waitFor(`document.querySelector('.tc-app').dataset.convo === 'dm:ana'`);
  const subs = await texts(s, '.tc-subagents .tc-sub');
  assert(subs.length === 3 && subs.includes('Read the report templates') && subs.includes('Measure rows per page'), `Ana's subagents show while they run (${subs.join(', ')})`);
  assert((await texts(s, '.tc-head .tc-status'))[0]?.includes('working on PDF: render the report'), 'her status says what she works on');
  await s.clickOn('#teamchat-input');
  await s.type('Keep the PDF under 2 MB, please.');
  await s.press('Enter');
  await s.waitFor(`window.__sent.some((m) => m.type === 'post' && m.to === 'ana')`);
  const queued = (await sent(s, 'post')).at(-1);
  assert(queued.as === 'request' && queued.text === 'Keep the PDF under 2 MB, please.', 'a message to a busy teammate queues as a request');
  assert((await texts(s, '.tc-msg.pending')).some((t) => t.includes('sending…')), 'it shows at once, as sending');
  await s.clickOn('.tc-compose .tc-btn', 'Steer instead');
  await s.type('Actually, use A4 pages.');
  await s.press('Enter');
  await s.waitFor(`window.__sent.filter((m) => m.type === 'post' && m.to === 'ana').length === 2`);
  const steer = (await sent(s, 'post')).at(-1);
  assert(steer.as === 'say' && steer.urgency === 'next', 'steering sends a say that reaches her running turn');
  await s.shot('team-chat-4-desk-ana');

  // An employee waiting on the owner is answered from the chat.
  await s.eval(`(() => { const c = ${store('company')}; __office.set({ company: { ...c, employees: c.employees.map((e) => e.id === 'bruno' ? { ...e, status: { kind: 'blocked_on_owner', task: 'Export button polish', question: { id: 'q-1', askedAt: Date.now() - 30_000, kind: 'ask', text: 'Should the Export button also offer PDF, or stay CSV only for now?', options: ['CSV only for now', 'Offer both'] } } } : e) } }); })()`);
  await s.clickOn('.tc-row[data-convo="dm:bruno"]');
  await s.waitFor(`!!document.querySelector('.tc-ask')`);
  assert(await s.eval(`document.querySelector('#teamchat-input').placeholder === 'Answer Bruno'`), 'the composer answers his question');
  await s.shot('team-chat-5-desk-question');
  await s.clickOn('.tc-ask .tc-btn', 'Offer both');
  const answer = (await sent(s, 'answer')).at(-1);
  assert(answer?.employeeId === 'bruno' && answer.questionId === 'q-1' && answer.text === 'Offer both', 'an option answers the question he is waiting on');

  // Another project: its own people, its own threads.
  await s.clickOn('.tc-ws[data-ws="b2"]');
  await s.waitFor(`document.querySelector('.tc-app').dataset.block === 'b2'`);
  assert((await texts(s, '.tc-side .tc-row:not(.tc-pair) .tc-row-name')).join() === 'Zed,Lia', 'switching project shows that project\'s people');
  assert((await s.eval(`document.querySelector('.tc-app').dataset.convo`)) === 'dm:zed' && (await texts(s, '.tc-pair')).length === 0, 'its PO opens first, and it has no team threads yet');
  assert((await sent(s, 'load_history')).some((m) => m.convo === 'pair:lia:zed'), 'and its conversations load');
  await s.shot('team-chat-6-desk-project');
  await s.clickOn('.tc-ws[data-ws="b1"]');
  await s.waitFor(`document.querySelector('.tc-app').dataset.block === 'b1'`);

  // Stand up. The laptop runs the same desktop, so the Chat app is there too.
  await s.eval('document.activeElement?.blur()');
  await s.press('KeyF', 'f');
  await s.waitFor(`!${store('portalMode')}`);
  await s.press('Escape');
  await s.waitFor(laptop('open'));
  await s.waitFor(laptop('ready'), LONG);
  await s.waitFor(`!!document.querySelector('.laptop-frame .tc-app')`);
  assert((await s.eval(`document.querySelector('.laptop-frame .tc-app').dataset.convo`)) === 'dm:po', 'the laptop opens on the same Chat app, on the PO');
  await s.sleep(400);
  await s.shot('team-chat-7-laptop-po');
  await s.clickOn('.laptop-frame .tc-pair', 'Pia ↔ Ana');
  await s.waitFor(`document.querySelector('.tc-app').dataset.convo === 'pair:ana:po'`);
  const poAna = await texts(s, '.laptop-frame .tc-main .tc-msg');
  const poAnaNames = await texts(s, '.laptop-frame .tc-main .tc-msg-head b');
  assert(poAna.some((t) => t.includes('Agree the column names with him directly')) && poAnaNames.every((n) => n === 'Pia' || n === 'Ana'), `on the laptop the PO and Ana have their own thread, with no Bruno in it (${poAnaNames.join(', ')})`);
  await tap(s, '.laptop-frame .tc-card', 'PDF: render the report');
  await s.waitFor(`!!document.querySelector('.laptop-frame .tc-thread')`);
  await s.sleep(300);
  await s.shot('team-chat-8-laptop-thread');
  const box = await s.eval(`(() => { const r = (q) => document.querySelector('.laptop-frame ' + q).getBoundingClientRect(); const a = r('.tc-app'), m = r('.tc-main'), t = r('.tc-thread'), h = r('.tc-main .tc-head h2'); return { app: a.right, main: m.right, left: t.left, right: t.right, w: t.width, title: h.width }; })()`);
  assert(Math.abs(box.app - box.right) < 2 && box.left < box.main - 100 && box.w > 200, `on the narrower laptop screen the thread lies over the conversation, inside the app (${JSON.stringify(box)})`);
  assert(box.title > 60, 'and the conversation keeps its title');
  await s.press('Escape');
  await s.waitFor(`!${laptop('open')}`);
  assert(!(await s.eval(`window.__sent.some((m) => m.type === 'post' && m.to !== 'ana')`)), 'nothing was sent but what the owner typed');
};
