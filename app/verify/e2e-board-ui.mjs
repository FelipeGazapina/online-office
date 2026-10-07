// The task board, driven the way the owner drives it: real mouse and key events through CDP, and every claim read from the
// store's snapshot or the page. Boards and tabs, the inline composer (title, notes, assignee and priority; Enter, Cmd+Enter,
// Create more and Esc; mouse and keyboard alone; a task made with an assignee starts at once), a drag between columns, the
// detail (title, notes, priority, assigning to the PO and to an employee, hours per person), a CronoSpark board from a fake
// server with its origin link, the sync button and the error state, keyboard use, and F at the 3D board. Last comes a Linear
// board against a fake Linear (board-linear-flow.mjs): assignee, cycle, limit, hiding Done, and a restart. Three real haiku
// runs: a task the composer hands to the PO, one the detail hands to the PO, and one for an employee whose timer must tick
// on the card while they work.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-board-ui.mjs
// OFFICE_BOARD_WAIT_MIN caps each agent run (default 6).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAIKU, assert, wallTime } from './lib.mjs';
import { startFakeCronoSpark } from './fake-cronospark.ts';
import { linearWorld, startFakeLinear, TOKEN as LINEAR_TOKEN } from './fake-linear.ts';
import { linearBoardFlow } from './board-linear-flow.mjs';

const WAIT_MS = Number(process.env.OFFICE_BOARD_WAIT_MIN ?? 6) * 60_000;

const dataDir = mkdtempSync(join(tmpdir(), 't2-data-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 't2-repo-')));
const git = (...args) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', ...args], { cwd: repo, stdio: 'pipe' }).toString();
git('init', '-q');
writeFileSync(join(repo, 'README.md'), '# scratch\n');
git('add', '-A');
git('commit', '-q', '-m', 'initial');

const fake = await startFakeCronoSpark({
  tasks: [
    { _id: 'fake-task-701', code: 'CS-701', title: 'Write the changelog entry', status: 'pending', priority: 2, url: 'https://app.cronospark.example/tasks/701' },
    { _id: 'fake-task-702', code: 'CS-702', title: 'Review the pricing page copy', status: 'in-progress', priority: 3, url: 'https://app.cronospark.example/tasks/702' },
  ],
});

const linearWorldData = linearWorld();
const linear = await startFakeLinear(linearWorldData);

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '5',
  OFFICE_CLAUDE_MODEL: HAIKU,
  CRONOSPARK_MCP_URL: fake.url,
  CRONOSPARK_MCP_API_KEY: 'fake-key',
  CRONOSPARK_MCP_USER_ID: 'fake-user',
  LINEAR_MCP_TOKEN: LINEAR_TOKEN,
  LINEAR_MCP_URL: linear.url,
  OFFICE_TASK_BOARD_FIXTURE: '',
};

const state = '__office.store.getState()';
const taskByTitle = (title) => `${state}.tasks.find((t) => t.title === ${JSON.stringify(title)})`;
const ledgerFile = join(dataDir, 'company.mail.jsonl');

export const diagnose = async (s) => {
  console.log('tasks at failure:', JSON.stringify(await s.eval(`${state}.tasks.map((t) => ({ title: t.title, stage: t.stage, board: t.boardId, assignees: t.assignees, runs: t.runs.length }))`).catch(() => '?')));
  console.log('sent at failure:', JSON.stringify(await s.eval('window.__sent?.slice(-12)').catch(() => '?')));
  await s.shot('t2-failure').catch(() => {});
};

// Nobody is at the keyboard, so every employee runs in yolo mode and a permission card raised before the switch is answered.
async function unattended(s) {
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, mode: e.permissions.mode, q: e.status.kind === 'blocked_on_owner' ? e.status.question : null }))`);
  for (const p of people) {
    if (p.mode !== 'yolo') await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(p.id)}, mode: 'yolo' })`);
    if (p.q?.kind === 'permission') await s.eval(`window.office.send({ type: 'answer', employeeId: ${JSON.stringify(p.id)}, questionId: ${JSON.stringify(p.q.id)}, text: 'Yes' })`);
  }
}

async function settled(s, title, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    await unattended(s);
    const t = await s.eval(`(() => { const t = ${taskByTitle(title)}; const time = ${state}.taskTime[t.id]; return { stage: t.stage, out: t.lastOutcome?.outcome, running: time?.running.length ?? 0 }; })()`);
    if (t.out && t.running === 0) return t;
    await s.sleep(2500);
  }
  throw new Error(`${label}: no settled run after ${Math.round(WAIT_MS / 1000)} s`);
}

export default async (s, { launch }) => {
  await s.resize(1440, 900);
  await s.waitFor('!!window.__office && !!window.office');
  await s.eval('window.__sent = []; __office.tapSend((m) => { window.__sent.push(m); window.office.send(m); })');
  const sent = (type) => s.eval(`window.__sent.filter((m) => m.type === ${JSON.stringify(type)})`);
  const sentSince = async (n) => s.eval(`window.__sent.slice(${n})`);
  const sentCount = () => s.eval('window.__sent.length');

  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)}, name: 'Checkout' })`);
  await s.waitFor(`${state}.company.blocks.length === 1`);
  const blockId = await s.eval(`${state}.company.blocks[0].id`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Pia', role: 'orchestrator' })`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Ana' })`);
  await s.waitFor(`${state}.company.employees.length === 2`);
  const pia = await s.eval(`${state}.company.employees.find((e) => e.name === 'Pia').id`);
  const ana = await s.eval(`${state}.company.employees.find((e) => e.name === 'Ana').id`);
  await unattended(s);

  // ── the HUD entry and the first board ──
  await s.clickOn('[data-testid=tasks-chip]');
  await s.waitFor("!!document.querySelector('[data-testid=task-board]')");
  assert(await s.eval("document.querySelectorAll('[role=tab]').length === 1 && document.querySelector('[role=tab]').innerText.includes('Quick tasks')"), 'the Tasks chip opens the block\'s board with its one Quick tasks tab');
  assert(await s.eval("[...document.querySelectorAll('.tb-col')].map((c) => c.dataset.stage).join() === 'todo,doing,review,done'"), 'the board has four columns: todo, doing, review, done');
  assert(await s.eval("!document.querySelector('[aria-label=\"Sync this board\"]') && document.body.innerText.includes('Saved on this Mac')"), 'a quick board has no sync button and no source setup');
  const quickId = await s.eval(`${state}.boards.find((b) => b.kind === 'quick').id`);

  // ── inline create: Enter makes the card, Cmd+Enter or Create more keeps the composer for the next, Esc cancels ──
  const inTitle = "document.activeElement?.dataset.testid === 'composer-title'";
  const composerOpen = "!!document.querySelector('[data-testid=composer]')";
  await s.clickOn('[aria-label="Add a task to Todo"]');
  await s.waitFor(inTitle);
  assert(await s.eval("document.querySelector('[data-testid=composer-stage]').innerText.trim() === 'Todo' && document.querySelector('[data-testid=composer-hint]').innerText.includes('Enter creates')"), 'the composer says which column it makes the card in and what Enter does');
  const reading = await s.eval(`(() => {
    const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
    const back = (el) => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!/, 0\\)$|transparent/.test(c)) return rgb(c); } return [255, 255, 255]; };
    const one = (sel, pseudo) => { const el = document.querySelector(sel); const st = getComputedStyle(el, pseudo); return { size: parseFloat(st.fontSize), ratio: ratio(rgb(st.color), back(el)) }; };
    return { hint: one('[data-testid=composer-hint] span'), key: one('[data-testid=composer-hint] kbd'), placeholder: one('[data-testid=composer-title]', '::placeholder'), pill: one('[data-testid=pill-assignee] .tb-pill-text'), clipped: [...document.querySelectorAll('[data-testid=composer] *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible' || getComputedStyle(el).textOverflow === 'ellipsis').length };
  })()`);
  console.log('composer text:', JSON.stringify(reading));
  assert(reading.hint.size >= 12 && reading.hint.ratio >= 4.5 && reading.key.size >= 11 && reading.key.ratio >= 4.5, `the hint reads at ${reading.hint.size}px with contrast ${reading.hint.ratio.toFixed(1)}:1 and its keys ${reading.key.ratio.toFixed(1)}:1 (AA is 4.5:1)`);
  assert(reading.placeholder.ratio >= 4.5 && reading.pill.ratio >= 4.5 && reading.clipped === 0, `the placeholder (${reading.placeholder.ratio.toFixed(1)}:1) and the empty pill (${reading.pill.ratio.toFixed(1)}:1) read, and nothing in the composer is cut off`);

  const mark0 = await sentCount();
  await s.type('Draft the launch checklist');
  await s.press('Enter');
  await s.waitFor(`!!${taskByTitle('Draft the launch checklist')}`);
  assert(await s.eval(`(() => { const t = ${taskByTitle('Draft the launch checklist')}; return t.stage === 'todo' && t.origin.kind === 'manual' && t.boardId === ${JSON.stringify(quickId)}; })()`), 'Enter in the Todo composer creates a manual todo task on this board');
  const bare = (await sentSince(mark0)).filter((m) => m.type === 'create_task');
  assert(bare.length === 1 && JSON.stringify(bare[0]) === JSON.stringify({ type: 'create_task', boardId: quickId, title: 'Draft the launch checklist', stage: 'todo' }), 'a bare title sends a bare create_task: no assignee, no priority, no notes');
  await s.waitFor(`!${composerOpen}`);
  assert(await s.eval("!!document.querySelector('[data-testid=task-board]')"), 'Enter makes the task and puts the composer away');

  await s.clickOn('[aria-label="Add a task to Todo"]');
  await s.waitFor(inTitle);
  await s.type('Book the demo room');
  await s.chord('Enter', 4);
  await s.waitFor(`!!${taskByTitle('Book the demo room')}`);
  await s.waitFor(`${inTitle} && document.querySelector('[data-testid=composer-title]').value === ''`);
  assert(await s.eval(composerOpen), 'Cmd+Enter makes the task and keeps the composer open and empty, with focus in the title');

  await s.clickOn('[data-testid=create-more]');
  assert(await s.eval("document.querySelector('[data-testid=create-more]').getAttribute('aria-checked') === 'true' && document.querySelector('[data-testid=composer-hint]').innerText.includes('Enter creates another')"), 'the Create more switch turns on and the hint now says Enter creates another');
  await s.clickOn('[data-testid=composer-title]');
  await s.type('Send the invite');
  await s.press('Enter');
  await s.waitFor(`!!${taskByTitle('Send the invite')}`);
  await s.waitFor(inTitle);
  await s.type('Confirm the room');
  await s.press('Enter');
  await s.waitFor(`!!${taskByTitle('Confirm the room')}`);
  assert(await s.eval(`${composerOpen} && ${inTitle}`), 'with Create more on, Enter makes the task and the composer stays for the next one');
  const before = await s.eval(`${state}.tasks.length`);
  await s.type('discard me');
  await s.press('Escape');
  await s.waitFor(`!${composerOpen}`);
  await s.sleep(500);
  assert((await s.eval(`${state}.tasks.length`)) === before && !(await s.eval(`${state}.tasks.some((t) => t.title === 'discard me')`)), 'Esc cancels the composer and creates nothing');
  assert(await s.eval("!!document.querySelector('[data-testid=task-board]')"), 'Esc in the composer closes only the composer, not the board');

  await s.clickOn('[aria-label="Add a task to Todo"]');
  await s.waitFor(inTitle);
  await s.clickOn('.tb-stats');
  await s.waitFor(`!${composerOpen}`);
  ok('leaving an empty composer closes it');
  await s.clickOn('[aria-label="Add a task to Todo"]');
  await s.waitFor(inTitle);
  await s.type('half a thought');
  await s.clickOn('.tb-stats');
  await s.sleep(300);
  assert(await s.eval(`${composerOpen} && document.querySelector('[data-testid=composer-title]').value === 'half a thought'`), 'leaving a composer with words in it keeps them');
  await s.clickOn('[data-testid=composer-title]');
  await s.press('Escape');
  await s.waitFor(`!${composerOpen}`);

  // ── inline create in another column ──
  await s.clickOn('[aria-label="Add a task to In Review"]');
  await s.waitFor(inTitle);
  assert(await s.eval("document.querySelector('[data-testid=composer-stage]').innerText.trim() === 'In Review'"), 'the composer in the In Review column says In Review');
  await s.type('Check the staging deploy');
  await s.press('Enter');
  await s.waitFor(`${taskByTitle('Check the staging deploy')}?.stage === 'review'`);
  assert(await s.eval("!!document.querySelector('.tb-col[data-stage=review] .tb-card')?.innerText.includes('Check the staging deploy')"), 'a task made in the In Review column is created there and shown there');
  await s.waitFor(`!${composerOpen}`);

  // ── drag between columns, with the ghost and the drop outline in between ──
  const from = await s.center('.tb-card', 'Book the demo room');
  const to = await s.center('.tb-col[data-stage="doing"] .tb-col-body');
  const mark = await sentCount();
  await s.mouse('mouseMoved', from.x, from.y);
  await s.mouse('mousePressed', from.x, from.y, 1);
  for (let i = 1; i <= 10; i++) await s.mouse('mouseMoved', from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10, 1);
  await s.waitFor("!!document.querySelector('.tb-ghost') && !!document.querySelector('.tb-col.over[data-stage=doing]')");
  assert(await s.eval("document.querySelector('.tb-card.dragging')?.innerText.includes('Book the demo room')"), 'mid-drag, a ghost follows the pointer, the source card dims and the column under it is outlined');
  await s.mouse('mouseReleased', to.x, to.y);
  await s.waitFor(`${taskByTitle('Book the demo room')}?.stage === 'doing'`);
  const moves = (await sentSince(mark)).filter((m) => m.type === 'update_task');
  assert(moves.length === 1 && moves[0].stage === 'doing' && moves[0].taskId === (await s.eval(`${taskByTitle('Book the demo room')}.id`)), 'the drop sends one update_task with the new stage');
  assert(await s.eval("!!document.querySelector('.tb-col[data-stage=doing] .tb-card')?.innerText.includes('Book the demo room') && !document.querySelector('.tb-ghost')"), 'the card now sits in the In Progress column and the ghost is gone');
  assert(!(await s.eval("!!document.querySelector('[data-testid=task-detail]')")), 'a drag does not open the card');
  await s.drag(await s.center('.tb-card', 'Check the staging deploy'), await s.center('.tb-col[data-stage="done"] .tb-col-body'));
  await s.waitFor(`${taskByTitle('Check the staging deploy')}?.stage === 'done'`);
  ok('a second drag, review to done, lands too');

  // ── detail: title, notes ──
  await s.clickOn('.tb-card', 'Draft the launch checklist');
  await s.waitFor("!!document.querySelector('[data-testid=task-detail] .tb-title-input')");
  await s.eval("document.querySelector('.tb-title-input').select()");
  await s.type('Draft the launch checklist v2');
  await s.press('Enter');
  await s.waitFor(`!!${taskByTitle('Draft the launch checklist v2')}`);
  ok('editing the title and pressing Enter saves it');
  await s.clickOn('.tb-notes');
  await s.type('Include the rollback steps.');
  await s.clickOn('.tb-dock-head');
  await s.waitFor(`${taskByTitle('Draft the launch checklist v2')}.notes === 'Include the rollback steps.'`);
  ok('typing notes and leaving the field saves them');
  assert(await s.eval("document.querySelector('.tb-card.selected')?.innerText.includes('launch checklist v2')"), 'the opened card is marked selected on the board');
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=task-detail]')");
  assert(await s.eval("!!document.querySelector('[data-testid=task-board]')"), 'Esc closes the detail first and the board stays');

  // ── a CronoSpark board from a fake server, made and set up from the board ──
  await s.clickOn('[aria-label="New board"]');
  await s.waitFor("!!document.querySelector('.tb-newboard')");
  await s.type('Sprint');
  assert(await s.eval("[...document.querySelectorAll('.tb-kindcard')].map((k) => k.dataset.kind).join() === 'feature,bug,quick'"), 'the new board offers feature, bug and quick');
  await s.clickOn('.tb-kindcard[data-kind=feature]');
  await s.clickOn('.tb-newboard button[type=submit]');
  await s.waitFor(`${state}.boards.some((b) => b.name === 'Sprint' && b.kind === 'feature')`);
  await s.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('Sprint')");
  ok('creating a board adds its tab and selects it');
  const sprint = await s.eval(`${state}.boards.find((b) => b.name === 'Sprint')`);
  assert(await s.eval("!!document.querySelector('[data-testid=no-sources]')"), 'a feature board with no source says so and offers to set one up');
  await s.clickOn('[data-testid=no-sources] button');
  await s.waitFor("!!document.querySelector('[data-testid=board-settings]')");
  await s.clickOn('.tb-settings .tb-btn', 'CronoSpark');
  await s.waitFor("!!document.querySelector('.tb-source input')");
  await s.clickOn('.tb-source input[aria-label=Project]');
  await s.type('fake-project');
  await s.clickOn('.tb-settings .tb-btn.primary', 'Save and sync');
  await s.waitFor(`${state}.boardSync[${JSON.stringify(sprint.id)}]?.kind === 'ready' && ${state}.tasks.filter((t) => t.boardId === ${JSON.stringify(sprint.id)}).length === 2`);
  assert(await s.eval(`${state}.tasks.filter((t) => t.boardId === ${JSON.stringify(sprint.id)}).every((t) => t.origin.kind === 'cronospark')`), 'saving a source syncs its cards onto the board as CronoSpark tasks');
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=board-settings]')");
  assert(await s.eval("[...document.querySelectorAll('.tb-card')].some((c) => c.dataset.origin === 'cronospark' && c.querySelector('a[href=\"https://app.cronospark.example/tasks/701\"]') && c.innerText.includes('CS-701'))"), 'a CronoSpark card carries its identifier and a link to the task');
  assert(await s.eval("document.querySelector('.tb-col[data-stage=todo] .tb-card[data-origin=cronospark]')?.innerText.includes('CS-701') && document.querySelector('.tb-col[data-stage=doing] .tb-card[data-origin=cronospark]')?.innerText.includes('CS-702')"), 'the provider statuses put the cards in their columns');
  const syncedAt = await s.eval(`${state}.boardSync[${JSON.stringify(sprint.id)}].lastFetchedAt`);
  await s.clickOn('[aria-label="Sync this board"]');
  await s.waitFor(`${state}.boardSync[${JSON.stringify(sprint.id)}]?.kind === 'ready' && ${state}.boardSync[${JSON.stringify(sprint.id)}].lastFetchedAt > ${syncedAt}`);
  assert((await sent('refresh_board')).length >= 1, 'the Sync button sends refresh_board and the board syncs again');

  await s.clickOn('[aria-label="Board settings"]');
  await s.waitFor("!!document.querySelector('[data-testid=board-settings]')");
  await s.clickOn('.tb-source [aria-label="Remove source"]');
  await s.clickOn('.tb-settings .tb-btn', 'Linear');
  await s.clickOn('.tb-source input[aria-label=Project]');
  await s.type('team:NOPE');
  await s.clickOn('.tb-settings .tb-btn.primary', 'Save and sync');
  await s.waitFor(`${state}.boardSync[${JSON.stringify(sprint.id)}]?.kind === 'error'`);
  await s.waitFor("!!document.querySelector('[data-testid=sync-error]')");
  assert(await s.eval("document.querySelector('[data-sync=error]')?.innerText.includes('Sync failed') && document.querySelector('[data-testid=sync-error]').innerText.includes('Team not found: NOPE')"), 'a failed sync shows Linear\'s own message in an error banner and marks the header');
  assert(await s.eval(`${state}.tasks.filter((t) => t.boardId === ${JSON.stringify(sprint.id)}).length === 2`), 'and the failed sync left the board\'s tasks where they were');
  await s.press('Escape');

  // ── rename and delete a board from its settings ──
  await s.clickOn('[aria-label="New board"]');
  await s.waitFor("!!document.querySelector('.tb-newboard')");
  await s.type('Scratch');
  await s.clickOn('.tb-kindcard[data-kind=quick]');
  await s.clickOn('.tb-newboard button[type=submit]');
  await s.waitFor(`${state}.boards.some((b) => b.name === 'Scratch' && b.kind === 'quick')`);
  await s.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('Scratch')");
  await s.clickOn('[aria-label="Board settings"]');
  await s.waitFor("!!document.querySelector('[data-testid=board-settings]')");
  assert(await s.eval("!document.querySelector('.tb-source') && !document.querySelector('.tb-settings .tb-check') && document.querySelector('[data-testid=board-settings]').innerText.includes('Quick board')"), 'a quick board\'s settings show no sources and no hours switch');
  await s.eval("document.querySelector('[aria-label=\"Board name\"]').select()");
  await s.type('Scratch pad');
  await s.press('Enter');
  await s.waitFor(`${state}.boards.some((b) => b.name === 'Scratch pad')`);
  await s.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('Scratch pad')");
  ok('renaming from the settings renames the tab');
  const scratchId = await s.eval(`${state}.boards.find((b) => b.name === 'Scratch pad').id`);
  await s.clickOn('[data-testid=board-settings] .tb-btn.danger');
  assert(await s.eval("document.querySelector('[data-testid=board-settings] .tb-btn.danger.armed')?.innerText.includes('Delete the board')"), 'deleting asks once more before it does it');
  await s.clickOn('[data-testid=board-settings] .tb-btn.danger');
  await s.waitFor(`!${state}.boards.some((b) => b.id === ${JSON.stringify(scratchId)})`);
  assert(await s.eval("![...document.querySelectorAll('[role=tab]')].some((t) => t.innerText.includes('Scratch'))"), 'the deleted board\'s tab is gone');
  await s.clickOn('[role=tab]', 'Quick tasks');
  await s.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('Quick tasks')");

  // ── keyboard: every card is a tab stop, arrows move, Enter opens, Shift+arrow moves the card ──
  assert(await s.eval("[...document.querySelectorAll('.tb-card')].every((c) => c.tabIndex === 0 && c.getAttribute('role') === 'button')"), 'every card is focusable and named for a screen reader');
  await s.eval("document.querySelector('.tb-col[data-stage=todo] .tb-card').focus()");
  const key = (k, extra = {}) => s.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} }))`);
  const focusedTitle = () => s.eval('document.activeElement?.querySelector?.(".tb-card-title")?.innerText ?? null');
  await key('ArrowRight');
  assert((await focusedTitle()) === 'Book the demo room', 'the right arrow moves focus to the next column\'s card');
  await key('ArrowRight', { shiftKey: true });
  await s.waitFor(`${taskByTitle('Book the demo room')}?.stage === 'review'`);
  await s.waitFor("document.activeElement?.closest('.tb-col')?.dataset.stage === 'review'");
  ok('Shift+right arrow moves the focused card one column on and keeps focus on it');
  await s.press('Enter');
  await s.waitFor("!!document.querySelector('[data-testid=task-detail]')");
  assert(await s.eval("document.querySelector('[data-testid=task-detail] .tb-title-input').value === 'Book the demo room'"), 'Enter on a focused card opens its detail');
  await s.press('Escape');

  // ── the composer with the mouse: notes, priority and the PO, then Enter makes the task and starts the PO ──
  const poTitle = 'Reply to the launch note';
  const option = (text) => `[...document.querySelectorAll('[role=option]')].find((o) => o.innerText.includes(${JSON.stringify(text)}))`;
  await s.clickOn('[aria-label="Add a task to Todo"]');
  await s.waitFor(inTitle);
  await s.clickOn('[data-testid=pill-notes]');
  await s.waitFor("document.activeElement?.dataset.testid === 'composer-notes'");
  await s.type('Reply done at once. Do not delegate, hire anyone or change any file.');
  await s.clickOn('[data-testid=pill-priority]');
  await s.waitFor("!!document.querySelector('[role=listbox][aria-label=Priority]')");
  assert(await s.eval("[...document.querySelectorAll('[role=option]')].map((o) => o.innerText.trim()).join() === 'No priority,Urgent,High,Medium,Low'"), 'the priority list offers none, urgent, high, medium and low');
  await s.clickOn('[role=option]', 'High');
  await s.waitFor(`${inTitle} && !document.querySelector('[role=listbox]')`);
  assert(await s.eval("document.querySelector('[data-testid=pill-priority]').innerText.includes('High')"), 'picking High closes the list, shows it on the pill and hands focus back to the title');
  await s.clickOn('[data-testid=pill-assignee]');
  await s.waitFor("!!document.querySelector('[role=listbox][aria-label=Assignee]')");
  const people = await s.eval("[...document.querySelectorAll('[role=listbox][aria-label=Assignee] [role=option]')].map((o) => ({ text: o.innerText.replace(/\\s+/g, ' ').trim(), avatar: !!o.querySelector('.tb-av'), selected: o.getAttribute('aria-selected') }))");
  console.log('assignee list:', JSON.stringify(people));
  assert(people.length === 3 && /^No one yet/.test(people[0].text) && people[0].selected === 'true' && /^P Pia PO (idle|working)$/.test(people[1].text) && /^A Ana (idle|working)$/.test(people[2].text) && people.slice(1).every((x) => x.avatar), 'the assignee list is no one, then the PO, then the block\'s employees, each with an avatar and working or idle');
  await s.clickOn('[role=option]', 'Pia');
  await s.waitFor(`${inTitle} && !document.querySelector('[role=listbox]')`);
  assert(await s.eval("document.querySelector('[data-testid=composer-stage]').innerText.replace(/\\s+/g, ' ').trim() === 'In Progress Pia starts at once' && document.querySelector('[data-testid=pill-assignee]').innerText.includes('Pia')"), 'with Pia picked the composer says the card begins in In Progress and Pia starts at once');
  await s.type(poTitle);
  const mark1 = await sentCount();
  await s.press('Enter');
  const entered = Date.now();
  let landed = false;
  while (Date.now() - entered < 2000 && !landed) {
    landed = await s.eval(`(() => { const t = ${taskByTitle(poTitle)}; return !!t && t.runs.length === 1 && t.stage === 'doing' && t.assignees.includes(${JSON.stringify(pia)}); })()`);
    if (!landed) await s.sleep(25);
  }
  assert(landed, `Enter on a task with an assignee makes it, posts the run and moves it to doing in ${Date.now() - entered} ms (limit 2000)`);
  const poMsg = (await sentSince(mark1)).filter((m) => m.type === 'create_task');
  assert(poMsg.length === 1 && JSON.stringify(poMsg[0]) === JSON.stringify({ type: 'create_task', boardId: quickId, title: poTitle, stage: 'doing', notes: 'Reply done at once. Do not delegate, hire anyone or change any file.', assignee: pia, priority: 'high' }), 'one create_task carried the title, notes, priority and assignee, and nothing else was sent for it');
  assert((await sentSince(mark1)).filter((m) => m.type === 'assign_task').length === 0, 'the assignee went with create_task: no second assign_task');
  while (Date.now() - entered < 2000 && !(await s.eval(`${state}.taskTime[${taskByTitle(poTitle)}.id]?.running.some((r) => r.employeeId === ${JSON.stringify(pia)})`))) await s.sleep(25);
  assert(await s.eval(`${state}.taskTime[${taskByTitle(poTitle)}.id]?.running.some((r) => r.employeeId === ${JSON.stringify(pia)})`), `the PO is running on it ${Date.now() - entered} ms after Enter`);
  await s.waitFor(`!!document.querySelector('.tb-col[data-stage=doing] .tb-card[data-task-id=${JSON.stringify(await s.eval(`${taskByTitle(poTitle)}.id`))}]')`, 2000);
  assert(await s.eval(`(() => { const c = document.querySelector('.tb-col[data-stage=doing] .tb-card[data-task-id=${JSON.stringify(await s.eval(`${taskByTitle(poTitle)}.id`))}]'); return !!c.querySelector('[data-employee=${JSON.stringify(pia)}]') && c.innerText.includes('High') && c.innerText.includes('Manual'); })()`), 'the card sits in In Progress with the PO as its assignee and the High chip');
  assert(await s.eval(`${composerOpen} === false`), 'the composer is put away');

  // ── the composer with the keyboard alone ──
  const pill = (id) => `document.activeElement?.dataset.testid === ${JSON.stringify(id)}`;
  const focused = (text) => s.eval(`document.activeElement?.getAttribute('role') === 'option' && document.activeElement.innerText.includes(${JSON.stringify(text)})`);
  await s.eval("document.querySelector('[aria-label=\"Add a task to Todo\"]').focus()");
  await s.chord('Enter');
  await s.waitFor(inTitle);
  await s.type('Write the changelog');
  await s.chord('Tab');
  assert(await s.eval(pill('pill-assignee')), 'Tab from the title lands on the assignee pill');
  await s.chord('Tab');
  assert(await s.eval(pill('pill-priority')), 'then the priority pill');
  await s.chord('Tab');
  assert(await s.eval(pill('pill-notes')), 'then the notes pill');
  await s.chord('Tab');
  assert(await s.eval("document.activeElement?.dataset.testid === 'create-more'"), 'then Create more');
  await s.chord('Tab');
  assert(await s.eval("document.activeElement?.dataset.testid === 'create-task'"), 'then Create task');
  for (let i = 0; i < 4; i++) await s.chord('Tab', 8);
  assert(await s.eval(pill('pill-assignee')), 'Shift+Tab walks back to the assignee pill');
  await s.chord('Enter');
  await s.waitFor("!!document.querySelector('[role=listbox][aria-label=Assignee]')");
  assert(await focused('No one yet'), 'Enter on the pill opens the list with focus on the current choice');
  await s.chord('ArrowDown');
  await s.chord('ArrowDown');
  assert(await focused('Ana'), 'the arrow keys move down the list');
  await s.chord('ArrowDown');
  assert(await focused('No one yet'), 'and wrap at the end');
  await s.chord('ArrowUp');
  assert(await focused('Ana'), 'and up again');
  await s.chord('Enter');
  await s.waitFor(`${inTitle} && !document.querySelector('[role=listbox]')`);
  assert(await s.eval("document.querySelector('[data-testid=composer-stage]').innerText.includes('Ana starts at once')"), 'Enter picks Ana and hands focus back to the title, where Enter would make the task');
  await s.chord('Tab');
  await s.chord('ArrowDown');
  await s.waitFor("!!document.querySelector('[role=listbox][aria-label=Assignee]')");
  assert(await focused('Ana'), 'ArrowDown on the pill opens the list on the current choice');
  await s.chord('Home');
  await s.chord('Enter');
  await s.waitFor(inTitle);
  assert(await s.eval("!document.querySelector('[data-testid=composer-stage]').innerText.includes('starts at once') && document.querySelector('[data-testid=composer-stage]').innerText.trim() === 'Todo'"), 'picking No one again takes it back: the card stays in Todo');
  await s.chord('Tab');
  await s.chord('Tab');
  assert(await s.eval(pill('pill-priority')), 'two Tabs from the title reach the priority pill again');
  await s.chord('Enter');
  await s.waitFor("!!document.querySelector('[role=listbox][aria-label=Priority]')");
  await s.chord('ArrowDown');
  await s.chord('ArrowDown');
  await s.chord('ArrowDown');
  assert(await focused('Medium'), 'three arrows down the priority list reach Medium');
  await s.chord('Enter');
  await s.waitFor(inTitle);
  for (let i = 0; i < 3; i++) await s.chord('Tab');
  assert(await s.eval(pill('pill-notes')), 'three Tabs from the title reach the notes pill');
  await s.chord('Enter');
  await s.waitFor("document.activeElement?.dataset.testid === 'composer-notes'");
  await s.type('Newest first, keep it short.');
  const markKb = await sentCount();
  await s.chord('Enter', 4);
  await s.waitFor(`!!${taskByTitle('Write the changelog')}`);
  const kb = (await sentSince(markKb)).filter((m) => m.type === 'create_task');
  assert(kb.length === 1 && JSON.stringify(kb[0]) === JSON.stringify({ type: 'create_task', boardId: quickId, title: 'Write the changelog', stage: 'todo', notes: 'Newest first, keep it short.', priority: 'medium' }), 'Cmd+Enter from the notes field made one create_task with title, notes and priority, in Todo');
  await s.waitFor(`${inTitle} && document.querySelector('[data-testid=composer-title]').value === ''`);
  assert(await s.eval("document.querySelector('[data-testid=composer-notes]').value === '' && document.querySelector('[data-testid=pill-priority]').innerText.includes('Medium')"), 'the composer stays for the next one: words cleared, the priority kept');
  await s.chord('Tab');
  assert(await s.eval("document.activeElement?.dataset.testid === 'composer-notes'"), 'with the notes field open it is the next stop after the title');
  await s.chord('Tab');
  assert(await s.eval(pill('pill-assignee')), 'and the pills come after it');
  await s.chord('Enter');
  await s.waitFor("!!document.querySelector('[role=listbox][aria-label=Assignee]')");
  await s.chord('Escape');
  await s.waitFor("!document.querySelector('[role=listbox]')");
  assert(await s.eval(`${composerOpen} && ${pill('pill-assignee')}`), 'Esc in an open list shuts the list and leaves the composer, with focus on its pill');
  await s.chord('Escape');
  await s.waitFor(`!${composerOpen}`);
  assert(await s.eval("!!document.querySelector('[data-testid=task-board]')"), 'a second Esc cancels the composer and the board stays');

  // ── the priority on the card, in the detail, and not editable on a provider's card ──
  const poId = await s.eval(`${taskByTitle(poTitle)}.id`);
  await s.clickOn('.tb-card', poTitle);
  await s.waitFor(`document.querySelector('[data-testid=task-detail] .tb-title-input')?.value === ${JSON.stringify(poTitle)}`);
  assert(await s.eval("document.querySelector('[data-testid=task-detail] select[aria-label=Priority]').value === 'high'"), 'the detail of a task made by hand shows its priority');
  const markPriority = await sentCount();
  await s.eval("(() => { const sel = document.querySelector('[data-testid=task-detail] select[aria-label=Priority]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'urgent'); sel.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await s.waitFor(`${state}.tasks.find((t) => t.id === ${JSON.stringify(poId)}).origin.priority === 'urgent'`);
  assert((await sentSince(markPriority)).filter((m) => m.type === 'update_task').length === 1, 'changing it in the detail sends one update_task');
  await s.waitFor(`document.querySelector('.tb-card[data-task-id=${JSON.stringify(poId)}]')?.innerText.includes('Urgent')`);
  ok('and the card\'s chip follows');
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=task-detail]')");
  await s.clickOn('[role=tab]', 'Sprint');
  await s.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('Sprint')");
  await s.clickOn('.tb-card', 'CS-701');
  await s.waitFor("!!document.querySelector('[data-testid=task-detail]')");
  assert(await s.eval("!document.querySelector('[data-testid=task-detail] select[aria-label=Priority]') && document.querySelector('[data-testid=task-detail]').innerText.includes('P2')"), 'a CronoSpark task shows the provider\'s own priority and offers no priority to change');
  assert(await s.eval("(() => { const b = document.querySelector('[data-testid=send-hours]'); return !!b && b.disabled && b.innerText.trim() === 'Send hours to CronoSpark' && document.querySelector('[data-testid=send-hours-reason]')?.innerText.includes('Nothing to send yet'); })()"), 'a CronoSpark task nobody worked on shows a disabled Send hours button and says why');
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=task-detail]')");
  await s.clickOn('[role=tab]', 'Quick tasks');
  await s.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('Quick tasks')");

  // A turn that serves two tasks splits its time between them, which is right and is not what the per-person comparison below
  // measures, so the PO finishes the task the composer gave them before anyone is handed another.
  await settled(s, poTitle, 'the PO\'s task made by the composer');

  // ── assign to the PO and to an employee, from the detail ──
  await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(quickId)}, title: 'Confirm the launch checklist', notes: 'Reply done at once. Do not delegate, hire anyone or change any file.' })`);
  await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(quickId)}, title: 'Create board.txt', notes: 'Create a file named board.txt in the project folder whose only line is: hello from the board. Then reply done naming it.' })`);
  await s.waitFor(`!!${taskByTitle('Confirm the launch checklist')} && !!${taskByTitle('Create board.txt')}`);
  const poTask = await s.eval(taskByTitle('Confirm the launch checklist'));
  const anaTask = await s.eval(taskByTitle('Create board.txt'));
  await s.clickOn('.tb-card', 'Confirm the launch checklist');
  await s.waitFor("!!document.querySelector('[data-testid=task-detail]')");
  const mark2 = await sentCount();
  await s.clickOn(`.tb-people li[data-employee="${pia}"] button`);
  await s.waitFor(`${state}.tasks.find((t) => t.id === ${JSON.stringify(poTask.id)}).assignees.includes(${JSON.stringify(pia)})`);
  const assigns = (await sentSince(mark2)).filter((m) => m.type === 'assign_task');
  assert(assigns.length === 1 && assigns[0].employeeId === pia && assigns[0].taskId === poTask.id, 'Assign on the PO\'s row sends assign_task for the PO');
  assert(await s.eval(`!!document.querySelector('.tb-card[data-task-id=${JSON.stringify(poTask.id)}] [data-employee=${JSON.stringify(pia)}]')`), 'the card shows the PO as its assignee');
  assert(await s.eval(`${state}.tasks.find((t) => t.id === ${JSON.stringify(poTask.id)}).stage === 'doing'`), 'assigning moves the task to In Progress');

  await s.clickOn('.tb-card', 'Create board.txt');
  await s.waitFor("document.querySelector('[data-testid=task-detail] .tb-title-input')?.value === 'Create board.txt'");
  const mark3 = await sentCount();
  await s.clickOn(`.tb-people li[data-employee="${ana}"] button`);
  const assignAna = (await sentSince(mark3)).filter((m) => m.type === 'assign_task');
  assert(assignAna.length === 1 && assignAna[0].employeeId === ana && assignAna[0].taskId === anaTask.id, 'Assign on an employee\'s row sends assign_task for that employee');
  await s.waitFor(`${state}.tasks.find((t) => t.id === ${JSON.stringify(anaTask.id)}).assignees.includes(${JSON.stringify(ana)})`);
  assert(await s.eval(`!!document.querySelector('.tb-card[data-task-id=${JSON.stringify(anaTask.id)}] [data-employee=${JSON.stringify(ana)}]')`), 'the card shows the employee as its assignee');

  // ── the timer ticks on the card while Ana works ──
  const running = `${state}.taskTime[${JSON.stringify(anaTask.id)}]?.running.some((r) => r.employeeId === ${JSON.stringify(ana)})`;
  const timer = `document.querySelector('.tb-card[data-task-id=${JSON.stringify(anaTask.id)}] [data-testid=task-timer]')`;
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000 && !(await s.eval(running))) await s.sleep(100);
  assert(await s.eval(running), 'Ana is running on the task in the snapshot');
  const seen = Date.now();
  while (Date.now() - seen < 2000 && !(await s.eval(`${timer}?.dataset.running === 'true'`))) await s.sleep(50);
  assert(await s.eval(`${timer}?.dataset.running === 'true'`), `the card shows a running timer within 2 s of the snapshot (${Date.now() - seen} ms)`);
  const a = await s.eval(`({ ms: Number(${timer}.dataset.ms), text: ${timer}.innerText.trim() })`);
  await s.sleep(2300);
  const b = await s.eval(`({ ms: Number(${timer}.dataset.ms), text: ${timer}.innerText.trim() })`);
  assert(b.ms - a.ms >= 1000 && b.ms - a.ms <= 4000 && a.text !== b.text && /^\d+:\d\d/.test(b.text), `the timer on the card ticks while they work (${a.text} then ${b.text})`);
  const live1 = await s.eval("document.querySelector('[data-testid=task-total]').innerText");
  await s.sleep(1500);
  const live2 = await s.eval("document.querySelector('[data-testid=task-total]').innerText");
  assert(live1 !== live2, `the detail's total ticks too (${live1} then ${live2})`);

  // ── both runs settle ──
  await settled(s, 'Confirm the launch checklist', 'the PO\'s task');
  const out = await settled(s, 'Create board.txt', 'Ana\'s task');
  assert(out.stage === 'review' && out.out === 'done', 'Ana\'s run finished and the task moved to In Review on its own');
  await s.sleep(1500);
  const quiet = await s.eval(`${state}.taskTime[${JSON.stringify(anaTask.id)}].running.length === 0`);
  assert(quiet, 'nobody is running once the task is in review');

  // ── a task two people worked on: the detail reports the hours of each ──
  await s.clickOn('.tb-card', 'Confirm the launch checklist');
  await s.waitFor("document.querySelector('[data-testid=task-detail] .tb-title-input')?.value === 'Confirm the launch checklist'");
  await s.clickOn(`.tb-people li[data-employee="${ana}"] button`);
  const both = `(() => { const t = ${state}.tasks.find((x) => x.id === ${JSON.stringify(poTask.id)}); const time = ${state}.taskTime[t.id]; return t.runs.length === 2 && time.byEmployee[${JSON.stringify(ana)}] > 0 && time.byEmployee[${JSON.stringify(pia)}] > 0 && time.running.length === 0 && !!t.lastOutcome; })()`;
  const tWait = Date.now();
  while (Date.now() - tWait < WAIT_MS && !(await s.eval(both))) {
    await unattended(s);
    await s.sleep(2500);
  }
  assert(await s.eval(both), 'the PO\'s task now has time from the PO and from Ana');
  await s.sleep(1500);
  const final = await s.eval(`(() => { const t = ${state}.tasks.find((x) => x.id === ${JSON.stringify(poTask.id)}); return { runs: t.runs, time: ${state}.taskTime[t.id] }; })()`);
  const shown = await s.eval(`[...document.querySelectorAll('[data-testid=task-hours] li')].map((li) => ({ who: li.dataset.employee, ms: Number(li.querySelector('[data-testid=share-time]').dataset.ms), text: li.querySelector('[data-testid=share-time]').innerText.trim() }))`);
  const independent = wallTime(ledgerFile, final.runs);
  console.log('detail shows:', JSON.stringify(shown), '| snapshot:', JSON.stringify(final.time.byEmployee), '| mail.jsonl:', JSON.stringify(independent));
  assert(shown.length === 2 && shown.length === Object.keys(final.time.byEmployee).length, 'the detail lists every person who worked on the task');
  for (const row of shown) {
    assert(Math.abs(row.ms - (final.time.byEmployee[row.who] ?? -1e9)) <= 1000, `${row.who === ana ? 'Ana' : row.who}: the detail's ${row.text} matches the snapshot's ${final.time.byEmployee[row.who]} ms`);
    assert(Math.abs(row.ms - (independent[row.who] ?? -1e9)) <= 2000, `${row.who === ana ? 'Ana' : row.who}: the detail's ${row.ms} ms is within 2 s of what mail.jsonl says (${independent[row.who]} ms)`);
  }
  const totalText = await s.eval("document.querySelector('[data-testid=task-total]').innerText.trim()");
  const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  assert(totalText === mmss(final.time.totalMs) && final.time.totalMs === Object.values(final.time.byEmployee).reduce((a, b) => a + b, 0), `the total reads ${totalText}, the sum of both people's time`);

  // ── hours leave only on the owner's click ──
  assert(await s.eval("!document.querySelector('[data-testid=send-hours]') && !document.querySelector('[data-testid=task-send-hours]')"), 'a task made by hand has no Send hours button');
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=task-detail]')");
  await s.clickOn('[role=tab]', 'Sprint');
  await s.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('Sprint')");
  const csTask = await s.eval(taskByTitle('Write the changelog entry'));
  await s.eval(`window.office.send({ type: 'update_task', taskId: ${JSON.stringify(csTask.id)}, notes: 'Write a file named changelog.txt in the project folder whose only line is: hello from the changelog. Reply done naming it.' })`);
  await s.clickOn('.tb-card', 'CS-701');
  await s.waitFor("!!document.querySelector('[data-testid=task-detail]')");
  await s.clickOn(`.tb-people li[data-employee="${ana}"] button`);
  const csDone = `(() => { const t = ${state}.tasks.find((x) => x.id === ${JSON.stringify(csTask.id)}); const time = ${state}.taskTime[t.id]; return t.runs.length === 1 && !!t.lastOutcome && time.running.length === 0 && (time.unsent?.[${JSON.stringify(ana)}] ?? 0) > 0; })()`;
  const csWait = Date.now();
  while (Date.now() - csWait < WAIT_MS && !(await s.eval(csDone))) {
    await unattended(s);
    await s.sleep(2500);
  }
  assert(await s.eval(csDone), 'Ana worked on the CronoSpark task and her closed time is reported as not sent');
  await s.sleep(1500);
  assert(fake.calls.length === 0, 'the work and the task moving on posted no hours to CronoSpark');
  const owed = await s.eval(`${state}.taskTime[${JSON.stringify(csTask.id)}].unsent[${JSON.stringify(ana)}]`);
  const csRuns = await s.eval(`${state}.tasks.find((x) => x.id === ${JSON.stringify(csTask.id)}).runs`);
  const csWall = wallTime(ledgerFile, csRuns)[ana];
  assert(Math.abs(owed - csWall) <= 2000, `the unsent time is ${owed} ms, mail.jsonl says ${csWall} ms`);
  assert(await s.eval(`(() => { const b = document.querySelector('[data-testid=send-hours]'); return !!b && !b.disabled && document.querySelector('[data-testid=hours-unsent]')?.innerText.includes('Ana') && !document.querySelector('[data-testid=send-hours-reason]'); })()`), 'the detail lists what is not sent per person and offers an enabled Send button');
  assert(await s.eval(`!!document.querySelector('.tb-card[data-task-id=${JSON.stringify(csTask.id)}] [data-testid=unsent-chip]')`), 'the card carries a small chip with the time to send');
  const markSend = await sentCount();
  // The branch and pull request rows push the button below the fold of a short window, and a click lands on the pixel it is given.
  await s.eval(`document.querySelector('[data-testid=send-hours]').scrollIntoView({ block: 'center' })`);
  await s.sleep(300);
  await s.clickOn('[data-testid=send-hours]');
  assert((await sentSince(markSend)).filter((m) => m.type === 'send_hours').length === 1, 'the click sends one send_hours');
  await s.waitFor(`document.querySelector('[data-testid=send-hours]')?.disabled === true && document.querySelector('[data-testid=send-hours-reason]')?.innerText.includes('Nothing to send yet')`, 15000);
  const csDay = new Date();
  assert(fake.calls.length === 1 && fake.calls[0].taskId === 'fake-task-701' && fake.calls[0].description.startsWith('Ana') && Math.abs(fake.calls[0].hours - owed / 3_600_000) < 0.0002 && fake.calls[0].date === `${csDay.getFullYear()}-${String(csDay.getMonth() + 1).padStart(2, '0')}-${String(csDay.getDate()).padStart(2, '0')}`, 'CronoSpark got one call for Ana with exactly the unsent time', JSON.stringify(fake.calls));
  assert(await s.eval("document.querySelector('[data-testid=hours-sent]').innerText.includes('Sent to CronoSpark: Ana') && !document.querySelector('[data-testid=hours-unsent]') && !document.querySelector('[data-testid=unsent-chip]')"), 'the detail now says it was sent, and the card chip is gone');
  await s.sleep(2500);
  assert(fake.calls.length === 1, 'nothing else was posted');

  // ── F at the 3D board ──
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=task-detail]')");
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=task-board]')");
  await s.eval('document.activeElement?.blur()');
  await s.waitFor("__office.store.getState().building?.stories.some((st) => st.items.some((i) => i.def === 'board_terminal'))");
  await s.eval("__office.teleport(-12, -7.4, Math.PI); __office.step(0.5)");
  await s.waitFor(`${state}.nearTaskBoard === ${JSON.stringify(blockId)}`);
  assert(await s.eval("document.body.innerText.includes('open the task board')"), 'standing at the board, the prompt offers F');
  await s.press('KeyF', 'f');
  await s.waitFor("!!document.querySelector('[data-testid=task-board]')");
  assert(await s.eval("!!document.querySelector('.tb-card')"), 'F at the 3D board opens the same board with its cards');

  await linearBoardFlow(s, { fake: linear, world: linearWorldData, launch, env });
  assert(linear.auth.every((a) => a === `Bearer ${LINEAR_TOKEN}`), 'every call to Linear carried the token');
};

function ok(msg) {
  console.log('ok:', msg);
}

process.on('exit', () => {
  for (const dir of [dataDir, repo]) rmSync(dir, { recursive: true, force: true });
  void linear.close();
});
