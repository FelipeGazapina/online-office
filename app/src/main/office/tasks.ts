// The owner's boards and tasks. State lives in tasks.json beside company.json. A task's time is not kept here: it is
// folded from the mailroom's ledger every time it is asked for (shared/tasks.ts), so what this file stores about work is
// the root requests a task started and, for CronoSpark, how much of that time the owner already sent. Hours leave only when
// the owner asks (sendHours): nothing here sends them on its own.
//
// Plain Node: verify/task-check.ts imports it without Electron.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { activityIndexOf, answerKey, clipText, emptyActivity, foldActivity, liveOf, logOf, noInputs, noteKey, type ActivityEntry, type ActivityIndex, type LiveInputs, type TaskLive } from '../../shared/activity.ts';
import type { LedgerEntry, MessageId } from '../../shared/mail.ts';
import type { BlockId, EmployeeId, LinearPeople, LinearPerson, TaskBoardSource, TaskCard } from '../../shared/protocol.ts';
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
  type Board,
  type BoardId,
  type BoardPatch,
  type BoardSpec,
  type BoardSync,
  type HoursEntry,
  type LegacySources,
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
import { ensurePr, readPr, type Gh } from './pull-request.ts';
import type { HoursCall } from './task-board.ts';
import { createTaskWorkspace, defaultBase, isGitRepo, pushBranch, removeTaskWorkspace, unpushed, type Workspace } from './workspace.ts';

export type TasksHost = {
  now(): number;
  newId(): string;
  // The mailroom changes when the owner resets the company, so this is asked for every time.
  mail(): Mailroom;
  blocks(): readonly BlockId[];
  // Everyone who works anywhere, PO included.
  members(): readonly { id: EmployeeId; name: string; blockId: BlockId }[];
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

type TasksFile = { v: 1; boards: Board[]; tasks: Task[]; people: Record<string, string> };

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

// What the owner's retried assign_task shares with the first one: the same task, the same person, and how many runs that
// person already had of it.
const runKey = (task: TaskId, who: EmployeeId, nth: number) => `task:${task}:${who}:${nth}`;

const QUESTION_QUOTE_CAP = 1500;
const quote = (text: string) => text.split('\n').map((l) => `> ${l}`).join('\n');

export class Tasks {
  private boards: Board[] = [];
  private tasks: Task[] = [];
  // The names of people who left, so hours they worked still go out under their name.
  private people: Record<string, string> = {};
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
  private readonly existed: boolean;

  constructor(file: string, host: TasksHost, ledger: readonly LedgerEntry[]) {
    this.file = file;
    this.host = host;
    this.log = turnLogOf(ledger);
    this.activity = activityIndexOf(ledger);
    const stored = read(file);
    this.existed = !!stored;
    if (stored) ({ boards: this.boards, tasks: this.tasks, people: this.people } = stored);
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
    this.sync.clear();
    this.log = emptyTurnLog();
    this.activity = emptyActivity();
    this.save();
  }

  // ── the mailroom changed ──

  // Every ledger entry, in order, as the mailroom writes it.
  observe(entry: LedgerEntry) {
    foldTurn(this.log, entry);
    foldActivity(this.activity, entry);
  }

  // Takes in how runs ended.
  onMail() {
    const mail = this.host.mail().state;
    let moved = false;
    this.tasks = this.tasks.map((t) => {
      if (!t.runs.length) return t;
      const outcome = outcomeFromRuns(t, (run) => runStateOf(mail, run));
      if (!outcome) return t;
      moved = true;
      const now = this.host.now();
      const { stage, ...taken } = outcome;
      const noted = { ...t, ...taken, updatedAt: now };
      return stage ? restage(noted, stage, 'mailroom', now, outcome.lastOutcome.reply) : noted;
    });
    if (moved) this.save();
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
    const synced = syncCards(board, this.tasks, result.cards, { now: this.host.now(), complete: result.errors.length === 0, newId: () => this.taskId() });
    this.tasks = this.noteMoves(synced.tasks, 'provider');
    if (synced.changed) this.save();
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
    const task = newTask({ id: this.taskId(), boardId, title: clean, ...(notes ? { notes } : {}), origin, stage: opt.stage ?? 'todo', now: this.host.now() });
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
    // A provider task the owner moves stays where the owner put it, whatever the provider says on the next sync.
    const pin = patch.stage !== undefined && task.origin.kind !== 'manual';
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
  // another run.
  assign(taskId: TaskId, employeeId: EmployeeId) {
    const task = this.task(taskId);
    const board = this.board(task.boardId);
    this.assertMember(employeeId, board.blockId);
    const mail = this.host.mail();
    const theirs = task.runs.filter((r) => mail.state.messages.get(r)?.to === employeeId);
    if (theirs.some((r) => mail.state.unsettled.has(r))) return;
    // The branch exists before the request is posted, because the person's first sync already comes from it.
    const branched = this.startBranch(task);
    const { title, text } = runRequest(branched, board);
    const posted = mail.post({ from: 'owner', to: employeeId, blockId: board.blockId, key: runKey(task.id, employeeId, theirs.length), body: { kind: 'request', intent: 'work', title, text } });
    if (!posted.ok) throw new OfficeError(posted.detail);
    this.replace(this.withRun(this.task(task.id), posted.id, employeeId, 'owner'));
    void this.publish(task.id);
  }

  // The task with `who` taking the run that starts at `root`, and in doing: what assigning means. `by` is who moved it.
  private withRun(task: Task, root: MessageId, who: EmployeeId, by: StageBy, cause?: MessageId): Task {
    const now = this.host.now();
    const taken = {
      ...task,
      runs: task.runs.includes(root) ? task.runs : [...task.runs, root],
      assignees: task.assignees.includes(who) ? task.assignees : [...task.assignees, who],
      updatedAt: now,
    };
    return restage(taken, 'doing', by, now, cause);
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
    const said = clipText(question.text, QUESTION_QUOTE_CAP);
    const asker = this.nameOf(question.asker);
    if (question.how === 'blocked' && question.to === 'owner') {
      const text = `The owner answers: ${answer}\n\nYou stopped on "${asked.title}" and told them:\n${quote(said)}\n\nCarry on with the task now.\n\n${runRequest(task, board).text}`;
      const posted = mail.post({ from: 'owner', to: question.asker, blockId: board.blockId, parentId: asked.rootId, key: answerKey(task.id, question.asker, id), body: { kind: 'request', intent: 'work', title: asked.title, text } });
      if (!posted.ok) throw new OfficeError(posted.detail);
      this.replace(this.withRun(task, posted.id, question.asker, 'owner', id));
      return;
    }
    const nudge = question.how === 'blocked'
      ? { to: question.to as EmployeeId, parentId: asked.parentId ?? undefined, text: `The owner answers ${asker}'s block on "${asked.title}": ${answer}\n\n${asker} stopped and said:\n${quote(said)}\n\nA message alone does not restart ${asker}: send them a new request that carries this answer, or do the piece yourself.` }
      : { to: question.asker, parentId: asked.id, text: `The owner answers your question to ${this.nameOf(question.to as EmployeeId)}: ${answer}` };
    const posted = mail.post({ from: 'owner', to: nudge.to, blockId: board.blockId, ...(nudge.parentId ? { parentId: nudge.parentId } : {}), key: noteKey(task.id, id), body: { kind: 'say', text: nudge.text, urgency: 'next' } });
    if (!posted.ok) throw new OfficeError(posted.detail);
    this.host.changed();
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
