// What the task screens draw, worked out from the snapshot: which board a block shows, which column a task sits in, how
// time reads. Pure, so the 3D board, the HUD board and the per-frame sim agree and verify/board-view-check.ts can run it.
import { taskBoardStatusLabel, type BlockId, type Employee, type EmployeeId, type TaskProvider } from '../../shared/protocol.ts';
import { STAGES, primaryBoard, stageOfStatus, totalWorkedMs, workedMs, type Board, type BoardId, type Task, type TaskId, type TaskStage, type TaskTime } from '../../shared/tasks.ts';

export const STAGE_LABEL: Record<TaskStage, string> = { todo: 'Todo', doing: 'In Progress', review: 'In Review', done: 'Done' };

// A stage the owner just chose, drawn until the snapshot says so too, so a dropped card does not jump back for the round
// trip. It only counts while the task is still where it was (`from`): once main moves it, main is right.
export type StageHold = { from: TaskStage; stage: TaskStage; until: number };
export type StageHolds = Record<TaskId, StageHold>;

export function stageOf(task: Task, holds: StageHolds, now: number): TaskStage {
  const hold = holds[task.id];
  return hold && hold.until > now && task.stage === hold.from ? hold.stage : task.stage;
}

export type Column = { stage: TaskStage; label: string; tasks: Task[] };

// Newest work first. The order does not depend on who is running, so a card never moves under the pointer.
const newestFirst = (a: Task, b: Task) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1);

export function columnsOf(tasks: readonly Task[], holds: StageHolds = {}, now = 0): Column[] {
  const by = new Map<TaskStage, Task[]>(STAGES.map((s) => [s, []]));
  for (const t of tasks) by.get(stageOf(t, holds, now))!.push(t);
  return STAGES.map((stage) => ({ stage, label: STAGE_LABEL[stage], tasks: by.get(stage)!.sort(newestFirst) }));
}

export const stageStep = (stage: TaskStage, dir: 1 | -1): TaskStage | undefined => STAGES[STAGES.indexOf(stage) + dir];

// ───────────────────────────── Boards ─────────────────────────────

export const boardsOf = (boards: readonly Board[], blockId: BlockId): Board[] => boards.filter((b) => b.blockId === blockId);

// The board the owner picked for the block, else the one T1 calls primary.
export function boardFor(boards: readonly Board[], blockId: BlockId, picked: Readonly<Record<string, BoardId>>): Board | undefined {
  return boards.find((b) => b.blockId === blockId && b.id === picked[blockId]) ?? primaryBoard(boards, blockId);
}

// A block's 3D board and its F prompt turn into the task board when the block has something to show on it: a source to pull
// from, or any task at all. Otherwise the wall keeps its diagram.
let memo: { boards: readonly Board[]; tasks: readonly Task[]; blocks: ReadonlySet<BlockId> } | undefined;
export function blocksWithTasks(boards: readonly Board[], tasks: readonly Task[]): ReadonlySet<BlockId> {
  if (memo && memo.boards === boards && memo.tasks === tasks) return memo.blocks;
  const blockOf = new Map(boards.map((b) => [b.id, b.blockId]));
  const blocks = new Set<BlockId>();
  for (const b of boards) if (b.kind !== 'quick' && b.sources.length) blocks.add(b.blockId);
  for (const t of tasks) {
    const block = blockOf.get(t.boardId);
    if (block) blocks.add(block);
  }
  memo = { boards, tasks, blocks };
  return blocks;
}

// ───────────────────────────── People ─────────────────────────────

const isPo = (e: Employee) => (e.role ?? 'employee') === 'orchestrator';

// The block's PO first, then everyone else in the order they were hired.
export const peopleOf = (employees: readonly Employee[], blockId: BlockId): Employee[] =>
  employees.filter((e) => e.blockId === blockId).sort((a, b) => Number(isPo(b)) - Number(isPo(a)) || a.hiredAt - b.hiredAt || (a.id < b.id ? -1 : 1));

// ───────────────────────────── Where a task came from ─────────────────────────────

export type OriginView = { kind: 'manual' | TaskProvider; ref: string; source: string; url?: string; priority?: string; providerStatus?: string };

// Provider text is outside data. Only a web address becomes a link.
export function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function originOf(task: Task): OriginView {
  const o = task.origin;
  if (o.kind === 'manual') return { kind: 'manual', ref: 'Manual', source: 'Added here' };
  const url = safeUrl(o.url);
  return { kind: o.kind, ref: o.identifier, source: o.sourceLabel, providerStatus: o.providerStatus, ...(url ? { url } : {}), ...(o.priority ? { priority: o.priority } : {}) };
}

const GENERIC_STATUS = new Set(['Open', 'In Progress', 'Ready to Review', 'Done']);

// What the provider says about a card when the column does not already say it: a status the owner's four columns cannot
// name ("In Design", "Deferred"), or one that disagrees because the owner moved the card.
export function providerNote(task: Task, stage: TaskStage): string | undefined {
  const o = task.origin;
  if (o.kind === 'manual' || task.runs.length > 0) return undefined;
  if (stageOfStatus(o.providerStatus) !== stage) return o.providerStatus;
  return GENERIC_STATUS.has(taskBoardStatusLabel(o.providerStatus)) ? undefined : o.providerStatus;
}

// ───────────────────────────── Time ─────────────────────────────

export function fmtClock(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const fmtHours = (ms: number): string => `${(Math.max(0, ms) / 3_600_000).toFixed(2)} h`;

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export type Share = { employeeId: EmployeeId; ms: number; running: boolean };

// Each person's time on a task at `now`, the one who has worked longest first. Someone still in a turn keeps counting.
export function sharesOf(time: TaskTime | undefined, now: number): Share[] {
  if (!time) return [];
  const who = new Set<EmployeeId>([...(Object.keys(time.byEmployee) as EmployeeId[]), ...time.running.map((r) => r.employeeId)]);
  return [...who]
    .map((employeeId) => ({ employeeId, ms: workedMs(time, employeeId, now), running: time.running.some((r) => r.employeeId === employeeId) }))
    .sort((a, b) => b.ms - a.ms || (a.employeeId < b.employeeId ? -1 : 1));
}

export const taskMs = (time: TaskTime | undefined, now: number): number => (time ? totalWorkedMs(time, now) : 0);
export const isRunning = (time: TaskTime | undefined): boolean => !!time && time.running.length > 0;

export type BoardStats = { tasks: number; running: number; ms: number };
export function statsOf(tasks: readonly Task[], times: Readonly<Record<TaskId, TaskTime>>, now: number): BoardStats {
  let running = 0;
  let ms = 0;
  for (const t of tasks) {
    const time = times[t.id];
    if (isRunning(time)) running++;
    ms += taskMs(time, now);
  }
  return { tasks: tasks.length, running, ms };
}
