// The task board, driven the way the owner drives it: real mouse and key events through CDP, and every claim read from the
// store's snapshot or the page. Boards and tabs, an inline create in two columns (Enter saves, Esc cancels), a drag between
// columns, the detail (title, notes, assigning to the PO and to an employee, hours per person), a CronoSpark board from a
// fake server with its origin link, the sync button and the error state, keyboard use, and F at the 3D board. Two real
// haiku runs: a task for the PO, and one for an employee whose timer must tick on the card while they work.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-board-ui.mjs
// OFFICE_BOARD_WAIT_MIN caps each agent run (default 6).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAIKU, assert, wallTime } from './lib.mjs';
import { startFakeCronoSpark } from './fake-cronospark.ts';

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

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '5',
  OFFICE_CLAUDE_MODEL: HAIKU,
  CRONOSPARK_MCP_URL: fake.url,
  CRONOSPARK_MCP_API_KEY: 'fake-key',
  CRONOSPARK_MCP_USER_ID: 'fake-user',
  LINEAR_MCP_TOKEN: '',
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

export default async (s) => {
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

  // ── the HUD entry and the first board ──
  await s.clickOn('[data-testid=tasks-chip]');
  await s.waitFor("!!document.querySelector('[data-testid=task-board]')");
  assert(await s.eval("document.querySelectorAll('[role=tab]').length === 1 && document.querySelector('[role=tab]').innerText.includes('Quick tasks')"), 'the Tasks chip opens the block\'s board with its one Quick tasks tab');
  assert(await s.eval("[...document.querySelectorAll('.tb-col')].map((c) => c.dataset.stage).join() === 'todo,doing,review,done'"), 'the board has four columns: todo, doing, review, done');
  assert(await s.eval("!document.querySelector('[aria-label=\"Sync this board\"]') && document.body.innerText.includes('Saved on this Mac')"), 'a quick board has no sync button and no source setup');
  const quickId = await s.eval(`${state}.boards.find((b) => b.kind === 'quick').id`);

  // ── inline create: Enter saves and keeps the field for the next, Esc cancels ──
  await s.clickOn('[aria-label="Add a task to Todo"]');
  await s.waitFor("!!document.activeElement?.closest('[data-testid=composer]')");
  await s.type('Draft the launch checklist');
  await s.press('Enter');
  await s.waitFor(`!!${taskByTitle('Draft the launch checklist')}`);
  assert(await s.eval(`(() => { const t = ${taskByTitle('Draft the launch checklist')}; return t.stage === 'todo' && t.origin.kind === 'manual' && t.boardId === ${JSON.stringify(quickId)}; })()`), 'Enter in the Todo composer creates a manual todo task on this board');
  assert(await s.eval("document.querySelector('[data-testid=composer] input')?.value === ''"), 'the composer stays open and empty for the next task');
  await s.type('Book the demo room');
  await s.press('Enter');
  await s.waitFor(`!!${taskByTitle('Book the demo room')}`);
  const before = await s.eval(`${state}.tasks.length`);
  await s.type('discard me');
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=composer]')");
  await s.sleep(500);
  assert((await s.eval(`${state}.tasks.length`)) === before && !(await s.eval(`${state}.tasks.some((t) => t.title === 'discard me')`)), 'Esc cancels the composer and creates nothing');
  assert(await s.eval("!!document.querySelector('[data-testid=task-board]')"), 'Esc in the composer closes only the composer, not the board');

  // ── inline create in another column ──
  await s.clickOn('[aria-label="Add a task to In Review"]');
  await s.waitFor("!!document.activeElement?.closest('[data-testid=composer]')");
  await s.type('Check the staging deploy');
  await s.press('Enter');
  await s.waitFor(`${taskByTitle('Check the staging deploy')}?.stage === 'review'`);
  assert(await s.eval("!!document.querySelector('.tb-col[data-stage=review] .tb-card')?.innerText.includes('Check the staging deploy')"), 'a task made in the In Review column is created there and shown there');
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=composer]')");

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

  // The error state: a Linear source with no connection.
  await s.clickOn('[aria-label="Board settings"]');
  await s.waitFor("!!document.querySelector('[data-testid=board-settings]')");
  await s.clickOn('.tb-source [aria-label="Remove source"]');
  await s.clickOn('.tb-settings .tb-btn', 'Linear');
  await s.clickOn('.tb-source input[aria-label=Project]');
  await s.type('bloomnetwork');
  await s.clickOn('.tb-settings .tb-btn.primary', 'Save and sync');
  await s.waitFor(`${state}.boardSync[${JSON.stringify(sprint.id)}]?.kind === 'error'`);
  await s.waitFor("!!document.querySelector('[data-testid=sync-error]')");
  assert(await s.eval("document.querySelector('[data-sync=error]')?.innerText.includes('Sync failed') && document.querySelector('[data-testid=sync-error]').innerText.includes('Connect Linear')"), 'a failed sync shows an error banner with Connect Linear and marks the header');
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
};

function ok(msg) {
  console.log('ok:', msg);
}

process.on('exit', () => {
  for (const dir of [dataDir, repo]) rmSync(dir, { recursive: true, force: true });
});
