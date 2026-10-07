// Employees move their own cards, with real haiku agents. Four scenarios on one scratch office:
//   1. An employee given a task finishes it and moves the card to review with a reason the owner reads in the task log.
//   2. An employee the task never reached is asked to move that card and is refused; the card stays.
//   3. The owner moves a card while its employee works; the employee's own move is refused and the owner's pin holds.
//   4. A PO delegates two pieces and moves its task to done only after both settled.
// Nothing in the notes of the first and last task mentions the tool: the persona alone has to make the agents use it.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-task-moves.mjs
// OFFICE_MOVES_WAIT_MIN caps each scenario (default 8). OFFICE_SHOTS is where moves.png goes.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAIKU, assert } from './lib.mjs';

const WAIT_MS = Number(process.env.OFFICE_MOVES_WAIT_MIN ?? 8) * 60_000;
const SHOTS = process.env.OFFICE_SHOTS ?? '/Users/feliperico/.claude/orchestrate/online-office-game/shots/a2';

const dataDir = mkdtempSync(join(tmpdir(), 'a2-data-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'a2-repo-')));
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
// Work lands on the task's own branch, whose worktree sits beside the data. A block with no branch for it gets the project folder.
const landed = (taskId, file) => existsSync(join(dataDir, 'worktrees', `task-${taskId}`, file)) || existsSync(join(repo, file));
const ledgerFile = join(dataDir, 'company.mail.jsonl');
const posts = () =>
  existsSync(ledgerFile)
    ? readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          const e = JSON.parse(l);
          return e.t === 'post' ? [e.msg] : [];
        } catch {
          return [];
        }
      })
    : [];

export const diagnose = async (s) => {
  console.log('tasks at failure:', JSON.stringify(await s.eval(`${state}.tasks`).catch(() => '?')));
  console.log('ledger tail:\n' + posts().slice(-14).map((m) => `${m.kind} ${m.from}->${m.to} ${m.outcome ?? ''} ${(m.title ?? m.text ?? '').slice(0, 120)}`).join('\n'));
  await s.shot('a2-moves-failure').catch(() => {});
};

async function unattended(s) {
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, mode: e.permissions.mode, q: e.status.kind === 'blocked_on_owner' ? e.status.question : null }))`);
  for (const p of people) {
    if (p.mode !== 'yolo') await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(p.id)}, mode: 'yolo' })`);
    if (p.q?.kind === 'permission') await s.eval(`window.office.send({ type: 'answer', employeeId: ${JSON.stringify(p.id)}, questionId: ${JSON.stringify(p.q.id)}, text: 'Yes' })`);
  }
}

// Polls a page expression until it is true, answering permission cards on the way.
async function until(s, expr, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    await unattended(s);
    if (await s.eval(expr).catch(() => false)) return;
    await s.sleep(1500);
  }
  throw new Error(`${label}: not true after ${Math.round(WAIT_MS / 1000)} s (${expr})`);
}

export default async (s) => {
  await s.resize(1440, 900);
  await s.waitFor(`!!${state}.company`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${state}.company.blocks.length === 1`);
  const blockId = await s.eval(`${state}.company.blocks[0].id`);
  for (const [name, role] of [['Pia', 'orchestrator'], ['Ana', 'employee'], ['Bruno', 'employee']]) {
    await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: ${JSON.stringify(name)}, role: ${JSON.stringify(role)} })`);
  }
  await s.waitFor(`${state}.company.employees.length === 3`, 30000);
  const id = (name) => s.eval(`${state}.company.employees.find((e) => e.name === ${JSON.stringify(name)}).id`);
  const [pia, ana, bruno] = [await id('Pia'), await id('Ana'), await id('Bruno')];
  await unattended(s);
  const boardId = await s.eval(`${state}.boards[0].id`);

  const makeTask = async (title, notes, assignee) => {
    await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(boardId)}, title: ${JSON.stringify(title)}, notes: ${JSON.stringify(notes)} })`);
    await s.waitFor(`${state}.tasks.some((t) => t.title === ${JSON.stringify(title)})`);
    const taskId = await s.eval(`${state}.tasks.find((t) => t.title === ${JSON.stringify(title)}).id`);
    await s.eval(`window.office.send({ type: 'assign_task', taskId: ${JSON.stringify(taskId)}, employeeId: ${JSON.stringify(assignee)} })`);
    await s.waitFor(`${state}.tasks.find((t) => t.id === ${JSON.stringify(taskId)}).runs.length === 1`);
    return taskId;
  };
  const task = (taskId) => s.eval(`${state}.tasks.find((t) => t.id === ${JSON.stringify(taskId)})`);
  const moves = (t) => (t.history ?? []).filter((h) => h.kind === 'stage').map((h) => `${h.by === pia ? 'Pia' : h.by === ana ? 'Ana' : h.by === bruno ? 'Bruno' : h.by}:${h.to}`);

  // 1. An employee finishes and says so on the board.
  const hello = await makeTask('Write hello.txt', 'Create hello.txt in the project folder with the single line hello.', ana);
  await until(s, `${state}.tasks.find((t) => t.id === ${JSON.stringify(hello)}).lastOutcome?.outcome === 'done'`, 'Ana finishes hello.txt');
  const first = await task(hello);
  console.log('hello stage moves:', moves(first).join(' > '));
  const toReview = (first.history ?? []).find((h) => h.kind === 'stage' && h.to === 'review');
  assert(first.stage === 'review' && toReview?.by === ana, 'the card is in review and Ana moved it herself, not the office');
  assert(typeof toReview.reason === 'string' && toReview.reason.length >= 10, `she gave a reason: ${JSON.stringify(toReview.reason)}`);
  assert(landed(hello, 'hello.txt'), 'and her work landed');
  await s.eval(`__office.store.setState({ modal: { kind: 'task_board', blockId: ${JSON.stringify(blockId)}, taskId: ${JSON.stringify(hello)} } })`);
  await s.waitFor(`!!document.querySelector('[data-testid="task-activity"] [data-testid="entry-reason"]')`, 15000);
  const shown = await s.eval(`[...document.querySelectorAll('[data-testid="activity-entry"][data-kind="stage"]')].map((e) => ({ head: e.querySelector('.tb-log-head').innerText, reason: e.querySelector('[data-testid="entry-reason"]')?.innerText ?? null }))`);
  const row = shown.find((e) => /In Review/.test(e.head));
  assert(row && /Ana/.test(row.head) && row.reason && toReview.reason.startsWith(row.reason.replace(/…$/, '').trim().slice(0, 40)), `the owner reads it in the log: "${row?.head}" and "${row?.reason}"`);
  await s.eval(`document.querySelector('[data-testid="task-activity"]').scrollIntoView({ block: 'center' })`);
  await s.sleep(500);
  await s.shot('a2-moves');
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync('/tmp/office-shots/a2-moves.png', join(SHOTS, 'moves.png'));

  // 2. Someone the task never reached tries to move it.
  const asked = posts().length;
  await s.eval(`window.office.send({ type: 'post', to: ${JSON.stringify(bruno)}, clientId: 'refuse-1', as: 'say', text: 'Call the moveTask tool once with to "done", reason "checking the board" and task "Write hello.txt". Then use the message tool with to "owner" to send me the exact JSON the tool answered with, word for word, and nothing else.' })`);
  const t0 = Date.now();
  let said;
  while (Date.now() - t0 < WAIT_MS && !said) {
    await unattended(s);
    said = posts().slice(asked).find((m) => m.from === bruno && m.kind === 'say' && /not_on_task|not yours|never given/i.test(m.text ?? ''));
    if (!said) await s.sleep(1500);
  }
  assert(!!said, `Bruno was refused and told the owner so: ${JSON.stringify((said?.text ?? '').slice(0, 160))}`);
  const after = await task(hello);
  assert(after.stage === 'review' && !moves(after).some((m) => m.startsWith('Bruno')), 'the card stayed in review and nothing is recorded under his name');

  // 3. The owner moves a card while its employee works: the pin holds.
  const pin = await makeTask(
    'Write pin.txt',
    'Create pin.txt in the project folder with the single line pin. Then call the moveTask tool once with to "review" and a reason, and in your final reply quote word for word what the tool answered.',
    ana,
  );
  await s.eval(`window.office.send({ type: 'update_task', taskId: ${JSON.stringify(pin)}, stage: 'todo' })`);
  await s.waitFor(`${state}.tasks.find((t) => t.id === ${JSON.stringify(pin)}).stagePinned === true`, 5000);
  await until(s, `${state}.tasks.find((t) => t.id === ${JSON.stringify(pin)}).lastOutcome?.outcome === 'done'`, 'Ana finishes pin.txt');
  const held = await task(pin);
  console.log('pin stage moves:', moves(held).join(' > '), '| her reply:', JSON.stringify(held.lastOutcome.text.slice(0, 200)));
  assert(held.stage === 'todo' && held.stagePinned === true, 'the card is still where the owner put it');
  assert(moves(held).join() === 'owner:doing,owner:todo', `no move is recorded under Ana's name (${moves(held).join(' > ')})`);
  assert(/pinned/.test(held.lastOutcome.text) || /put this task in todo/.test(held.lastOutcome.text), 'and her reply shows she asked and was refused');

  // 4. A PO delegates two pieces and finishes its task once both are in.
  const report = await makeTask(
    'Two small files',
    'Ask two different teammates for one file each in the project folder: one.txt with the single line one, and two.txt with the single line two. When both pieces are back and you have looked at them, the task is finished and needs no review from me.',
    pia,
  );
  await until(s, `${state}.tasks.find((t) => t.id === ${JSON.stringify(report)}).lastOutcome?.outcome === 'done'`, 'Pia finishes the task');
  const fin = await task(report);
  console.log('report stage moves:', moves(fin).join(' > '));
  const chain = posts().filter((m) => m.rootId === fin.runs[0]);
  const pieces = chain.filter((m) => m.kind === 'request' && m.from === pia && (m.intent === 'work' || m.intent === 'gauntlet'));
  const settledAt = pieces.map((p) => chain.find((m) => m.kind === 'reply' && m.requestId === p.id)?.at ?? Infinity);
  const done = (fin.history ?? []).find((h) => h.kind === 'stage' && h.to === 'done');
  assert(pieces.length >= 2, `Pia handed out ${pieces.length} pieces`);
  assert(fin.stage === 'done' && done?.by === pia, 'the card is in done and Pia moved it herself');
  assert(settledAt.every((at) => at <= done.at), 'every piece had settled before she moved it');
  assert(typeof done.reason === 'string' && done.reason.length >= 10, `with a reason: ${JSON.stringify(done.reason)}`);
  assert(!moves(fin).some((m) => m.startsWith('Ana') || m.startsWith('Bruno')), 'the people who did the pieces did not move the card');
  assert(landed(report, 'one.txt') && landed(report, 'two.txt'), 'both files landed');
};
