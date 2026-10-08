// A task changes hands when the person on it and the PO agree, end to end with real Claude agents. Ana is given a task that
// says it is Bob's, proposes handing it to Bob and stops, the PO agrees, and the card is Bob's: Ana leaves the assignees, her
// run is cancelled (when she asks), Bob gets a run and finishes it on the task branch. Nothing here calls the handoff tools:
// the agents do.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9343 node verify/cdp.mjs verify/e2e-handoff.mjs
// OFFICE_TASKS_WAIT_MIN caps each wait on the agents (default 8).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAIKU, assert } from './lib.mjs';

const WAIT_MS = Number(process.env.OFFICE_TASKS_WAIT_MIN ?? 8) * 60_000;

const dataDir = mkdtempSync(join(tmpdir(), 'h1-data-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'h1-repo-')));
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
};

const state = '__office.store.getState()';
const taskExpr = (id) => `${state}.tasks.find((t) => t.id === ${JSON.stringify(id)})`;
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
const posts = () => ledger().filter((e) => e.t === 'post').map((e) => e.msg);

async function unattended(s) {
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, mode: e.permissions.mode, q: e.status.kind === 'blocked_on_owner' ? e.status.question : null }))`);
  for (const p of people) {
    if (p.mode !== 'yolo') await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(p.id)}, mode: 'yolo' })`);
    if (p.q?.kind === 'permission') await s.eval(`window.office.send({ type: 'answer', employeeId: ${JSON.stringify(p.id)}, questionId: ${JSON.stringify(p.q.id)}, text: 'Yes' })`);
  }
}

async function until(s, expr, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    await unattended(s);
    if (await s.eval(expr)) return;
    if ((Date.now() - t0) % 60_000 < 3100) console.log(`[${Math.round((Date.now() - t0) / 1000)} s] waiting: ${label}`);
    await s.sleep(3000);
  }
  throw new Error(`${label}: not after ${Math.round(WAIT_MS / 1000)} s`);
}

const NOTES =
  'Bob owns everything about billing in this project, so this task is his. If you are not Bob, do not do any of the work: hand the task to Bob with handoffTask, giving "Bob owns billing" as the reason, and end your turn. ' +
  'The deliverable is a file named billing.txt in the project folder whose only line is: billing by bob';

export const diagnose = async (s) => {
  console.log('tasks at failure:', JSON.stringify(await s.eval(`${state}.tasks`).catch(() => '?')));
  console.log('ledger tail:\n' + posts().slice(-16).map((m) => `${m.kind} ${m.from}->${m.to} ${(m.title ?? m.text ?? m.outcome ?? '').slice(0, 120)}`).join('\n'));
  await s.shot('h1-failure').catch(() => {});
};

export default async (s) => {
  await s.waitFor(`!!${state}.company`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${state}.company.blocks.length === 1`);
  const blockId = await s.eval(`${state}.company.blocks[0].id`);
  for (const [name, role] of [['Pia', 'orchestrator'], ['Ana', 'employee'], ['Bob', 'employee']]) {
    await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: ${JSON.stringify(name)}, role: ${JSON.stringify(role)} })`);
  }
  await s.waitFor(`${state}.company.employees.length === 3`);
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, name: e.name }))`);
  const idOf = Object.fromEntries(people.map((p) => [p.name, p.id]));
  const { Pia: pia, Ana: ana, Bob: bob } = idOf;
  await unattended(s);

  const boardId = await s.eval(`${state}.boards[0].id`);
  await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(boardId)}, title: 'Add billing.txt', notes: ${JSON.stringify(NOTES)} })`);
  await s.waitFor(`${state}.tasks.some((t) => t.title === 'Add billing.txt')`);
  const task = await s.eval(`${state}.tasks.find((t) => t.title === 'Add billing.txt')`);
  await s.eval(`window.office.send({ type: 'assign_task', taskId: ${JSON.stringify(task.id)}, employeeId: ${JSON.stringify(ana)} })`);
  await s.waitFor(`${taskExpr(task.id)}.runs.length === 1 && ${taskExpr(task.id)}.assignees[0] === ${JSON.stringify(ana)}`);
  const anaRun = await s.eval(`${taskExpr(task.id)}.runs[0]`);

  await until(s, `(() => { const t = ${taskExpr(task.id)}; return t.assignees.length === 1 && t.assignees[0] === ${JSON.stringify(bob)}; })()`, 'the task is Bob\'s');
  const moved = await s.eval(`${taskExpr(task.id)}`);
  const steps = (moved.history ?? []).filter((h) => h.kind === 'handoff');
  console.log('handoff history:', JSON.stringify(steps));
  const proposed = steps.find((h) => h.step === 'proposed');
  const accepted = steps.find((h) => h.step === 'accepted');
  assert(proposed && proposed.by === ana && proposed.from === ana && proposed.to === bob, 'Ana proposed handing the task to Bob herself');
  assert(accepted && accepted.by === pia && accepted.handoff === proposed.handoff, 'the PO accepted that same proposal');
  assert(!moved.handoff, 'no proposal is left open on the task');
  assert(moved.runs.length === 2 && moved.runs[0] === anaRun, 'Bob got a run of his own next to Ana\'s');
  const mail = posts();
  const settled = mail.find((m) => m.kind === 'reply' && m.requestId === anaRun);
  assert(settled, `Ana's run is settled (${settled?.outcome})`);
  const bobRun = mail.find((m) => m.id === moved.runs[1]);
  assert(bobRun?.kind === 'request' && bobRun.to === bob && /Ana/.test(bobRun.text) && /billing/i.test(bobRun.text), 'Bob\'s run says Ana handed the task over and carries the task');
  const ask = mail.find((m) => m.kind === 'say' && m.from === 'mailroom' && m.to === pia && m.text.includes(proposed.handoff));
  assert(ask, 'the office asked the PO in the mail, with the proposal id');

  await until(s, `(() => { const t = ${taskExpr(task.id)}; return t.lastOutcome && t.lastOutcome.reply !== ${JSON.stringify(settled.id)} && (t.stage === 'review' || t.stage === 'done' || t.stage === 'todo'); })()`, 'Bob\'s run settles');
  const end = await s.eval(`(() => { const t = ${taskExpr(task.id)}; return { stage: t.stage, out: t.lastOutcome, git: t.git, assignees: t.assignees }; })()`);
  assert(end.out.outcome === 'done' && end.stage === 'review', `Bob finished: ${end.stage}, ${end.out.outcome}: ${end.out.text.slice(0, 160)}`);
  assert(end.assignees.length === 1 && end.assignees[0] === bob, 'the card still shows only Bob');
  assert(git('show', `${end.git.branch}:billing.txt`).trim() === 'billing by bob', `billing.txt is on the task branch ${end.git.branch}`);

  const chatter = posts().filter((m) => m.kind === 'say' && [ana, pia, 'mailroom'].includes(m.from) && [ana, pia].includes(m.to) && m.at >= proposed.at);
  console.log(`says between Ana and the PO after the proposal: ${chatter.length}`);
  assert(chatter.length <= 8, `Ana and the PO do not talk in circles about it (${chatter.length} messages)`);
};

process.on('exit', () => {
  for (const dir of [dataDir, repo]) rmSync(dir, { recursive: true, force: true });
});
