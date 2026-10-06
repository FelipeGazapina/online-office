// No model, no Electron. Tasks and boards: the pure rules in shared/tasks.ts, the Tasks store on a real mailroom, and the
// real Office on a scripted harness. Time and hours are checked against numbers computed here from the ledger.
// Run from app/: node verify/task-check.ts   Exits 1 on any failed check.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlockId, EmployeeId, TaskCard } from '../src/shared/protocol.ts';
import type { LedgerEntry, MessageId, TurnId } from '../src/shared/mail.ts';
import {
  closedDayWork,
  emptyTurnLog,
  ensureBoards,
  foldTurn,
  hoursDue,
  localDate,
  makeBoard,
  moveMark,
  newTask,
  outcomeFromRuns,
  patchBoard,
  stageOfStatus,
  syncCards,
  timesOf as timesOfTasks,
  totalWorkedMs,
  turnLogOf,
  workedMs,
  type Board,
  type BoardId,
  type RunState,
  type Task,
  type TaskId,
  type TaskTime,
} from '../src/shared/tasks.ts';
import { Office } from '../src/main/office/company.ts';
import { OfficeError } from '../src/main/office/error.ts';
import { HARNESSES } from '../src/main/office/adapters/index.ts';
import type { SessionHost } from '../src/main/office/adapters/types.ts';
import { startOfficeMcp } from '../src/main/office/mcp.ts';
import { MemoryStore } from '../src/main/office/memory.ts';
import { TaskBoardService, type HoursCall } from '../src/main/office/task-board.ts';
import { Tasks, type TasksHost } from '../src/main/office/tasks.ts';
import { check, finish, sleep, until } from './check.ts';
import { startFakeCronoSpark } from './fake-cronospark.ts';
import { ANA, B1, B2, BRUNO, PO, world } from './mail-world.ts';

const e = (s: string) => s as EmployeeId;
const m = (s: string) => s as MessageId;
const tid = (s: string) => s as TurnId;
const task = (s: string) => s as TaskId;
const board = (s: string) => s as BoardId;

// ───────────────────────────── a ledger by hand ─────────────────────────────

const post = (id: string, root: string, at: number, to = 'ana'): LedgerEntry => ({
  t: 'post',
  msg: { id: m(id), rootId: m(root), parentId: id === root ? null : m(root), from: 'owner', to: e(to), at, hops: 0, kind: 'request', intent: 'work', title: id, text: id },
});
const deliver = (ids: string[], to: string, turn: string, at: number): LedgerEntry => ({ t: 'deliver', ids: ids.map(m), to: e(to), turn: tid(turn), at });
const end = (turn: string, at: number): LedgerEntry => ({ t: 'turn_end', turn: tid(turn), at });
// The tests name their tasks with plain letters.
const timesOf = (...a: Parameters<typeof timesOfTasks>) => timesOfTasks(...a) as Record<string, TaskTime>;
const t = (id: string, ...runs: string[]) => ({ id: task(id), runs: runs.map(m) });

console.log('# time is a fold of the ledger');
{
  const one = timesOf([t('A', 'r1')], turnLogOf([post('r1', 'r1', 0), deliver(['r1'], 'ana', 't1', 10), end('t1', 70)]), 1000).A!;
  check(one.byEmployee[e('ana')] === 60 && one.totalMs === 60 && one.running.length === 0, 'a turn counts for its actor from deliver to turn_end', JSON.stringify(one));

  const batched = timesOf(
    [t('A', 'r1'), t('B', 'r2')],
    turnLogOf([post('r1', 'r1', 0), post('r2', 'r2', 0), deliver(['r1', 'r2'], 'ana', 't1', 0), end('t1', 100)]),
    1000,
  );
  check(batched.A!.totalMs === 50 && batched.B!.totalMs === 50, 'a turn batching two tasks splits its interval evenly', JSON.stringify(batched));
  check(batched.A!.totalMs + batched.B!.totalMs === 100, 'no minute is billed twice: the tasks add up to the turn');

  const three = timesOf(
    [t('A', 'r1'), t('B', 'r2'), t('C', 'r3')],
    turnLogOf([post('r1', 'r1', 0), post('r2', 'r2', 0), post('r3', 'r3', 0), deliver(['r1', 'r2', 'r3'], 'ana', 't1', 0), end('t1', 90)]),
    1000,
  );
  check([three.A!, three.B!, three.C!].every((x) => x.totalMs === 30), 'three tasks in one turn get a third each');

  const twoRuns = timesOf([t('A', 'r1', 'r2')], turnLogOf([post('r1', 'r1', 0), post('r2', 'r2', 0), deliver(['r1', 'r2'], 'ana', 't1', 0), end('t1', 100)]), 1000);
  check(twoRuns.A!.totalMs === 100, 'two runs of one task in the same turn are one task, not two shares');

  // PO takes the root (turn 1), delegates a child (root inherited) to Ana, Ana works, the reply wakes the PO again.
  const chain = turnLogOf([
    post('r1', 'r1', 0, 'po'),
    deliver(['r1'], 'po', 't1', 0),
    post('c1', 'r1', 20, 'ana'),
    deliver(['c1'], 'ana', 't2', 25),
    end('t1', 40),
    end('t2', 85),
    post('p1', 'r1', 85, 'po'),
    deliver(['p1'], 'po', 't3', 90),
    end('t3', 100),
  ]);
  const delegated = timesOf([t('A', 'r1')], chain, 1000).A!;
  check(delegated.byEmployee[e('po')] === 50 && delegated.byEmployee[e('ana')] === 60 && delegated.totalMs === 110, 'a delegated child counts for the child\'s actor, and the PO counts for every turn on the chain', JSON.stringify(delegated));

  const open = turnLogOf([post('r1', 'r1', 0), deliver(['r1'], 'ana', 't1', 100)]);
  const at500 = timesOf([t('A', 'r1')], open, 500).A!;
  const at900 = timesOf([t('A', 'r1')], open, 900).A!;
  check(at500.byEmployee[e('ana')] === 400 && at900.byEmployee[e('ana')] === 800, 'an open turn counts until now', JSON.stringify([at500, at900]));
  check(at500.running.length === 1 && at500.running[0]!.employeeId === e('ana') && at500.running[0]!.share === 1 && at500.at === 500, 'and the person is running, so a screen can keep counting');

  const shared = timesOf([t('A', 'r1'), t('B', 'r2')], turnLogOf([post('r1', 'r1', 0), post('r2', 'r2', 0), deliver(['r1', 'r2'], 'ana', 't1', 0)]), 200);
  check(shared.A!.running[0]!.share === 0.5 && shared.A!.totalMs === 100, 'an open turn on two tasks runs at half speed on each');
  check(workedMs(at500, e('ana'), 800) === 700 && totalWorkedMs(at500, 800) === 700 && workedMs(at500, e('po'), 800) === 0, 'a screen counts on from when the time was measured');
  check(workedMs(shared.A!, e('ana'), 400) === 200 && totalWorkedMs(shared.B!, 400) === 200, 'and counts at half speed while the turn is split');
  check(workedMs(one, e('ana'), 9999) === 60 && totalWorkedMs(one, 9999) === 60, 'and stops counting for someone who is not running');

  // A message that reaches a turn in the middle (the agent read its inbox) is billed from then on.
  const mid = timesOf(
    [t('A', 'r1'), t('B', 'r2')],
    turnLogOf([post('r1', 'r1', 0), post('r2', 'r2', 40), deliver(['r1'], 'ana', 't1', 0), deliver(['r2'], 'ana', 't1', 40), end('t1', 100)]),
    1000,
  );
  check(mid.A!.totalMs === 70 && mid.B!.totalMs === 30, 'a task that arrives mid-turn is billed from its arrival, the first task keeps the rest', JSON.stringify(mid));

  const other = timesOf([t('A', 'r1')], turnLogOf([post('x', 'x', 0), deliver(['x'], 'ana', 't1', 0), end('t1', 50)]), 1000).A!;
  check(other.totalMs === 0 && Object.keys(other.byEmployee).length === 0, 'a turn serving something else is not the task\'s time');

  // The app died inside a turn. Nobody worked while it was closed.
  const crashed = turnLogOf([post('r1', 'r1', 0), deliver(['r1'], 'ana', 't1', 10), post('z', 'z', 300), { t: 'recover', at: 90_000 }]);
  check(timesOf([t('A', 'r1')], crashed, 99_999).A!.byEmployee[e('ana')] === 290, 'a turn the process died in ends at the last moment the ledger was alive');

  const ledger = [post('r1', 'r1', 0), deliver(['r1'], 'ana', 't1', 10), deliver(['r1'], 'ana', 't1', 10), end('t1', 70), end('t1', 70)];
  check(JSON.stringify(timesOf([t('A', 'r1')], turnLogOf([...ledger, ...ledger]), 1000)) === JSON.stringify(timesOf([t('A', 'r1')], turnLogOf(ledger), 1000)), 'replaying entries changes nothing');
  const stepwise = emptyTurnLog();
  for (const entry of ledger) foldTurn(stepwise, entry);
  check(JSON.stringify(timesOf([t('A', 'r1')], stepwise, 1000)) === JSON.stringify(timesOf([t('A', 'r1')], turnLogOf(ledger), 1000)), 'entry by entry gives what the whole ledger gives');
}

console.log('\n# the mailroom hands the root down the chain');
{
  let clock = 1_000_000;
  const w = world([], undefined, () => clock);
  const root = w.room.post({ from: 'owner', to: 'po', blockId: B1, body: { kind: 'request', text: 'ship csv' }, key: 'run' });
  if (!root.ok) throw new Error('post refused');
  clock += 20_000;
  const child = w.room.post({ from: PO, to: 'Ana', body: { kind: 'request', text: 'backend' } });
  if (!child.ok) throw new Error('child refused');
  clock += 40_000;
  w.room.turnEnded(PO, 'delegated', true);
  clock += 50_000;
  w.room.turnEnded(ANA, 'backend done', true);
  clock += 10_000;
  w.room.turnEnded(PO, 'shipped', true);
  const times = timesOf([{ id: task('A'), runs: [root.id] }], turnLogOf(w.persisted), clock).A!;
  // Computed straight from the entries, the way a person reading mail.jsonl would.
  const wall = (who: string) => {
    let sum = 0;
    const started = new Map<string, number>();
    for (const x of w.persisted) {
      if (x.t === 'deliver' && x.to === who && !started.has(x.turn)) started.set(x.turn, x.at);
      if (x.t === 'turn_end' && started.has(x.turn)) sum += x.at - started.get(x.turn)!;
    }
    return sum;
  };
  check(w.room.state.messages.get(child.id)!.rootId === root.id, 'a child request carries the root of the request being served');
  check(times.byEmployee[PO] === wall(PO) && times.byEmployee[ANA] === wall(ANA), `PO ${times.byEmployee[PO]} ms and Ana ${times.byEmployee[ANA]} ms equal the deliver-to-turn_end wall time`, JSON.stringify([wall(PO), wall(ANA)]));
  check(times.byEmployee[PO]! > 0 && times.byEmployee[ANA]! > 0 && times.totalMs === times.byEmployee[PO]! + times.byEmployee[ANA]!, 'the task has hours for both people and the total is their sum');
}

console.log('\n# boards');
{
  const src = [{ provider: 'cronospark' as const, projectId: 'p1', label: 'Sprint' }];
  const made = ensureBoards([B1, B2], [], [{ blockId: B1, sources: src }], (() => { let n = 0; return () => board(`b${++n}`); })());
  const mine = made.boards.filter((b) => b.blockId === B1);
  check(mine.length === 2 && mine[0]!.kind === 'feature' && mine[0]!.name === 'Tasks' && mine[1]!.kind === 'quick' && mine[1]!.name === 'Quick tasks', 'a block with old sources gets a Tasks feature board, then a quick board', JSON.stringify(mine));
  check(mine[0]!.kind === 'feature' && JSON.stringify(mine[0]!.sources) === JSON.stringify(src) && mine[0]!.logHours, 'the migrated board keeps the old sources and logs hours');
  const plain = made.boards.filter((b) => b.blockId === B2);
  check(plain.length === 1 && plain[0]!.kind === 'quick', 'a block without sources gets just a quick board');
  const again = ensureBoards([B1, B2], made.boards, [{ blockId: B1, sources: src }], () => board('x'));
  check(!again.changed && again.boards.length === 3, 'migrating twice makes nothing twice');
  check(ensureBoards([B2], made.boards, [], () => board('x')).boards.every((b) => b.blockId === B2), 'boards of a block that is gone are dropped');

  const quick = makeBoard(board('q'), B1, ' Ideas ', { kind: 'quick', sources: src } as never);
  check(quick.ok && quick.board.name === 'Ideas' && quick.board.kind === 'quick' && !('sources' in quick.board) && !('logHours' in quick.board), 'a quick board is built without sources even when handed some');
  const q = quick.ok ? quick.board : undefined!;
  const refusedSources = patchBoard(q, { sources: src });
  const refusedHours = patchBoard(q, { logHours: true });
  check(!refusedSources.ok && !refusedHours.ok, 'a quick board refuses sources and hours when updated', JSON.stringify([refusedSources, refusedHours]));
  const renamed = patchBoard(q, { name: 'Head' });
  check(renamed.ok && renamed.board.name === 'Head', 'a quick board still renames');
  const feat = makeBoard(board('f'), B1, 'Sprint', { kind: 'bug', sources: src, logHours: false });
  check(feat.ok && feat.board.kind === 'bug' && patchBoard(feat.board, { logHours: true }).ok, 'feature and bug boards take sources and the hours switch');
  check(!makeBoard(board('f'), B1, 'x', { kind: 'feature', sources: [{ provider: 'linear', projectId: ' ' }], logHours: true }).ok, 'a source needs a project id');
  check(!makeBoard(board('f'), B1, 'x', { kind: 'feature', sources: [src[0]!, src[0]!], logHours: true }).ok, 'a source cannot be listed twice');
  check(!makeBoard(board('f'), B1, '  ', { kind: 'quick' }).ok, 'a board needs a name');
}

console.log('\n# the mail moves the stage');
{
  const base = (over: Partial<Task> = {}): Task => ({ ...newTask({ id: task('A'), boardId: board('b'), title: 'x', origin: { kind: 'manual' }, stage: 'doing', now: 0 }), runs: [m('r1'), m('r2')], ...over });
  const settled = (reply: string, outcome: Extract<RunState, { s: 'settled' }>['outcome'], at: number): RunState => ({ s: 'settled', reply: m(reply), outcome, text: `${outcome} ${reply}`, at });
  const states = (map: Record<string, RunState>) => (run: MessageId) => map[run];
  const done = outcomeFromRuns(base(), states({ r1: settled('p1', 'done', 10), r2: settled('p2', 'done', 20) }));
  check(done?.stage === 'review' && done.lastOutcome.reply === m('p2'), 'every run settled and the latest done: review');
  const failed = outcomeFromRuns(base(), states({ r1: settled('p1', 'done', 10), r2: settled('p2', 'blocked', 20) }));
  check(failed?.stage === 'todo' && failed.lastOutcome.outcome === 'blocked' && failed.lastOutcome.text === 'blocked p2', 'the latest blocked: back to todo with the outcome kept');
  for (const outcome of ['failed', 'declined', 'cancelled'] as const) check(outcomeFromRuns(base(), states({ r1: settled('p1', outcome, 10), r2: settled('p2', outcome, 20) }))?.stage === 'todo', `${outcome} sends it back to todo`);
  check(outcomeFromRuns(base(), states({ r1: settled('p1', 'done', 10), r2: { s: 'open' } })) === undefined, 'a run still open keeps it in doing');
  const taken = done!;
  check(outcomeFromRuns(base({ lastOutcome: taken.lastOutcome }), states({ r1: settled('p1', 'done', 10), r2: settled('p2', 'done', 20) })) === undefined, 'the same reply moves it only once, so the owner can put it back to doing');
  const moved = outcomeFromRuns(base({ stage: 'done' }), states({ r1: settled('p1', 'done', 10), r2: settled('p2', 'done', 20) }));
  check(moved !== undefined && moved.stage === undefined && moved.lastOutcome.outcome === 'done', 'a stage the owner chose stays, and the outcome is still recorded');
  check(outcomeFromRuns(base({ runs: [] }), states({})) === undefined, 'a task with no runs has no mail to follow');
  check(stageOfStatus('In Progress') === 'doing' && stageOfStatus('Ready to Review') === 'review' && stageOfStatus('completed') === 'done' && stageOfStatus('pending') === 'todo' && stageOfStatus('Waiting on vendor') === 'todo' && stageOfStatus('in-approval') === 'review', 'provider statuses map to stages');
}

console.log('\n# provider cards become tasks');
{
  const b: Board = { id: board('b'), blockId: B1, name: 'Sprint', kind: 'feature', sources: [{ provider: 'cronospark', projectId: 'p' }], logHours: true };
  const card = (n: number, status: string, title = `Card ${n}`): TaskCard => ({ id: `cronospark:x${n}`, provider: 'cronospark', externalId: `x${n}`, identifier: `CS-${n}`, title, status, sourceLabel: 'CronoSpark' });
  let n = 0;
  const newId = () => task(`t${++n}`);
  const first = syncCards(b, [], [card(1, 'pending'), card(2, 'in-progress'), card(1, 'pending')], { now: 5, complete: true, newId });
  check(first.tasks.length === 2 && first.tasks[0]!.stage === 'todo' && first.tasks[1]!.stage === 'doing', 'cards become tasks (a card listed twice is one), staged by their status');
  check(first.tasks[0]!.origin.kind === 'cronospark' && first.tasks[0]!.origin.externalId === 'x1' && first.tasks[0]!.origin.identifier === 'CS-1', 'the task keeps where it came from');
  const again = syncCards(b, first.tasks, [card(1, 'pending'), card(2, 'in-progress')], { now: 6, complete: true, newId });
  check(!again.changed && again.tasks.length === 2 && again.tasks.every((x, i) => x === first.tasks[i]), 'the same cards change nothing');
  const manual = newTask({ id: task('m'), boardId: b.id, title: 'mine', origin: { kind: 'manual' }, stage: 'todo', now: 1 });
  const worked: Task = { ...first.tasks[0]!, runs: [m('r1')], stage: 'doing' };
  const next = syncCards(b, [worked, first.tasks[1]!, manual], [card(1, 'completed', 'Card 1 renamed'), card(2, 'Done')], { now: 7, complete: true, newId });
  check(next.tasks.find((x) => x.id === worked.id)!.stage === 'doing' && next.tasks.find((x) => x.id === worked.id)!.title === 'Card 1 renamed', 'a card\'s status maps to stage only while the task has no runs; its title still follows');
  check(next.tasks.find((x) => x.id === first.tasks[1]!.id)!.stage === 'done', 'a task with no runs follows its card to done');
  const pinned: Task = { ...first.tasks[0]!, stage: 'review', stagePinned: true };
  const kept = syncCards(b, [pinned, first.tasks[1]!], [card(1, 'pending'), card(2, 'Done')], { now: 7, complete: true, newId });
  check(kept.tasks.find((x) => x.id === pinned.id)!.stage === 'review', 'a stage the owner pinned is not overridden by the card, though the task has no runs');
  check(kept.tasks.find((x) => x.id === first.tasks[1]!.id)!.stage === 'done', 'and a card the owner never moved keeps following its status');
  const vanished = syncCards(b, [worked, first.tasks[1]!, manual], [], { now: 8, complete: true, newId });
  check(vanished.tasks.length === 2 && vanished.tasks.some((x) => x.id === worked.id) && vanished.tasks.some((x) => x.id === manual.id), 'a card gone upstream drops its task unless it has runs; manual tasks stay');
  const partial = syncCards(b, [worked, first.tasks[1]!], [], { now: 8, complete: false, newId });
  check(partial.tasks.length === 2, 'a source that failed cannot empty the board');
  const other: Board = { ...b, id: board('b2') };
  check(syncCards(other, first.tasks, [], { now: 9, complete: true, newId }).tasks.length === 2, 'a board only touches its own tasks');
}

console.log('\n# hours are sent once');
{
  const day = (h: number, min = 0) => new Date(2026, 9, 6, h, min).getTime();
  const slice = (who: string, from: number, to: number, share = 1) => ({ employeeId: e(who), from, to, share, open: false });
  const work = closedDayWork([slice('ana', day(10), day(11)), slice('ana', day(11), day(11, 30)), slice('po', day(10), day(10, 30), 0.5)]);
  check(work.length === 2 && work[0]!.employeeId === e('ana') && work[0]!.ms === 5_400_000 && work[1]!.ms === 900_000, 'closed time adds up per person and day, a share counts for its part', JSON.stringify(work));
  check(closedDayWork([{ ...slice('ana', day(10), day(11)), open: true }]).length === 0, 'an open stretch is not pushed');
  const late = closedDayWork([slice('ana', day(23, 30), new Date(2026, 9, 7, 0, 30).getTime())]);
  check(late.length === 2 && late[0]!.date === '2026-10-06' && late[0]!.ms === 1_800_000 && late[1]!.date === '2026-10-07' && late[1]!.ms === 1_800_000, 'a stretch over midnight is cut at midnight into two days', JSON.stringify(late));
  check(localDate(day(9)) === '2026-10-06', 'the day is the local one');

  const fresh = newTask({ id: task('A'), boardId: board('b'), title: 'x', origin: { kind: 'cronospark', externalId: 'x1', identifier: 'CS-1', providerStatus: 'pending', sourceLabel: 'CronoSpark' }, stage: 'review', now: 0 });
  const due = hoursDue(fresh, work);
  check(due.length === 2 && due[0]!.hours === 1.5 && due[1]!.hours === 0.25, 'hours due are the time not sent yet', JSON.stringify(due));
  const sent = due.reduce<Task>((acc, d) => ({ ...acc, hours: moveMark(acc.hours, d, 1) }), fresh);
  check(hoursDue(sent, work).length === 0, 'once the mark moved, the same time is not due again');
  const more = closedDayWork([slice('ana', day(10), day(11)), slice('ana', day(11), day(11, 30)), slice('ana', day(12), day(12, 6)), slice('po', day(10), day(10, 30), 0.5)]);
  const rest = hoursDue(sent, more);
  check(rest.length === 1 && rest[0]!.employeeId === e('ana') && rest[0]!.hours === 0.1, 'new time is due on top of the mark', JSON.stringify(rest));
  const back = due.reduce<Task>((acc, d) => ({ ...acc, hours: moveMark(acc.hours, d, -1) }), sent);
  check(hoursDue(back, work).length === 2, 'taking a failed push\'s time back makes it due again');
  const tiny = hoursDue(fresh, closedDayWork([slice('ana', day(10), day(10) + 5)]));
  check(tiny.length === 0, 'less than a tenth of a second is not worth a call');
  check(hoursDue(fresh, closedDayWork([slice('ana', day(0), day(23, 59))]))[0]!.hours <= 24, 'an entry never exceeds the 24 hours CronoSpark takes');
}

// ───────────────────────────── the store on a real mailroom ─────────────────────────────

class FakeProvider {
  cards: TaskCard[] = [];
  errors: string[] = [];
  calls: HoursCall[] = [];
  failing = 0;
  async fetchSources() {
    return { cards: this.cards, errors: this.errors };
  }
  async logHours(entry: HoursCall) {
    if (this.failing > 0) {
      this.failing--;
      throw new Error('CronoSpark is down');
    }
    this.calls.push(entry);
  }
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'task-check-')));
const T0 = new Date(2026, 9, 6, 10, 0, 0).getTime();

function taskWorld(file = join(dir, `tasks-${Math.random().toString(36).slice(2)}.json`), ledger: LedgerEntry[] = []) {
  let now = T0;
  const w = world(ledger, undefined, () => now);
  const provider = new FakeProvider();
  let ids = 0;
  const host: TasksHost = {
    now: () => now,
    newId: () => `id${++ids}`,
    mail: () => w.room,
    blocks: () => [B1, B2],
    members: () => w.members.map((x) => ({ id: x.id, name: x.name, blockId: x.blockId })),
    provider,
    changed() {},
  };
  const tasks = new Tasks(file, host, ledger);
  tasks.recover([B1, B2], []);
  let fed = ledger.length;
  // What the office does on every ledger append: tell the tasks, then let them follow the mail.
  const sync = () => {
    for (const entry of w.persisted.slice(fed)) tasks.observe(entry);
    fed = w.persisted.length;
    tasks.onMail();
  };
  return { w, tasks, provider, file, sync, advance: (ms: number) => void (now += ms), now: () => now, host };
}

const crono = (n: number, status = 'pending'): TaskCard => ({ id: `cronospark:ext${n}`, provider: 'cronospark', externalId: `ext${n}`, identifier: `CS-${n}`, title: `Card ${n}`, status, sourceLabel: 'CronoSpark' });

console.log('\n# a task worked by the PO and a delegate');
{
  const x = taskWorld();
  const quick = x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!;
  check(!!quick && x.tasks.boardsOf(B2).length === 1, 'every block starts with a quick board');
  const made = x.tasks.createTask(quick.id, '  Add CSV export ', 'with tests');
  check(made.title === 'Add CSV export' && made.notes === 'with tests' && made.stage === 'todo' && made.origin.kind === 'manual', 'a manual task on a quick board');
  const inReview = x.tasks.createTask(quick.id, 'Born in review', undefined, 'review');
  check(inReview.stage === 'review' && x.tasks.view(x.now()).tasks.find((y) => y.id === inReview.id)!.stage === 'review', 'a task can be created straight into another column, in one step');
  x.tasks.deleteTask(inReview.id);

  x.tasks.assign(made.id, PO);
  x.sync();
  const view = () => x.tasks.view(x.now());
  const doing = view().tasks.find((y) => y.id === made.id)!;
  check(doing.stage === 'doing' && doing.assignees[0] === PO && doing.runs.length === 1, 'assigning moves it to doing and records the run');
  check(/Add CSV export/.test(x.w.prompts.get(PO)![0]!) && /with tests/.test(x.w.prompts.get(PO)![0]!), 'the PO got a request with the title and the notes, and starts at once');
  const rootRequest = x.w.room.state.messages.get(doing.runs[0]!)!;
  check(rootRequest.kind === 'request' && rootRequest.intent === 'work' && rootRequest.from === 'owner' && rootRequest.title === 'Add CSV export', 'it is one work request from the owner');

  x.tasks.assign(made.id, PO);
  check(x.tasks.view(x.now()).tasks[0]!.runs.length === 1 && x.w.prompts.get(PO)!.length === 1, 'assigning again to someone already on it posts nothing');

  x.advance(60_000);
  const child = x.w.room.post({ from: PO, to: 'Ana', body: { kind: 'request', text: 'the route' } });
  if (!child.ok) throw new Error('delegation refused');
  x.sync();
  x.advance(30_000);
  x.w.room.turnEnded(PO, 'delegated the route', true);
  x.sync();
  check(view().tasks[0]!.stage === 'doing', 'the PO ending their turn with a piece out does not finish the task');
  x.advance(120_000);
  x.w.room.turnEnded(ANA, 'route done', true);
  x.sync();
  x.advance(15_000);
  x.w.room.turnEnded(PO, 'csv export shipped', true);
  x.sync();
  const after = view();
  check(after.tasks[0]!.stage === 'review' && after.tasks[0]!.lastOutcome?.outcome === 'done' && after.tasks[0]!.lastOutcome.text === 'csv export shipped', 'every run settled done moves it to review with the result');
  const time = after.taskTime[made.id]!;
  check(time.byEmployee[PO] === 105_000 && time.byEmployee[ANA] === 150_000 && time.totalMs === 255_000, `PO 105 s and Ana 150 s, the total is their sum (${JSON.stringify(time.byEmployee)})`);
  check(time.running.length === 0, 'nobody is running once the work is done');

  const reloaded = taskWorld(x.file, x.w.persisted);
  check(JSON.stringify(reloaded.tasks.view(x.now()).taskTime) === JSON.stringify(after.taskTime) && reloaded.tasks.view(x.now()).tasks[0]!.stage === 'review', 'time and stage survive a restart: both come from the files');

  x.tasks.assign(made.id, ANA);
  const second = view().tasks[0]!;
  check(second.stage === 'doing' && second.assignees.length === 2 && second.runs.length === 2, 'adding a second person posts another run and puts it back to doing');
  x.w.room.turnEnded(ANA, 'blocked: no access', false);
  x.sync();
  check(view().tasks[0]!.stage === 'todo' && view().tasks[0]!.lastOutcome?.outcome === 'failed', 'a failed run sends it back to todo with the outcome kept');
  x.tasks.assign(made.id, ANA);
  check(view().tasks[0]!.runs.length === 3, 'giving it to the same person again after they settled posts a new run');

  let refused = '';
  try {
    x.tasks.assign(made.id, e('zed'));
  } catch (error) {
    refused = error instanceof OfficeError ? error.message : String(error);
  }
  check(/PO of its block/.test(refused), 'someone from another block cannot take it');
}

console.log('\n# a retried assign never posts twice');
{
  const x = taskWorld();
  const made = x.tasks.createTask(x.tasks.boardsOf(B1)[0]!.id, 'Retry me');
  const beforeAssign = readFileSync(x.file, 'utf8');
  x.tasks.assign(made.id, ANA);
  x.sync();
  const keyed = [...x.w.room.state.keys.keys()].filter((k) => k.startsWith('task:'));
  check(keyed.length === 1 && keyed[0] === `task:${made.id}:${ANA}:0`, 'the request has a key made of the task, the person and their run number', keyed.join());
  // The crash window: the request is in the ledger and the task file never heard of it.
  writeFileSync(x.file, beforeAssign);
  const again = new Tasks(x.file, x.host, x.w.persisted);
  check(again.view(0).tasks[0]!.runs.length === 0, 'a task file written before the assign knows no run');
  again.recover([B1, B2], []);
  const healed = again.view(0).tasks[0]!;
  check(healed.runs.length === 1 && healed.assignees[0] === ANA && healed.stage === 'doing', 'a restart relinks the run it finds by its key and puts the task in doing');
  const requests = () => x.w.room.state.order.filter((id) => x.w.room.state.messages.get(id)!.kind === 'request').length;
  again.assign(made.id, ANA);
  check(requests() === 1 && again.view(0).tasks[0]!.runs.length === 1, 'asking again while the run is open posts nothing');
  // The same call retried by someone who has not seen the run yet: the key finds the request, so it is linked, not posted.
  writeFileSync(x.file, beforeAssign);
  const retry = new Tasks(x.file, x.host, x.w.persisted);
  retry.assign(made.id, ANA);
  check(requests() === 1 && retry.view(0).tasks[0]!.runs.length === 1 && retry.view(0).tasks[0]!.runs[0] === healed.runs[0], 'a retry that has not seen the run finds the request by its key and links it');
}

console.log('\n# CronoSpark hours');
{
  const x = taskWorld();
  const created = x.tasks.createBoard(B1, 'Sprint', { kind: 'feature', sources: [{ provider: 'cronospark', projectId: 'p1' }], logHours: true });
  x.provider.cards = [crono(1), crono(2)];
  await x.tasks.refresh(created.id);
  const synced = x.tasks.view(x.now()).tasks.filter((y) => y.boardId === created.id);
  check(synced.length === 2 && x.tasks.view(x.now()).boardSync[created.id]!.kind === 'ready', 'a synced card becomes a task and the board says it is ready');

  const target = synced[0]!;
  x.tasks.assign(target.id, PO);
  x.sync();
  x.advance(60_000);
  const child = x.w.room.post({ from: PO, to: 'Ana', body: { kind: 'request', text: 'piece' } });
  if (!child.ok) throw new Error('refused');
  x.sync();
  x.advance(30_000);
  x.w.room.turnEnded(PO, 'delegated', true);
  x.sync();
  x.advance(120_000);
  x.w.room.turnEnded(ANA, 'piece done', true);
  x.sync();
  x.advance(15_000);
  x.w.room.turnEnded(PO, 'all done', true);
  x.sync();
  await x.tasks.idle();
  const rows = x.provider.calls.map((c) => `${c.description}|${c.hours}|${c.date}|${c.taskId}`);
  check(x.tasks.view(x.now()).tasks.find((y) => y.id === target.id)!.stage === 'review', 'the work finishing moves the task to review');
  check(rows.length === 2 && rows[0] === 'Ana (AI employee, Online Office)|0.0417|2026-10-06|ext1' && rows[1] === 'Pia (AI employee, Online Office)|0.0292|2026-10-06|ext1', 'one call per person and day with their hours, under the task\'s provider id', rows.join(' ; '));

  x.tasks.updateTask(target.id, { stage: 'done' });
  await x.tasks.idle();
  x.tasks.pushHours();
  await x.tasks.idle();
  check(x.provider.calls.length === 2, 'a second transition sends nothing new');
  await x.tasks.refresh(created.id);
  await x.tasks.idle();
  check(x.provider.calls.length === 2, 'a refresh sends nothing new');

  const restarted = new Tasks(x.file, x.host, x.w.persisted);
  restarted.recover([B1, B2], []);
  restarted.pushHours();
  await restarted.idle();
  check(x.provider.calls.length === 2, 'a restart sends nothing new: the marks were saved with the task');

  // More work, and CronoSpark is down for the first try.
  x.tasks.assign(target.id, ANA);
  x.sync();
  x.advance(60_000);
  x.provider.failing = 1;
  x.w.room.turnEnded(ANA, 'a bit more', true);
  x.sync();
  await x.tasks.idle();
  const failed = x.tasks.view(x.now()).tasks.find((y) => y.id === target.id)!;
  check(x.provider.calls.length === 2 && /CronoSpark is down/.test(failed.hours?.error?.message ?? '') && failed.hours?.inflight === undefined, 'a failed push stays visible on the task and leaves the mark where it was', failed.hours?.error?.message);
  x.tasks.pushHours();
  await x.tasks.idle();
  const healed = x.tasks.view(x.now()).tasks.find((y) => y.id === target.id)!;
  const anaHours = x.provider.calls.filter((c) => c.description.startsWith('Ana')).reduce((sum, c) => sum + c.hours, 0);
  check(x.provider.calls.length === 3 && x.provider.calls[2]!.description.startsWith('Ana') && healed.hours?.error === undefined, 'the next ask retries it once and clears the error', JSON.stringify(x.provider.calls[2]));
  check(Math.abs(anaHours - 210 / 3600) < 0.0001, `Ana's 210 s went out as ${anaHours} h in all, the rounding of the first call carried into the second`);
  x.tasks.pushHours();
  await x.tasks.idle();
  check(x.provider.calls.length === 3, 'and then it is sent for good');

  // Switches that keep hours at home.
  const quiet = x.tasks.createBoard(B1, 'Quiet', { kind: 'bug', sources: [{ provider: 'cronospark', projectId: 'p2' }], logHours: false });
  x.provider.cards = [crono(3)];
  await x.tasks.refresh(quiet.id);
  const quietTask = x.tasks.view(x.now()).tasks.find((y) => y.boardId === quiet.id)!;
  x.tasks.assign(quietTask.id, ANA);
  x.sync();
  x.advance(60_000);
  x.w.room.turnEnded(ANA, 'done', true);
  x.sync();
  await x.tasks.idle();
  check(x.tasks.view(x.now()).tasks.find((y) => y.id === quietTask.id)!.stage === 'review' && x.provider.calls.length === 3, 'a board that does not log hours sends nothing');

  const linear = x.tasks.createBoard(B1, 'Linear', { kind: 'feature', sources: [{ provider: 'linear', projectId: 'team:ENG' }], logHours: true });
  x.provider.cards = [{ ...crono(4), id: 'linear:l4', provider: 'linear', externalId: 'l4' }];
  await x.tasks.refresh(linear.id);
  const linearTask = x.tasks.view(x.now()).tasks.find((y) => y.boardId === linear.id)!;
  x.tasks.assign(linearTask.id, ANA);
  x.sync();
  x.advance(60_000);
  x.w.room.turnEnded(ANA, 'done', true);
  x.sync();
  await x.tasks.idle();
  check(x.provider.calls.length === 3, 'Linear has no hours, so nothing is sent for its cards');

  const idle = x.tasks.view(x.now()).tasks.find((y) => y.id === synced[1]!.id)!;
  check(idle.stage === 'todo' && idle.runs.length === 0, 'a synced card nobody worked on stays where its status put it');
}

console.log('\n# the CronoSpark client against a local server');
{
  const fake = await startFakeCronoSpark({ tasks: [{ _id: 'ext-9', code: 'CS-9', title: 'Wire it up', status: 'in-progress', priority: 1 }] });
  const saved = { url: process.env.CRONOSPARK_MCP_URL, key: process.env.CRONOSPARK_MCP_API_KEY, user: process.env.CRONOSPARK_MCP_USER_ID, fixture: process.env.OFFICE_TASK_BOARD_FIXTURE };
  Object.assign(process.env, { CRONOSPARK_MCP_URL: fake.url, CRONOSPARK_MCP_API_KEY: 'fake-key', CRONOSPARK_MCP_USER_ID: 'fake-user' });
  delete process.env.OFFICE_TASK_BOARD_FIXTURE;
  const service = new TaskBoardService();
  const listed = await service.fetchSources([{ provider: 'cronospark', projectId: 'p1' }]);
  check(listed.errors.length === 0 && listed.cards.length === 1 && listed.cards[0]!.externalId === 'ext-9' && listed.cards[0]!.identifier === 'CS-9', 'cards come over MCP with the provider id the hours need', JSON.stringify(listed));
  await service.logHours({ taskId: 'ext-9', hours: 0.5, date: '2026-10-06', description: 'Ana (AI employee, Online Office)' });
  check(fake.calls.length === 1 && fake.calls[0]!.taskId === 'ext-9' && fake.calls[0]!.hours === 0.5 && fake.calls[0]!.date === '2026-10-06', 'registrar_horas gets the task id, hours, date and description', JSON.stringify(fake.calls));
  check(fake.headers.every((h) => h.authorization === 'Bearer fake-key' && h.user === 'fake-user'), 'every call carries the saved credentials');
  let refusedByServer = '';
  await service.logHours({ taskId: 'ext-9', hours: 25, date: '2026-10-06', description: 'x' }).catch((error: Error) => void (refusedByServer = error.message));
  check(refusedByServer !== '' && fake.calls.length === 1, 'an error from the tool is thrown, not swallowed', refusedByServer);
  process.env.OFFICE_TASK_BOARD_FIXTURE = join(dir, 'unused.json');
  await service.logHours({ taskId: 'ext-9', hours: 1, date: '2026-10-06', description: 'x' });
  check(fake.calls.length === 1, 'with a fixture set, nothing goes to any server');
  for (const [key, value] of Object.entries({ CRONOSPARK_MCP_URL: saved.url, CRONOSPARK_MCP_API_KEY: saved.key, CRONOSPARK_MCP_USER_ID: saved.user, OFFICE_TASK_BOARD_FIXTURE: saved.fixture })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fake.close();
}

console.log('\n# board and task rules');
{
  const x = taskWorld();
  const [only] = x.tasks.boardsOf(B1);
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (error) {
      return error instanceof OfficeError ? error.message : String(error);
    }
    return '';
  };
  check(/at least one board/.test(refusal(() => x.tasks.deleteBoard(only!.id))), 'a block keeps at least one board');
  const extra = x.tasks.createBoard(B1, 'Bugs', { kind: 'bug', sources: [], logHours: true });
  const made = x.tasks.createTask(extra.id, 'Crash on save');
  x.tasks.assign(made.id, ANA);
  x.sync();
  check(/still being worked on/.test(refusal(() => x.tasks.deleteBoard(extra.id))), 'a board with a task in doing cannot be deleted');
  x.tasks.updateTask(made.id, { stage: 'todo' });
  check(/still being worked on/.test(refusal(() => x.tasks.deleteBoard(extra.id))), 'nor while one of its runs is still open');
  x.w.room.turnEnded(ANA, 'ok', true);
  x.sync();
  x.tasks.updateTask(made.id, { stage: 'todo' });
  x.tasks.deleteBoard(extra.id);
  check(x.tasks.boardsOf(B1).length === 1 && !x.tasks.view(0).tasks.some((y) => y.id === made.id), 'once nothing runs, the board goes with its tasks');
  check(/no sources/.test(refusal(() => x.tasks.updateBoard(only!.id, { sources: [{ provider: 'linear', projectId: 'ENG' }] }))), 'a quick board refuses sources');
  check(/no sources to refresh/.test(refusal(() => x.tasks.refresh(only!.id))), 'refreshing a quick board is refused');

  const doomed = x.tasks.createTask(only!.id, 'Cancel me');
  x.tasks.assign(doomed.id, BRUNO);
  x.sync();
  const run = x.tasks.view(0).tasks.find((y) => y.id === doomed.id)!.runs[0]!;
  x.tasks.deleteTask(doomed.id);
  check(x.w.room.state.life.get(run)?.s === 'settled' && !x.tasks.view(0).tasks.some((y) => y.id === doomed.id), 'deleting a task cancels the run still open');
  check(/needs a title/.test(refusal(() => x.tasks.createTask(only!.id, '   '))), 'a task needs a title');

  const gone = taskWorld();
  gone.tasks.dropBlock(B2);
  check(gone.tasks.boardsOf(B2).length === 0 && gone.tasks.boardsOf(B1).length === 1, 'dropping a block drops its boards');
  gone.tasks.reset();
  check(gone.tasks.view(0).boards.length === 0 && gone.tasks.view(0).tasks.length === 0 && JSON.parse(readFileSync(gone.file, 'utf8')).boards.length === 0, 'a reset empties the store and the file');
}

// ───────────────────────────── the real office ─────────────────────────────

console.log('\n# the office, with a scripted harness');
{
  process.env.OFFICE_START_LEVEL = '5';
  delete process.env.OFFICE_CLAUDE_MODEL;
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const repo2 = join(dir, 'repo2');
  mkdirSync(repo2);
  const memory = MemoryStore.open(join(dir, 'memory'));
  const mcp = await startOfficeMcp();
  const acker = { warm() {}, ack: () => undefined, stop() {} };
  type Fake = { host: SessionHost; assigned: string[]; stopped: boolean };
  const fakes: Fake[] = [];
  HARNESSES['claude-code'] = {
    ...HARNESSES['claude-code'],
    session: (host) => {
      const fake: Fake = { host, assigned: [], stopped: false };
      fakes.push(fake);
      return {
        assign: (taskText, title) => {
          fake.assigned.push(taskText);
          host.setStatus({ kind: 'working', task: title ?? taskText, startedAt: Date.now() });
        },
        interject() {},
        setModel() {},
        permissionsChanged() {},
        rulesChanged() {},
        stop: () => void (fake.stopped = true),
      };
    },
  };
  const finishTurn = async (fake: Fake, text = 'done') => {
    fake.host.taskCompleted(text);
    fake.host.setStatus({ kind: 'idle' });
    await sleep(10);
  };
  class Provider extends TaskBoardService {
    cards: TaskCard[] = [];
    calls: HoursCall[] = [];
    override async fetchSources() {
      return { cards: this.cards, errors: [] };
    }
    override async logHours(entry: HoursCall) {
      this.calls.push(entry);
    }
  }
  const provider = new Provider();
  const harnesses = { 'claude-code': { kind: 'ready' as const, version: 'fake' }, codex: { kind: 'missing' as const }, hermes: { kind: 'missing' as const } };
  const errors: string[] = [];
  const open = (file: string) => new Office(file, harnesses, { building() {}, rejected() {}, changed() {}, said() {}, log() {}, error: (msg) => void errors.push(msg) }, { mcp, memory, acker, taskBoards: provider });
  const file = join(dir, 'company.json');
  const office = open(file);
  office.handle({ type: 'create_block', cwd: repo });
  const blockId = office.snapshot().company.blocks[0]!.id;
  const snap = () => office.snapshot();
  const boardsOf = (b: BlockId) => snap().boards.filter((x) => x.blockId === b);
  check(boardsOf(blockId).length === 1 && boardsOf(blockId)[0]!.kind === 'quick' && boardsOf(blockId)[0]!.name === 'Quick tasks', 'a new block comes with its quick board');
  check(existsSync(join(dir, 'tasks.json')), 'boards live in tasks.json beside company.json');
  const refused = (msg: Parameters<Office['handle']>[0]) => {
    try {
      office.handle(msg);
    } catch (error) {
      return error instanceof OfficeError ? error.message : String(error);
    }
    return '';
  };

  office.handle({ type: 'hire', provider: 'claude-code', blockId, name: 'Pia', role: 'orchestrator' });
  office.handle({ type: 'hire', provider: 'claude-code', blockId, name: 'Ana' });
  const [poFake, anaFake] = fakes as [Fake, Fake];
  const pia = snap().company.employees.find((x) => x.name === 'Pia')!.id;
  const quick = boardsOf(blockId)[0]!;

  office.handle({ type: 'create_task', boardId: quick.id, title: 'Write the docs', notes: 'Short and plain' });
  const doc = snap().tasks[0]!;
  check(doc.title === 'Write the docs' && doc.stage === 'todo', 'create_task adds a manual task');
  office.handle({ type: 'assign_task', taskId: doc.id, employeeId: pia });
  check(poFake.assigned.length === 1 && /Write the docs/.test(poFake.assigned[0]!) && /Short and plain/.test(poFake.assigned[0]!) && snap().company.employees.find((x) => x.id === pia)!.status.kind === 'working', 'assign_task starts the PO on the task at once');
  check(snap().tasks[0]!.stage === 'doing' && snap().tasks[0]!.runs.length === 1, 'and the snapshot shows it in doing');
  await sleep(40);
  const running = snap().taskTime[doc.id]!;
  check(running.running.some((r) => r.employeeId === pia) && running.totalMs >= 40, 'the snapshot carries time, with the PO running', JSON.stringify(running));
  writeFileSync(join(repo, 'docs.md'), 'Short and plain\n');
  await finishTurn(poFake, 'docs written');
  check(snap().tasks[0]!.stage === 'review' && snap().tasks[0]!.lastOutcome?.text === 'docs written', 'the turn ending settles the run and moves the task to review');
  const total = snap().taskTime[doc.id]!;
  check(total.running.length === 0 && total.byEmployee[pia]! >= 40 && total.byEmployee[pia]! < 2000, 'time stops when the turn ends', JSON.stringify(total));

  const frozen = snap().taskTime[doc.id]!.totalMs;
  await sleep(50);
  check(snap().taskTime[doc.id]!.totalMs === frozen, 'an idle task does not keep counting');

  console.log('\n# hire into a task');
  const taskNow = office.snapshot();
  const idsBefore = new Set(taskNow.company.employees.map((x) => x.id));
  office.handle({ type: 'create_task', boardId: quick.id, title: 'Fix the login bug' });
  const bug = snap().tasks.find((x) => x.title === 'Fix the login bug')!;
  const desks = taskNow.company.employees.map((x) => x.seat);
  const building = office.buildingState().building;
  const benches = building.stories.flatMap((s) => s.items).filter((i) => i.def === 'bench_desk' && i.blockId === blockId).map((i) => i.id);
  const wanted = benches.filter((id) => !desks.includes(id)).at(-1)!;
  office.handle({ type: 'hire', provider: 'claude-code', blockId, name: 'Ben', taskId: bug.id, deskId: wanted });
  const ben = snap().company.employees.find((x) => !idsBefore.has(x.id))!;
  check(ben.seat === wanted, 'the new hire takes the desk they were given');
  check(fakes.at(-1)!.assigned.length === 1 && /Fix the login bug/.test(fakes.at(-1)!.assigned[0]!) && ben.status.kind === 'working', 'a hire with a task starts on it without anyone telling them');
  check(snap().tasks.find((x) => x.id === bug.id)!.assignees.includes(ben.id) && snap().tasks.find((x) => x.id === bug.id)!.runs.length === 1, 'the task records the hire as its assignee with a run');
  const taken = snap().company.employees.find((x) => x.name === 'Ana')!.seat;
  office.handle({ type: 'hire', provider: 'claude-code', blockId, name: 'Cal', deskId: taken! });
  const cal = snap().company.employees.find((x) => x.name === 'Cal')!;
  check(cal.seat !== taken && cal.seat !== null, 'a desk that is not free is not taken: the hire gets the usual free desk');
  check(/belongs to another block|No such block|No such task/.test(refused({ type: 'hire', provider: 'claude-code', blockId, taskId: 'nope' as TaskId })) && snap().company.employees.length === 4, 'a hire for a task that is not there is refused before anyone is hired');
  check(refused({ type: 'assign_task', taskId: bug.id, employeeId: 'ghost' as EmployeeId }).includes('PO of its block'), 'assign_task needs someone of the block');
  check(/at least one board/.test(refused({ type: 'delete_board', boardId: quick.id })), 'the last board cannot be deleted through the office');
  check(/no sources/.test(refused({ type: 'update_board', boardId: quick.id, sources: [{ provider: 'linear', projectId: 'x' }] })), 'a quick board refuses sources through the office');

  console.log('\n# an old company.json');
  office.shutdown();
  const legacyFile = join(dir, 'legacy', 'company.json');
  mkdirSync(join(dir, 'legacy'));
  const seeded = open(legacyFile);
  seeded.handle({ type: 'create_block', cwd: repo2 });
  seeded.shutdown();
  const stored = JSON.parse(readFileSync(legacyFile, 'utf8'));
  stored.blocks[0].taskBoard = { sources: [{ provider: 'cronospark', projectId: 'old-project', label: 'Old' }] };
  writeFileSync(legacyFile, JSON.stringify(stored));
  rmSync(join(dir, 'legacy', 'tasks.json'), { force: true });
  provider.cards = [crono(7)];
  const migrated = open(legacyFile);
  const legacyBoards = migrated.snapshot().boards;
  check(legacyBoards.length === 2 && legacyBoards[0]!.kind === 'feature' && legacyBoards[0]!.name === 'Tasks' && legacyBoards[1]!.kind === 'quick', 'the old per-block sources became a Tasks board and a quick board');
  check(legacyBoards[0]!.kind === 'feature' && legacyBoards[0]!.sources[0]!.projectId === 'old-project' && legacyBoards[0]!.sources[0]!.label === 'Old', 'the board kept the sources');
  check(!('taskBoard' in JSON.parse(readFileSync(legacyFile, 'utf8')).blocks[0]), 'company.json no longer holds the old field');
  check(await until(() => migrated.snapshot().tasks.some((x) => x.origin.kind === 'cronospark')), 'the migrated board pulls its cards at start');
  migrated.shutdown();
  const reopened = open(legacyFile);
  check(reopened.snapshot().boards.length === 2 && reopened.snapshot().tasks.length === 1, 'opening it again makes no second board and no second task');
  reopened.shutdown();
  await mcp.close();
}

finish();
