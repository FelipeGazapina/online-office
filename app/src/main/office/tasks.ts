// The owner's boards and tasks. State lives in tasks.json beside company.json. A task's time is not kept here: it is
// folded from the mailroom's ledger every time it is asked for (shared/tasks.ts), so what this file stores about work is
// the root requests a task started and, for CronoSpark, how much of that time the owner already sent. Hours leave only when
// the owner asks (sendHours): nothing here sends them on its own.
//
// Plain Node: verify/task-check.ts imports it without Electron.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { activityIndexOf, answerKey, clipText, emptyActivity, foldActivity, liveOf, logOf, noInputs, noteKey, rootsOf, type ActivityEntry, type ActivityIndex, type LiveInputs, type TaskLive } from '../../shared/activity.ts';
import type { LedgerEntry, Message, MessageId, Posted } from '../../shared/mail.ts';
import type { BlockId, EmployeeId, EmployeeRole, LinearPeople, LinearPerson, TaskBoardSource, TaskCard } from '../../shared/protocol.ts';
import {
  agentMoveRefusal,
  closedDayWork,
  emptyTurnLog,
  ensureBoards,
  foldTurn,
  handoffEnding,
  handoffsMade,
  handoffsProposed,
  handoffLive,
  hoursDue,
  makeBoard,
  MAX_HANDOFFS,
  MAX_PROPOSALS,
  moveMark,
  newTask,
  outcomeFromRuns,
  patchBoard,
  prBody,
  prIsOpen,
  restage,
  runRequest,
  sliceTasks,
  syncCards,
  taskBranchName,
  taskKey,
  timeFromSlices,
  turnLogOf,
  unsentOf,
  wantsCard,
  withGitNote,
  withPr,
  withEvent,
  type AgentStage,
  type Board,
  type BoardId,
  type BoardPatch,
  type BoardSpec,
  type BoardSync,
  type FindRefusalReason,
  type Handoff,
  type HandoffId,
  type HandoffRefusal,
  type HandoffRefusalReason,
  type HandoffStep,
  type HoursEntry,
  type LegacySources,
  type MoveFacts,
  type MoveRefusal,
  type Priority,
  type RunState,
  type StageBy,
  type Task,
  type TaskId,
  type TaskStage,
  type TaskTime,
  type TurnLog,
} from '../../shared/tasks.ts';
import { OfficeError } from './error.ts';
import type { MailState, Mailroom } from './mail.ts';
import { ensurePr, markReady, readPr, type Gh } from './pull-request.ts';
import type { HoursCall } from './task-board.ts';
import { createTaskWorkspace, defaultBase, isGitRepo, pushBranch, removeTaskWorkspace, unpushed, type Workspace } from './workspace.ts';

export type Teammate = { id: EmployeeId; name: string; blockId: BlockId; role: EmployeeRole };

export type TasksHost = {
  now(): number;
  newId(): string;
  // The mailroom changes when the owner resets the company, so this is asked for every time.
  mail(): Mailroom;
  blocks(): readonly BlockId[];
  // Everyone who works anywhere, PO included.
  members(): readonly Teammate[];
  // The branch a person works on in their own worktree, when they have one. What is on it is not merged until they finish a request.
  branchOf?(who: EmployeeId): string | undefined;
  provider: {
    // `keep` says which cards the board wants. A provider drops the others before it counts anything against a limit.
    fetchSources(sources: readonly TaskBoardSource[], keep: (card: TaskCard) => boolean): Promise<{ cards: TaskCard[]; errors: string[] }>;
    linearPeople(): Promise<LinearPerson[]>;
    logHours(entry: HoursCall): Promise<void>;
  };
  changed(): void;
  // Absent, no task gets a branch or a pull request.
  git?: TasksGit;
};

// What a task's branch and pull request need from the office: the block's repository, a place for the task's worktree, and gh.
export type TasksGit = {
  block(blockId: BlockId): { name: string; cwd: string } | undefined;
  worktree(taskId: TaskId): string;
  gh: Gh;
};

// `nextNumber` is the number the next task gets. It only grows, so a deleted task's number is never given again.
type TasksFile = { v: 1; boards: Board[]; tasks: Task[]; people: Record<string, string>; nextNumber: number };

// What a task made by hand may carry beyond its title. `assignee` hands it over in the same step.
export type NewTask = { notes?: string; stage?: TaskStage; priority?: Priority; assignee?: EmployeeId };

export type TasksView = { boards: Board[]; tasks: Task[]; boardSync: Record<BoardId, BoardSync>; taskTime: Record<TaskId, TaskTime>; taskLive: Record<TaskId, TaskLive>; linearPeople: LinearPeople };

// What pulling a board depends on: its sources, filters included, and the columns it has folded away.
const pulls = (board: Board): string => (board.kind === 'quick' ? '' : JSON.stringify([board.sources, board.collapsed ?? []]));

// The state of a root request as a task cares about it.
function runStateOf(mail: MailState, id: MessageId): RunState | undefined {
  const life = mail.life.get(id);
  if (!life) return undefined;
  if (life.s !== 'settled') return { s: 'open' };
  const reply = mail.messages.get(life.by);
  return reply?.kind === 'reply' ? { s: 'settled', reply: reply.id, outcome: life.outcome, text: reply.text, at: reply.at } : undefined;
}

// Whether a notice reached its person, read off the mail: the message under `key` and the turn it was delivered to. A notice
// that is still queued is unseen, so is one whose turn the app died in once it has restarted (the mailroom queues it again),
// and one delivered to a turn that goes on is not heard yet, since the person may still answer in it.
export type NoticeSeen = 'unseen' | 'seen_in_open_turn' | 'seen_in_ended_turn';

export function noticeSeen(mail: Pick<MailState, 'keys' | 'life' | 'turns'>, key: string): NoticeSeen {
  const id = mail.keys.get(key);
  const life = id && mail.life.get(id);
  if (!life || life.s !== 'delivered') return 'unseen';
  return mail.turns.get(life.turn)?.ended ? 'seen_in_ended_turn' : 'seen_in_open_turn';
}

// What the owner's retried assign_task shares with the first one: the same task, the same person, and how many runs that
// person already had of it.
const runKey = (task: TaskId, who: EmployeeId, nth: number) => `task:${task}:${who}:${nth}`;

// The same for the run a handoff posts, whether to its receiver or, when it ends with the task staying, back to its giver.
// It holds the handoff instead of a count, so a retry after a crash finds the run even once its person has finished it.
const handoffRunKey = (task: TaskId, who: EmployeeId, handoff: HandoffId, back = false) => `task:${task}:${who}:${handoff}${back ? '-back' : ''}`;

// How a handoff call went. An open proposal answers with who it waits on, a settled one with the people it moved between.
export type HandoffResult =
  | { ok: true; state: 'proposed'; id: HandoffId; task: string; from: string; to: string; awaits: string; next: string }
  | { ok: true; state: 'accepted' | 'declined' | 'withdrawn'; id: HandoffId; task: string; from: string; to: string }
  | ({ ok: false } & HandoffRefusal);

const refused = (reason: HandoffRefusalReason, detail: string): HandoffResult => ({ ok: false, reason, detail });

const poOf = (team: readonly Teammate[]): Teammate | undefined => team.find((m) => m.role === 'orchestrator');

const STALE = 'someone on it left the task or the block.';
const DONE = 'This task is done. Ask the owner to reopen it.';

// The step each answer ends a proposal with.
const ENDS = { accept: 'accepted', decline: 'declined', withdraw: 'withdrawn' } as const;

// Each step of a proposal is told once, whoever asks again.
const handoffKey = (id: HandoffId, step: Notice) => `handoff:${id}:${step}`;

// Each step of a proposal is told, and the person it waits on is also reminded once.
type Notice = HandoffStep | 'reminder' | 'accepted-to';

const QUESTION_QUOTE_CAP = 1500;
const quote = (text: string) => text.split('\n').map((l) => `> ${l}`).join('\n');

export class Tasks {
  private boards: Board[] = [];
  private tasks: Task[] = [];
  // The names of people who left, so hours they worked still go out under their name.
  private people: Record<string, string> = {};
  private nextNumber = 1;
  private readonly sync = new Map<BoardId, BoardSync>();
  private linearPeople: LinearPeople = { kind: 'unknown' };
  private log: TurnLog;
  // The ledger as the activity log reads it: kept up to date entry by entry, like the turn log.
  private activity: ActivityIndex;
  private readonly file: string;
  private readonly host: TasksHost;
  private refreshing = new Map<BoardId, Promise<void>>();
  private refreshAgain = new Set<BoardId>();
  // The tasks whose hours are going out right now, so a second ask joins the first instead of sending the same time twice.
  private readonly sending = new Map<TaskId, Promise<void>>();
  // The tasks whose branch is going to GitHub right now, and those that moved again while it was.
  private readonly publishing = new Map<TaskId, Promise<void>>();
  private readonly publishAgain = new Set<TaskId>();
  private prRound: Promise<void> | undefined;
  // Tasks in review whose draft pull request was asked to leave draft during this stay in review.
  private readonly readyAsked = new Set<TaskId>();
  private readonly existed: boolean;
  // Requests the mailroom has handed to their person. A task waits in its column while its run sits in a queue, and the office
  // moves it to doing once, when the run is delivered: `begun` holds the runs that already moved their task.
  private readonly delivered = new Set<MessageId>();
  private readonly begun = new Set<MessageId>();

  constructor(file: string, host: TasksHost, ledger: readonly LedgerEntry[]) {
    this.file = file;
    this.host = host;
    this.log = turnLogOf(ledger);
    this.activity = activityIndexOf(ledger);
    const stored = read(file);
    this.existed = !!stored;
    if (stored) {
      ({ boards: this.boards, tasks: this.tasks, people: this.people, nextNumber: this.nextNumber } = stored);
      // A file from before task numbers: number its tasks in the order they were made, once, and write it back.
      if (this.tasks.some((t) => !t.number)) {
        const numbered = numberTasks(this.tasks, this.nextNumber);
        this.tasks = numbered.tasks;
        this.nextNumber = numbered.nextNumber;
        this.save();
      }
    }
    for (const entry of ledger) if (entry.t === 'deliver') for (const id of entry.ids) this.delivered.add(id);
    for (const t of this.tasks) for (const run of t.runs) if (this.delivered.has(run)) this.begun.add(run);
  }

  // Run once the mailroom is open. Brings the stored state in line with the company: boards for every block (the old
  // per-block sources become a board the first time), runs a crash left unlinked, and flags an hours entry a crash left unconfirmed.
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
      this.tasks = this.tasks.map((t) => (t === task ? this.withRun(t, id, who as EmployeeId, 'mailroom') : t));
      changed = true;
    }
    // A relinked run may already have been picked up. Chasing handoffs posts words, and nobody has a session yet.
    if (changed) this.follow();
    if (changed || !this.existed) this.save();
  }

  // ── what the renderer sees ──

  view(now: number, inputs: LiveInputs = noInputs): TasksView {
    const worked = this.tasks.filter((t) => t.runs.length);
    const slices = sliceTasks(this.log, worked, now);
    const taskTime = {} as Record<TaskId, TaskTime>;
    for (const t of worked) {
      const mine = slices.get(t.id) ?? [];
      const time = timeFromSlices(mine, now);
      const unsent = t.origin.kind === 'cronospark' ? unsentOf(t, mine) : undefined;
      taskTime[t.id] = unsent ? { ...time, unsent } : time;
    }
    const taskLive = Object.fromEntries(worked.map((t) => [t.id, liveOf(t, this.activity, inputs)])) as Record<TaskId, TaskLive>;
    return { boards: this.boards, tasks: this.tasks, boardSync: Object.fromEntries(this.sync) as Record<BoardId, BoardSync>, taskTime, taskLive, linearPeople: this.linearPeople };
  }

  // Everything that happened on a task and what is happening now. Folded from the ledger and the task's history each time it is asked.
  // A task deleted while its detail was asking has no log, and that is not an error.
  activityOf(taskId: TaskId, inputs: LiveInputs): { entries: ActivityEntry[]; live: TaskLive } | undefined {
    const task = this.tasks.find((t) => t.id === taskId);
    return task && { entries: logOf(task, this.activity), live: liveOf(task, this.activity, inputs) };
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
    this.releaseWorktrees(blockId);
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
    for (const t of this.tasks) this.releaseWorktree(t);
    this.boards = [];
    this.tasks = [];
    this.people = {};
    this.nextNumber = 1;
    this.sync.clear();
    this.delivered.clear();
    this.begun.clear();
    this.log = emptyTurnLog();
    this.activity = emptyActivity();
    this.save();
  }

  // ── the mailroom changed ──

  // Every ledger entry, in order, as the mailroom writes it.
  observe(entry: LedgerEntry) {
    if (entry.t === 'deliver') for (const id of entry.ids) this.delivered.add(id);
    foldTurn(this.log, entry);
    foldActivity(this.activity, entry);
  }

  // Takes in how runs ended, and chases the handoffs nobody answers.
  onMail() {
    this.follow();
    this.chase();
  }

  private follow() {
    const mail = this.host.mail().state;
    let moved = false;
    this.tasks = this.tasks.map((t0) => {
      if (!t0.runs.length) return t0;
      let t = t0;
      for (const run of t0.runs) {
        if (this.begun.has(run) || !(this.delivered.has(run) || mail.life.get(run)?.s === 'running')) continue;
        this.begun.add(run);
        moved = true;
        t = restage({ ...t, updatedAt: this.host.now() }, 'doing', 'mailroom', this.host.now(), run);
      }
      const outcome = outcomeFromRuns(t, (run) => runStateOf(mail, run));
      if (!outcome) return t;
      moved = true;
      const now = this.host.now();
      const { stage, ...taken } = outcome;
      const noted = { ...t, ...taken, updatedAt: now };
      return stage ? restage(noted, stage, 'mailroom', now, outcome.lastOutcome.reply) : noted;
    });
    if (moved) {
      this.save();
      this.readyDrafts();
    }
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
    // What a board pulls is its sources and the columns it has open: changing either asks for a round of its own.
    if (made.board.kind !== 'quick' && pulls(made.board) !== pulls(board)) void this.refresh(boardId);
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
    const result = await this.host.provider.fetchSources(before.sources, (card) => wantsCard(before, card)).catch((err: unknown) => ({ cards: [] as TaskCard[], errors: [err instanceof Error ? err.message : String(err)] }));
    const board = this.boards.find((b) => b.id === boardId);
    if (!board || board.kind === 'quick') return;
    // What the board pulls changed while this was out, and the change asked for its own round.
    if (pulls(board) !== pulls(before)) return;
    const synced = syncCards(board, this.tasks, result.cards, { now: this.host.now(), complete: result.errors.length === 0, newId: () => this.taskId(), nextNumber: () => this.nextNumber++ });
    this.tasks = this.noteMoves(synced.tasks, 'provider');
    if (synced.changed) {
      this.save();
      this.readyDrafts();
    }
    this.sync.set(boardId, result.errors.length && !result.cards.length ? { kind: 'error', message: result.errors.join(' ') } : { kind: 'ready', lastFetchedAt: this.host.now() });
    this.host.changed();
  }

  // ── who the Linear assignee picker offers ──

  // Asks Linear for its users. Two asks at once are one: the second sees `loading` and leaves.
  async loadLinearPeople() {
    if (this.linearPeople.kind === 'loading') return;
    this.linearPeople = { kind: 'loading' };
    this.host.changed();
    try {
      this.linearPeople = { kind: 'ready', people: await this.host.provider.linearPeople() };
    } catch (err) {
      this.linearPeople = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    this.host.changed();
  }

  // ── tasks ──

  // With an `assignee` the task is made and handed over in one step: either both happen, or the task is not made at all.
  createTask(boardId: BoardId, title: string, opt: NewTask = {}): Task {
    const board = this.board(boardId);
    const clean = title.trim();
    if (!clean) throw new OfficeError('A task needs a title.');
    if (opt.assignee) this.assertMember(opt.assignee, board.blockId);
    const notes = opt.notes?.trim();
    const origin = { kind: 'manual' as const, ...(opt.priority ? { priority: opt.priority } : {}) };
    const task = newTask({ id: this.taskId(), number: this.nextNumber++, boardId, title: clean, ...(notes ? { notes } : {}), origin, stage: opt.stage ?? 'todo', now: this.host.now() });
    this.tasks = [...this.tasks, task];
    this.save();
    if (!opt.assignee) return task;
    try {
      this.assign(task.id, opt.assignee);
    } catch (err) {
      this.releaseWorktree(this.task(task.id));
      this.tasks = this.tasks.filter((t) => t.id !== task.id);
      this.save();
      throw err;
    }
    return this.task(task.id);
  }

  updateTask(taskId: TaskId, patch: { title?: string; notes?: string; stage?: TaskStage; priority?: Priority | null }) {
    const task = this.task(taskId);
    const title = patch.title === undefined ? task.title : patch.title.trim();
    if (!title) throw new OfficeError('A task needs a title.');
    const { notes: _, ...rest } = task;
    const notes = patch.notes === undefined ? task.notes : patch.notes.trim() || undefined;
    // A task the owner moves stays where the owner put it: whatever its provider says on the next sync, and whatever a teammate
    // would say, until the owner gives the task to someone again.
    const pin = patch.stage !== undefined;
    let origin = task.origin;
    if (patch.priority !== undefined) {
      if (origin.kind !== 'manual') throw new OfficeError(`The priority of a ${origin.sourceLabel} task is set in ${origin.sourceLabel}.`);
      origin = patch.priority === null ? { kind: 'manual' } : { kind: 'manual', priority: patch.priority };
    }
    const now = this.host.now();
    this.replace(restage({ ...rest, ...(notes ? { notes } : {}), origin, title, stage: task.stage, ...(pin ? { stagePinned: true as const } : {}), updatedAt: now }, patch.stage ?? task.stage, 'owner', now));
  }

  deleteTask(taskId: TaskId) {
    const task = this.task(taskId);
    const mail = this.host.mail();
    for (const run of task.runs) if (mail.state.unsettled.has(run)) mail.cancel('owner', run);
    this.releaseWorktree(task);
    this.tasks = this.tasks.filter((t) => t !== task);
    this.save();
  }

  // The block's PO or any of its employees takes the task, and starts on it now. Giving it to someone who is already on it
  // changes nothing, a retry of the same call does not post twice, and giving it to someone again once they settled posts
  // another run. A run the owner posts settles a handoff still waiting on someone's agreement: the owner has decided.
  assign(taskId: TaskId, employeeId: EmployeeId) {
    const task = this.task(taskId);
    const board = this.board(task.boardId);
    this.assertMember(employeeId, board.blockId);
    const given = this.giveRun(task, employeeId);
    if (!given.ok) throw new OfficeError(given.detail);
    if (!given.posted) return;
    this.replace(given.task);
    this.drop(given.task, 'the owner assigned the task.', 'owner');
    // Someone free got the request as it was posted, before the task knew the run: it moves to doing now.
    this.onMail();
    void this.publish(task.id);
  }

  // The one request a person is given for a task: a work request from the owner, on the task's own branch. Like any assignment it
  // lifts the owner's pin, which would keep the person from moving the card. Someone who already holds an open run is given no
  // second. The task comes back with the run on it, unsaved, so a caller with more to change saves once.
  private giveRun(task: Task, who: EmployeeId, opt: { note?: string; key?: string } = {}): { ok: true; task: Task; posted: boolean } | { ok: false; detail: string } {
    const mail = this.host.mail();
    const theirs = this.runsOf(task, who);
    if (!(opt.key && mail.state.keys.has(opt.key)) && theirs.some((r) => mail.state.unsettled.has(r))) return { ok: true, task, posted: false };
    const board = this.board(task.boardId);
    // The branch exists before the request is posted, because the person's first sync already comes from it.
    const { title, text } = runRequest(this.startBranch(task), board);
    const posted = mail.post({ from: 'owner', to: who, blockId: board.blockId, key: opt.key ?? runKey(task.id, who, theirs.length), body: { kind: 'request', intent: 'work', title, text: opt.note ? `${opt.note}\n\n${text}` : text } });
    if (!posted.ok) return { ok: false, detail: posted.detail };
    return { ok: true, task: this.withRun(this.task(task.id), posted.id, who, 'owner'), posted: true };
  }

  // The runs of a task that were given to `who`.
  private runsOf(task: Task, who: EmployeeId): MessageId[] {
    const mail = this.host.mail().state;
    return task.runs.filter((r) => mail.messages.get(r)?.to === who);
  }

  // The task with `who` taking the run that starts at `root`. It stays in its column while the run waits in `who`'s queue:
  // onMail moves it to doing when the run is delivered. `by` is who gave it.
  private withRun(task: Task, root: MessageId, who: EmployeeId, by: StageBy): Task {
    const taken = {
      ...task,
      runs: task.runs.includes(root) ? task.runs : [...task.runs, root],
      assignees: task.assignees.includes(who) ? task.assignees : [...task.assignees, who],
      updatedAt: this.host.now(),
    };
    if (by === 'owner') delete taken.stagePinned;
    return taken;
  }

  // ── questions ──

  // The owner answers a question from the board. A blocked request cannot take another word, so the answer starts a new run
  // for whoever stopped, inside the same chain (the key makes a second click the same run). A question the asker put to a
  // teammate or to the owner's own desk reaches whoever has to act on it as a word in the thread. In both the owner's words
  // go through the mailroom, so the person wakes the way any teammate would.
  answer(taskId: TaskId, id: MessageId, text: string, inputs: LiveInputs) {
    const answer = text.trim();
    if (!answer) throw new OfficeError('An answer needs some words.');
    const task = this.task(taskId);
    if (this.activity.answered.has(id)) return;
    const question = liveOf(task, this.activity, inputs).questions.find((q) => q.ref.kind === 'mail' && q.ref.id === id);
    if (!question || question.how === 'ask' || question.how === 'permission') throw new OfficeError('That question is not waiting for an answer any more.');
    const board = this.board(task.boardId);
    const mail = this.host.mail();
    const asked = this.activity.msgs.get(question.piece.id);
    if (asked?.kind !== 'request') throw new OfficeError('That question is not waiting for an answer any more.');
    const said = clipText(question.how === 'blocked' && question.blocker ? `${question.blocker.why}\nQuestion: ${question.blocker.question}` : question.text, QUESTION_QUOTE_CAP);
    const asker = this.nameOf(question.asker);
    if (question.how === 'blocked' && question.to === 'owner') {
      const text = `The owner answers: ${answer}\n\nYou stopped on "${asked.title}" and told them:\n${quote(said)}\n\nCarry on with the task now.\n\n${runRequest(task, board).text}`;
      const posted = mail.post({ from: 'owner', to: question.asker, blockId: board.blockId, parentId: asked.rootId, key: answerKey(task.id, question.asker, id), body: { kind: 'request', intent: 'work', title: asked.title, text } });
      if (!posted.ok) throw new OfficeError(posted.detail);
      this.replace(this.withRun(task, posted.id, question.asker, 'owner'));
      this.onMail();
      return;
    }
    const nudge = question.how === 'blocked'
      ? { to: question.to as EmployeeId, parentId: asked.parentId ?? undefined, text: `The owner answers ${asker}'s block on "${asked.title}": ${answer}\n\n${asker} stopped and said:\n${quote(said)}\n\nA message alone does not restart ${asker}: send them a new request that carries this answer, or do the piece yourself.` }
      : { to: question.asker, parentId: asked.id, text: `The owner answers your question to ${this.nameOf(question.to as EmployeeId)}: ${answer}` };
    const posted = mail.post({ from: 'owner', to: nudge.to, blockId: board.blockId, ...(nudge.parentId ? { parentId: nudge.parentId } : {}), key: noteKey(task.id, id), body: { kind: 'say', text: nudge.text, urgency: 'next' } });
    if (!posted.ok) throw new OfficeError(posted.detail);
    this.host.changed();
  }

  // ── a teammate moves the card ──

  // A teammate takes their task to review, to done, or back to doing, and says why. The card is the one they name (its id or
  // its title), or the only one they are working on. The rules are shared/tasks.ts agentMoveRefusal, asked of what the mail
  // says: the move is recorded on the task's history under their name with their reason, and a refused one changes nothing.
  // Asking again for where the card already is changes nothing either.
  moveByAgent(who: EmployeeId, to: AgentStage, reason: string, ref?: string): { ok: true; task: string; from: TaskStage; to: AgentStage; changed: boolean } | ({ ok: false } & MoveRefusal) {
    const found = this.taskFor(who, ref);
    if ('reason' in found) return { ok: false, ...found };
    const refusal = agentMoveRefusal(found, to, this.movesOf(found, who));
    if (refusal) return { ok: false, ...refusal };
    const now = this.host.now();
    const moved = restage({ ...found, updatedAt: now }, to, who, now, undefined, reason);
    const changed = moved.stage !== found.stage;
    if (changed) this.replace(moved);
    return { ok: true, task: found.title, from: found.stage, to, changed };
  }

  // The task a teammate means: the one they name among their block's tasks, else the one they hold a request of, or that `also` picks.
  private taskFor(who: EmployeeId, ref?: string, also: (t: Task) => boolean = () => false): Task | { reason: FindRefusalReason; detail: string } {
    const blockId = this.host.members().find((m) => m.id === who)?.blockId;
    const mine = this.tasks.filter((t) => this.board(t.boardId).blockId === blockId);
    const line = (t: Task) => `"${t.title}" (${t.id})`;
    if (ref) {
      const key = ref.trim().toLowerCase();
      const found = mine.filter((t) => t.id === ref || t.title.toLowerCase() === key);
      if (found.length === 1) return found[0]!;
      return { reason: found.length ? 'ambiguous' : 'unknown_task', detail: found.length ? `More than one task is called "${ref}": ${found.map(line).join(', ')}. Name one by its id.` : `No task of your block is called or numbered "${ref}".` };
    }
    const held = mine.filter((t) => this.movesOf(t, who).holding || also(t));
    if (held.length === 1) return held[0]!;
    return held.length
      ? { reason: 'ambiguous', detail: `You are working on ${held.length} tasks: ${held.map(line).join(', ')}. Say which one with task.` }
      : { reason: 'no_task', detail: 'You hold no request of a task right now. Say which task you mean with task (its title or id), if it is yours.' };
  }

  // What the mail says about `who` and a task: whether it is theirs, whether they hold one of its requests, and what else is open.
  private movesOf(task: Task, who: EmployeeId): MoveFacts {
    const ix = this.activity;
    const chain = [...rootsOf(task, ix)].flatMap((root) => ix.members.get(root) ?? []).map((id) => ix.msgs.get(id)!);
    const open = chain.filter((m): m is Extract<Message, { kind: 'request' }> => m.kind === 'request' && m.intent !== 'gauntlet' && ix.unsettled.has(m.id));
    const mine = open.filter((r) => r.to === who && ix.life.get(r.id)?.s === 'delivered');
    return {
      onTask: task.assignees.includes(who) || chain.some((m) => m.from === who || m.to === who),
      holding: mine.length > 0,
      open: open.filter((r) => !mine.includes(r)).map((r) => `${this.nameOf(r.to as EmployeeId)}: "${r.title}"`),
    };
  }

  // ── a task changes hands ──

  // `who` asks to give a task to a teammate or, as the PO, asks the person holding it to. The other of the giver and the PO has to
  // agree (answerHandoff), and when they are one person it applies at once. Names are looked up in `who`'s block, and "po" is its PO.
  // One proposal is open on a task at a time, and asking for the same one again returns it and posts nothing.
  proposeHandoff(who: EmployeeId, a: { to: string; reason: string; task?: string; from?: string }): HandoffResult {
    // A giver who asked has stepped off, so asking again finds the task by its open handoff, not by a run.
    const found = this.taskFor(who, a.task, (t) => t.handoff?.by === who);
    if ('reason' in found) return refused(found.reason, found.detail);
    const team = this.teamOf(found);
    const po = poOf(team);
    if (!found.assignees.includes(who) && who !== po?.id) {
      return refused('not_on_task', this.movesOf(found, who).onTask
        ? 'You hold a piece of this task that someone gave you, not the task. If another person should take your piece, reply blocked and name them: the one who sent it decides.'
        : 'This task is not yours to hand over: you are not on it, and you are not the PO.');
    }
    if (!po) return refused('no_po', 'Your block has no PO to agree with. Message the owner instead.');
    if (found.stage === 'done') return refused('done', DONE);
    const task = this.dropStale(found, who);
    const named = a.from === undefined ? undefined : this.teammate(team, a.from);
    if (a.from !== undefined && !named) return refused('bad_target', `No teammate of your block is called "${a.from}".`);
    const lone = task.assignees.length === 1 ? task.assignees[0] : undefined;
    // An employee gives their own part. The PO's part goes only when the PO names it, or is all there is.
    const own = who !== po.id && task.assignees.includes(who) ? who : undefined;
    const from = named?.id ?? own ?? lone;
    if (!from) return refused('bad_target', task.assignees.length ? `Say whose part to hand over with from. On this task: ${task.assignees.map((id) => this.nameOf(id)).join(', ')}.` : 'Nobody is on this task, so there is nothing to hand over.');
    if (!task.assignees.includes(from)) return refused('bad_target', `${this.nameOf(from)} is not on this task.`);
    if (from !== who && who !== po.id) return refused('bad_target', 'You can hand over only your own part of a task. The PO hands over anyone\'s.');
    const to = this.teammate(team, a.to)?.id;
    if (!to) return refused('bad_target', `No teammate of your block is called "${a.to}".`);
    if (to === from) return refused('bad_target', 'A task cannot be handed to the person giving it away.');
    const open = task.handoff;
    if (open) {
      if (open.by === who && open.from === from && open.to === to) {
        if (open.by === open.from) this.stepOff(task, open);
        return this.openResult(task, open);
      }
      const answer = open.awaits === who
        ? ` It waits on you: answer it with answerHandoff { id: "${open.id}", answer: "accept" }, or "decline".`
        : open.by === who ? ` To propose something else, withdraw it first with answerHandoff { id: "${open.id}", answer: "withdraw" }.` : '';
      return refused('open_handoff', `Another handoff is open on this task: ${open.id}, ${this.nameOf(open.from)} to ${this.nameOf(open.to)}, waiting on ${this.nameOf(open.awaits)}.${answer}`);
    }
    if (handoffsMade(task) >= MAX_HANDOFFS) return refused('too_many', `This task changed hands ${MAX_HANDOFFS} times already. Message the owner to decide who holds it.`);
    if (handoffsProposed(task) >= MAX_PROPOSALS) return refused('too_many', `This task was proposed for handing over ${MAX_PROPOSALS} times already. Message the owner to decide who holds it.`);
    const h: Handoff = { id: `h-${this.host.newId().slice(0, 8)}` as HandoffId, from, to, by: who, awaits: who === from ? po.id : from, reason: a.reason.trim(), at: this.host.now() };
    if (!this.live(task, h)) return refused('bad_target', `${this.nameOf(from)} no longer works in this block.`);
    if (h.awaits === h.by) {
      const done = this.transfer(task, h, who, h.reason);
      return 'reason' in done ? refused(done.reason, done.detail) : this.result(done, h, 'accepted');
    }
    const stopped = h.by === h.from ? ` ${this.nameOf(h.by)} has stopped working on it until you answer.` : '';
    const asked = `${this.nameOf(h.by)} asks ${h.by === h.from ? 'to hand over' : 'you to hand over'} the task "${task.title}" to ${this.nameOf(h.to)}.${stopped}\nReason: ${h.reason}\n\nIt changes hands only if you agree, and saying yes in a message changes nothing. Answer with answerHandoff { id: "${h.id}", answer: "accept" }, or answer "decline" and say why in reason. Answer before this turn ends. If you do not, the office reminds you once, and drops the handoff if your next turn also ends without an answer.`;
    // Told first: a proposal nobody was told of is never recorded.
    const told = this.tell(h.awaits, task, h, 'proposed', asked);
    if (!told.ok) return refused('bad_target', `${this.nameOf(h.awaits)} cannot be asked right now: ${told.detail}`);
    const now = this.host.now();
    this.replace(withEvent({ ...task, handoff: h, updatedAt: now }, { kind: 'handoff', at: now, handoff: h.id, step: 'proposed', from, to, by: who, reason: h.reason }));
    if (h.by === h.from) this.stepOff(this.task(task.id), h);
    return this.openResult(this.task(task.id), h);
  }

  // Drops every open proposal that can no longer apply, for the office to run when someone leaves and when it starts. Running it
  // again changes nothing.
  reconcileHandoffs() {
    for (const { id } of [...this.tasks]) {
      const task = this.task(id);
      if (task.handoff && !this.live(task, task.handoff)) this.drop(task, STALE);
    }
  }

  // The person a handoff waits on accepts or declines it, or the one who proposed it withdraws it. Accepting is the one place the
  // task changes hands. Answering a proposal that already settled says how it ended and does nothing else, so a retry is safe.
  answerHandoff(who: EmployeeId, a: { id: string; answer: 'accept' | 'decline' | 'withdraw'; reason?: string }): HandoffResult {
    const blockId = this.host.members().find((m) => m.id === who)?.blockId;
    const task = this.tasks.find((t) => this.board(t.boardId).blockId === blockId && (t.handoff?.id === a.id || handoffEnding(t, a.id as HandoffId)));
    if (!task) return refused('unknown_handoff', `No handoff ${a.id} is open on a task of your block.`);
    const h = task.handoff?.id === a.id ? task.handoff : undefined;
    if (!h) return this.endedResult(task, who, a.id as HandoffId, a.answer);
    if (!this.live(task, h)) {
      this.drop(task, STALE, who);
      return refused('stale', `This handoff can no longer apply: ${STALE} The office dropped it.`);
    }
    if (who !== (a.answer === 'withdraw' ? h.by : h.awaits)) return refused('not_yours', a.answer === 'withdraw' ? 'Only the one who proposed a handoff withdraws it.' : `Only ${this.nameOf(h.awaits)} accepts or declines this handoff.`);
    if (a.answer === 'accept' && task.stage === 'done') return refused('done', DONE);
    const reason = a.reason?.trim() || undefined;
    const title = task.title;
    const [from, to, actor] = [this.nameOf(h.from), this.nameOf(h.to), this.nameOf(who)];
    const why = reason ? `\nReason: ${reason}` : '';
    switch (a.answer) {
      case 'accept': {
        const done = this.transfer(task, h, who, reason);
        if ('reason' in done) return refused(done.reason, done.detail);
        this.tell(h.by, done, h, 'accepted', `${actor} agreed: "${title}" is now ${to}'s, no longer ${from}'s.${why}`);
        return this.result(done, h, 'accepted');
      }
      case 'decline': {
        const closed = this.close(task, h, 'declined', who, reason);
        this.replace(closed);
        if (!this.giveBack(closed, h, `${actor} declined to hand this task over to ${to}. It stays with you: carry on with it.${why}`)) {
          this.tell(h.by, closed, h, 'declined', `${actor} declined to hand "${title}" over to ${to}. It stays with ${from}.${why}`);
        }
        return this.result(closed, h, 'declined');
      }
      case 'withdraw': {
        const closed = this.close(task, h, 'withdrawn', who, reason);
        this.replace(closed);
        this.tell(h.awaits, closed, h, 'withdrawn', `${actor} withdrew the request to hand "${title}" over to ${to}. Nothing is needed from you.${why}`);
        this.giveBack(closed, h, `You withdrew the request to hand this task over to ${to}. It stays with you: carry on with it.${why}`);
        return this.result(closed, h, 'withdrawn');
      }
    }
  }

  // The one place an agreement changes who has a task, in one synchronous step and one save. onMail sees the new person's open
  // run together with the giver's cancelled ones, so the card does not drop back to todo. A refusal changes nothing.
  private transfer(task: Task, h: Handoff, agreedBy: EmployeeId, reason: string | undefined): Task | HandoffRefusal {
    const [by, agreed, from] = [this.nameOf(h.by), this.nameOf(h.awaits), this.nameOf(h.from)];
    const theirs = this.host.branchOf?.(h.from);
    const note = [
      `${by} handed this task ${h.by === h.from ? '' : `from ${from} `}over to you${h.by === h.awaits ? '' : `, and ${agreed} agreed`}.`,
      `Reason: ${h.reason}`,
      theirs && `${from}'s unfinished work on it, if any, is on their own branch ${theirs} and is not merged: look at it before you start.`,
      task.git && `Finished work of this task is on ${task.git.branch}.`,
    ].filter(Boolean).join('\n');
    const given = this.giveRun(task, h.to, { note, key: handoffRunKey(task.id, h.to, h.id) });
    if (!given.ok) return { reason: 'bad_target', detail: `${this.nameOf(h.to)} cannot take the task now: ${given.detail}` };
    // Someone who already holds a run gets no new one, so the word that says the task is theirs alone has to come another way.
    if (!given.posted) this.tell(h.to, given.task, h, 'accepted-to', `${note}\nThe task is yours alone now: ${from} is off it.`);
    this.release(given.task, h.from, `Handed over to ${this.nameOf(h.to)}.`);
    const next = { ...this.close(given.task, h, 'accepted', agreedBy, reason), assignees: given.task.assignees.filter((id) => id !== h.from) };
    this.replace(next);
    this.onMail();
    return next;
  }

  // The task without its open proposal, and the step that closed it on its history. A handoff applied at once was never open.
  private close(task: Task, h: Handoff, step: Exclude<HandoffStep, 'proposed'>, by: EmployeeId, reason?: string): Task {
    const { handoff: _, ...rest } = task;
    const now = this.host.now();
    return withEvent({ ...rest, updatedAt: now }, { kind: 'handoff', at: now, handoff: h.id, step, from: h.from, to: h.to, by, ...(reason ? { reason } : {}) });
  }

  // Clears a proposal nobody can act on any more. A giver who asked gets the task back, and the one who proposed is told, unless
  // they are the one who ended it. `cause` is who ended it: the owner's own assignment gives nothing back, since the owner decided.
  private drop(task: Task, because: string, cause?: EmployeeId | 'owner'): Task {
    const h = task.handoff;
    if (!h) return task;
    const closed = this.close(task, h, 'dropped', h.by, because);
    this.replace(closed);
    const back = cause === 'owner' ? undefined : this.giveBack(closed, h, `The handoff of this task to ${this.nameOf(h.to)} was dropped: ${because} It stays with you: carry on with it.`);
    if (!back && cause !== h.by) this.tell(h.by, closed, h, 'dropped', `The office dropped the handoff of "${task.title}" to ${this.nameOf(h.to)}: ${because}`);
    return back ?? closed;
  }

  // A giver who asked has stepped off, so when the proposal ends with the task staying they get it back as a new request, with a
  // note that says why. Not when they have gone, and not for a card the owner closed: that is the owner's to reopen.
  private giveBack(task: Task, h: Handoff, note: string): Task | undefined {
    if (h.by !== h.from || task.stage === 'done' || !task.assignees.includes(h.from) || !this.teamOf(task).some((m) => m.id === h.from)) return undefined;
    const given = this.giveRun(task, h.from, { note, key: handoffRunKey(task.id, h.from, h.id, true) });
    if (!given.ok || !given.posted) return undefined;
    this.replace(given.task);
    this.onMail();
    return this.task(task.id);
  }

  // A giver who asks stops working on the task at once, so nothing they leave half done is settled or merged while they wait.
  private stepOff(task: Task, h: Handoff) {
    const po = poOf(this.teamOf(task));
    this.release(task, h.from, `Handing over to ${this.nameOf(h.to)}; waiting on ${po ? this.nameOf(po.id) : 'the PO'}.`);
    this.onMail();
  }

  // An open handoff ends within two turns of the person it waits on: the first turn that ends with its notice read gets them one
  // reminder, and the first that ends with the reminder read drops it. Read off the mail, so running it again changes nothing.
  private chase() {
    const mail = this.host.mail().state;
    for (const { id } of [...this.tasks]) {
      const task = this.tasks.find((t) => t.id === id);
      const h = task?.handoff;
      if (!task || !h || !this.live(task, h)) continue;
      const reminder = handoffKey(h.id, 'reminder');
      if (noticeSeen(mail, reminder) === 'seen_in_ended_turn') this.drop(task, `${this.nameOf(h.awaits)} did not answer it.`);
      else if (!mail.keys.has(reminder) && noticeSeen(mail, handoffKey(h.id, 'proposed')) === 'seen_in_ended_turn') {
        const [from, to] = [this.nameOf(h.from), this.nameOf(h.to)];
        const keeper = h.by === h.from ? `${from} gets the task back` : `${from} keeps the task`;
        this.tell(h.awaits, task, h, 'reminder', `You ended a turn without answering the handoff of "${task.title}" from ${from} to ${to}. Answer it now with answerHandoff { id: "${h.id}", answer: "accept" }, or answer "decline" and say why in reason. If your next turn also ends without an answer, the office drops it and ${keeper}.`);
      }
    }
  }

  // Ends the open runs of the task that `who` holds. Their pieces end with them, for the same reason.
  private release(task: Task, who: EmployeeId, because: string) {
    const mail = this.host.mail();
    for (const run of this.runsOf(task, who)) if (mail.state.unsettled.has(run)) mail.cancel('owner', run, because);
  }

  private dropStale(task: Task, actor: EmployeeId): Task {
    return task.handoff && !this.live(task, task.handoff) ? this.drop(task, STALE, actor) : task;
  }

  private live(task: Task, h: Handoff): boolean {
    return handoffLive(task, h, new Set(this.teamOf(task).map((m) => m.id)));
  }

  // What a proposal that already ended says to the two who must agree. The same answer again is ok, a different one is told how it
  // ended, and a dropped one can no longer be answered.
  private endedResult(task: Task, who: EmployeeId, id: HandoffId, answer: keyof typeof ENDS): HandoffResult {
    const end = handoffEnding(task, id)!;
    if (who !== end.from && who !== poOf(this.teamOf(task))?.id) return refused('not_yours', 'Only the PO and the person giving the task away can read how this handoff ended.');
    if (end.step === 'dropped') return refused('stale', `This handoff was dropped by the office${end.reason ? `: ${end.reason}` : '.'}`);
    if (end.step !== ENDS[answer]) return refused('settled', `This handoff already ended: ${end.step} by ${this.nameOf(end.by)}.`);
    return { ok: true, state: end.step, id, task: task.title, from: this.nameOf(end.from), to: this.nameOf(end.to) };
  }

  private result(task: Task, h: Handoff, state: 'accepted' | 'declined' | 'withdrawn'): HandoffResult {
    return { ok: true, state, id: h.id, task: task.title, from: this.nameOf(h.from), to: this.nameOf(h.to) };
  }

  private openResult(task: Task, h: Handoff): HandoffResult {
    const awaits = this.nameOf(h.awaits);
    const po = poOf(this.teamOf(task))?.id === h.awaits ? ' (PO)' : '';
    const next = h.by === h.from
      ? `${awaits}${po} must agree. You stop working on it now: end your turn. The answer reaches you as a message, and if the task stays with you it comes back as a new request.`
      : `${awaits} must agree, and keeps working on it until they answer. The answer reaches you as a message.`;
    return { ok: true, state: 'proposed', id: h.id, task: task.title, from: this.nameOf(h.from), to: this.nameOf(h.to), awaits, next };
  }

  // A word from the office to one person about a proposal. It joins the chain of their latest run of the task, else of the task's,
  // so it shows in their thread and in the task's activity. Its key holds the proposal and the step, so a retry never posts it twice.
  private tell(to: EmployeeId, task: Task, h: Handoff, step: Notice, text: string): Posted {
    return this.host.mail().post({
      from: 'mailroom',
      to,
      blockId: this.board(task.boardId).blockId,
      parentId: this.runsOf(task, to).at(-1) ?? task.runs.at(-1),
      key: handoffKey(h.id, step),
      body: { kind: 'say', text: step === 'proposed' || step === 'reminder' ? text : `${text}\n\nNo reply needed.` },
    });
  }

  private teamOf(task: Task): Teammate[] {
    const blockId = this.board(task.boardId).blockId;
    return this.host.members().filter((m) => m.blockId === blockId);
  }

  // The one teammate a name, an id or "po" stands for.
  private teammate(team: readonly Teammate[], ref: string): Teammate | undefined {
    const key = ref.trim().toLowerCase();
    if (key === 'po') return poOf(team);
    const hit = team.filter((m) => m.id === ref || m.name.toLowerCase() === key);
    return hit.length === 1 ? hit[0] : undefined;
  }

  private assertMember(employeeId: EmployeeId, blockId: BlockId) {
    if (!this.host.members().some((m) => m.id === employeeId && m.blockId === blockId)) throw new OfficeError('A task goes to the PO of its block or to one of the block\'s employees.');
  }

  // Throws when `taskId` is not a task of `blockId`, so a hire can be refused before anyone is hired.
  assertOfBlock(taskId: TaskId, blockId: BlockId) {
    if (this.board(this.task(taskId).boardId).blockId !== blockId) throw new OfficeError('That task belongs to another block.');
  }

  // ── a branch and a pull request per task ──

  // The task a chain of mail belongs to, by the root request: one of the task's runs, or a run still being posted, which
  // carries the task in its key.
  private taskOfRoot(root: MessageId): Task | undefined {
    const known = this.tasks.find((t) => t.runs.includes(root));
    if (known) return known;
    const [tag, id] = (this.host.mail().state.messages.get(root)?.key ?? '').split(':');
    return tag === 'task' ? this.tasks.find((t) => t.id === id) : undefined;
  }

  // Where the work of this chain lands: the task's own worktree, when the task has a branch. A task that has a branch whose
  // worktree cannot be made says so instead: its work must not fall through to the owner's branch.
  homeOf(roots: readonly MessageId[]): { taskId: TaskId; ws: Workspace } | { taskId: TaskId; lost: string } | undefined {
    const git = this.host.git;
    for (const root of roots) {
      const task = this.taskOfRoot(root);
      if (!git || !task?.git) continue;
      const path = git.worktree(task.id);
      if (!existsSync(path)) this.startBranch(task);
      if (existsSync(path)) return { taskId: task.id, ws: { path, branch: task.git.branch } };
      return { taskId: task.id, lost: this.task(task.id).git?.note ?? `${task.git.branch} has no worktree` };
    }
    return undefined;
  }

  // Makes sure the task has its branch and worktree, cut from the block's default branch the first time and found again after.
  // Local and quick. A block that is not a git repository gets nothing, and a branch git refuses is told on the task, not thrown.
  private startBranch(task: Task): Task {
    const git = this.host.git;
    const block = git?.block(this.board(task.boardId).blockId);
    if (!git || !block || !existsSync(block.cwd) || !isGitRepo(block.cwd)) return task;
    const base = defaultBase(block.cwd);
    const branch = task.git?.branch ?? taskBranchName(task.title, task.id);
    let note: string | undefined;
    try {
      createTaskWorkspace(block.cwd, git.worktree(task.id), { branch, title: task.title, key: taskKey(task.id) }, base);
    } catch (err) {
      note = err instanceof Error ? err.message : String(err);
    }
    const had = this.task(task.id);
    const here = { ...had, git: { ...had.git, branch, base: had.git?.base ?? base.name } };
    // A note about the start is only ever set here. The next publish clears it, or replaces it with what GitHub says.
    const next = note ? withGitNote(here, note, this.host.now()) : here;
    if (JSON.stringify(next.git) !== JSON.stringify(had.git)) this.replace(next);
    return next;
  }

  // Sends the task's branch to origin and makes sure it has a pull request. Safe to ask again and again: two asks at once are
  // one send and one more round, and a branch that already has its pull request is only pushed.
  publish(taskId: TaskId): Promise<void> {
    const running = this.publishing.get(taskId);
    if (running) {
      this.publishAgain.add(taskId);
      return running;
    }
    const round = (async () => {
      try {
        do {
          this.publishAgain.delete(taskId);
          await this.publishOnce(taskId).catch((err: unknown) => console.error('Could not publish a task branch:', err));
        } while (this.publishAgain.has(taskId));
      } finally {
        this.publishing.delete(taskId);
      }
    })();
    this.publishing.set(taskId, round);
    return round;
  }

  private async publishOnce(taskId: TaskId) {
    const git = this.host.git;
    const task = this.tasks.find((t) => t.id === taskId);
    if (!git || !task?.git) return;
    const path = git.worktree(taskId);
    if (!existsSync(path)) return;
    const pushed = await pushBranch(path, task.git.branch);
    if (pushed.kind !== 'pushed') {
      const note = pushed.kind === 'no-remote' ? 'There is no remote called origin, so the branch stays on this computer and there is no pull request.' : `Could not push ${task.git.branch} to origin: ${pushed.reason}`;
      return this.update(taskId, (t) => withGitNote(t, note, this.host.now()));
    }
    if (this.tasks.find((t) => t.id === taskId)?.git?.pr) return this.update(taskId, (t) => withGitNote(t, undefined, this.host.now()));
    const now = this.tasks.find((t) => t.id === taskId);
    if (!now?.git) return;
    const people = now.assignees.map((id) => this.nameOf(id));
    const made = await ensurePr(git.gh, path, { branch: now.git.branch, base: now.git.base, title: now.title, body: prBody(now, people) });
    this.update(taskId, (t) => (made.kind === 'pr' ? withPr(t, made.pr, this.host.now()) : withGitNote(t, made.note, this.host.now())));
    if (made.kind === 'pr') this.settled(taskId);
  }

  // Asks GitHub where the open pull requests stand, and with `retry` tries again for the tasks that have no pull request yet.
  // Merged moves the task to done. Closed is only shown. Never throws, and one pull request that cannot be read leaves the
  // others to be read. A round that is already out answers a plain ask; a retry waits for it and goes next.
  refreshPrs(retry = false): Promise<void> {
    if (this.prRound) return retry ? this.prRound.then(() => this.refreshPrs(true)) : this.prRound;
    const round = this.readPrs(retry).finally(() => (this.prRound = undefined));
    this.prRound = round;
    return round;
  }

  private async readPrs(retry: boolean) {
    const git = this.host.git;
    if (!git) return;
    if (retry) this.readyAsked.clear();
    for (const { id } of [...this.tasks]) {
      // Read again each time: the ones before this took a while, and this one may have moved on meanwhile.
      const task = this.tasks.find((t) => t.id === id);
      if (!task?.git) continue;
      if (!task.git.pr) {
        if (retry) void this.publish(task.id);
        continue;
      }
      if (!prIsOpen(task.git.pr)) continue;
      const path = git.worktree(task.id);
      const block = git.block(this.board(task.boardId).blockId);
      const seen = await readPr(git.gh, existsSync(path) ? path : (block?.cwd ?? path), task.git.pr.number).catch(() => undefined);
      if (seen?.kind !== 'pr') continue;
      this.update(task.id, (t) => withPr(t, seen.pr, this.host.now()));
      this.settled(task.id);
    }
    this.readyDrafts();
  }

  // Whether there is a pull request worth asking about again later.
  watchingPrs(): boolean {
    return this.tasks.some((t) => prIsOpen(t.git?.pr));
  }

  // Run once at start: a crash can leave a branch unpushed or a pull request unopened, and the owner may have merged one while the app was closed.
  resumeGit() {
    const git = this.host.git;
    if (!git) return;
    for (const t of this.tasks) {
      if (!t.git || (t.git.pr && !prIsOpen(t.git.pr))) continue;
      const path = git.worktree(t.id);
      if (existsSync(path) && (!t.git.pr || unpushed(path, t.git.branch))) void this.publish(t.id);
    }
    void this.refreshPrs();
    this.readyDrafts();
  }

  // A task in review is the team saying the work is ready to look at, so its draft pull request leaves draft too. That is
  // asked once per stay in review: a refusal is a note on the card and is not retried in a loop, and the owner's retry on the
  // board asks again. Moving the task out of review leaves the pull request as it is.
  private readyDrafts() {
    for (const t of this.tasks) {
      if (t.stage !== 'review') this.readyAsked.delete(t.id);
      else if (t.git?.pr?.state === 'draft' && !this.readyAsked.has(t.id)) {
        this.readyAsked.add(t.id);
        void this.readyPr(t.id).catch((err: unknown) => console.error('Could not mark a pull request ready for review:', err));
      }
    }
  }

  private async readyPr(taskId: TaskId) {
    const git = this.host.git;
    const task = this.tasks.find((t) => t.id === taskId);
    if (!git || !task?.git?.pr) return;
    const path = git.worktree(task.id);
    const cwd = existsSync(path) ? path : (git.block(this.board(task.boardId).blockId)?.cwd ?? path);
    const result = await markReady(git.gh, cwd, task.git.pr.number);
    this.update(taskId, (t) => (result.kind === 'pr' ? withPr(t, result.pr, this.host.now()) : withGitNote(t, result.note, this.host.now())));
  }

  // A pull request that is over does not need its worktree any more. The branch stays.
  private settled(taskId: TaskId) {
    const t = this.tasks.find((x) => x.id === taskId);
    if (t?.git?.pr && !prIsOpen(t.git.pr)) this.releaseWorktree(t);
  }

  // The block's repository is about to change or go: the task worktrees made in it go first. Their branches and pull requests stay,
  // and the next run of a task makes its worktree again in whichever repository the block has then.
  releaseWorktrees(blockId: BlockId) {
    const mine = new Set(this.boardsOf(blockId).map((b) => b.id));
    for (const t of this.tasks) if (mine.has(t.boardId)) this.releaseWorktree(t);
  }

  private releaseWorktree(task: Task) {
    const git = this.host.git;
    if (!git || !task.git) return;
    removeTaskWorkspace(git.block(this.board(task.boardId).blockId)?.cwd, git.worktree(task.id));
  }

  private update(taskId: TaskId, change: (t: Task) => Task) {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const next = change(t);
    if (next !== t) this.replace(next);
  }

  // ── hours ──

  // Sends the closed time of a CronoSpark task that was not sent yet, one call per person and day, whatever its stage. Only the
  // owner's click gets here. Level-triggered: it looks at the marks, so asking twice sends once, asking while a send is out
  // joins it, and a call that failed is simply sent by the next ask. Resolves when the send has ended.
  sendHours(taskId: TaskId): Promise<void> {
    const task = this.task(taskId);
    if (task.origin.kind !== 'cronospark') throw new OfficeError('Only a CronoSpark task has hours to send.');
    const running = this.sending.get(taskId);
    if (running) return running;
    const send = this.pushDue(task)
      .catch((err: unknown) => console.error('Could not send task hours:', err))
      .finally(() => this.sending.delete(taskId));
    this.sending.set(taskId, send);
    return send;
  }

  private async pushDue(task: Task) {
    const slices = sliceTasks(this.log, [task], this.host.now()).get(task.id) ?? [];
    for (const entry of hoursDue(task, closedDayWork(slices))) {
      if (!(await this.pushOne(task.id, entry))) break;
    }
  }

  // The mark moves before the call and moves back if the call fails, so nothing is ever sent twice.
  private async pushOne(taskId: TaskId, e: HoursEntry): Promise<boolean> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || task.origin.kind !== 'cronospark') return false;
    const externalId = task.origin.externalId;
    this.replace({ ...task, hours: { ...moveMark(task.hours, e, 1), inflight: e } });
    let failure: string | undefined;
    try {
      await this.host.provider.logHours({ taskId: externalId, hours: e.hours, date: e.date, description: `${this.nameOf(e.employeeId)} (AI employee, Online Office)` });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    const now = this.tasks.find((t) => t.id === taskId);
    if (!now) return failure === undefined;
    const { inflight: _, error: __, ...hours } = failure === undefined ? (now.hours ?? { pushed: {} }) : moveMark(now.hours, e, -1);
    const at = this.host.now();
    const settled = { ...now, hours: failure === undefined ? hours : { ...hours, error: { message: `Could not send ${e.hours} h for ${this.nameOf(e.employeeId)} on ${e.date} to CronoSpark: ${failure}`, at } } };
    this.replace(withEvent(settled, { kind: 'hours', at, employeeId: e.employeeId, date: e.date, hours: e.hours, ...(failure === undefined ? {} : { error: failure }) }));
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
    this.readyDrafts();
  }

  // Tasks a provider's cards moved to another stage, with the move on their history.
  private noteMoves(next: readonly Task[], by: StageBy): Task[] {
    const before = new Map(this.tasks.map((t) => [t.id, t]));
    const now = this.host.now();
    return next.map((t) => {
      const was = before.get(t.id);
      return was && was.stage !== t.stage ? withEvent(t, { kind: 'stage', at: now, from: was.stage, to: t.stage, by }) : t;
    });
  }

  private boardId = () => this.host.newId() as BoardId;
  private taskId = () => this.host.newId() as TaskId;

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const body: TasksFile = { v: 1, boards: this.boards, tasks: this.tasks, people: this.people, nextNumber: this.nextNumber };
    writeFileSync(tmp, JSON.stringify(body, null, 2));
    renameSync(tmp, this.file);
  }
}

// Only this process writes the file, so a shape check is enough. Anything odd starts the boards from scratch.
function read(file: string): TasksFile | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TasksFile> | null;
    if (!raw || raw.v !== 1 || !Array.isArray(raw.boards) || !Array.isArray(raw.tasks)) return undefined;
    return { v: 1, boards: raw.boards, tasks: raw.tasks, people: raw.people ?? {}, nextNumber: typeof raw.nextNumber === 'number' ? raw.nextNumber : 1 };
  } catch {
    return undefined;
  }
}

// Tasks without a number get the next ones in the order they were made. The counter ends past every number in use.
export function numberTasks(tasks: readonly Task[], next: number): { tasks: Task[]; nextNumber: number } {
  let counter = Math.max(next, ...tasks.map((t) => (t.number ?? 0) + 1));
  const given = new Map<TaskId, number>();
  for (const t of [...tasks].filter((t) => !t.number).sort((a, b) => a.createdAt - b.createdAt)) given.set(t.id, counter++);
  return { tasks: tasks.map((t) => (given.has(t.id) ? { ...t, number: given.get(t.id)! } : t)), nextNumber: counter };
}
