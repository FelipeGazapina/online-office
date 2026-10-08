// The activity of a task, read off a copy of the owner's own office. company.json, company.mail.jsonl and tasks.json are copied
// into a scratch data folder (never task-board-credentials.json), every block folder is swapped for a scratch git repo, and the
// app starts with OFFICE_NO_AGENTS so nothing runs: the task "Na sala de reunião ..." shows what the ledger says, not what
// agents do after it. Run with OFFICE_OWNER_COPY=<folder holding the three files> (a copy, never the real folder).
// Run: pnpm build:verify && OFFICE_OWNER_COPY=/tmp/a1-owner-copy OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-activity-owner.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert } from './lib.mjs';

const source = process.env.OFFICE_OWNER_COPY;
if (!source) throw new Error('OFFICE_OWNER_COPY must name a folder with a copy of company.json, company.mail.jsonl and tasks.json');
const SHOTS = process.env.OFFICE_SHOTS ?? '/Users/feliperico/.claude/orchestrate/online-office-game/shots/a1';

const dataDir = mkdtempSync(join(tmpdir(), 'a1-owner-data-'));
for (const file of ['company.json', 'company.mail.jsonl', 'tasks.json']) copyFileSync(join(source, file), join(dataDir, file));
const company = JSON.parse(readFileSync(join(dataDir, 'company.json'), 'utf8'));
for (const block of company.blocks) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'a1-owner-repo-')));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=scratch', '-c', 'user.email=scratch@example.com', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), `# ${block.name}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  block.cwd = repo;
}
writeFileSync(join(dataDir, 'company.json'), JSON.stringify(company, null, 2));

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_NO_AGENTS: '1',
  // No provider is reachable from a copy: an empty variable is no connection, and the boards keep their cards.
  LINEAR_MCP_TOKEN: '',
  CRONOSPARK_MCP_URL: '',
  CRONOSPARK_MCP_API_KEY: '',
  CRONOSPARK_MCP_USER_ID: '',
  OFFICE_TASK_BOARD_FIXTURE: '',
};

const state = '__office.store.getState()';
const TITLE = 'Na sala de reunião';

export default async (s) => {
  await s.resize(1440, 900);
  await s.waitFor(`!!${state}.company && ${state}.tasks.length > 0`);
  const task = await s.eval(`(() => { const t = ${state}.tasks.find((t) => t.title.startsWith(${JSON.stringify(TITLE)})); const b = ${state}.boards.find((b) => b.id === t.boardId); return { id: t.id, blockId: b.blockId, boardId: b.id, runs: t.runs }; })()`);
  const names = await s.eval(`Object.fromEntries(${state}.company.employees.map((e) => [e.name, e.id]))`);
  assert(task.runs.length === 2, 'the task has the owner\'s two runs');

  await s.eval(`__office.store.setState({ modal: { kind: 'task_board', blockId: ${JSON.stringify(task.blockId)}, taskId: ${JSON.stringify(task.id)} } })`);
  await s.waitFor(`!!document.querySelector('[data-testid="task-detail"]')`);
  await s.waitFor(`document.querySelectorAll('[data-testid="activity-entry"]').length > 10`, 20000);

  const card = await s.eval(`(() => { const c = document.querySelector('[data-task-id="${task.id}"]'); return c && { badge: c.querySelector('[data-testid="question-badge"]')?.innerText, count: c.querySelector('[data-testid="question-badge"]')?.dataset.count, live: c.querySelector('[data-testid="card-live"]')?.innerText }; })()`);
  assert(card?.count === '1', `the card carries one question badge (${JSON.stringify(card)})`);
  assert(/Rui waiting on/i.test(card.live ?? '') || /working/.test(card.live ?? ''), `the card says who is on it instead of nothing (${card?.live})`);

  const live = await s.eval(`Object.fromEntries([...document.querySelectorAll('[data-testid="task-detail"] .tb-people li')].map((li) => [li.querySelector('b').innerText, li.querySelector('[data-testid="person-live"]')?.innerText ?? li.querySelector('em').innerText]))`);
  console.log('who is doing what:', JSON.stringify(live, null, 1));
  assert(/^Waiting since/.test(live.Rui) && ['Tess', 'Jo', 'Fay'].every((n) => live.Rui.includes(n)), 'Rui is waiting on Tess, Jo and Fay, not idle');
  assert(['piece 1 of 4', 'piece 2 of 4', 'piece 3 of 4'].every((p) => live.Rui.includes(p)), 'and the wait names each piece');
  assert(!live.Rui.includes('Quin'), 'Quin is not among those he waits on: his pieces are settled');
  for (const n of ['Tess', 'Jo', 'Fay']) assert(/^Working on/.test(live[n]), `${n} is working on their piece (${live[n]})`);
  assert(/^Blocked: “Chefe, essa reunião/.test(live.Quin), `Quin is blocked, with his own words (${live.Quin})`);

  const question = await s.eval(`(() => { const q = document.querySelector('[data-testid="task-question"]'); return q && { asker: q.dataset.asker, how: q.dataset.how, text: q.querySelector('[data-testid="question-text"]').innerText, answerBox: !!q.querySelector('[data-testid="question-answer"]') }; })()`);
  assert(question?.asker === names.Quin && question.how === 'blocked' && /Chefe, essa reunião de time já está em andamento/.test(question.text) && question.answerBox, 'Quin\'s second run is a question on the board with an answer box');

  const entries = await s.eval(`[...document.querySelectorAll('[data-testid="activity-entry"]')].map((e) => ({ kind: e.dataset.kind, text: e.innerText.replace(/\\s+/g, ' ') }))`);
  const readmeReplies = entries.filter((e) => e.kind === 'reply' && /app\/README\.md/.test(e.text) && /Quin/.test(e.text) && /finished/.test(e.text));
  assert(readmeReplies.length === 2, `Quin's two settled README pieces are in the log with their file (${readmeReplies.length})`);
  const readmeAsks = entries.filter((e) => e.kind === 'request' && /README/.test(e.text));
  assert(readmeAsks.length === 2, 'and the two requests that asked for them');
  assert(entries.some((e) => e.kind === 'reply' && /Quin is blocked/.test(e.text) && /Chefe/.test(e.text)), 'the blocked reply is in the log with its text');
  assert(entries.filter((e) => e.kind === 'request' && /gauntlet/i.test(e.text)).length === 3, 'the three gauntlet pieces are in the log');
  assert(entries.some((e) => e.kind === 'request' && /Build round 1/.test(e.text)), 'a gauntlet round is labelled');
  assert(entries[0].kind === 'created', 'the log opens with the task being made');

  // Nobody ran anything: the ledger the app reads is the copy it was given.
  const ledgerBefore = readFileSync(join(source, 'company.mail.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  const ledgerNow = readFileSync(join(dataDir, 'company.mail.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  assert(ledgerNow === ledgerBefore, `no agent wrote to the ledger (${ledgerNow} entries, the copy had ${ledgerBefore})`);

  // The screenshots: the people with what each is doing and the start of the log, then the log further down.
  await s.eval(`(() => { const body = document.querySelector('[data-testid="task-detail"] .tb-dock-body'); const assign = [...body.querySelectorAll('.tb-section')].find((x) => /^assign/i.test(x.querySelector('h3')?.innerText ?? '')); body.scrollTop += assign.getBoundingClientRect().top - body.getBoundingClientRect().top - 8; })()`);
  await s.sleep(400);
  await s.shot('a1-activity');
  await s.eval(`(() => { const body = document.querySelector('[data-testid="task-detail"] .tb-dock-body'); const rows = [...body.querySelectorAll('[data-testid="activity-entry"]')]; const at = rows.find((r) => r.dataset.kind === 'reply' && /Quin/.test(r.innerText) && r.innerText.includes('app/README.md')); body.scrollTop += at.getBoundingClientRect().top - body.getBoundingClientRect().top - 150; })()`);
  await s.sleep(400);
  await s.shot('a1-activity-log');
  console.log(`shots in /tmp/office-shots (copy to ${SHOTS})`);
};
