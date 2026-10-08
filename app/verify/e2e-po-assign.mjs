// A task nobody is assigned to, on the built app with a real Haiku PO and one employee. The task reaches the PO by itself,
// the PO hands the work out however it chooses, and the teammate it gave the work to joins the task's assignees. Nothing in
// the task tells the PO which tool to use: it may delegate with request (or a gauntlet), and the office adds Ana with an
// assign entry and no run of the owner's; or it may call assignTask, and Ana gets the owner's run for it.
// Run: pnpm build && OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-po-assign.mjs
// OFFICE_TASKS_WAIT_MIN caps the wait for the PO to delegate (default 10).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAIKU, assert } from './lib.mjs';

const WAIT_MS = Number(process.env.OFFICE_TASKS_WAIT_MIN ?? 10) * 60_000;

// Prefixed pa- so another worktree's cleanup of office-* scratch folders cannot delete a run in progress.
const dataDir = mkdtempSync(join(tmpdir(), 'pa-data-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pa-repo-')));
const git = (...args) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', ...args], { cwd: repo, stdio: 'pipe' }).toString();
git('init', '-q');
writeFileSync(join(repo, 'README.md'), '# scratch\n');
git('add', '-A');
git('commit', '-q', '-m', 'initial');

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_CLAUDE_MODEL: HAIKU, OFFICE_TASK_BOARD_FIXTURE: '', OFFICE_DEBUG: '1' };

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
let nameOf = {};
const who = (id) => nameOf[id] ?? id;
const posts = () =>
  ledger()
    .filter((e) => e.t === 'post')
    .map((e) => `post ${e.msg.kind}${e.msg.intent ? `/${e.msg.intent}` : ''} ${who(e.msg.from)} -> ${who(e.msg.to)}${e.msg.gauntlet ? ` (builder ${who(e.msg.gauntlet.builder)})` : ''}: ${(e.msg.title ?? e.msg.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`);

// Nobody is at the keyboard: every employee runs in yolo mode, and a permission card raised before the switch is answered.
async function unattended(s) {
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, mode: e.permissions.mode, q: e.status.kind === 'blocked_on_owner' ? e.status.question : null }))`);
  for (const p of people) {
    if (p.mode !== 'yolo') await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(p.id)}, mode: 'yolo' })`);
    if (p.q?.kind === 'permission') await s.eval(`window.office.send({ type: 'answer', employeeId: ${JSON.stringify(p.id)}, questionId: ${JSON.stringify(p.q.id)}, text: 'Yes' })`);
  }
}

export const diagnose = async (s) => {
  console.log('tasks at failure:', JSON.stringify(await s.eval(`${state}.tasks`).catch(() => '?')));
  console.log('ledger posts:\n' + posts().join('\n'));
  await s.shot('pa-failure').catch(() => {});
};

export default async (s) => {
  await s.waitFor(`!!${state}.company`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${state}.company.blocks.length === 1`);
  const blockId = await s.eval(`${state}.company.blocks[0].id`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Pia', role: 'orchestrator' })`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Ana' })`);
  await s.waitFor(`${state}.company.employees.length === 2`);
  await unattended(s);
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, name: e.name }))`);
  nameOf = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const pia = people.find((p) => p.name === 'Pia').id;
  const ana = people.find((p) => p.name === 'Ana').id;
  const quick = await s.eval(`${state}.boards.find((b) => b.blockId === ${JSON.stringify(blockId)}).id`);

  await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(quick)}, title: 'Add hi.txt', notes: 'A file named hi.txt in the project folder whose only line is: hi. Ana is the right person for this.' })`);
  await s.waitFor(`${state}.tasks.some((t) => t.title === 'Add hi.txt')`);
  const id = await s.eval(`${state}.tasks.find((t) => t.title === 'Add hi.txt').id`);
  await s.waitFor(`${taskExpr(id)}.assignees.join() === ${JSON.stringify(pia)} && ${taskExpr(id)}.stage === 'doing'`);
  assert(true, 'the task nobody was assigned to went to the PO by itself, in doing');
  const routed = ledger().find((e) => e.t === 'post' && e.msg.from === 'owner' && e.msg.to === pia);
  assert(!!routed && /Nobody is assigned to this task yet/.test(routed.msg.text), 'and the request the PO got says to give the work to a teammate');

  await handOut(s, id, 'hi.txt', pia);

  // The owner gives the next task to the PO directly: the request is the plain one, with no line about assigning.
  await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(quick)}, title: 'Add ho.txt', notes: 'A file named ho.txt in the project folder whose only line is: ho', assignee: ${JSON.stringify(pia)} })`);
  await s.waitFor(`${state}.tasks.some((t) => t.title === 'Add ho.txt')`);
  const ho = await s.eval(`${state}.tasks.find((t) => t.title === 'Add ho.txt').id`);
  await s.waitFor(`${taskExpr(ho)}.assignees.join() === ${JSON.stringify(pia)} && ${taskExpr(ho)}.runs.length === 1`);
  const direct = ledger().find((e) => e.t === 'post' && e.msg.from === 'owner' && e.msg.to === pia && e.msg.key?.startsWith(`task:${ho}:`));
  assert(!!direct && !/Nobody is assigned to this task yet/.test(direct.msg.text), 'a task the owner gives the PO directly carries no line about assigning');
  await handOut(s, ho, 'ho.txt', pia);

  // The PO is told to delegate with a plain request. The office, not the PO, makes Ana an assignee.
  await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(quick)}, title: 'Add hey.txt', notes: 'Send it to Ana as one plain request and do not use assignTask. The deliverable is a file named hey.txt in the project folder whose only line is: hey.' })`);
  await s.waitFor(`${state}.tasks.some((t) => t.title === 'Add hey.txt')`);
  const hey = await s.eval(`${state}.tasks.find((t) => t.title === 'Add hey.txt').id`);
  await s.waitFor(`${taskExpr(hey)}.assignees.join() === ${JSON.stringify(pia)}`);
  const how = await handOut(s, hey, 'hey.txt', pia, ana);
  assert(how === 'request', 'hey.txt: the PO delegated with request, and the office alone made Ana an assignee');
  console.log('ledger posts:\n' + posts().join('\n'));
};

// Waits for the PO to hand the task's work to a teammate (`wanted`, or anyone but the PO), by its own request or gauntlet,
// or by assignTask, and checks that the teammate joined. The PO may hire someone for it: they count as a teammate.
async function handOut(s, id, label, pia, wanted) {
  const fits = (to) => !!to && to !== pia && to !== 'owner' && (!wanted || to === wanted);
  const t0 = Date.now();
  let delegated;
  let mate;
  while (Date.now() - t0 < WAIT_MS) {
    await unattended(s);
    const roots = (await s.eval(taskExpr(id))).runs;
    delegated =
      ledger().find((e) => e.t === 'post' && e.msg.kind === 'request' && e.msg.from === pia && roots.includes(e.msg.rootId) && ((e.msg.intent === 'work' && fits(e.msg.to)) || (e.msg.intent === 'gauntlet' && fits(e.msg.gauntlet?.builder)))) ??
      ledger().find((e) => e.t === 'post' && e.msg.kind === 'request' && e.msg.from === 'owner' && fits(e.msg.to) && e.msg.key?.startsWith(`task:${id}:`));
    mate = delegated && (delegated.msg.intent === 'gauntlet' ? delegated.msg.gauntlet.builder : delegated.msg.to);
    if (mate && (await s.eval(`${taskExpr(id)}.assignees`)).includes(mate)) break;
    await s.sleep(2000);
  }
  nameOf = Object.fromEntries((await s.eval(`${state}.company.employees.map((e) => [e.id, e.name])`)));
  console.log(`${label}: waited ${Math.round((Date.now() - t0) / 1000)} s for the hand-out`);
  const byRequest = delegated?.msg.from === pia;
  assert(!!delegated, `${label}: the PO handed the work to ${who(mate)} with ${byRequest ? `its own ${delegated.msg.intent} request` : `assignTask, so the owner's run went to ${who(mate)}`}`);
  const task = await s.eval(taskExpr(id));
  console.log(`${label} assignees:`, JSON.stringify(task.assignees.map(who)), '| history:', JSON.stringify((task.history ?? []).map((h) => (h.kind === 'assign' ? `assign ${who(h.employeeId)} by ${who(h.by)}` : `${h.kind} ${h.from ?? ''}->${h.to ?? ''}`))));
  assert(task.assignees.includes(pia) && task.assignees.includes(mate), `${label}: ${who(mate)} joined the task's assignees beside the PO`);
  const ownerRuns = ledger().filter((e) => e.t === 'post' && e.msg.from === 'owner' && e.msg.to === mate && e.msg.key?.startsWith(`task:${id}:`)).length;
  if (byRequest) {
    const entry = (task.history ?? []).find((h) => h.kind === 'assign' && h.employeeId === mate);
    assert(!!entry && entry.by === pia && entry.cause === delegated.msg.id, `${label}: with an assign entry by the PO pointing at the request that gave ${who(mate)} the work`);
    assert(ownerRuns === 0 && task.runs.length === 1, `${label}: and no run of the owner's was posted for ${who(mate)}`);
  } else {
    assert(ownerRuns === 1 && task.runs.includes(delegated.msg.id), `${label}: with exactly one run of the owner's for ${who(mate)}, the one assignTask posted`);
  }
  return byRequest ? 'request' : 'assignTask';
}

process.on('exit', () => {
  for (const dir of [dataDir, repo]) rmSync(dir, { recursive: true, force: true });
});
