// No model, no Electron. The pure rules the task screens draw by: columns, held stages, which board a block shows, when the
// 3D board turns into the task board, and how time reads.
// Run from app/: node verify/board-view-check.ts   Exits 1 on any failed check.
import type { BlockId, Employee, EmployeeId, TaskBoardSource } from '../src/shared/protocol.ts';
import type { Board, BoardId, Task, TaskId, TaskTime } from '../src/shared/tasks.ts';
import { assigneeOf, blocksWithTasks, boardFor, columnsOf, findPeople, fmtAgo, fmtClock, foldStep, foldedOf, landingStage, listStep, withFilters, newTaskMessage, nextDraft, originOf, peopleOf, presenceOf, providerNote, safeUrl, sharesOf, stageOf, statsOf, stageStep, type Draft } from '../src/renderer/src/boardView.ts';

let failed = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) failed++;
  console.log(cond ? 'ok:' : 'FAIL:', msg);
};

const block = (n: number) => `block-${n}` as BlockId;
const board = (id: string, blockId: BlockId, extra: Partial<Board> = {}): Board => ({ id: id as BoardId, blockId, name: id, kind: 'quick', ...extra }) as Board;
const task = (id: string, boardId: string, over: Partial<Task> = {}): Task => ({
  id: id as TaskId,
  number: 0,
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

// ── presence ──
const withStatus = (id: string, status: Employee['status']) => ({ ...person(id, block(1), 1), status }) as Employee;
check(presenceOf(withStatus('a', { kind: 'idle' })).word === 'idle' && presenceOf(withStatus('a', { kind: 'working', task: 't', startedAt: 1 })).word === 'working', 'a person is idle or working');
check(presenceOf(withStatus('a', { kind: 'blocked_on_owner', task: 't', question: {} as never })).word === 'waiting on you' && presenceOf(withStatus('a', { kind: 'error', message: 'x' })).kind === 'error', 'and may wait on the owner or be in error, with the status kind kept for styling');

// ── priority on a card ──
check(originOf(task('p', 'b', { origin: { kind: 'manual', priority: 'urgent' } })).priority === 'Urgent' && originOf(task('p', 'b')).priority === undefined, 'a task made by hand shows its priority as the label, and none when it has none');
check(originOf(linear).priority === 'High', 'a provider task keeps the provider\'s own text');

// ── a task being made ──
const crew = [person('po', block(1), 9, 'orchestrator'), person('ana', block(1), 2)];
const draft = (over: Partial<Draft> = {}): Draft => ({ title: '', notes: '', ...over });
const into = 'b1' as BoardId;
check(newTaskMessage(into, 'todo', draft({ title: '   ' }), crew) === undefined, 'a draft with no title makes nothing');
const plain = newTaskMessage(into, 'review', draft({ title: '  Check staging  ' }), crew)!;
check(JSON.stringify(plain) === JSON.stringify({ type: 'create_task', boardId: 'b1', title: 'Check staging', stage: 'review' }), 'a bare draft is the trimmed title in its column and nothing else');
const full = newTaskMessage(into, 'todo', draft({ title: 'Ship it', notes: ' with tests ', assignee: 'ana' as EmployeeId, priority: 'high' }), crew)!;
check(full.assignee === 'ana' && full.priority === 'high' && full.notes === 'with tests' && full.stage === 'doing', 'an assignee, a priority and notes are carried, and handing it over starts it in doing');
const left = newTaskMessage(into, 'todo', draft({ title: 'Ship it', assignee: 'gone' as EmployeeId }), crew)!;
check(!('assignee' in left) && left.stage === 'todo' && assigneeOf(draft({ assignee: 'gone' as EmployeeId }), crew) === undefined, 'someone who left the team since they were picked is not sent, and the task stays in its column');
check(!('notes' in newTaskMessage(into, 'todo', draft({ title: 'x', notes: '  ' }), crew)!), 'blank notes are not sent');
check(landingStage('done', crew[0]) === 'doing' && landingStage('done', undefined) === 'done', 'the stage a card lands in follows the assignee');
const kept = nextDraft(draft({ title: 'a', notes: 'b', assignee: 'ana' as EmployeeId, priority: 'low' }));
check(kept.title === '' && kept.notes === '' && kept.assignee === 'ana' && kept.priority === 'low', 'staying open keeps who and how urgent for the next task, not the words');
check(!('assignee' in nextDraft(draft({ title: 'a' }))), 'and nothing it never had');

// ── keys in a list ──
check(listStep(0, 4, 'ArrowDown') === 1 && listStep(3, 4, 'ArrowDown') === 0 && listStep(0, 4, 'ArrowUp') === 3, 'arrows step and wrap');
check(listStep(2, 4, 'Home') === 0 && listStep(1, 4, 'End') === 3 && listStep(2, 4, 'x') === 2 && listStep(0, 0, 'ArrowDown') === -1, 'Home and End jump, other keys stay, an empty list has no option');

// ── folded columns ──
check(stageStep('todo', 1, ['doing']) === 'review' && stageStep('review', -1, ['doing']) === 'todo' && stageStep('review', 1, ['done']) === undefined && stageStep('done', -1, ['review', 'doing']) === 'todo', 'a card steps over a folded column, and stops where nothing open is left');
check(foldedOf(undefined).length === 0 && foldedOf(board('b', block(1))).length === 0 && foldedOf(board('b', block(1), { collapsed: ['done'] })).join() === 'done', 'a board with nothing folded has an empty list');
check(foldStep([], 'done')?.join() === 'done' && foldStep(['done'], 'done')?.join() === '' && foldStep(['done'], 'todo')?.join() === 'done,todo', 'folding adds a column, unfolding takes it off');
check(foldStep(['todo', 'doing', 'review'], 'done') === undefined && foldStep(['todo', 'doing', 'review'], 'todo')?.join() === 'doing,review', 'the last open column cannot be folded, though one can always be unfolded');

// ── a Linear source's filters ──
const lin: TaskBoardSource = { provider: 'linear', projectId: 'team:BLOOM', label: 'Mine' };
const me = withFilters(lin, { assignee: 'me' });
check(me.provider === 'linear' && me.filters?.assignee === 'me' && me.filters.cycle === 'any' && me.filters.limit === 50 && me.label === 'Mine', 'one filter changed leaves the others at their defaults and the source as it was');
const both = withFilters(me, { limit: 200, cycle: 'current' });
check(both.provider === 'linear' && JSON.stringify(both.filters) === JSON.stringify({ assignee: 'me', cycle: 'current', limit: 200 }), 'filters accumulate');
const back = withFilters(withFilters(both, { assignee: 'anyone', cycle: 'any' }), { limit: 50 });
check(JSON.stringify(back) === JSON.stringify(lin), 'set back to the defaults the source is the one saved, so the settings do not read as edited');
const crono: TaskBoardSource = { provider: 'cronospark', projectId: 'p' };
check(withFilters(crono, { limit: 200 }) === crono, 'a CronoSpark source takes no filters');
const names = [{ id: 'a', name: 'Ana Souza' }, { id: 'b', name: 'Bruno' }, { id: 'c', name: 'Joana' }];
check(findPeople(names, '  ana ').map((p) => p.id).join() === 'a,c' && findPeople(names, '').length === 3 && findPeople(names, 'zz').length === 0, 'the people list narrows to names that contain what was typed, in any case');

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
