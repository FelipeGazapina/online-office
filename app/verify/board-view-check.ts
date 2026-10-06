// No model, no Electron. The pure rules the task screens draw by: columns, held stages, which board a block shows, when the
// 3D board turns into the task board, and how time reads.
// Run from app/: node verify/board-view-check.ts   Exits 1 on any failed check.
import type { BlockId, Employee, EmployeeId } from '../src/shared/protocol.ts';
import type { Board, BoardId, Task, TaskId, TaskTime } from '../src/shared/tasks.ts';
import { blocksWithTasks, boardFor, columnsOf, fmtAgo, fmtClock, originOf, peopleOf, providerNote, safeUrl, sharesOf, stageOf, statsOf, stageStep } from '../src/renderer/src/boardView.ts';

let failed = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) failed++;
  console.log(cond ? 'ok:' : 'FAIL:', msg);
};

const block = (n: number) => `block-${n}` as BlockId;
const board = (id: string, blockId: BlockId, extra: Partial<Board> = {}): Board => ({ id: id as BoardId, blockId, name: id, kind: 'quick', ...extra }) as Board;
const task = (id: string, boardId: string, over: Partial<Task> = {}): Task => ({
  id: id as TaskId,
  boardId: boardId as BoardId,
  title: id,
  origin: { kind: 'manual' },
  stage: 'todo',
  assignees: [],
  runs: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

// ── columns ──
const tasks = [task('a', 'b1', { updatedAt: 5 }), task('b', 'b1', { updatedAt: 9 }), task('c', 'b1', { stage: 'review', updatedAt: 2 }), task('d', 'b1', { stage: 'done' })];
const cols = columnsOf(tasks);
check(cols.map((c) => c.stage).join() === 'todo,doing,review,done', 'four columns in stage order, empty ones kept');
check(cols[0]!.tasks.map((t) => t.id).join() === 'b,a', 'a column lists the most recently touched task first');
const held = columnsOf(tasks, { ['a' as TaskId]: { from: 'todo', stage: 'done', until: 1000 } }, 500);
check(held[3]!.tasks.some((t) => t.id === 'a') && !held[0]!.tasks.some((t) => t.id === 'a'), 'a held stage is drawn while the task has not moved');
check(stageOf(tasks[0]!, { a: { from: 'todo', stage: 'done', until: 400 } } as never, 500) === 'todo', 'an expired hold is ignored');
check(stageOf({ ...tasks[0]!, stage: 'doing' }, { a: { from: 'todo', stage: 'done', until: 1000 } } as never, 500) === 'doing', 'once main moves the task somewhere else, main wins over the hold');
check(stageStep('todo', -1) === undefined && stageStep('todo', 1) === 'doing' && stageStep('done', 1) === undefined, 'stages step within the four and stop at the ends');

// ── which board ──
const boards = [board('quick1', block(1)), board('feat1', block(1), { kind: 'feature', sources: [{ provider: 'linear', projectId: 'x' }], logHours: true } as never), board('quick2', block(2))];
check(boardFor(boards, block(1), {})?.id === 'feat1', 'with no pick a block shows its first board that has sources');
check(boardFor(boards, block(2), {})?.id === 'quick2', 'with no sources anywhere it shows the first board');
check(boardFor(boards, block(1), { [block(1)]: 'quick1' as BoardId })?.id === 'quick1', 'the owner\'s pick wins');
check(boardFor(boards, block(1), { [block(1)]: 'quick2' as BoardId })?.id === 'feat1', 'a pick that belongs to another block is ignored');
check(boardFor(boards, block(1), { [block(1)]: 'gone' as BoardId })?.id === 'feat1', 'a pick that was deleted falls back');

// ── when the 3D board is the task board ──
const noTasks: Task[] = [];
check(!blocksWithTasks(boards, noTasks).has(block(2)), 'a block with only an empty quick board keeps its diagram wall');
check(blocksWithTasks(boards, noTasks).has(block(1)), 'a block with a source shows the task board');
const withManual = [task('m', 'quick2')];
check(blocksWithTasks(boards, withManual).has(block(2)), 'a block with any task shows the task board');
check(blocksWithTasks(boards, withManual) === blocksWithTasks(boards, withManual), 'the answer is kept while the snapshot does not change');

// ── origin ──
const linear = task('l', 'feat1', { origin: { kind: 'linear', externalId: '1', identifier: 'ENG-1', url: 'https://linear.app/x/issue/ENG-1', priority: 'High', providerStatus: 'In Progress', sourceLabel: 'Linear' } });
check(originOf(linear).kind === 'linear' && originOf(linear).ref === 'ENG-1' && originOf(linear).url === 'https://linear.app/x/issue/ENG-1', 'a Linear task names its identifier and links to it');
check(originOf(task('x', 'b')).kind === 'manual', 'a manual task says so');
check(safeUrl('javascript:alert(1)') === undefined && safeUrl('file:///etc/passwd') === undefined && safeUrl('not a url') === undefined && safeUrl('https://a.b/c') === 'https://a.b/c', 'only web addresses become links');
const bad = task('bad', 'b', { origin: { kind: 'cronospark', externalId: '1', identifier: 'CS-1', url: 'javascript:alert(1)', providerStatus: 'x', sourceLabel: 'CronoSpark' } });
check(originOf(bad).url === undefined, 'a provider card with a script address gets no link');

// ── what the provider adds ──
const card = (status: string, over: Partial<Task> = {}) => task('c', 'feat1', { origin: { kind: 'linear', externalId: '1', identifier: 'ENG-1', providerStatus: status, sourceLabel: 'Linear' }, ...over });
check(providerNote(card('Todo'), 'todo') === undefined && providerNote(card('pending'), 'todo') === undefined && providerNote(card('In Progress'), 'doing') === undefined, 'a status the column already says is not repeated');
check(providerNote(card('In Design', { stage: 'doing' }), 'doing') === 'In Design' && providerNote(card('Deferred'), 'todo') === 'Deferred', 'a status the four columns cannot name stays on the card');
check(providerNote(card('Todo', { stage: 'done' }), 'done') === 'Todo', 'when the owner moved a card away from what the provider says, the card says what it says');
check(providerNote(card('In Design', { runs: ['r' as never] }), 'doing') === undefined && providerNote(task('m', 'b'), 'todo') === undefined, 'once the office worked on a card, or for a manual one, there is nothing to add');

// ── time ──
check(fmtClock(0) === '0:00' && fmtClock(42_000) === '0:42' && fmtClock(724_000) === '12:04' && fmtClock(3_909_000) === '1:05:09', 'clock text for seconds, minutes and hours');
check(fmtAgo(3000) === 'just now' && fmtAgo(30_000) === '30 s ago' && fmtAgo(180_000) === '3 min ago' && fmtAgo(7_300_000) === '2 h ago', 'relative time');
const ana = 'ana' as EmployeeId;
const pia = 'pia' as EmployeeId;
const time: TaskTime = { at: 1_000, totalMs: 70_000, byEmployee: { [ana]: 60_000, [pia]: 10_000 }, running: [{ employeeId: pia, share: 1 }] };
const shares = sharesOf(time, 6_000);
check(shares[0]!.employeeId === ana && shares[0]!.ms === 60_000 && !shares[0]!.running, 'the person with most time is listed first');
check(shares[1]!.employeeId === pia && shares[1]!.ms === 15_000 && shares[1]!.running, 'someone in a turn keeps counting from when it was measured');
check(sharesOf(undefined, 1).length === 0, 'a task nobody worked on has no shares');
const stats = statsOf([task('t1', 'b'), task('t2', 'b')], { ['t1' as TaskId]: time }, 6_000);
check(stats.tasks === 2 && stats.running === 1 && stats.ms === 75_000, 'board totals count running tasks and live time');

// ── people ──
const person = (id: string, blockId: BlockId, hiredAt: number, role?: 'orchestrator'): Employee => ({ id: id as EmployeeId, name: id, blockId, hiredAt, ...(role ? { role } : {}) }) as Employee;
const team = peopleOf([person('z', block(1), 1), person('po', block(1), 9, 'orchestrator'), person('y', block(1), 2), person('other', block(2), 0)], block(1));
check(team.map((p) => p.id).join() === 'po,z,y', 'the PO comes first, then the block\'s people in hiring order, nobody from another block');

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
