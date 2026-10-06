// What the owner does on the task screens. Each one sends the message main already knows. A board made by name has to wait
// for the snapshot because the protocol answers a create with nothing: it is matched against the next snapshot that brings
// a board it has not seen.
import type { BlockId } from '../../../../shared/protocol.ts';
import type { Board, BoardId, Task, TaskId, TaskStage } from '../../../../shared/tasks.ts';
import type { Aim } from '../../deskDrop.ts';
import { get, send, set, toast, useStore } from '../../store.ts';

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

// A card dropped on a desk. Someone sits there: the task goes to them and the owner is back in the office to see them start.
// Nobody does: the hire panel opens for that desk with the task in it. Anything else is refused and the board comes back.
export function dropOnDesk(task: Task, aim: Aim) {
  const v = aim.verdict;
  switch (v.kind) {
    case 'assign':
      if (v.already) return void toast(`${v.to.name} is already on "${task.title}".`);
      send({ type: 'assign_task', taskId: task.id, employeeId: v.to.id });
      set({ modal: null });
      toast(`"${task.title}" goes to ${v.to.name}.`, 'ok');
      return;
    case 'hire':
      set({ modal: { kind: 'hire', for: { taskId: task.id, blockId: v.blockId, deskId: aim.deskId, role: v.role } } });
      return;
    case 'refuse':
      toast(v.message, 'warn');
      return;
  }
}

type PendingBoard = { blockId: BlockId; name: string; before: Set<BoardId>; until: number };
let pendingBoard: PendingBoard | undefined;

export function createTaskIn(board: Board, stage: TaskStage, title: string) {
  const text = title.trim();
  if (!text) return;
  send({ type: 'create_task', boardId: board.id, title: text, stage });
}

export function createBoard(blockId: BlockId, name: string, kind: Board['kind']) {
  pendingBoard = { blockId, name: name.trim(), before: new Set(get().boards.map((b) => b.id)), until: Date.now() + PENDING_MS };
  send({ type: 'create_board', blockId, name, spec: kind === 'quick' ? { kind } : { kind, sources: [], logHours: true } });
}

useStore.subscribe((s, prev) => {
  if (s.boards !== prev.boards && pendingBoard) {
    const want = pendingBoard;
    const made = s.boards.find((b) => !want.before.has(b.id) && b.blockId === want.blockId && b.name === want.name);
    if (made) {
      pendingBoard = undefined;
      pickBoard(want.blockId, made.id);
    } else if (want.until < Date.now()) pendingBoard = undefined;
  }
});
