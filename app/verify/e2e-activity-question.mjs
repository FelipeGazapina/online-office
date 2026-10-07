// A question on the board, with a real haiku employee. The employee is told to ask the owner something and stop, so their turn ends
// blocked with the question as its text. The card must carry the question within 2 s of that reply landing in the ledger, the owner
// answers from the task detail with real mouse and keyboard input, the same employee resumes inside the same chain, writes the
// file, and settles; the task goes to review and the log tells the whole story in order.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-activity-question.mjs
// OFFICE_ACTIVITY_WAIT_MIN caps each agent run (default 6). OFFICE_SHOTS is where question.png goes.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAIKU, assert } from './lib.mjs';

const WAIT_MS = Number(process.env.OFFICE_ACTIVITY_WAIT_MIN ?? 6) * 60_000;
const SHOTS = process.env.OFFICE_SHOTS ?? '/Users/feliperico/.claude/orchestrate/online-office-game/shots/a1';
const BADGE_MS = 2000;

const dataDir = mkdtempSync(join(tmpdir(), 'a1-data-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'a1-repo-')));
const git = (...args) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', ...args], { cwd: repo, stdio: 'pipe' }).toString();
git('init', '-q');
writeFileSync(join(repo, 'README.md'), '# scratch\n');
git('add', '-A');
git('commit', '-q', '-m', 'initial');

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '5',
  OFFICE_CLAUDE_MODEL: HAIKU,
  OFFICE_TASK_BOARD_FIXTURE: '',
  LINEAR_MCP_TOKEN: '',
};

const state = '__office.store.getState()';
const ledgerFile = join(dataDir, 'company.mail.jsonl');
const ledger = () =>
  existsSync(ledgerFile)
    ? readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
    : [];

export const diagnose = async (s) => {
  console.log('tasks at failure:', JSON.stringify(await s.eval(`${state}.tasks`).catch(() => '?')));
  console.log('live at failure:', JSON.stringify(await s.eval(`${state}.mail.open`).catch(() => '?')));
  console.log('ledger tail:\n' + ledger().filter((e) => e.t === 'post').slice(-10).map((e) => `${e.msg.kind} ${e.msg.from}->${e.msg.to} ${e.msg.outcome ?? ''} ${(e.msg.title ?? e.msg.text ?? '').slice(0, 100)}`).join('\n'));
  await s.shot('a1-question-failure').catch(() => {});
};

async function unattended(s) {
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, mode: e.permissions.mode, q: e.status.kind === 'blocked_on_owner' ? e.status.question : null }))`);
  for (const p of people) {
    if (p.mode !== 'yolo') await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(p.id)}, mode: 'yolo' })`);
    if (p.q?.kind === 'permission') await s.eval(`window.office.send({ type: 'answer', employeeId: ${JSON.stringify(p.id)}, questionId: ${JSON.stringify(p.q.id)}, text: 'Yes' })`);
  }
}

const NOTES = [
  'Write a file named colour.txt in the project folder whose only line is the colour the owner picks, red or blue.',
  'You do not know the colour and you must not guess it. Do not use the ask_owner tool, do not hire anyone, and do not create any file until you know the colour.',
  'If the request does not yet say which colour the owner picked, end your turn right now with this one question as your whole answer: Which colour should colour.txt hold, red or blue?',
  'Once the request says which colour the owner picked, write colour.txt with exactly that colour as its only line, and reply done naming colour.txt.',
].join(' ');

export default async (s) => {
  await s.resize(1440, 900);
  await s.waitFor(`!!${state}.company`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${state}.company.blocks.length === 1`);
  const blockId = await s.eval(`${state}.company.blocks[0].id`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Ana' })`);
  await s.waitFor(`${state}.company.employees.length === 1`);
  const ana = await s.eval(`${state}.company.employees[0].id`);
  await unattended(s);
  const boardId = await s.eval(`${state}.boards[0].id`);
  await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(boardId)}, title: 'Write colour.txt', notes: ${JSON.stringify(NOTES)} })`);
  await s.waitFor(`${state}.tasks.some((t) => t.title === 'Write colour.txt')`);
  const taskId = await s.eval(`${state}.tasks.find((t) => t.title === 'Write colour.txt').id`);
  const task = () => `${state}.tasks.find((t) => t.id === ${JSON.stringify(taskId)})`;
  await s.eval(`__office.store.setState({ modal: { kind: 'task_board', blockId: ${JSON.stringify(blockId)}, taskId: ${JSON.stringify(taskId)} } })`);
  await s.waitFor(`!!document.querySelector('[data-testid="task-detail"]')`);

  await s.eval(`window.office.send({ type: 'assign_task', taskId: ${JSON.stringify(taskId)}, employeeId: ${JSON.stringify(ana)} })`);
  await s.waitFor(`${task()}.runs.length === 1`);

  // From the blocked reply landing in the ledger to the badge on the card.
  let repliedAt = 0;
  let seenAt = 0;
  const t0 = Date.now();
  while (!seenAt && Date.now() - t0 < WAIT_MS) {
    await unattended(s);
    if (!repliedAt) repliedAt = ledger().find((e) => e.t === 'post' && e.msg.kind === 'reply' && e.msg.from === ana && e.msg.outcome === 'blocked')?.msg.at ?? 0;
    const badge = await s.eval(`document.querySelector('[data-task-id="${taskId}"] [data-testid="question-badge"]')?.dataset.count ?? null`);
    if (badge) seenAt = Date.now();
    else await s.sleep(40);
  }
  assert(!!seenAt, 'a question badge showed on the card');
  repliedAt ||= ledger().find((e) => e.t === 'post' && e.msg.kind === 'reply' && e.msg.from === ana && e.msg.outcome === 'blocked')?.msg.at ?? 0;
  assert(repliedAt > 0, 'it came from the employee\'s blocked reply in the ledger');
  assert(seenAt - repliedAt <= BADGE_MS, `the badge showed ${seenAt - repliedAt} ms after the blocked reply landed (limit ${BADGE_MS} ms)`);
  const asked = ledger().find((e) => e.t === 'post' && e.msg.kind === 'reply' && e.msg.from === ana && e.msg.outcome === 'blocked').msg;
  console.log('the question, as the employee wrote it:', JSON.stringify(asked.text.slice(0, 200)));

  await s.waitFor(`${task()}.stage === 'todo' && ${task()}.lastOutcome?.outcome === 'blocked'`, 10000);
  // The owner opens the card the way the owner does: a real click.
  await s.clickOn(`[data-task-id="${taskId}"]`);
  await s.waitFor(`document.querySelectorAll('[data-testid="task-question"]').length === 1`);
  const shown = await s.eval(`(() => { const q = document.querySelector('[data-testid="task-question"]'); return { asker: q.dataset.asker, how: q.dataset.how, text: q.querySelector('[data-testid="question-text"]').innerText }; })()`);
  assert(shown.asker === ana && shown.how === 'blocked' && shown.text.includes('colour'), `the detail shows the question with its asker (${shown.text})`);
  const person = await s.eval(`document.querySelector('[data-employee="${ana}"] [data-testid="person-live"]')?.innerText`);
  assert(/^Blocked/.test(person ?? ''), `and the employee is blocked, not idle (${person})`);
  await s.eval(`document.querySelector('[data-testid="task-questions"]').scrollIntoView({ block: 'center' })`);
  await s.sleep(500);
  await s.shot('a1-question');
  mkdirSync(SHOTS, { recursive: true });

  // The answer, typed and sent with real input events.
  await s.clickOn('[data-testid="question-answer"]');
  await s.type('blue');
  await s.clickOn('[data-testid="question-send"]');
  const answeredAt = Date.now();
  await s.waitFor(`${task()}.runs.length === 2`, 5000);
  const after = await s.eval(`${task()}`);
  const run = ledger().find((e) => e.t === 'post' && e.msg.id === after.runs[1])?.msg;
  assert(run?.kind === 'request' && run.from === 'owner' && run.to === ana && run.rootId === after.runs[0] && /blue/.test(run.text), 'the answer is a new request to the same employee inside the same chain, carrying the words');
  assert(/:answer:/.test(run.key ?? ''), `its key says which question it answers (${run.key})`);
  const gone = `document.querySelectorAll('[data-testid="task-question"]').length === 0 && !document.querySelector('[data-task-id="${taskId}"] [data-testid="question-badge"]')`;
  await s.waitFor(gone, BADGE_MS + 1000);
  assert(await s.eval(gone), `the question and its badge are gone ${Date.now() - answeredAt} ms after the answer`);
  assert((await s.eval(`${task()}.stage`)) === 'doing', 'the task is back in progress');
  const working = `${state}.company.employees[0].status.kind === 'working' && document.querySelector('[data-employee="${ana}"] [data-testid="person-live"]')?.dataset.state === 'working'`;
  await s.waitFor(working, 20000);
  assert(await s.eval(working), 'the employee is working again, and the board says so');

  const t1 = Date.now();
  while (Date.now() - t1 < WAIT_MS) {
    await unattended(s);
    const t = await s.eval(`${task()}`);
    if (t.stage === 'review') break;
    if (t.stage === 'todo' && t.lastOutcome && t.runs.length === 2 && t.lastOutcome.reply !== asked.id) throw new Error(`the second run ended ${t.lastOutcome.outcome}: ${t.lastOutcome.text.slice(0, 300)}`);
    await s.sleep(2000);
  }
  const done = await s.eval(`${task()}`);
  assert(done.stage === 'review' && done.lastOutcome.outcome === 'done', 'the employee resumed, settled, and the task moved to review');
  assert(existsSync(join(repo, 'colour.txt')) && readFileSync(join(repo, 'colour.txt'), 'utf8').trim() === 'blue', 'colour.txt holds the colour the owner answered');
  await s.sleep(1500);

  const entries = await s.eval(`[...document.querySelectorAll('[data-testid="activity-entry"]')].map((e) => ({ kind: e.dataset.kind, text: e.innerText.replace(/\\s+/g, ' ') }))`);
  const kinds = entries.map((e) => e.kind);
  console.log('the log, in order:', kinds.join(' > '));
  assert(kinds[0] === 'created' && kinds[1] === 'request' && /You asked Ana/.test(entries[1].text), 'the log opens with the owner asking Ana');
  const blockedAt = entries.findIndex((e) => e.kind === 'reply' && /is blocked/.test(e.text));
  const answerAt = entries.findIndex((e) => e.kind === 'request' && /Your answer/.test(e.text));
  const doneAt = entries.findIndex((e) => e.kind === 'reply' && /finished/.test(e.text) && /colour\.txt/.test(e.text));
  assert(blockedAt > 0 && answerAt > blockedAt && doneAt > answerAt, `blocked (${blockedAt}), then the owner's answer (${answerAt}), then done with its file (${doneAt})`);
  assert(entries.filter((e) => e.kind === 'stage').length >= 3, 'the stage moves are in the log');
  const stages = (await s.eval(`${task()}.history`)).filter((h) => h.kind === 'stage').map((h) => `${h.by}:${h.to}`);
  assert(stages.join() === 'owner:doing,mailroom:todo,owner:doing,mailroom:review', `each stage move says who made it (${stages.join(' ')})`);
  await s.eval(`(() => { const b = document.querySelector('[data-testid="task-detail"] .tb-dock-body'); b.scrollTop = b.scrollHeight; })()`);
  await s.sleep(400);
  await s.shot('a1-question-after');
  copyFileSync('/tmp/office-shots/a1-question.png', join(SHOTS, 'question.png'));
  console.log(`question.png copied to ${SHOTS}`);
};
