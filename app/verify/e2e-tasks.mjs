// Tasks end to end with real Claude agents and a fake CronoSpark. A manual task on a quick board goes to the PO, who delegates
// a piece to the one employee. A CronoSpark card does the same and its hours reach the fake server. A hire starts a task on
// its own. Then the app restarts. Time is checked against numbers computed here from mail.jsonl, not read from the app.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-tasks.mjs
// OFFICE_TASKS_WAIT_MIN caps each run of an agent (default 8).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HAIKU, assert } from './lib.mjs';
import { startFakeCronoSpark } from './fake-cronospark.ts';

const WAIT_MS = Number(process.env.OFFICE_TASKS_WAIT_MIN ?? 8) * 60_000;
const TOLERANCE_MS = 2000;
const MS_PER_HOUR = 3_600_000;

// Prefixed t1- so another worktree's cleanup of office-* scratch folders cannot delete a run in progress.
const dataDir = mkdtempSync(join(tmpdir(), 't1-data-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 't1-repo-')));
const git = (...args) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', ...args], { cwd: repo, stdio: 'pipe' }).toString();
git('init', '-q');
writeFileSync(join(repo, 'README.md'), '# scratch\n');
git('add', '-A');
git('commit', '-q', '-m', 'initial');

const fake = await startFakeCronoSpark({
  tasks: [
    { _id: 'fake-task-501', code: 'CS-501', title: 'Add crono.txt', status: 'pending', priority: 2 },
    { _id: 'fake-task-502', code: 'CS-502', title: 'Nobody works on this', status: 'in-progress', priority: 3 },
  ],
});

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '5',
  OFFICE_CLAUDE_MODEL: HAIKU,
  CRONOSPARK_MCP_URL: fake.url,
  CRONOSPARK_MCP_API_KEY: 'fake-key',
  CRONOSPARK_MCP_USER_ID: 'fake-user',
  // A fixture would send every card and every hour call to a file instead of the fake server.
  OFFICE_TASK_BOARD_FIXTURE: '',
};

const ok = (msg) => console.log('ok:', msg);
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

// What a person reading mail.jsonl would work out: for every turn that was handed a message of these chains, the time from
// its first delivery to its turn_end, per person and per local day. No code of the app is used.
function wallTime(rootIds) {
  const rootOf = new Map();
  const turns = new Map();
  for (const e of ledger()) {
    if (e.t === 'post') rootOf.set(e.msg.id, e.msg.rootId);
    else if (e.t === 'deliver') {
      const turn = turns.get(e.turn) ?? { to: e.to, start: e.at, end: null, roots: new Set() };
      turns.set(e.turn, turn);
      for (const id of e.ids) turn.roots.add(rootOf.get(id));
    } else if (e.t === 'turn_end') {
      const turn = turns.get(e.turn);
      if (turn && turn.end === null) turn.end = e.at;
    }
  }
  const total = {};
  const byDay = {};
  const day = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  for (const turn of turns.values()) {
    if (![...turn.roots].some((r) => rootIds.includes(r))) continue;
    const end = turn.end ?? Date.now();
    total[turn.to] = (total[turn.to] ?? 0) + (end - turn.start);
    for (let at = turn.start; at < end; ) {
      const d = new Date(at);
      const cut = Math.min(end, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
      byDay[`${turn.to}|${day(at)}`] = (byDay[`${turn.to}|${day(at)}`] ?? 0) + (cut - at);
      at = cut;
    }
  }
  return { total, byDay };
}

// Nobody is at the keyboard, so every employee runs in yolo mode and a permission card raised before the switch is answered.
const interventions = { modeSwitches: 0, permissionAnswers: 0 };
async function unattended(s) {
  const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, mode: e.permissions.mode, q: e.status.kind === 'blocked_on_owner' ? e.status.question : null }))`);
  for (const p of people) {
    if (p.mode !== 'yolo') {
      interventions.modeSwitches++;
      await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(p.id)}, mode: 'yolo' })`);
    }
    if (p.q?.kind === 'permission') {
      interventions.permissionAnswers++;
      await s.eval(`window.office.send({ type: 'answer', employeeId: ${JSON.stringify(p.id)}, questionId: ${JSON.stringify(p.q.id)}, text: 'Yes' })`);
    }
  }
}

async function waitForStage(s, taskId, stage, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    await unattended(s);
    const t = await s.eval(`(() => { const t = ${taskExpr(taskId)}; return t && { stage: t.stage, runs: t.runs.length, out: t.lastOutcome && { outcome: t.lastOutcome.outcome, text: t.lastOutcome.text.slice(0, 200) } }; })()`);
    if (t?.stage === stage) return t;
    if (t?.stage === 'todo' && t.out) throw new Error(`${label}: the task went back to todo (${t.out.outcome}: ${t.out.text})`);
    if ((Date.now() - t0) % 60_000 < 3100) console.log(`[${Math.round((Date.now() - t0) / 1000)} s] ${label}: ${JSON.stringify(t)}`);
    await s.sleep(3000);
  }
  throw new Error(`${label}: still not ${stage} after ${Math.round(WAIT_MS / 1000)} s`);
}

const deliverable = (file, line) =>
  `One deliverable and no acceptance bar. Send it to Ana as one plain request, not a gauntlet, and do not hire anyone. The deliverable is a file named ${file} in the project folder whose only line is: ${line}. When Ana replies done, check the file exists and reply done to the owner naming ${file}.`;

export const diagnose = async (s) => {
  console.log('tasks at failure:', JSON.stringify(await s.eval(`${state}.tasks`).catch(() => '?')));
  console.log('ledger tail:\n' + ledger().filter((e) => e.t === 'post').slice(-12).map((e) => `${e.msg.kind} ${e.msg.from}->${e.msg.to} ${(e.msg.title ?? e.msg.text ?? '').slice(0, 90)}`).join('\n'));
  console.log('fake CronoSpark calls:', JSON.stringify(fake.calls));
  await s.shot('t1-failure').catch(() => {});
};

export default async (s, { launch }) => {
  try {
    await s.waitFor(`!!${state}.company`);
    await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
    await s.waitFor(`${state}.company.blocks.length === 1`);
    const blockId = await s.eval(`${state}.company.blocks[0].id`);
    await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Pia', role: 'orchestrator' })`);
    await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Ana' })`);
    await s.waitFor(`${state}.company.employees.length === 2`);
    const people = await s.eval(`${state}.company.employees.map((e) => ({ id: e.id, name: e.name }))`);
    const nameOf = Object.fromEntries(people.map((p) => [p.id, p.name]));
    const pia = people.find((p) => p.name === 'Pia').id;
    const ana = people.find((p) => p.name === 'Ana').id;

    // ── boards ──
    const boards = await s.eval(`${state}.boards`);
    assert(boards.length === 1 && boards[0].kind === 'quick' && boards[0].blockId === blockId && boards[0].name === 'Quick tasks', 'a new block has one quick board');
    const quickId = boards[0].id;
    await s.eval(`window.office.send({ type: 'create_board', blockId: ${JSON.stringify(blockId)}, name: 'Ideas', spec: { kind: 'quick', sources: [{ provider: 'linear', projectId: 'x' }] } })`);
    await s.waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.innerText.includes('Bad message'))`);
    assert((await s.eval(`${state}.boards.length`)) === 1, 'a quick board sent with sources is refused at the door');
    await s.eval(`window.office.send({ type: 'update_board', boardId: ${JSON.stringify(quickId)}, logHours: true })`);
    await s.waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.innerText.includes('no sources and logs no hours') || t.innerText.includes('takes no sources'))`);
    assert(await s.eval(`${state}.boards[0].kind === 'quick' && !('logHours' in ${state}.boards[0])`), 'an existing quick board refuses an hours switch');

    // ── a manual task, the PO delegates ──
    await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(quickId)}, title: 'Add hello.txt', notes: ${JSON.stringify(deliverable('hello.txt', 'hello from tasks'))} })`);
    await s.waitFor(`${state}.tasks.some((t) => t.title === 'Add hello.txt')`);
    const hello = await s.eval(`${state}.tasks.find((t) => t.title === 'Add hello.txt')`);
    assert(hello.stage === 'todo' && hello.origin.kind === 'manual' && hello.boardId === quickId, 'a manual task lands in todo on the quick board');
    await s.eval(`window.office.send({ type: 'assign_task', taskId: ${JSON.stringify(hello.id)}, employeeId: ${JSON.stringify(pia)} })`);
    await s.waitFor(`${taskExpr(hello.id)}.stage === 'doing' && ${taskExpr(hello.id)}.runs.length === 1`);
    ok('assigning to the PO puts the task in doing with one run');
    await s.waitFor(`${state}.company.employees.find((e) => e.id === ${JSON.stringify(pia)}).status.kind === 'working'`, 20000);
    ok('the PO is working on it without anyone else doing anything');
    await s.waitFor(`${state}.taskTime[${JSON.stringify(hello.id)}]?.running.some((r) => r.employeeId === ${JSON.stringify(pia)})`, 20000);
    const t1 = await s.eval(`(() => { const t = ${state}.taskTime[${JSON.stringify(hello.id)}]; return { at: t.at, total: t.totalMs }; })()`);
    await s.sleep(2500);
    const t2 = await s.eval(`(() => { const t = ${state}.taskTime[${JSON.stringify(hello.id)}]; return { at: t.at, total: t.totalMs }; })()`);
    assert(t2.at > t1.at || t2.total >= t1.total, 'the snapshot carries time and the PO is running, so a screen can keep counting');

    await waitForStage(s, hello.id, 'review', 'hello.txt');
    await s.sleep(3000);
    const done = await s.eval(`(() => { const t = ${taskExpr(hello.id)}; return { assignees: t.assignees, runs: t.runs, last: t.lastOutcome?.outcome, time: ${state}.taskTime[t.id] }; })()`);
    assert(done.last === 'done', 'the work settled done and the task moved doing to review');
    assert(existsSync(join(repo, 'hello.txt')), 'hello.txt reached the block folder');
    const mine = wallTime(done.runs);
    console.log('independent wall time per person (ms):', JSON.stringify(Object.fromEntries(Object.entries(mine.total).map(([k, v]) => [nameOf[k] ?? k, v]))), '| app:', JSON.stringify(Object.fromEntries(Object.entries(done.time.byEmployee).map(([k, v]) => [nameOf[k] ?? k, v]))));
    for (const [who, ms] of Object.entries(mine.total)) assert(Math.abs((done.time.byEmployee[who] ?? 0) - ms) <= TOLERANCE_MS, `${nameOf[who] ?? who}: the app says ${done.time.byEmployee[who] ?? 0} ms, mail.jsonl says ${ms} ms (within ${TOLERANCE_MS} ms)`);
    assert((done.time.byEmployee[pia] ?? 0) > 0 && (done.time.byEmployee[ana] ?? 0) > 0, `both the PO (${done.time.byEmployee[pia]} ms) and the employee (${done.time.byEmployee[ana]} ms) have time on the task`);
    assert(Object.keys(done.time.byEmployee).every((k) => k in mine.total) && done.time.totalMs === Object.values(done.time.byEmployee).reduce((a, b) => a + b, 0), 'nobody else is billed and the total is the sum');
    assert(done.time.running.length === 0, 'nobody is running once it is in review');

    // ── a CronoSpark card, the PO delegates, hours go out ──
    await s.eval(`window.office.send({ type: 'create_board', blockId: ${JSON.stringify(blockId)}, name: 'Sprint', spec: { kind: 'feature', sources: [{ provider: 'cronospark', projectId: 'fake-project' }], logHours: true } })`);
    await s.waitFor(`${state}.tasks.some((t) => t.origin.identifier === 'CS-501') && ${state}.tasks.some((t) => t.origin.identifier === 'CS-502')`, 30000);
    const sprint = await s.eval(`${state}.boards.find((b) => b.name === 'Sprint')`);
    const card = await s.eval(`${state}.tasks.find((t) => t.origin.identifier === 'CS-501')`);
    const other = await s.eval(`${state}.tasks.find((t) => t.origin.identifier === 'CS-502')`);
    assert(card.boardId === sprint.id && card.origin.kind === 'cronospark' && card.origin.externalId === 'fake-task-501' && card.stage === 'todo' && other.stage === 'doing', 'a synced card becomes a task, staged by its status');
    assert(fake.headers.length > 0 && fake.headers.every((h) => h.authorization === 'Bearer fake-key' && h.user === 'fake-user'), 'the cards came from the fake server with its credentials, never the real one');
    await s.eval(`window.office.send({ type: 'update_task', taskId: ${JSON.stringify(card.id)}, notes: ${JSON.stringify(deliverable('crono.txt', 'hello from crono'))} })`);
    await s.eval(`window.office.send({ type: 'assign_task', taskId: ${JSON.stringify(card.id)}, employeeId: ${JSON.stringify(pia)} })`);
    await waitForStage(s, card.id, 'review', 'crono.txt');
    // The reply that moves the task to review can come in the middle of the PO's last turn. That turn's end then adds time to a
    // person-day that was already sent, and that time is due as a follow-up. So wait until every turn on the task has ended and the
    // fake server has what mail.jsonl says, and judge the sums, not how many calls it took to get there.
    const sums = () => {
      const by = {};
      for (const c of fake.calls) by[`${c.description}|${c.date}`] = (by[`${c.description}|${c.date}`] ?? 0) + c.hours;
      return by;
    };
    const keyOf = (who, date) => `${nameOf[who]} (AI employee, Online Office)|${date}`;
    const caughtUp = async () => {
      const t = await s.eval(`(() => { const t = ${taskExpr(card.id)}; return { running: ${state}.taskTime[t.id]?.running.length ?? 0, inflight: !!t.hours?.inflight }; })()`);
      if (t.running || t.inflight) return false;
      const { byDay } = wallTime((await s.eval(`${taskExpr(card.id)}.runs`)));
      const got = sums();
      return Object.keys(byDay).length >= 2 && Object.entries(byDay).every(([key, ms]) => Math.abs((got[keyOf(...key.split('|'))] ?? 0) - ms / MS_PER_HOUR) <= TOLERANCE_MS / MS_PER_HOUR + 0.0001);
    };
    const t0 = Date.now();
    while (!(await caughtUp()) && Date.now() - t0 < 60_000) await s.sleep(500);
    await s.sleep(4000);
    const cardNow = await s.eval(`${taskExpr(card.id)}`);
    const expected = wallTime(cardNow.runs);
    console.log('fake CronoSpark got:', JSON.stringify(fake.calls));
    const got = sums();
    const pairs = Object.keys(expected.byDay);
    assert(pairs.length >= 2, `the PO and the employee each worked on at least one day (${pairs.length} person-days in mail.jsonl)`);
    for (const key of pairs) {
      const [who, date] = key.split('|');
      const want = expected.byDay[key] / MS_PER_HOUR;
      const sum = got[keyOf(who, date)] ?? 0;
      const calls = fake.calls.filter((c) => c.description === `${nameOf[who]} (AI employee, Online Office)` && c.date === date);
      assert(calls.length >= 1 && calls.every((c) => c.taskId === 'fake-task-501' && c.hours > 0) && Math.abs(sum - want) <= TOLERANCE_MS / MS_PER_HOUR + 0.0001, `${nameOf[who]} on ${date}: ${calls.length} call(s) add up to ${sum.toFixed(4)} h, mail.jsonl says ${want.toFixed(4)} h`);
    }
    assert(fake.calls.every((c) => pairs.includes(`${Object.keys(nameOf).find((id) => c.description.startsWith(nameOf[id]))}|${c.date}`)), 'nothing was sent for a person-day that has no time in mail.jsonl');
    assert(new Set(fake.calls.map((c) => JSON.stringify([c.description, c.date, c.hours]))).size === fake.calls.length, 'no call repeats an earlier one: time that was sent is never sent again');
    const sent = fake.calls.length;
    await s.eval(`window.office.send({ type: 'update_task', taskId: ${JSON.stringify(card.id)}, stage: 'done' })`);
    await s.sleep(4000);
    await s.eval(`window.office.send({ type: 'refresh_board', boardId: ${JSON.stringify(sprint.id)} })`);
    await s.sleep(4000);
    assert(fake.calls.length === sent, 'a second transition and a refresh send nothing new');
    assert(!fake.calls.some((c) => c.taskId === 'fake-task-502'), 'the card nobody worked on has no hours');
    assert((await s.eval(`${taskExpr(card.id)}.hours?.error === undefined`)), 'the task shows no push error');

    // ── a hire that starts a task ──
    await s.eval(`window.office.send({ type: 'create_task', boardId: ${JSON.stringify(quickId)}, title: 'Add hire.txt', notes: 'Write a file named hire.txt in the project folder whose only line is: hello from the new hire. Reply done naming it.' })`);
    await s.waitFor(`${state}.tasks.some((t) => t.title === 'Add hire.txt')`);
    const hireTask = await s.eval(`${state}.tasks.find((t) => t.title === 'Add hire.txt')`);
    const free = await s.eval(`(() => { const st = ${state}; const taken = new Set(st.company.employees.map((e) => e.seat)); return st.building.stories.flatMap((x) => x.items).filter((i) => i.def === 'bench_desk' && i.blockId === ${JSON.stringify(blockId)} && !taken.has(i.id)).map((i) => i.id); })()`);
    const desk = free.at(-1);
    await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Cleo', taskId: ${JSON.stringify(hireTask.id)}, deskId: ${JSON.stringify(desk)} })`);
    await s.waitFor(`${state}.company.employees.some((e) => e.name === 'Cleo')`);
    const cleo = await s.eval(`${state}.company.employees.find((e) => e.name === 'Cleo')`);
    assert(cleo.seat === desk, 'the hire sits at the desk the owner chose');
    await s.waitFor(`${taskExpr(hireTask.id)}.runs.length === 1 && ${taskExpr(hireTask.id)}.assignees.includes(${JSON.stringify(cleo.id)})`, 20000);
    const run = ledger().flatMap((e) => (e.t === 'post' && e.msg.kind === 'request' && e.msg.to === cleo.id && e.msg.from === 'owner' ? [e.msg] : []))[0];
    const linked = await s.eval(`${taskExpr(hireTask.id)}.runs[0]`);
    assert(!!run && run.id === linked && run.intent === 'work' && run.title === 'Add hire.txt', 'a request from the owner with the new hire as the addressee is the task\'s run, posted by the hire itself');
    await waitForStage(s, hireTask.id, 'review', 'hire.txt');
    assert(existsSync(join(repo, 'hire.txt')), 'the new hire did the task without any further owner action');

    // ── restart ──
    const before = await s.eval(`(() => { const st = ${state}; return { tasks: st.tasks.map((t) => ({ id: t.id, stage: t.stage, runs: t.runs.length })), time: st.taskTime, boards: st.boards.length }; })()`);
    const callsBefore = fake.calls.length;
    await s.close();
    const again = await launch({ env });
    await again.waitFor('!!window.__office && !!window.office');
    await again.waitFor(`${state}.company.employees.length === 3 && ${state}.tasks.length === ${before.tasks.length}`, 30000);
    await again.sleep(6000);
    const after = await again.eval(`(() => { const st = ${state}; return { tasks: st.tasks.map((t) => ({ id: t.id, stage: t.stage, runs: t.runs.length })), time: st.taskTime, boards: st.boards.length }; })()`);
    assert(JSON.stringify(after.tasks) === JSON.stringify(before.tasks) && after.boards === before.boards, 'every task keeps its stage and runs across a restart');
    for (const id of [hello.id, card.id, hireTask.id]) {
      for (const [who, ms] of Object.entries(before.time[id].byEmployee)) assert(Math.abs((after.time[id].byEmployee[who] ?? 0) - ms) <= TOLERANCE_MS, `${nameOf[who] ?? 'Cleo'}'s time on a task survives the restart (${ms} ms before, ${after.time[id].byEmployee[who]} ms after)`);
    }
    assert(fake.calls.length === callsBefore, 'a restart sends no hours again');
    console.log(`harness interventions: ${JSON.stringify(interventions)}`);
  } finally {
    await fake.close();
  }
};

// After the driver has printed its diagnosis, which reads these folders.
process.on('exit', () => {
  for (const dir of [dataDir, repo]) rmSync(dir, { recursive: true, force: true });
});
