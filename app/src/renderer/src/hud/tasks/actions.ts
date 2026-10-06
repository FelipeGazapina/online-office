// What the owner does on the task screens. Each one sends the message main already knows. Two things have to wait for the
// snapshot because the protocol answers a create with nothing: a task made in a column other than todo, and a board made
// by name. They are matched against the next snapshot that brings something new.
import type { BlockId } from '../../../../shared/protocol.ts';
import type { Board, BoardId, Task, TaskId, TaskStage } from '../../../../shared/tasks.ts';
import { get, send, set, useStore } from '../../store.ts';

const HOLD_MS = 4000;
const PENDING_MS = 10_000;

export const openBoard = (blockId: BlockId, taskId?: TaskId) => set({ modal: { kind: 'task_board', blockId, ...(taskId ? { taskId } : {}) } });
export const pickBoard = (blockId: BlockId, boardId: BoardId) => set((s) => ({ boardPick: { ...s.boardPick, [blockId]: boardId } }));

function hold(task: Task, stage: TaskStage) {
  set((s) => ({ stageHold: { ...s.stageHold, [task.id]: { from: task.stage, stage, until: Date.now() + HOLD_MS } } }));
  // When the hold runs out the card goes where main says it is, which is where it was if main refused the move.
  setTimeout(() => set((s) => ({ stageHold: Object.fromEntries(Object.entries(s.stageHold).filter(([, h]) => h.until > Date.now())) })), HOLD_MS + 50);
}

export function moveTask(task: Task, stage: TaskStage) {
  if (task.stage === stage) return;
  hold(task, stage);
  send({ type: 'update_task', taskId: task.id, stage });
}

type PendingTask = { boardId: BoardId; title: string; stage: TaskStage; before: Set<TaskId>; until: number };
type PendingBoard = { blockId: BlockId; name: string; before: Set<BoardId>; until: number };
let pendingTasks: PendingTask[] = [];
let pendingBoard: PendingBoard | undefined;

export function createTaskIn(board: Board, stage: TaskStage, title: string) {
  const text = title.trim();
  if (!text) return;
  if (stage !== 'todo') pendingTasks.push({ boardId: board.id, title: text, stage, before: new Set(get().tasks.map((t) => t.id)), until: Date.now() + PENDING_MS });
  send({ type: 'create_task', boardId: board.id, title: text });
}

export function createBoard(blockId: BlockId, name: string, kind: Board['kind']) {
  pendingBoard = { blockId, name: name.trim(), before: new Set(get().boards.map((b) => b.id)), until: Date.now() + PENDING_MS };
  send({ type: 'create_board', blockId, name, spec: kind === 'quick' ? { kind } : { kind, sources: [], logHours: true } });
}

useStore.subscribe((s, prev) => {
  if (s.tasks !== prev.tasks && pendingTasks.length) {
    const now = Date.now();
    const still: PendingTask[] = [];
    for (const p of pendingTasks) {
      const made = s.tasks.find((t) => !p.before.has(t.id) && t.boardId === p.boardId && t.origin.kind === 'manual' && t.title === p.title);
      if (made) moveTask(made, p.stage);
      else if (p.until > now) still.push(p);
    }
    pendingTasks = still;
  }
  if (s.boards !== prev.boards && pendingBoard) {
    const want = pendingBoard;
    const made = s.boards.find((b) => !want.before.has(b.id) && b.blockId === want.blockId && b.name === want.name);
    if (made) {
      pendingBoard = undefined;
      pickBoard(want.blockId, made.id);
    } else if (want.until < Date.now()) pendingBoard = undefined;
  }
});
