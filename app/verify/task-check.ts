// No model, no Electron. Tasks and boards: the pure rules in shared/tasks.ts, the Tasks store on a real mailroom, and the
// real Office on a scripted harness. Time and hours are checked against numbers computed here from the ledger.
// Run from app/: node verify/task-check.ts   Exits 1 on any failed check.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlockId, EmployeeId, LinearFilters, TaskBoardSource, TaskCard } from '../src/shared/protocol.ts';
import type { LedgerEntry, MessageId, TurnId } from '../src/shared/mail.ts';
import {
  cleanCollapsed,
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
  wantsCard,
  workedMs,
  type Board,
  type BoardId,
  type RunState,
  type Task,
  type TaskId,
  type TaskTime,
} from '../src/shared/tasks.ts';
import { noInputs, type LiveInputs } from '../src/shared/activity.ts';
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
  check(mine[0]!.kind === 'feature' && JSON.stringify(mine[0]!.sources) === JSON.stringify(src), 'the migrated board keeps the old sources');
  const plain = made.boards.filter((b) => b.blockId === B2);
  check(plain.length === 1 && plain[0]!.kind === 'quick', 'a block without sources gets just a quick board');
  const again = ensureBoards([B1, B2], made.boards, [{ blockId: B1, sources: src }], () => board('x'));
  check(!again.changed && again.boards.length === 3, 'migrating twice makes nothing twice');
  check(ensureBoards([B2], made.boards, [], () => board('x')).boards.every((b) => b.blockId === B2), 'boards of a block that is gone are dropped');

  const quick = makeBoard(board('q'), B1, ' Ideas ', { kind: 'quick', sources: src } as never);
  check(quick.ok && quick.board.name === 'Ideas' && quick.board.kind === 'quick' && !('sources' in quick.board) && !('logHours' in quick.board), 'a quick board is built without sources even when handed some');
  const q = quick.ok ? quick.board : undefined!;
  const refusedSources = patchBoard(q, { sources: src });
  check(!refusedSources.ok, 'a quick board refuses sources when updated', JSON.stringify(refusedSources));
  const renamed = patchBoard(q, { name: 'Head' });
  check(renamed.ok && renamed.board.name === 'Head', 'a quick board still renames');
  const feat = makeBoard(board('f'), B1, 'Sprint', { kind: 'bug', sources: src });
  check(feat.ok && feat.board.kind === 'bug' && !('logHours' in feat.board) && patchBoard(feat.board, { sources: [] }).ok, 'feature and bug boards take sources and carry no hours switch');
  check(!makeBoard(board('f'), B1, 'x', { kind: 'feature', sources: [{ provider: 'linear', projectId: ' ' }] }).ok, 'a source needs a project id');
  check(!makeBoard(board('f'), B1, 'x', { kind: 'feature', sources: [src[0]!, src[0]!] }).ok, 'a source cannot be listed twice');
  check(!makeBoard(board('f'), B1, '  ', { kind: 'quick' }).ok, 'a board needs a name');
}

console.log('\n# what a Linear source pulls and which columns a board folds');
{
  const linear = (filters?: LinearFilters): TaskBoardSource => ({ provider: 'linear', projectId: 'team:BLOOM', ...(filters ? { filters } : {}) });
  const f = (over: Partial<LinearFilters> = {}): LinearFilters => ({ assignee: 'anyone', cycle: 'any', limit: 50, ...over });
  const feature = (sources: TaskBoardSource[]) => {
    const made = makeBoard(board('f'), B1, 'Sprint', { kind: 'feature', sources });
    if (!made.ok) throw new Error(made.reason);
    return made.board;
  };
  const sourcesOf = (b: Board) => (b.kind === 'quick' ? [] : b.sources);

  check(JSON.stringify(sourcesOf(feature([linear(f())]))) === JSON.stringify([linear()]), 'filters that are the defaults are not stored: the source reads as it always did');
  check(JSON.stringify(sourcesOf(feature([linear(f({ assignee: 'me', cycle: 'current', limit: 200 }))]))[0]) === JSON.stringify(linear(f({ assignee: 'me', cycle: 'current', limit: 200 }))), 'a filter that is not the default is stored as given');
  const picked = sourcesOf(feature([linear(f({ assignee: { id: ' u1 ', name: ' Ana ' } }))]))[0];
  check(picked?.provider === 'linear' && JSON.stringify(picked.filters?.assignee) === JSON.stringify({ id: 'u1', name: 'Ana' }), 'a picked person is stored trimmed');
  const once = feature([linear(f({ limit: 200 }))]);
  const twice = patchBoard(once, { sources: sourcesOf(once) });
  check(twice.ok && JSON.stringify(twice.board) === JSON.stringify(once), 'cleaning cleaned sources changes nothing');
  check(JSON.stringify(sourcesOf(feature([{ provider: 'cronospark', projectId: 'p', filters: f({ limit: 200 }) } as never]))[0]) === JSON.stringify({ provider: 'cronospark', projectId: 'p' }), 'a CronoSpark source carries no filters');

  check(JSON.stringify(cleanCollapsed(['done', 'todo', 'done'])) === JSON.stringify(['todo', 'done']), 'folded columns come back once each, in column order');
  check(JSON.stringify(cleanCollapsed([])) === '[]', 'no column folded is an empty list');
  check(!Array.isArray(cleanCollapsed(['todo', 'doing', 'review', 'done'])), 'the last open column cannot be folded');

  const open = feature([linear()]);
  const folded = patchBoard(open, { collapsed: ['done'] });
  check(folded.ok && JSON.stringify(folded.board.collapsed) === '["done"]' && folded.board.name === 'Sprint' && JSON.stringify(sourcesOf(folded.board)) === JSON.stringify([linear()]), 'a board folds a column and keeps its name and sources');
  const renamedFolded = folded.ok ? patchBoard(folded.board, { name: 'Next' }) : folded;
  check(renamedFolded.ok && JSON.stringify(renamedFolded.board.collapsed) === '["done"]', 'a rename leaves the folded columns alone');
  const unfolded = folded.ok ? patchBoard(folded.board, { collapsed: [] }) : folded;
  check(unfolded.ok && !('collapsed' in unfolded.board), 'unfolding every column leaves no trace on the board');
  check(!patchBoard(open, { collapsed: ['todo', 'doing', 'review', 'done'] }).ok, 'a board refuses to fold every column');
  const quickBoard = makeBoard(board('q'), B1, 'Ideas', { kind: 'quick' });
  const foldedQuick = quickBoard.ok ? patchBoard(quickBoard.board, { collapsed: ['review'] }) : quickBoard;
  check(foldedQuick.ok && foldedQuick.board.kind === 'quick' && JSON.stringify(foldedQuick.board.collapsed) === '["review"]', 'a quick board folds a column too');

  const card = (status: string) => ({ status });
  check(wantsCard(open, card('Done')) && wantsCard(open, card('Canceled')), 'a board with nothing folded wants every card');
  const noDone = folded.ok ? folded.board : open;
  check(!wantsCard(noDone, card('Done')) && !wantsCard(noDone, card('Canceled')) && !wantsCard(noDone, card('Completed')) && !wantsCard(noDone, card('Duplicate')), 'a folded Done wants neither done, canceled, completed nor duplicate cards');
  check(wantsCard(noDone, card('Backlog')) && wantsCard(noDone, card('Todo')) && wantsCard(noDone, card('In Progress')) && wantsCard(noDone, card('In Review')), 'and every other status');
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
  const b: Board = { id: board('b'), blockId: B1, name: 'Sprint', kind: 'feature', sources: [{ provider: 'cronospark', projectId: 'p' }] };
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

  // The PO replies done in the middle of a turn, so the task is in review before that turn ends. The turn's end adds time to
  // a person-day that was already sent. That time, and only that time, is due again.
  const stretches = [slice('po', day(10), day(10, 20)), slice('po', day(10, 20), day(10, 41)), slice('po', day(11), day(11, 7)), slice('po', day(11, 7), day(11, 7) + 1234)];
  let acc: Task = fresh;
  let posted = 0;
  for (let n = 1; n <= stretches.length; n++) {
    const accrued = closedDayWork(stretches.slice(0, n)).reduce((sum, w) => sum + w.ms, 0);
    for (const due of hoursDue(acc, closedDayWork(stretches.slice(0, n)))) {
      acc = { ...acc, hours: moveMark(acc.hours, due, 1) };
      posted += due.ms;
    }
    check(posted <= accrued && accrued - posted < 200, `after stretch ${n} what went out (${posted} ms) never exceeds what accrued (${accrued} ms) and trails it by under 0.2 s`);
  }
  check(hoursDue(acc, closedDayWork(stretches)).length === 0, 'with every stretch closed and sent, nothing is due and nothing is sent twice');
}

// ───────────────────────────── the store on a real mailroom ─────────────────────────────

class FakeProvider {
  cards: TaskCard[] = [];
  errors: string[] = [];
  calls: HoursCall[] = [];
  failing = 0;
  asked: { sources: readonly TaskBoardSource[]; kept: number }[] = [];
  people: { id: string; name: string }[] = [];
  async fetchSources(sources: readonly TaskBoardSource[], keep: (card: TaskCard) => boolean = () => true) {
    const cards = this.cards.filter(keep);
    this.asked.push({ sources, kept: cards.length });
    return { cards, errors: this.errors };
  }
  async linearPeople() {
    return this.people;
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
  const made = x.tasks.createTask(quick.id, '  Add CSV export ', { notes: 'with tests' });
  check(made.title === 'Add CSV export' && made.notes === 'with tests' && made.stage === 'todo' && made.origin.kind === 'manual', 'a manual task on a quick board');
  const inReview = x.tasks.createTask(quick.id, 'Born in review', { stage: 'review' });
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

console.log('\n# the activity of a task, and the owner answering its questions');
{
  const x = taskWorld();
  const quick = x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!;
  const noAsks: LiveInputs = noInputs;
  const made = x.tasks.createTask(quick.id, 'Add the export');
  x.w.fresh.add('app/export.ts');
  x.tasks.assign(made.id, ANA);
  x.sync();
  const view = () => x.tasks.view(x.now(), noAsks);
  const live = () => view().taskLive[made.id]!;
  check(live().people.find((p) => p.employeeId === ANA)?.state === 'working', 'the snapshot carries what each person on a task is doing: Ana is working');
  check(view().taskLive[x.tasks.createTask(quick.id, 'Not started').id] === undefined, 'a task nobody worked on has no summary');

  x.advance(5_000);
  const root = view().tasks.find((y) => y.id === made.id)!.runs[0]!;
  const blocked = x.w.room.reply(ANA, root, { outcome: 'blocked', text: 'CSV or JSON?' });
  x.w.room.turnEnded(ANA, 'blocked', true);
  x.sync();
  check(blocked.ok && live().questions.length === 1 && live().questions[0]!.text === 'CSV or JSON?' && live().questions[0]!.asker === ANA, 'a blocked reply shows up as a question on the task in the same sync', JSON.stringify(live().questions));
  check(view().tasks.find((y) => y.id === made.id)!.stage === 'todo', 'and the run ending blocked still sends the task back to todo');

  const qid = (live().questions[0]!.ref as { id: MessageId }).id;
  const requests = () => x.w.room.state.order.filter((id) => x.w.room.state.messages.get(id)!.kind === 'request').length;
  const before = requests();
  const said = (f: () => unknown) => {
    try {
      f();
    } catch (error) {
      return error instanceof OfficeError ? error.message : String(error);
    }
    return '';
  };
  check(/some words/.test(said(() => x.tasks.answer(made.id, qid, '   ', noAsks))), 'an empty answer is refused');
  check(/no longer|any more/.test(said(() => x.tasks.answer(made.id, 'nope' as MessageId, 'CSV', noAsks))), 'a question that is not open is refused');
  x.advance(5_000);
  x.tasks.answer(made.id, qid, 'CSV, please.', noAsks);
  x.sync();
  const after = view().tasks.find((y) => y.id === made.id)!;
  const answerRun = x.w.room.state.messages.get(after.runs[1]!)!;
  check(after.runs.length === 2 && answerRun.kind === 'request' && answerRun.from === 'owner' && answerRun.to === ANA && answerRun.rootId === root && answerRun.parentId === root, 'the answer is a new run for the one who stopped, in the same chain', JSON.stringify(answerRun));
  check(answerRun.kind === 'request' && /CSV, please\./.test(answerRun.text) && /CSV or JSON\?/.test(answerRun.text) && /Add the export/.test(answerRun.text), 'it carries the answer, what they said, and the task');
  check(after.stage === 'doing' && after.history!.at(-1)!.kind === 'stage' && (after.history!.at(-1) as { by: string }).by === 'owner', 'the task is back in doing, moved by the owner');
  check(live().questions.length === 0 && live().people.find((p) => p.employeeId === ANA)?.state === 'working', 'the question closed and Ana resumed');
  x.tasks.answer(made.id, qid, 'CSV, please.', noAsks);
  x.tasks.answer(made.id, qid, 'CSV, please.', noAsks);
  check(requests() === before + 1 && view().tasks.find((y) => y.id === made.id)!.runs.length === 2, 'answering again posts nothing: the same answer is the same run');

  x.advance(60_000);
  x.w.room.reply(ANA, answerRun.id, { outcome: 'done', text: 'Exported as CSV.', artifact: ['app/export.ts'] });
  x.w.room.turnEnded(ANA, 'done', true);
  x.sync();
  const done = view().tasks.find((y) => y.id === made.id)!;
  check(done.stage === 'review' && done.lastOutcome?.outcome === 'done' && done.lastOutcome.text === 'Exported as CSV.', 'the answer\'s run settling done moves the task to review with its result');
  check(live().people.find((p) => p.employeeId === ANA)?.state === 'done', 'and Ana is done');
  const time = view().taskTime[made.id]!;
  check(time.byEmployee[ANA]! > 0 && !time.running.length, 'the answer\'s time counts for the task like any run');
  const log = x.tasks.activityOf(made.id, noAsks)!;
  check(x.tasks.activityOf('gone' as TaskId, noAsks) === undefined, 'the log of a task that does not exist is nothing, not an error');
  const tags = log.entries.map((e) => (e.kind === 'stage' ? `stage:${e.by}:${e.to}` : e.kind === 'reply' ? `reply:${e.outcome}` : e.kind === 'request' ? `request:${e.answers ? 'answer' : 'run'}` : e.kind));
  check(tags.join() === 'created,request:run,started,stage:owner:doing,reply:blocked,stage:mailroom:todo,request:answer,started,stage:owner:doing,reply:done,stage:mailroom:review', 'the log reads: asked, picked up, blocked, answered, resumed, done, each stage move with who made it', tags.join());
  const moved = log.entries.filter((e) => e.kind === 'stage' && e.by === 'mailroom');
  check(moved.every((e) => e.kind === 'stage' && !!e.cause && x.w.room.state.messages.get(e.cause as MessageId)?.kind === 'reply'), 'a move the office made names the reply that caused it');

  // The crash window: the answer is in the ledger and the task file never heard of it.
  const file = JSON.parse(readFileSync(x.file, 'utf8')) as { tasks: { id: string; runs: string[] }[] };
  file.tasks.find((y) => y.id === made.id)!.runs = [root];
  writeFileSync(x.file, JSON.stringify(file));
  const crashed = new Tasks(x.file, x.host, x.w.persisted);
  crashed.recover([B1, B2], []);
  check(crashed.view(x.now()).tasks.find((y) => y.id === made.id)!.runs.includes(answerRun.id), 'a restart that never saw the answer relinks its run by key');
}

console.log('\n# a question put to a teammate is answered where the asker will read it');
{
  const x = taskWorld();
  const quick = x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!;
  const made = x.tasks.createTask(quick.id, 'Ship the export');
  x.tasks.assign(made.id, PO);
  x.sync();
  const root = x.tasks.view(x.now()).tasks[0]!.runs[0]!;
  const piece = x.w.room.post({ from: PO, to: 'Ana', body: { kind: 'request', text: 'the exporter' } });
  if (!piece.ok) throw new Error('refused');
  x.w.room.reply(ANA, piece.id, { outcome: 'blocked', text: 'I need the schema.' });
  x.w.room.turnEnded(ANA, 'blocked', true);
  x.sync();
  const live = () => x.tasks.view(x.now()).taskLive[made.id]!;
  const q = live().questions[0]!;
  check(q.asker === ANA && q.to === PO && q.how === 'blocked', 'Ana\'s block on a piece is a question to the PO');
  x.tasks.answer(made.id, (q.ref as { id: MessageId }).id, 'Use schema.ts.', noInputs);
  x.sync();
  const say = [...x.w.room.state.messages.values()].find((y) => y.kind === 'say' && y.from === 'owner' && y.to === PO);
  check(say?.kind === 'say' && say.rootId === root && say.parentId === root && /Use schema\.ts\./.test(say.text) && /new request/.test(say.text), 'the owner\'s answer is a word to the PO inside the chain, who must act on it', JSON.stringify(say));
  check(x.tasks.view(x.now()).tasks[0]!.runs.length === 1, 'it adds no run: the PO\'s own request is still open');
  check(live().questions.length === 0, 'and the question closes');

  const help = x.w.room.post({ from: ANA, to: 'Bruno', parentId: piece.id, body: { kind: 'request', intent: 'help', text: 'Which port?' } });
  if (!help.ok) throw new Error('refused');
  x.sync();
  const hq = live().questions.find((y) => y.how === 'help')!;
  x.tasks.answer(made.id, (hq.ref as { id: MessageId }).id, '5173', noInputs);
  x.sync();
  const note = [...x.w.room.state.messages.values()].find((y) => y.kind === 'say' && y.to === ANA && /5173/.test(y.text));
  check(note?.kind === 'say' && note.parentId === help.id && /question to Bruno/.test(note.text), 'a help request is answered with a word to the one who asked, under the request', JSON.stringify(note));
  check(!live().questions.some((y) => y.how === 'help'), 'and it closes');

  const ask: LiveInputs = { awaiting: new Set(), asks: [{ employeeId: ANA, question: { id: 'q9' as never, askedAt: 1, kind: 'ask', text: 'In person?' } }] };
  check(x.tasks.view(x.now(), ask).taskLive[made.id]!.questions.some((y) => y.how === 'ask'), 'an employee on the task waiting on the owner in person is a question on it');
  check(/not waiting/.test((() => { try { x.tasks.answer(made.id, 'q9' as MessageId, 'x', ask); return ''; } catch (e2) { return e2 instanceof Error ? e2.message : ''; } })()), 'Tasks.answer takes only mail questions: the office answers the ones asked in person');
}

console.log('\n# a teammate moves the card');
{
  const x = taskWorld();
  const quick = x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!;
  const view = (id: TaskId) => x.tasks.view(x.now()).tasks.find((y) => y.id === id)!;
  const stages = (id: TaskId) => (view(id).history ?? []).flatMap((h) => (h.kind === 'stage' ? [`${h.by}:${h.to}`] : []));
  const verdict = (r: ReturnType<Tasks['moveByAgent']>) => (r.ok ? (r.changed ? 'moved' : 'unchanged') : r.reason);
  const csv = x.tasks.createTask(quick.id, 'Write the export');
  x.w.fresh.add('export.ts');
  x.tasks.assign(csv.id, ANA);
  x.sync();
  const root = view(csv.id).runs[0]!;

  check(verdict(x.tasks.moveByAgent(BRUNO, 'review', 'looks done to me', csv.id)) === 'not_on_task' && view(csv.id).stage === 'doing' && stages(csv.id).join() === 'owner:doing', 'someone who is not on the task cannot move it, and nothing is recorded');
  check(verdict(x.tasks.moveByAgent(e('zed'), 'review', 'x', 'Write the export')) === 'unknown_task', 'a task of another block cannot even be named');
  check(verdict(x.tasks.moveByAgent(ANA, 'review', 'x', 'Not a task')) === 'unknown_task' && verdict(x.tasks.moveByAgent(ANA, 'review', 'x', 'zz')) === 'unknown_task', 'a name or an id that matches nothing is refused');

  x.advance(5_000);
  const toReview = x.tasks.moveByAgent(ANA, 'review', 'The export is written and tested.');
  check(toReview.ok && toReview.changed && toReview.from === 'doing' && toReview.task === 'Write the export', 'the one person holding the task moves it without naming it', JSON.stringify(toReview));
  const ev = view(csv.id).history!.at(-1)!;
  check(view(csv.id).stage === 'review' && ev.kind === 'stage' && ev.by === ANA && ev.to === 'review' && ev.from === 'doing' && ev.reason === 'The export is written and tested.' && ev.at === x.now(), 'the move is on the task under her name with her reason', JSON.stringify(ev));
  const updated = view(csv.id).updatedAt;
  x.advance(1_000);
  check(verdict(x.tasks.moveByAgent(ANA, 'review', 'Saying it again.', csv.id)) === 'unchanged' && stages(csv.id).length === 2 && view(csv.id).updatedAt === updated, 'asking again for where the card already is records nothing');
  x.w.room.reply(ANA, root, { outcome: 'done', text: 'Export written.', artifact: ['export.ts'] });
  x.w.room.turnEnded(ANA, 'done', true);
  x.sync();
  check(stages(csv.id).join() === 'owner:doing,ana:review' && view(csv.id).lastOutcome?.outcome === 'done', 'the run settling afterwards adds no second move from the office, and the outcome is still taken in');
  check(verdict(x.tasks.moveByAgent(ANA, 'doing', 'Back on it.', csv.id)) === 'not_resumed' && view(csv.id).stage === 'review', 'someone holding none of its requests cannot take it back to doing');
  check(verdict(x.tasks.moveByAgent(ANA, 'done', 'Shipped.', csv.id)) === 'moved' && view(csv.id).stage === 'done', 'review goes to done when nothing is open');
  check(verdict(x.tasks.moveByAgent(ANA, 'review', 'x', csv.id)) === 'not_allowed' && view(csv.id).stage === 'done', 'done does not go back to review: only to doing');

  const log = x.tasks.activityOf(csv.id, noInputs)!.entries.filter((l) => l.kind === 'stage');
  check(log.map((l) => (l.kind === 'stage' ? `${l.by}:${l.to}:${l.reason ?? ''}` : '')).join('|') === 'owner:doing:|ana:review:The export is written and tested.|ana:done:Shipped.', 'the activity log carries each move with who and why', JSON.stringify(log));
  const reloaded = taskWorld(x.file, x.w.persisted);
  check(JSON.stringify(reloaded.tasks.view(x.now()).tasks.find((y) => y.id === csv.id)!.history) === JSON.stringify(view(csv.id).history), 'the moves and their reasons survive a restart');

  // Resuming: a second run puts her back to work, and the card follows her.
  x.tasks.assign(csv.id, ANA);
  x.sync();
  check(view(csv.id).stage === 'doing' && stages(csv.id).at(-1) === 'owner:doing', 'the owner giving the task to her again puts it in doing');
  x.tasks.moveByAgent(ANA, 'review', 'Second pass ready.', csv.id);
  check(verdict(x.tasks.moveByAgent(ANA, 'doing', 'More to do.', csv.id)) === 'moved' && view(csv.id).stage === 'doing', 'while she holds a request of it she takes it from review back to doing');
  x.w.room.reply(ANA, view(csv.id).runs[1]!, { outcome: 'done', text: 'Export written again.', artifact: ['export.ts'] });
  x.w.room.turnEnded(ANA, 'done', true);
  x.sync();
}

console.log('\n# a PO moves its card once its pieces are in');
{
  const x = taskWorld();
  const quick = x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!;
  const view = (id: TaskId) => x.tasks.view(x.now()).tasks.find((y) => y.id === id)!;
  const verdict = (r: ReturnType<Tasks['moveByAgent']>) => (r.ok ? (r.changed ? 'moved' : 'unchanged') : r.reason);
  const made = x.tasks.createTask(quick.id, 'Ship the report');
  x.w.fresh.add('report.md');
  x.tasks.assign(made.id, PO);
  x.sync();
  const piece = x.w.room.post({ from: PO, to: 'Ana', body: { kind: 'request', title: 'Write the numbers', text: 'the numbers' } });
  if (!piece.ok) throw new Error('delegation refused');
  x.sync();

  const early = x.tasks.moveByAgent(PO, 'done', 'All done.', made.id);
  check(!early.ok && early.reason === 'open_pieces' && /Ana: "Write the numbers"/.test(early.detail) && view(made.id).stage === 'doing', 'the PO cannot call it done while a piece is open, and the refusal names the piece', JSON.stringify(early));
  const earlyReview = x.tasks.moveByAgent(PO, 'review', 'Ready.', made.id);
  check(!earlyReview.ok && earlyReview.reason === 'open_pieces', 'nor ready for the owner');
  const helper = x.tasks.moveByAgent(ANA, 'review', 'My part is done.', made.id);
  check(!helper.ok && helper.reason === 'open_pieces' && /Pia: "Ship the report"/.test(helper.detail), 'the person holding a piece cannot finish the task for its PO: the PO\'s own request is still open', JSON.stringify(helper));
  check(verdict(x.tasks.moveByAgent(BRUNO, 'done', 'x', made.id)) === 'not_on_task', 'a teammate the chain never reached is refused');
  const both = x.tasks.moveByAgent(ANA, 'doing', 'Starting the numbers.', made.id);
  check(both.ok && !both.changed, 'a piece worker saying doing on a card already in doing changes nothing');

  x.w.room.reply(ANA, piece.id, { outcome: 'done', text: 'numbers in', artifact: ['report.md'] });
  x.w.room.turnEnded(ANA, 'done', true);
  x.sync();
  check(view(made.id).stage === 'doing', 'her piece settling does not move the task: the PO has not replied');
  const done = x.tasks.moveByAgent(PO, 'done', 'Both pieces are in and I checked the numbers.', made.id);
  check(done.ok && done.changed && view(made.id).stage === 'done' && (view(made.id).history!.at(-1) as { by: string }).by === PO, 'with every piece settled the PO moves its task to done');
  x.w.room.reply(PO, view(made.id).runs[0]!, { outcome: 'done', text: 'Report shipped.', artifact: ['report.md'] });
  x.w.room.turnEnded(PO, 'done', true);
  x.sync();
  check(view(made.id).stage === 'done' && view(made.id).lastOutcome?.text === 'Report shipped.', 'its own reply afterwards leaves the card in done');

  x.w.room.turnEnded(PO, 'read the last reply', true);
  const second = x.tasks.createTask(quick.id, 'Cancel one');
  x.tasks.assign(second.id, PO);
  x.sync();
  const side = x.w.room.post({ from: PO, to: 'Bruno', body: { kind: 'request', title: 'A side piece', text: 'x' } });
  if (!side.ok) throw new Error('delegation refused');
  x.sync();
  check(verdict(x.tasks.moveByAgent(PO, 'done', 'x', second.id)) === 'open_pieces', 'a second task: a piece is open');
  x.w.room.cancel(PO, side.id);
  x.sync();
  const dropped = x.tasks.moveByAgent(PO, 'done', 'Dropped the side piece and finished.', second.id);
  check(verdict(dropped) === 'moved', 'cancelling the piece lets the PO finish', JSON.stringify(dropped));
}

console.log('\n# the owner\'s pin wins over a teammate');
{
  const x = taskWorld();
  const quick = x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!;
  const view = (id: TaskId) => x.tasks.view(x.now()).tasks.find((y) => y.id === id)!;
  const verdict = (r: ReturnType<Tasks['moveByAgent']>) => (r.ok ? (r.changed ? 'moved' : 'unchanged') : r.reason);
  const made = x.tasks.createTask(quick.id, 'Pinned by hand');
  x.w.fresh.add('a.txt');
  x.tasks.assign(made.id, ANA);
  x.sync();
  x.tasks.updateTask(made.id, { stage: 'todo' });
  check(view(made.id).stagePinned === true && view(made.id).stage === 'todo', 'the owner moving the card pins it, a manual card too');
  const refused = x.tasks.moveByAgent(ANA, 'review', 'Done, in my view.', made.id);
  check(!refused.ok && refused.reason === 'pinned' && /todo/.test(refused.detail) && view(made.id).stage === 'todo' && view(made.id).history!.at(-1)!.kind === 'stage' && (view(made.id).history!.at(-1) as { by: string }).by === 'owner', 'a teammate holding its request is refused, the card stays, and nothing is recorded under her name');
  check(verdict(x.tasks.moveByAgent(ANA, 'doing', 'Picking it up.', made.id)) === 'pinned', 'and so is taking it back to doing');
  x.tasks.updateTask(made.id, { title: 'Pinned by hand, renamed' });
  check(view(made.id).stagePinned === true, 'editing the card keeps the pin');
  check(verdict(x.tasks.moveByAgent(ANA, 'doing', 'Picking it up.', made.id)) === 'pinned', 'still pinned');

  const settled = view(made.id).runs[0]!;
  x.w.room.reply(ANA, settled, { outcome: 'done', text: 'a.txt written', artifact: ['a.txt'] });
  x.w.room.turnEnded(ANA, 'done', true);
  x.sync();
  check(view(made.id).stage === 'todo', 'the office leaves the owner\'s card alone when the run settles');
  x.tasks.assign(made.id, ANA);
  x.sync();
  check(view(made.id).stagePinned === undefined && view(made.id).stage === 'doing', 'giving the task to someone lifts the pin: the owner handed it over');
  check(verdict(x.tasks.moveByAgent(ANA, 'review', 'Second go done.', made.id)) === 'moved', 'and she can move it again');
  x.tasks.updateTask(made.id, { stage: 'doing' });
  check(verdict(x.tasks.moveByAgent(ANA, 'done', 'x', made.id)) === 'pinned', 'the owner putting it back pins it again');
  check(x.tasks.moveByAgent(BRUNO, 'doing', 'x', made.id).ok === false && (x.tasks.moveByAgent(BRUNO, 'doing', 'x', made.id) as { reason: string }).reason === 'not_on_task', 'and someone off the task is told so before the pin is mentioned');
}

console.log('\n# a task with a pull request is merged by the owner');
{
  const x = taskWorld();
  const quick = x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!;
  const made = x.tasks.createTask(quick.id, 'Ship it on GitHub');
  x.w.fresh.add('ship.txt');
  x.tasks.assign(made.id, ANA);
  x.sync();
  const withPr = (state: 'draft' | 'open' | 'merged' | 'closed') => {
    const file = JSON.parse(readFileSync(x.file, 'utf8')) as { tasks: { id: string; stage: string; git?: unknown }[] };
    const row = file.tasks.find((y) => y.id === made.id)!;
    row.stage = 'doing';
    row.git = { branch: 'task/ship-it', base: 'main', pr: { number: 7, url: 'https://example.test/pull/7', state } };
    writeFileSync(x.file, JSON.stringify(file));
    const again = new Tasks(x.file, x.host, x.w.persisted);
    again.recover([B1, B2], []);
    for (const entry of x.w.persisted) again.observe(entry);
    return again;
  };
  for (const state of ['draft', 'open'] as const) {
    const t = withPr(state);
    const refused = t.moveByAgent(ANA, 'done', 'Finished.', made.id);
    check(!refused.ok && refused.reason === 'pr_open' && /#7/.test(refused.detail) && /owner merges/.test(refused.detail) && t.view(0).tasks[0]!.stage === 'doing', `a task whose pull request is ${state} cannot be called done by a teammate, and the refusal says the owner merges`, JSON.stringify(refused));
    const review = t.moveByAgent(ANA, 'review', 'Ready to merge.', made.id);
    check(review.ok && review.changed && t.view(0).tasks[0]!.stage === 'review', `but it goes to review while the pull request is ${state}`);
    const fromReview = t.moveByAgent(ANA, 'done', 'Finished.', made.id);
    check(!fromReview.ok && fromReview.reason === 'pr_open', `and from review it still cannot go to done while the pull request is ${state}`);
  }
  const closed = withPr('closed').moveByAgent(ANA, 'done', 'The pull request was closed, and the work is not needed.', made.id);
  check(closed.ok && closed.changed, 'a closed pull request is no reason to hold it: done goes through');
  const noPr = taskWorld();
  const plain = noPr.tasks.createTask(noPr.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!.id, 'No pull request here');
  noPr.tasks.assign(plain.id, ANA);
  noPr.sync();
  check(noPr.tasks.moveByAgent(ANA, 'done', 'A task without a branch has no pull request to wait for.', plain.id).ok, 'a task with no pull request is not held');
}

console.log('\n# which card a teammate means');
{
  const x = taskWorld();
  const quick = x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!;
  const verdict = (r: ReturnType<Tasks['moveByAgent']>) => (r.ok ? 'ok' : r.reason);
  const one = x.tasks.createTask(quick.id, 'First card');
  const two = x.tasks.createTask(quick.id, 'Second card');
  check(verdict(x.tasks.moveByAgent(ANA, 'review', 'x')) === 'no_task', 'a teammate holding no task, naming none, is told to name one');
  x.tasks.assign(one.id, ANA);
  x.tasks.assign(two.id, ANA);
  x.sync();
  check(verdict(x.tasks.moveByAgent(ANA, 'review', 'x')) === 'ok', 'the second request waits in the queue, so the one she holds is the card');
  x.w.room.inbox(ANA, false);
  x.sync();
  const both = x.tasks.moveByAgent(ANA, 'done', 'x');
  check(!both.ok && both.reason === 'ambiguous' && /First card/.test(both.detail) && /Second card/.test(both.detail), 'holding two, she has to say which', JSON.stringify(both));
  check(verdict(x.tasks.moveByAgent(ANA, 'done', 'Second is done.', 'second card')) === 'ok', 'a title is matched without case');
  check(verdict(x.tasks.moveByAgent(ANA, 'done', 'First is done.', one.id)) === 'ok', 'an id names it too');
  x.tasks.createTask(quick.id, 'Second card');
  const twins = x.tasks.moveByAgent(ANA, 'done', 'x', 'Second card');
  check(!twins.ok && twins.reason === 'ambiguous', 'two cards with one title cannot be named by it');
}

console.log('\n# a task made with its assignee and priority');
{
  const x = taskWorld();
  const quick = x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!;
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (error) {
      return error instanceof OfficeError ? error.message : String(error);
    }
    return '';
  };
  const view = () => x.tasks.view(x.now());

  const alone = x.tasks.createTask(quick.id, 'Sketch the schema', { priority: 'urgent', notes: '  with indexes ' });
  check(alone.origin.kind === 'manual' && alone.origin.priority === 'urgent' && alone.notes === 'with indexes' && alone.stage === 'todo' && alone.runs.length === 0, 'a task made by hand can carry a priority and notes and starts in todo');
  check(!('priority' in x.tasks.createTask(quick.id, 'No rush').origin), 'without a priority the origin says none');

  const handed = x.tasks.createTask(quick.id, 'Ship the invoice export', { assignee: ANA, notes: 'CSV, one row per line item', priority: 'high' });
  x.sync();
  const mine = view().tasks.find((y) => y.id === handed.id)!;
  check(mine.stage === 'doing' && mine.assignees.join() === ANA && mine.runs.length === 1, 'made with an assignee, the task starts in doing with one run for them');
  check(mine.origin.kind === 'manual' && mine.origin.priority === 'high' && mine.notes === 'CSV, one row per line item', 'and keeps its priority and notes');
  check(x.w.prompts.get(ANA)?.length === 1 && /Ship the invoice export/.test(x.w.prompts.get(ANA)![0]!) && /one row per line item/.test(x.w.prompts.get(ANA)![0]!), 'the person got one request with the title and the notes, at once');
  check(JSON.stringify(JSON.parse(readFileSync(x.file, 'utf8')).tasks.find((y: Task) => y.id === handed.id).runs) === JSON.stringify(mine.runs), 'the run is on disk with the task');

  const po = x.tasks.createTask(quick.id, 'Plan the quarter', { assignee: PO, stage: 'review' });
  check(view().tasks.find((y) => y.id === po.id)!.stage === 'doing', 'an assignee wins over the column: handing a task over starts it');

  const before = view().tasks.length;
  const posted = x.w.room.state.order.length;
  check(/PO of its block/.test(refusal(() => x.tasks.createTask(quick.id, 'For nobody', { assignee: e('zed') }))), 'an assignee from outside the block is refused');
  check(view().tasks.length === before && x.w.room.state.order.length === posted, 'and nothing was made and nothing was posted');
  check(/needs a title/.test(refusal(() => x.tasks.createTask(quick.id, '  ', { assignee: ANA }))) && view().tasks.length === before, 'a blank title is refused before anyone is asked');

  x.tasks.updateTask(alone.id, { priority: 'low' });
  check(view().tasks.find((y) => y.id === alone.id)!.origin.kind === 'manual' && (view().tasks.find((y) => y.id === alone.id)!.origin as { priority?: string }).priority === 'low', 'the owner can change the priority of a task made by hand');
  x.tasks.updateTask(alone.id, { priority: null });
  check(!('priority' in view().tasks.find((y) => y.id === alone.id)!.origin), 'and clear it');
  x.tasks.updateTask(alone.id, { notes: 'edited' });
  check(view().tasks.find((y) => y.id === alone.id)!.origin.kind === 'manual', 'an edit that leaves the priority alone leaves the origin alone');

  const board = x.tasks.createBoard(B1, 'Sprint', { kind: 'feature', sources: [{ provider: 'cronospark', projectId: 'p' }] });
  x.provider.cards = [crono(1)];
  await x.tasks.refresh(board.id);
  const card = view().tasks.find((y) => y.origin.kind === 'cronospark')!;
  check(/set in CronoSpark/.test(refusal(() => x.tasks.updateTask(card.id, { priority: 'high' }))) && !('priority' in card.origin), 'a provider task keeps the provider\'s priority: the owner\'s is refused');
}

console.log('\n# CronoSpark hours go out only when the owner sends them');
{
  const x = taskWorld();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const refuse = async (f: () => unknown) => {
    try {
      await f();
    } catch (error) {
      return error instanceof OfficeError ? error.message : String(error);
    }
    return '';
  };
  const created = x.tasks.createBoard(B1, 'Sprint', { kind: 'feature', sources: [{ provider: 'cronospark', projectId: 'p1' }] });
  x.provider.cards = [crono(1), crono(2)];
  await x.tasks.refresh(created.id);
  const synced = x.tasks.view(x.now()).tasks.filter((y) => y.boardId === created.id);
  check(synced.length === 2 && x.tasks.view(x.now()).boardSync[created.id]!.kind === 'ready', 'a synced card becomes a task and the board says it is ready');
  const view = () => x.tasks.view(x.now());
  const taskOf = (id: string) => view().tasks.find((y) => y.id === id)!;

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
  await settle();
  check(taskOf(target.id).stage === 'review', 'the work finishing moves the task to review');
  check(x.provider.calls.length === 0, 'and posts nothing: a turn ending and a stage change send no hours');
  const unsent = view().taskTime[target.id]!.unsent;
  check(!!unsent && Math.abs((unsent[ANA] ?? 0) - 150_000) < 200 && Math.abs((unsent[PO] ?? 0) - 105_000) < 200, 'the task reports each person\'s closed time as not sent yet', JSON.stringify(unsent));

  x.tasks.updateTask(target.id, { stage: 'done' });
  x.tasks.updateBoard(created.id, { name: 'Sprint 1' });
  await x.tasks.refresh(created.id);
  await settle();
  const restartedBefore = new Tasks(x.file, x.host, x.w.persisted);
  restartedBefore.recover([B1, B2], []);
  await settle();
  check(x.provider.calls.length === 0, 'done, a board edit, a refresh and a restart post nothing either');
  check(JSON.stringify(restartedBefore.view(x.now()).taskTime[target.id]!.unsent) === JSON.stringify(unsent), 'and the restart still knows what is not sent');

  await x.tasks.sendHours(target.id);
  const rows = x.provider.calls.map((c) => `${c.description}|${c.hours}|${c.date}|${c.taskId}`);
  check(rows.length === 2 && rows[0] === 'Ana (AI employee, Online Office)|0.0417|2026-10-06|ext1' && rows[1] === 'Pia (AI employee, Online Office)|0.0292|2026-10-06|ext1', 'sending posts one call per person and day with their hours, under the task\'s provider id', rows.join(' ; '));
  check(taskOf(target.id).stage === 'done' && view().taskTime[target.id]!.unsent === undefined, 'it works in any stage, and nothing is left to send');
  await x.tasks.sendHours(target.id);
  check(x.provider.calls.length === 2, 'a second send posts nothing');

  const restarted = new Tasks(x.file, x.host, x.w.persisted);
  restarted.recover([B1, B2], []);
  await restarted.sendHours(target.id);
  check(x.provider.calls.length === 2 && restarted.view(x.now()).taskTime[target.id]!.unsent === undefined, 'a restart keeps the marks: sending again posts nothing');

  // More work in the open turn is not closed time, so it cannot go out yet.
  x.tasks.assign(target.id, ANA);
  x.sync();
  x.advance(60_000);
  check(taskOf(target.id).stage === 'doing', 'giving the task to someone again puts it back in doing');
  await x.tasks.sendHours(target.id);
  check(x.provider.calls.length === 2 && view().taskTime[target.id]!.unsent === undefined, 'a send while the turn is still open posts nothing');

  // The turn ends and CronoSpark is down for the first try.
  x.provider.failing = 1;
  x.w.room.turnEnded(ANA, 'a bit more', true);
  x.sync();
  await settle();
  check(x.provider.calls.length === 2 && Math.abs((view().taskTime[target.id]!.unsent?.[ANA] ?? 0) - 60_000) < 500, 'only the new time is due once the turn ends, and still nothing went out by itself');
  await x.tasks.sendHours(target.id);
  const failed = taskOf(target.id);
  check(x.provider.calls.length === 2 && /CronoSpark is down/.test(failed.hours?.error?.message ?? '') && failed.hours?.inflight === undefined, 'a failed send stays visible on the task and leaves the mark where it was', failed.hours?.error?.message);
  check(Math.abs((view().taskTime[target.id]!.unsent?.[ANA] ?? 0) - 60_000) < 500, 'and the time is still reported as not sent');
  const first = x.tasks.sendHours(target.id);
  const second = x.tasks.sendHours(target.id);
  await Promise.all([first, second]);
  const healed = taskOf(target.id);
  const anaHours = x.provider.calls.filter((c) => c.description.startsWith('Ana')).reduce((sum, c) => sum + c.hours, 0);
  check(first === second && x.provider.calls.length === 3 && x.provider.calls[2]!.description.startsWith('Ana') && healed.hours?.error === undefined, 'two sends at once post it once, and the error clears', JSON.stringify(x.provider.calls[2]));
  check(Math.abs(x.provider.calls[2]!.hours - 60 / 3600) < 0.0002, 'the call carries only the new time', JSON.stringify(x.provider.calls[2]));
  check(Math.abs(anaHours - 210 / 3600) < 0.0001, `Ana's 210 s went out as ${anaHours} h in all, the rounding of the first call carried into the second`);
  await x.tasks.sendHours(target.id);
  check(x.provider.calls.length === 3, 'and then it is sent for good');
  const history = taskOf(target.id).history ?? [];
  check(history.filter((h) => h.kind === 'stage').map((h) => `${h.by}:${h.to}`).join() === 'owner:doing,mailroom:review,owner:done,owner:doing,mailroom:review', 'the task\'s history says who moved each stage', JSON.stringify(history));
  const sends = history.filter((h): h is Extract<typeof h, { kind: 'hours' }> => h.kind === 'hours');
  check(sends.length === 4 && sends.filter((h) => h.error).length === 1 && /CronoSpark is down/.test(sends.find((h) => h.error)?.error ?? '') && sends.filter((h) => !h.error).length === 3, 'every hours send is on the history, and the one that failed says why', JSON.stringify(sends));

  // Only a CronoSpark task has hours.
  const linear = x.tasks.createBoard(B1, 'Linear', { kind: 'feature', sources: [{ provider: 'linear', projectId: 'team:ENG' }] });
  x.provider.cards = [{ ...crono(4), id: 'linear:l4', provider: 'linear', externalId: 'l4' }];
  await x.tasks.refresh(linear.id);
  const linearTask = view().tasks.find((y) => y.boardId === linear.id)!;
  x.tasks.assign(linearTask.id, ANA);
  x.sync();
  x.advance(60_000);
  x.w.room.turnEnded(ANA, 'done', true);
  x.sync();
  const handmade = x.tasks.createTask(x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!.id, 'by hand', { assignee: ANA });
  x.sync();
  x.advance(60_000);
  x.w.room.turnEnded(ANA, 'done', true);
  x.sync();
  check(/Only a CronoSpark task/.test(await refuse(() => x.tasks.sendHours(linearTask.id))) && /Only a CronoSpark task/.test(await refuse(() => x.tasks.sendHours(handmade.id))), 'a Linear task and a task made by hand have no hours to send');
  check(view().taskTime[linearTask.id]!.unsent === undefined && view().taskTime[handmade.id]!.unsent === undefined && x.provider.calls.length === 3, 'they report nothing unsent and post nothing');
  check(/No such task/.test(await refuse(() => x.tasks.sendHours('nope' as never))), 'a task that does not exist is refused');

  const idle = x.tasks.view(x.now()).tasks.find((y) => y.id === synced[1]!.id)!;
  check(idle.stage === 'todo' && idle.runs.length === 0, 'a synced card nobody worked on stays where its status put it');

  const dragged = synced[1]!;
  x.tasks.updateTask(dragged.id, { stage: 'doing' });
  x.provider.cards = [crono(1), crono(2)];
  await x.tasks.refresh(created.id);
  const stays = x.tasks.view(x.now()).tasks.find((y) => y.id === dragged.id)!;
  check(stays.stage === 'doing' && stays.stagePinned === true && stays.runs.length === 0, 'a card the owner moved without any run stays there after the next sync, though its provider still says pending');
  x.tasks.updateTask(dragged.id, { title: 'Renamed by the owner' });
  check(x.tasks.view(x.now()).tasks.find((y) => y.id === dragged.id)!.stagePinned === true, 'editing the title keeps the stage pinned');
  const byHand = x.tasks.createTask(x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!.id, 'by hand');
  x.tasks.updateTask(byHand.id, { stage: 'review' });
  check(x.tasks.view(x.now()).tasks.find((y) => y.id === byHand.id)!.stagePinned === true, 'a manual task is pinned too: the pin also holds teammates back');
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
  const extra = x.tasks.createBoard(B1, 'Bugs', { kind: 'bug', sources: [] });
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

console.log('\n# a folded column pulls nothing, and a source\'s filters reach the provider');
{
  const x = taskWorld();
  const linearCard = (n: number, status: string): TaskCard => ({ id: `linear:i${n}`, provider: 'linear', externalId: `i${n}`, identifier: `BLM-${n}`, title: `Issue ${n}`, status, sourceLabel: 'Linear' });
  const statuses = ['Todo', 'In Progress', 'In Review', 'Done', 'Canceled', 'Backlog', 'Done'];
  x.provider.cards = statuses.map((status, i) => linearCard(i + 1, status));
  const made = x.tasks.createBoard(B1, 'Linear', { kind: 'feature', sources: [{ provider: 'linear', projectId: 'team:BLOOM' }] });
  await x.tasks.refresh(made.id);
  const onBoard = () => x.tasks.view(x.now()).tasks.filter((t) => t.boardId === made.id);
  const stages = () => onBoard().map((t) => t.stage).sort().join();
  check(onBoard().length === 7 && x.provider.asked.at(-1)!.kept === 7, 'with nothing folded every card becomes a task', stages());

  const worked = onBoard().find((t) => t.origin.kind === 'linear' && t.origin.externalId === 'i4')!;
  x.tasks.assign(worked.id, ANA);
  x.tasks.updateTask(worked.id, { stage: 'done' });
  const moved = onBoard().find((t) => t.origin.kind === 'linear' && t.origin.externalId === 'i1')!;
  x.tasks.updateTask(moved.id, { stage: 'done' });
  const before = x.provider.asked.length;
  x.tasks.updateBoard(made.id, { collapsed: ['done'] });
  await x.tasks.refresh(made.id);
  check(x.provider.asked.length > before && x.provider.asked.at(-1)!.kept === 4, 'folding Done asks the provider again, and it keeps only the four cards of the other columns', String(x.provider.asked.at(-1)!.kept));
  check(onBoard().every((t) => t.stage !== 'done' || t.runs.length > 0 || t.id === moved.id) && onBoard().length === 5, 'the done tasks nobody worked on left the board', stages());
  check(onBoard().some((t) => t.id === worked.id && t.stage === 'done'), 'a done task that has runs stays, in its folded column');
  check(onBoard().some((t) => t.id === moved.id && t.stage === 'done'), 'so does one the owner moved there whose card is still pulled: the fold is about what a card says, not where it sits');
  check(x.tasks.view(x.now()).boards.find((b) => b.id === made.id)!.collapsed?.join() === 'done', 'the snapshot says Done is folded');

  const again = x.provider.asked.length;
  x.tasks.updateBoard(made.id, { name: 'Renamed' });
  check(x.provider.asked.length === again, 'a rename pulls nothing');

  const restarted = new Tasks(x.file, x.host, []);
  restarted.recover([B1, B2], []);
  check(restarted.view(x.now()).boards.find((b) => b.id === made.id)!.collapsed?.join() === 'done', 'the folded column survives a restart');

  x.tasks.updateBoard(made.id, { collapsed: [] });
  await x.tasks.refresh(made.id);
  check(onBoard().length === 7 && !('collapsed' in x.tasks.view(x.now()).boards.find((b) => b.id === made.id)!), 'unfolding Done brings its cards back on the next pull', stages());

  const filters: LinearFilters = { assignee: { id: 'u-ana', name: 'Ana' }, cycle: 'current', limit: 200 };
  x.tasks.updateBoard(made.id, { sources: [{ provider: 'linear', projectId: 'team:BLOOM', filters }] });
  await x.tasks.refresh(made.id);
  const last = x.provider.asked.at(-1)!.sources[0]!;
  check(last.provider === 'linear' && JSON.stringify(last.filters) === JSON.stringify(filters), 'changing a filter pulls again with the filter in the source');
  const kept = restarted.view(x.now()).boards.find((b) => b.id === made.id)!;
  check(kept.kind !== 'quick' && kept.sources[0]!.provider === 'linear' && kept.sources[0]!.filters === undefined, 'the filter was saved after that restart opened its own copy, so it saw none');
  const reopened = new Tasks(x.file, x.host, []);
  reopened.recover([B1, B2], []);
  const saved = reopened.view(x.now()).boards.find((b) => b.id === made.id)!;
  check(saved.kind !== 'quick' && JSON.stringify((saved.sources[0] as Extract<TaskBoardSource, { provider: 'linear' }>).filters) === JSON.stringify(filters), 'the filters survive a restart');

  x.tasks.updateBoard(made.id, { sources: [{ provider: 'linear', projectId: 'team:BLOOM', filters: { assignee: 'anyone', cycle: 'any', limit: 50 } }] });
  const defaults = x.tasks.view(x.now()).boards.find((b) => b.id === made.id)!;
  check(defaults.kind !== 'quick' && !('filters' in defaults.sources[0]!), 'setting the filters back to the defaults stores none');
  await x.tasks.refresh(made.id);

  check(x.tasks.view(0).linearPeople.kind === 'unknown', 'nobody is listed until the picker asks');
  x.provider.people = [{ id: 'u-ana', name: 'Ana' }];
  const asking = x.tasks.loadLinearPeople();
  check(x.tasks.view(0).linearPeople.kind === 'loading', 'asking marks the list as loading');
  await asking;
  const ready = x.tasks.view(0).linearPeople;
  check(ready.kind === 'ready' && ready.people.length === 1 && ready.people[0]!.name === 'Ana', 'and then it holds Linear\'s people');
  x.provider.linearPeople = async () => {
    throw new Error('Linear is not connected.');
  };
  await x.tasks.loadLinearPeople();
  const failed = x.tasks.view(0).linearPeople;
  check(failed.kind === 'error' && /not connected/.test(failed.message), 'a failed ask says why');
}

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
  const anaId = snap().company.employees.find((x) => x.name === 'Ana')!.id;
  office.handle({ type: 'create_task', boardId: quick.id, title: 'Tidy the changelog', notes: 'newest first', assignee: anaId, priority: 'medium' });
  const tidy = snap().tasks.find((x) => x.title === 'Tidy the changelog')!;
  check(tidy.stage === 'doing' && tidy.assignees.join() === anaId && tidy.runs.length === 1 && tidy.origin.kind === 'manual' && tidy.origin.priority === 'medium', 'create_task through the office carries assignee and priority: the task is made and started');
  check(anaFake.assigned.length === 1 && /Tidy the changelog/.test(anaFake.assigned[0]!) && /newest first/.test(anaFake.assigned[0]!) && snap().company.employees.find((x) => x.id === anaId)!.status.kind === 'working', 'and the person is working on it before the call returns');
  office.handle({ type: 'update_task', taskId: tidy.id, priority: null });
  check(!('priority' in snap().tasks.find((x) => x.id === tidy.id)!.origin), 'update_task with a null priority clears it');
  const count = snap().tasks.length;
  check(refused({ type: 'create_task', boardId: quick.id, title: 'For a ghost', assignee: 'ghost' as EmployeeId }).includes('PO of its block') && snap().tasks.length === count, 'create_task for someone outside the block is refused and makes no task');
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
