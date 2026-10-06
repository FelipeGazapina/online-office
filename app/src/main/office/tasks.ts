// The owner's boards and tasks. State lives in tasks.json beside company.json. A task's time is not kept here: it is
// folded from the mailroom's ledger every time it is asked for (shared/tasks.ts), so what this file stores about work is
// the root requests a task started and, for CronoSpark, how much of that time was already sent.
//
// Plain Node: verify/task-check.ts imports it without Electron.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LedgerEntry, MessageId } from '../../shared/mail.ts';
import type { BlockId, EmployeeId, TaskBoardSource, TaskCard } from '../../shared/protocol.ts';
import {
  closedDayWork,
  emptyTurnLog,
  ensureBoards,
  foldTurn,
  hoursDue,
  makeBoard,
  moveMark,
  newTask,
  outcomeFromRuns,
  patchBoard,
  runRequest,
  sliceTasks,
  syncCards,
  timesOf,
  turnLogOf,
  type Board,
  type BoardId,
  type BoardPatch,
  type BoardSpec,
  type BoardSync,
  type HoursEntry,
  type LegacySources,
  type RunState,
  type Task,
  type TaskId,
  type TaskStage,
  type TaskTime,
  type TurnLog,
} from '../../shared/tasks.ts';
import { OfficeError } from './error.ts';
import type { MailState, Mailroom } from './mail.ts';
import type { HoursCall } from './task-board.ts';

export type TasksHost = {
  now(): number;
  newId(): string;
  // The mailroom changes when the owner resets the company, so this is asked for every time.
  mail(): Mailroom;
  blocks(): readonly BlockId[];
  // Everyone who works anywhere, PO included.
  members(): readonly { id: EmployeeId; name: string; blockId: BlockId }[];
  provider: {
    fetchSources(sources: readonly TaskBoardSource[]): Promise<{ cards: TaskCard[]; errors: string[] }>;
    logHours(entry: HoursCall): Promise<void>;
  };
  changed(): void;
};

type TasksFile = { v: 1; boards: Board[]; tasks: Task[]; people: Record<string, string> };

export type TasksView = { boards: Board[]; tasks: Task[]; boardSync: Record<BoardId, BoardSync>; taskTime: Record<TaskId, TaskTime> };

// The state of a root request as a task cares about it.
function runStateOf(mail: MailState, id: MessageId): RunState | undefined {
  const life = mail.life.get(id);
  if (!life) return undefined;
  if (life.s !== 'settled') return { s: 'open' };
  const reply = mail.messages.get(life.by);
  return reply?.kind === 'reply' ? { s: 'settled', reply: reply.id, outcome: life.outcome, text: reply.text, at: reply.at } : undefined;
}

// What the owner's retried assign_task shares with the first one: the same task, the same person, and how many runs that
// person already had of it.
const runKey = (task: TaskId, who: EmployeeId, nth: number) => `task:${task}:${who}:${nth}`;

export class Tasks {
  private boards: Board[] = [];
  private tasks: Task[] = [];
  // The names of people who left, so hours they worked still go out under their name.
  private people: Record<string, string> = {};
  private readonly sync = new Map<BoardId, BoardSync>();
  private log: TurnLog;
  private readonly file: string;
  private readonly host: TasksHost;
  private refreshing = new Map<BoardId, Promise<void>>();
  private refreshAgain = new Set<BoardId>();
  private pushing: Promise<void> | undefined;
  private pushAgain = false;
  private turnEnded = false;
  private readonly existed: boolean;

  constructor(file: string, host: TasksHost, ledger: readonly LedgerEntry[]) {
    this.file = file;
    this.host = host;
    this.log = turnLogOf(ledger);
    const stored = read(file);
    this.existed = !!stored;
    if (stored) ({ boards: this.boards, tasks: this.tasks, people: this.people } = stored);
  }

  // Run once the mailroom is open. Brings the stored state in line with the company: boards for every block (the old
  // per-block sources become a board the first time), runs a crash left unlinked, and pushes a crash left unconfirmed.
  recover(blocks: readonly BlockId[], legacy: readonly LegacySources[]) {
    const made = ensureBoards(blocks, this.boards, legacy, () => this.boardId());
    this.boards = made.boards;
    const live = new Set(this.boards.map((b) => b.id));
    const kept = this.tasks.filter((t) => live.has(t.boardId));
    let changed = made.changed || kept.length !== this.tasks.length;
    this.tasks = kept.map((t) => {
      let next = t;
      if (t.hours?.inflight) {
        const w = t.hours.inflight;
        const message = `Sending ${w.hours} h for ${this.nameOf(w.employeeId)} on ${w.date} was interrupted, so it may or may not have reached CronoSpark. Check there before adding it by hand.`;
        next = { ...next, hours: { pushed: t.hours.pushed, error: { message, at: this.host.now() } } };
      }
      return next;
    });
    changed ||= this.tasks.some((t, i) => t !== kept[i]);
    for (const [key, id] of this.host.mail().state.keys) {
      const [tag, taskId, who] = key.split(':');
      const task = tag === 'task' ? this.tasks.find((t) => t.id === taskId) : undefined;
      if (!task || !who || task.runs.includes(id)) continue;
      this.tasks = this.tasks.map((t) => (t === task ? this.withRun(t, id, who as EmployeeId) : t));
      changed = true;
    }
    if (changed || !this.existed) this.save();
  }

  // ── what the renderer sees ──

  view(now: number): TasksView {
    return {
      boards: this.boards,
      tasks: this.tasks,
      boardSync: Object.fromEntries(this.sync) as Record<BoardId, BoardSync>,
      taskTime: timesOf(this.tasks.filter((t) => t.runs.length), this.log, now),
    };
  }

  boardsOf(blockId: BlockId): Board[] {
    return this.boards.filter((b) => b.blockId === blockId);
  }

  // ── the company changed ──

  // The block is already in the company when this runs.
  addBlock() {
    this.boards = ensureBoards(this.host.blocks(), this.boards, [], () => this.boardId()).boards;
    this.save();
  }

  dropBlock(blockId: BlockId) {
    const gone = new Set(this.boardsOf(blockId).map((b) => b.id));
    this.boards = this.boards.filter((b) => b.blockId !== blockId);
    this.tasks = this.tasks.filter((t) => !gone.has(t.boardId));
    for (const id of gone) this.sync.delete(id);
    this.save();
  }

  rememberPerson(id: EmployeeId, name: string) {
    this.people[id] = name;
    this.save();
  }

  reset() {
    this.boards = [];
    this.tasks = [];
    this.people = {};
    this.sync.clear();
    this.log = emptyTurnLog();
    this.save();
  }

  // ── the mailroom changed ──

  // Every ledger entry, in order, as the mailroom writes it.
  observe(entry: LedgerEntry) {
    foldTurn(this.log, entry);
    if (entry.t === 'turn_end') this.turnEnded = true;
  }

  // Takes in how runs ended, and sends hours a finished turn left behind for a task that is already in review or done.
  onMail() {
    const mail = this.host.mail().state;
    let moved = false;
    this.tasks = this.tasks.map((t) => {
      if (!t.runs.length) return t;
      const outcome = outcomeFromRuns(t, (run) => runStateOf(mail, run));
      if (!outcome) return t;
      moved = true;
      return { ...t, ...outcome, updatedAt: this.host.now() };
    });
    if (moved) {
      this.save();
      this.pushHours();
    } else if (this.turnEnded) this.pushHours();
    this.turnEnded = false;
  }

  // ── boards ──

  createBoard(blockId: BlockId, name: string, spec: BoardSpec): Board {
    if (!this.host.blocks().includes(blockId)) throw new OfficeError(`No such block ${blockId}`);
    const made = makeBoard(this.boardId(), blockId, name, spec);
    if (!made.ok) throw new OfficeError(made.reason);
    this.boards = [...this.boards, made.board];
    this.save();
    if (made.board.kind !== 'quick') void this.refresh(made.board.id);
    return made.board;
  }

  updateBoard(boardId: BoardId, patch: BoardPatch) {
    const board = this.board(boardId);
    const made = patchBoard(board, patch);
    if (!made.ok) throw new OfficeError(made.reason);
    this.boards = this.boards.map((b) => (b === board ? made.board : b));
    this.save();
    if (made.board.kind !== 'quick' && board.kind !== 'quick' && JSON.stringify(made.board.sources) !== JSON.stringify(board.sources)) void this.refresh(boardId);
    if (made.board.kind !== 'quick' && made.board.logHours) this.pushHours();
  }

  deleteBoard(boardId: BoardId) {
    const board = this.board(boardId);
    if (this.boardsOf(board.blockId).length === 1) throw new OfficeError('A block keeps at least one board.');
    const mail = this.host.mail().state;
    const busy = this.tasks.find((t) => t.boardId === boardId && (t.stage === 'doing' || t.runs.some((r) => mail.unsettled.has(r))));
    if (busy) throw new OfficeError(`"${busy.title}" is still being worked on. Move it out of doing and let its runs finish first.`);
    this.boards = this.boards.filter((b) => b !== board);
    this.tasks = this.tasks.filter((t) => t.boardId !== boardId);
    this.sync.delete(boardId);
    this.save();
  }

  // Pulls the board's sources again. Two refreshes of one board never run side by side: the second asks the first for another
  // round and waits with it. A quick board has nothing to pull, which throws before any work starts.
  refresh(boardId: BoardId): Promise<void> {
    if (this.board(boardId).kind === 'quick') throw new OfficeError('A quick board has no sources to refresh.');
    const running = this.refreshing.get(boardId);
    if (running) {
      this.refreshAgain.add(boardId);
      return running;
    }
    const round = (async () => {
      try {
        do {
          this.refreshAgain.delete(boardId);
          await this.pull(boardId);
        } while (this.refreshAgain.has(boardId));
      } finally {
        this.refreshing.delete(boardId);
      }
    })();
    this.refreshing.set(boardId, round);
    return round;
  }

  refreshWhere(use: (b: Extract<Board, { kind: 'feature' | 'bug' }>) => boolean) {
    for (const b of this.boards) if (b.kind !== 'quick' && use(b)) void this.refresh(b.id);
  }

  private async pull(boardId: BoardId) {
    const before = this.boards.find((b) => b.id === boardId);
    if (!before || before.kind === 'quick') return;
    const last = this.sync.get(boardId);
    this.sync.set(boardId, { kind: 'loading', ...(last && 'lastFetchedAt' in last && last.lastFetchedAt ? { lastFetchedAt: last.lastFetchedAt } : {}) });
    this.host.changed();
    const result = await this.host.provider.fetchSources(before.sources).catch((err: unknown) => ({ cards: [] as TaskCard[], errors: [err instanceof Error ? err.message : String(err)] }));
    const board = this.boards.find((b) => b.id === boardId);
    if (!board || board.kind === 'quick') return;
    // The sources changed while this was out, and the change asked for its own round.
    if (JSON.stringify(board.sources) !== JSON.stringify(before.sources)) return;
    const synced = syncCards(board, this.tasks, result.cards, { now: this.host.now(), complete: result.errors.length === 0, newId: () => this.taskId() });
    this.tasks = synced.tasks;
    if (synced.changed) this.save();
    this.sync.set(boardId, result.errors.length && !result.cards.length ? { kind: 'error', message: result.errors.join(' ') } : { kind: 'ready', lastFetchedAt: this.host.now() });
    this.host.changed();
    this.pushHours();
  }

  // ── tasks ──

  createTask(boardId: BoardId, title: string, notes?: string): Task {
    this.board(boardId);
    const clean = title.trim();
    if (!clean) throw new OfficeError('A task needs a title.');
    const task = newTask({ id: this.taskId(), boardId, title: clean, ...(notes?.trim() ? { notes: notes.trim() } : {}), origin: { kind: 'manual' }, stage: 'todo', now: this.host.now() });
    this.tasks = [...this.tasks, task];
    this.save();
    return task;
  }

  updateTask(taskId: TaskId, patch: { title?: string; notes?: string; stage?: TaskStage }) {
    const task = this.task(taskId);
    const title = patch.title === undefined ? task.title : patch.title.trim();
    if (!title) throw new OfficeError('A task needs a title.');
    const { notes: _, ...rest } = task;
    const notes = patch.notes === undefined ? task.notes : patch.notes.trim() || undefined;
    this.replace({ ...rest, ...(notes ? { notes } : {}), title, stage: patch.stage ?? task.stage, updatedAt: this.host.now() });
    if (patch.stage && patch.stage !== task.stage) this.pushHours();
  }

  deleteTask(taskId: TaskId) {
    const task = this.task(taskId);
    const mail = this.host.mail();
    for (const run of task.runs) if (mail.state.unsettled.has(run)) mail.cancel('owner', run);
    this.tasks = this.tasks.filter((t) => t !== task);
    this.save();
  }

  // The block's PO or any of its employees takes the task, and starts on it now. Giving it to someone who is already on it
  // changes nothing, a retry of the same call does not post twice, and giving it to someone again once they settled posts
  // another run.
  assign(taskId: TaskId, employeeId: EmployeeId) {
    const task = this.task(taskId);
    const board = this.board(task.boardId);
    if (!this.host.members().some((m) => m.id === employeeId && m.blockId === board.blockId)) throw new OfficeError('A task goes to the PO of its block or to one of the block\'s employees.');
    const mail = this.host.mail();
    const theirs = task.runs.filter((r) => mail.state.messages.get(r)?.to === employeeId);
    if (theirs.some((r) => mail.state.unsettled.has(r))) return;
    const { title, text } = runRequest(task, board);
    const posted = mail.post({ from: 'owner', to: employeeId, blockId: board.blockId, key: runKey(task.id, employeeId, theirs.length), body: { kind: 'request', intent: 'work', title, text } });
    if (!posted.ok) throw new OfficeError(posted.detail);
    this.replace(this.withRun(task, posted.id, employeeId));
  }

  // The task with `who` taking the run that starts at `root`, and in doing: what assigning means.
  private withRun(task: Task, root: MessageId, who: EmployeeId): Task {
    return {
      ...task,
      runs: task.runs.includes(root) ? task.runs : [...task.runs, root],
      assignees: task.assignees.includes(who) ? task.assignees : [...task.assignees, who],
      stage: 'doing',
      updatedAt: this.host.now(),
    };
  }

  // Throws when `taskId` is not a task of `blockId`, so a hire can be refused before anyone is hired.
  assertOfBlock(taskId: TaskId, blockId: BlockId) {
    if (this.board(this.task(taskId).boardId).blockId !== blockId) throw new OfficeError('That task belongs to another block.');
  }

  // ── hours ──

  // Resolves when every push asked for so far has finished. For tests and shutdown.
  async idle() {
    while (this.pushing) await this.pushing;
  }

  // Sends what a CronoSpark task on a logging board has not sent yet, once it is in review or done. Level-triggered: it
  // looks at the marks, not at what changed, so asking twice sends once and a failed push is simply asked again later.
  pushHours() {
    if (this.pushing) {
      this.pushAgain = true;
      return;
    }
    this.pushing = (async () => {
      try {
        do {
          this.pushAgain = false;
          await this.pushDue();
        } while (this.pushAgain);
      } catch (err) {
        console.error('Could not send task hours:', err);
      } finally {
        this.pushing = undefined;
      }
    })();
  }

  private logsHours(t: Task): boolean {
    const board = this.boards.find((b) => b.id === t.boardId);
    return t.origin.kind === 'cronospark' && (t.stage === 'review' || t.stage === 'done') && board?.kind !== 'quick' && board?.logHours === true;
  }

  private async pushDue() {
    const eligible = this.tasks.filter((t) => this.logsHours(t));
    const slices = sliceTasks(this.log, eligible, this.host.now());
    for (const t of eligible) {
      for (const entry of hoursDue(t, closedDayWork(slices.get(t.id) ?? []))) {
        if (!(await this.pushOne(t.id, entry))) break;
      }
    }
  }

  // The mark moves before the call and moves back if the call fails, so nothing is ever sent twice.
  private async pushOne(taskId: TaskId, e: HoursEntry): Promise<boolean> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || task.origin.kind !== 'cronospark') return false;
    const externalId = task.origin.externalId;
    this.replace({ ...task, hours: { ...moveMark(task.hours, e, 1), inflight: e } }, false);
    let failure: string | undefined;
    try {
      await this.host.provider.logHours({ taskId: externalId, hours: e.hours, date: e.date, description: `${this.nameOf(e.employeeId)} (AI employee, Online Office)` });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    const now = this.tasks.find((t) => t.id === taskId);
    if (!now) return failure === undefined;
    const { inflight: _, error: __, ...hours } = failure === undefined ? (now.hours ?? { pushed: {} }) : moveMark(now.hours, e, -1);
    this.replace({ ...now, hours: failure === undefined ? hours : { ...hours, error: { message: `Could not send ${e.hours} h for ${this.nameOf(e.employeeId)} on ${e.date} to CronoSpark: ${failure}`, at: this.host.now() } } });
    return failure === undefined;
  }

  // ── plumbing ──

  private nameOf(id: EmployeeId): string {
    return this.host.members().find((m) => m.id === id)?.name ?? this.people[id] ?? 'a former employee';
  }

  private board(id: BoardId): Board {
    const b = this.boards.find((x) => x.id === id);
    if (!b) throw new OfficeError(`No such board ${id}`);
    return b;
  }

  private task(id: TaskId): Task {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new OfficeError(`No such task ${id}`);
    return t;
  }

  private replace(next: Task, notify = true) {
    this.tasks = this.tasks.map((t) => (t.id === next.id ? next : t));
    this.save();
    if (notify) this.host.changed();
  }

  private boardId = () => this.host.newId() as BoardId;
  private taskId = () => this.host.newId() as TaskId;

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const body: TasksFile = { v: 1, boards: this.boards, tasks: this.tasks, people: this.people };
    writeFileSync(tmp, JSON.stringify(body, null, 2));
    renameSync(tmp, this.file);
  }
}

// Only this process writes the file, so a shape check is enough. Anything odd starts the boards from scratch.
function read(file: string): TasksFile | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TasksFile> | null;
    if (!raw || raw.v !== 1 || !Array.isArray(raw.boards) || !Array.isArray(raw.tasks)) return undefined;
    return { v: 1, boards: raw.boards, tasks: raw.tasks, people: raw.people ?? {} };
  } catch {
    return undefined;
  }
}
