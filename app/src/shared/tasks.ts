// Tasks: what the owner wants done, how it is grouped on boards, and what working on it cost. Plain types and pure
// functions. The main process owns the state (main/office/tasks.ts) and this file never reads a clock or a disk.
//
// Time is not state. The mailroom's ledger says who was in a turn and when, and every message carries the root request
// of its chain, so a task's time is a fold over that ledger. The one thing a task stores is the root requests it started.
import type { ActorId, LedgerEntry, MessageId, Outcome, TurnId } from './mail.ts';
import { DEFAULT_LINEAR_FILTERS, taskBoardStatusLabel, type BlockId, type EmployeeId, type LinearFilters, type TaskBoardSource, type TaskCard, type TaskProvider } from './protocol.ts';

export type BoardId = string & { readonly __brand: 'BoardId' };
export type TaskId = string & { readonly __brand: 'TaskId' };
export type HandoffId = string & { readonly __brand: 'HandoffId' };
// A calendar day in the owner's time zone, as CronoSpark takes it.
export type LocalDate = `${number}-${number}-${number}`;

// A quick board is for tasks that came off the top of the owner's head. It cannot be linked to Linear or CronoSpark, so
// it has no sources to hold.
export type BoardSpec = { kind: 'quick' } | { kind: 'feature' | 'bug'; sources: TaskBoardSource[] };
// `collapsed` are the columns the owner folded away, in column order, and it is absent when none is. A collapsed column pulls
// nothing from a provider: the cards whose status lands in it are not fetched, so the limit is spent on the open columns.
export type Board = { id: BoardId; blockId: BlockId; name: string; collapsed?: TaskStage[] } & BoardSpec;
export type BoardPatch = { name?: string; sources?: TaskBoardSource[]; collapsed?: TaskStage[] };

export type ProviderOrigin = { kind: TaskProvider; externalId: string; identifier: string; url?: string; priority?: string; providerStatus: string; sourceLabel: string };
// A task made by hand has its own priority. A provider's task keeps the provider's text in `origin.priority`.
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export type TaskOrigin = { kind: 'manual'; priority?: Priority } | ProviderOrigin;

export type TaskStage = 'todo' | 'doing' | 'review' | 'done';
export const STAGES: readonly TaskStage[] = ['todo', 'doing', 'review', 'done'];

// How the last run of a task ended: the settling reply of its latest root request.
export type LastOutcome = { outcome: Outcome; text: string; at: number; reply: MessageId };

// What was already sent to CronoSpark, in ms per person and local day. A push moves the mark before the call and puts it
// back when the call fails, so a restart in between loses an hour entry at worst and never posts one twice.
export type HoursLog = {
  pushed: Partial<Record<EmployeeId, Partial<Record<LocalDate, number>>>>;
  inflight?: HoursEntry;
  error?: { message: string; at: number };
};

// A pull request as the owner sees it on GitHub: a draft until someone marks it ready, then open, then merged or closed.
export type PrState = 'draft' | 'open' | 'merged' | 'closed';
export type TaskPr = { number: number; url: string; state: PrState };

// Where a task's work lives in git: its branch, the branch its pull request targets, the pull request once there is one, and
// `note` for the one thing the owner should know, such as why there is no pull request. A task in a block that is not a git
// repository has none of this.
export type TaskGit = { branch: string; base: string; pr?: TaskPr; note?: string };

// Who moved a stage: the owner, the office when a run settled (`mailroom`), a teammate, or Linear or CronoSpark changing the card.
export type StageBy = ActorId | 'provider';

// What happened to a task that the mailroom's ledger does not say. Append-only: the activity log folds it in with the mail.
export type TaskEvent =
  // `reason` is what a teammate said when they moved the card themselves.
  | { kind: 'stage'; at: number; from: TaskStage; to: TaskStage; by: StageBy; cause?: MessageId; reason?: string }
  // `employeeId` joined the task's assignees because `by` gave them work on it (`cause`), without a run of the owner's.
  | { kind: 'assign'; at: number; employeeId: EmployeeId; by: EmployeeId; cause?: MessageId }
  // An hours entry sent to CronoSpark, or one that failed (`error`).
  | { kind: 'hours'; at: number; employeeId: EmployeeId; date: LocalDate; hours: number; error?: string }
  // One step of a handoff. `by` is who took it. A `dropped` step is the office clearing a proposal that can no longer apply,
  // and `by` is then whoever proposed it.
  | { kind: 'handoff'; at: number; handoff: HandoffId; step: HandoffStep; from: EmployeeId; to: EmployeeId; by: EmployeeId; reason?: string };

export type Task = {
  id: TaskId;
  // Office-wide and sequential from 1, given when the task is made and never reused. The owner sees it as "#N".
  number: number;
  boardId: BoardId;
  title: string;
  notes?: string;
  origin: TaskOrigin;
  stage: TaskStage;
  // Set once the owner has chosen the stage of a provider task. From then on the provider's status never moves it.
  stagePinned?: true;
  assignees: EmployeeId[];
  // The root request of every run this task started. A message belongs to the task when its rootId is one of these.
  runs: MessageId[];
  createdAt: number;
  updatedAt: number;
  lastOutcome?: LastOutcome;
  hours?: HoursLog;
  history?: TaskEvent[];
  git?: TaskGit;
  // At most one proposal to give the task to someone else is open at a time.
  handoff?: Handoff;
};

export const withEvent = (task: Task, event: TaskEvent): Task => ({ ...task, history: [...(task.history ?? []), event] });

// The task in `to`, with the move on its history. Moving a task to where it already is changes nothing.
export function restage(task: Task, to: TaskStage, by: StageBy, at: number, cause?: MessageId, reason?: string): Task {
  if (task.stage === to) return task;
  return withEvent({ ...task, stage: to }, { kind: 'stage', at, from: task.stage, to, by, ...(cause ? { cause } : {}), ...(reason ? { reason } : {}) });
}

export type BoardSync =
  | { kind: 'idle' }
  | { kind: 'loading'; lastFetchedAt?: number }
  | { kind: 'ready'; lastFetchedAt: number }
  | { kind: 'error'; message: string; lastFetchedAt?: number };

// ───────────────────────────── Stages ─────────────────────────────

const STAGE_OF_LABEL: Record<string, TaskStage> = { 'In Design': 'doing', 'In Dev': 'doing', 'In Progress': 'doing', 'Ready to Review': 'review', Done: 'done' };

export const stageOfStatus = (status: string): TaskStage => STAGE_OF_LABEL[taskBoardStatusLabel(status)] ?? 'todo';

const OUTCOME_TEXT_CAP = 2000;

// How a request settled, as far as a task is concerned.
export type RunState = { s: 'open' } | { s: 'settled'; reply: MessageId; outcome: Outcome; text: string; at: number };

// What the mail says about a task now. Every run settled, and the latest settled reply is one the task has not taken in
// yet: record it, and a task still in `doing` moves on. Done moves to review, anything else back to todo. The owner's
// own moves are left alone: the latest reply is taken in once, so a task the owner put back to doing stays there.
export function outcomeFromRuns(task: Task, runState: (run: MessageId) => RunState | undefined): { lastOutcome: LastOutcome; stage?: TaskStage } | undefined {
  let latest: Extract<RunState, { s: 'settled' }> | undefined;
  for (const run of task.runs) {
    const state = runState(run);
    if (!state) continue;
    if (state.s === 'open') return undefined;
    if (!latest || state.at >= latest.at) latest = state;
  }
  if (!latest || latest.reply === task.lastOutcome?.reply) return undefined;
  const lastOutcome: LastOutcome = { outcome: latest.outcome, text: latest.text.slice(0, OUTCOME_TEXT_CAP), at: latest.at, reply: latest.reply };
  return task.stage === 'doing' ? { lastOutcome, stage: latest.outcome === 'done' ? 'review' : 'todo' } : { lastOutcome };
}

// ───────────────────────────── Teammates moving the card ─────────────────────────────

// Where a teammate may take a card, by where it stands now. Back to doing is picking the work up again, review and done are
// claims about the work, and todo belongs to the owner and the office: a run that stops sends its task there.
export type AgentStage = Exclude<TaskStage, 'todo'>;
const AGENT_MOVES: Record<TaskStage, readonly AgentStage[]> = {
  todo: ['doing'],
  doing: ['review', 'done'],
  review: ['doing', 'done'],
  done: ['doing'],
};

// What the mail says about the teammate who asks, as far as one card is concerned.
export type MoveFacts = {
  // The card is theirs: it was given to them, or a request of it passed through them.
  onTask: boolean;
  // They hold an open request of this task right now, so they are working on it.
  holding: boolean;
  // The other open requests of the task that are not theirs, one line each.
  open: readonly string[];
};

// Why a teammate's words did not name one of their tasks.
export type FindRefusalReason = 'no_task' | 'unknown_task' | 'ambiguous';
export type MoveRefusalReason = FindRefusalReason | 'not_on_task' | 'pinned' | 'not_allowed' | 'not_resumed' | 'open_pieces' | 'pr_open';
export type MoveRefusal = { reason: MoveRefusalReason; detail: string };

const refuse = (reason: MoveRefusalReason, detail: string): MoveRefusal => ({ reason, detail });

const stillOpen = (open: readonly string[]) => `${open.length} request(s) of this task are still open (${open.join('; ')})`;

// Why a task is not ready for the owner to look at: a piece of it is still being worked on.
const reviewRefusal = (open: readonly string[]): MoveRefusal | undefined => (open.length ? refuse('open_pieces', `Not ready for the owner: ${stillOpen(open)}. Wait for them to settle, or cancel them.`) : undefined);

// Why a task cannot be called done. The one place that decides it.
export function doneRefusal(task: Task, open: readonly string[]): MoveRefusal | undefined {
  if (open.length) return refuse('open_pieces', `Not done yet: ${stillOpen(open)}. Wait for them to settle, or cancel them.`);
  const pr = task.git?.pr;
  if (pr && prIsOpen(pr)) return refuse('pr_open', `Pull request #${pr.number} of this task is still ${pr.state} on GitHub. The owner merges it, and that moves the task to done. Move the task to review instead, so the owner knows it is ready to merge.`);
  return undefined;
}

// What a teammate's move of a card is refused for, or undefined when it may go ahead. The owner's own hand is not asked:
// a card the owner placed stays where it is until they move it or give the task to someone again.
export function agentMoveRefusal(task: Task, to: AgentStage, facts: MoveFacts): MoveRefusal | undefined {
  if (!facts.onTask) return refuse('not_on_task', 'This task is not yours: it was never given to you and none of its requests passed through you.');
  if (task.stage === to) return undefined;
  if (task.stagePinned) return refuse('pinned', `The owner put this task in ${task.stage} themselves, so it stays there until they move it or give the task to someone again.`);
  if (!AGENT_MOVES[task.stage].includes(to)) return refuse('not_allowed', `A task in ${task.stage} does not go to ${to}. From ${task.stage} it can go to ${AGENT_MOVES[task.stage].join(' or ')}.`);
  if (to === 'doing') return facts.holding ? undefined : refuse('not_resumed', 'Only someone working on one of its requests takes a task back to doing, and you hold none of them now.');
  return to === 'done' ? doneRefusal(task, facts.open) : reviewRefusal(facts.open);
}

// ───────────────────────────── Handing a task over ─────────────────────────────

// An open proposal to move a task from one person to another. Whoever proposed has said yes; `awaits` must answer. The two
// who must agree are the person giving the task away and the block's PO. When they are the same person there is nobody to
// wait for and the handoff applies at once, so an open Handoff always has awaits !== by.
export type Handoff = {
  id: HandoffId;
  // An assignee of the task, who gives it away.
  from: EmployeeId;
  // A member of the task's block, other than `from`.
  to: EmployeeId;
  // `from`, or the block's PO.
  by: EmployeeId;
  // The other of `from` and the PO.
  awaits: EmployeeId;
  reason: string;
  at: number;
};

// A task that keeps passing between two people is not getting done: after this many the owner decides who holds it.
export const MAX_HANDOFFS = 3;

// Proposals that are declined, withdrawn or dropped end nothing, so they are counted too, or two people could go on for ever.
export const MAX_PROPOSALS = 6;

export type HandoffEnding = 'accepted' | 'declined' | 'withdrawn' | 'dropped';
export type HandoffStep = 'proposed' | HandoffEnding;
export type HandoffEvent = Extract<TaskEvent, { kind: 'handoff' }>;

export type HandoffRefusalReason =
  | FindRefusalReason
  // The proposer is neither an assignee of the task nor the block's PO.
  | 'not_on_task'
  | 'no_po'
  // A task the owner closed is the owner's to reopen.
  | 'done'
  // It changed hands MAX_HANDOFFS times already.
  | 'too_many'
  // `to` or `from` is not a member of the block, `to` is `from`, or `from` is not on the task.
  | 'bad_target'
  // Another live proposal is open on the task. Asking for the same one again is not refused.
  | 'open_handoff'
  | 'unknown_handoff'
  // Accepting or declining by someone other than `awaits`, or withdrawing by someone other than `by`.
  | 'not_yours'
  // The proposal can no longer apply. It is dropped as this is said.
  | 'stale'
  // The proposal already ended another way than the answer asks for.
  | 'settled';
export type HandoffRefusal = { reason: HandoffRefusalReason; detail: string };

// Whether an open proposal can still apply: `from` is still on the task, and from, to and awaits still work in the block.
export function handoffLive(task: Task, h: Handoff, members: ReadonlySet<EmployeeId>): boolean {
  return task.assignees.includes(h.from) && members.has(h.from) && members.has(h.to) && members.has(h.awaits);
}

// How many proposals the task has had: each counts once however it ended, and so does a handoff applied at once, which has no
// proposed step.
export function handoffsProposed(task: Task): number {
  const steps = (task.history ?? []).filter((e): e is HandoffEvent => e.kind === 'handoff');
  const proposed = steps.filter((e) => e.step === 'proposed');
  return proposed.length + steps.filter((e) => e.step === 'accepted' && !proposed.some((p) => p.handoff === e.handoff)).length;
}

// How many times the task has changed hands.
export const handoffsMade = (task: Task): number => (task.history ?? []).filter((e) => e.kind === 'handoff' && e.step === 'accepted').length;

// How a proposal ended, read from the task's history. Undefined while it is open, and for one the task never had.
export const handoffEnding = (task: Task, id: HandoffId): (HandoffEvent & { step: HandoffEnding }) | undefined =>
  task.history?.findLast((e): e is HandoffEvent & { step: HandoffEnding } => e.kind === 'handoff' && e.handoff === id && e.step !== 'proposed');

// ───────────────────────────── Boards ─────────────────────────────

export type Refused = { ok: false; reason: string };
export type BoardResult = { ok: true; board: Board } | Refused;

// A source's filters as they are kept: the defaults are not kept at all, so a source nobody filtered reads as it always did.
function cleanFilters(f: LinearFilters): LinearFilters | undefined {
  const assignee = typeof f.assignee === 'object' ? { id: f.assignee.id.trim(), name: f.assignee.name.trim() } : f.assignee;
  const clean: LinearFilters = { assignee, cycle: f.cycle, limit: f.limit };
  return JSON.stringify(clean) === JSON.stringify(DEFAULT_LINEAR_FILTERS) ? undefined : clean;
}

function cleanSource(s: TaskBoardSource): TaskBoardSource {
  const projectId = s.projectId.trim();
  const label = s.label?.trim() ? { label: s.label.trim() } : {};
  if (s.provider === 'cronospark') return { provider: 'cronospark', projectId, ...label };
  const filters = s.filters && cleanFilters(s.filters);
  return { provider: 'linear', projectId, ...label, ...(filters ? { filters } : {}) };
}

// What a source may hold. The same rules the old board configuration had, now in one place.
function cleanSources(sources: readonly TaskBoardSource[]): TaskBoardSource[] | Refused {
  const clean = sources.map(cleanSource);
  if (clean.some((s) => !s.projectId)) return { ok: false, reason: 'Each source needs a project id.' };
  const seen = new Set<string>();
  for (const s of clean) {
    const key = `${s.provider}:${s.projectId}`;
    if (seen.has(key)) return { ok: false, reason: 'A source is listed twice.' };
    seen.add(key);
  }
  return clean;
}

const refusedSources = (v: TaskBoardSource[] | Refused): v is Refused => !Array.isArray(v);

// The folded columns in column order, none of them twice. The last open column cannot be folded: a board with every column
// folded would have nowhere to put a task.
export function cleanCollapsed(stages: readonly TaskStage[]): TaskStage[] | Refused {
  const folded = STAGES.filter((s) => stages.includes(s));
  if (folded.length === STAGES.length) return { ok: false, reason: 'A board keeps at least one column open.' };
  return folded;
}

const refusedStages = (v: TaskStage[] | Refused): v is Refused => !Array.isArray(v);

// Whether a provider's card belongs on a board: not when its status lands in a column the owner folded away.
export const wantsCard = (board: Pick<Board, 'collapsed'>, card: Pick<TaskCard, 'status'>): boolean => !board.collapsed?.includes(stageOfStatus(card.status));

export function makeBoard(id: BoardId, blockId: BlockId, name: string, spec: BoardSpec): BoardResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'A board needs a name.' };
  if (spec.kind === 'quick') return { ok: true, board: { id, blockId, name: trimmed, kind: 'quick' } };
  const sources = cleanSources(spec.sources);
  if (refusedSources(sources)) return sources;
  return { ok: true, board: { id, blockId, name: trimmed, kind: spec.kind, sources } };
}

export function patchBoard(board: Board, patch: BoardPatch): BoardResult {
  const name = patch.name === undefined ? board.name : patch.name.trim();
  if (!name) return { ok: false, reason: 'A board needs a name.' };
  const folded = patch.collapsed === undefined ? board.collapsed ?? [] : cleanCollapsed(patch.collapsed);
  if (refusedStages(folded)) return folded;
  const { collapsed: _, ...rest } = board;
  const named = { ...rest, name, ...(folded.length ? { collapsed: folded } : {}) } as Board;
  if (board.kind === 'quick') {
    if (patch.sources !== undefined) return { ok: false, reason: 'A quick board holds tasks from your head. It takes no sources.' };
    return { ok: true, board: named };
  }
  const sources = patch.sources === undefined ? board.sources : cleanSources(patch.sources);
  if (refusedSources(sources)) return sources;
  return { ok: true, board: { ...named, sources } as Board };
}

// The board a block's task screens show: the first one that pulls from a provider, else the first one it has.
export const primaryBoard = (boards: readonly Board[], blockId: BlockId): Board | undefined => {
  const mine = boards.filter((b) => b.blockId === blockId);
  return mine.find((b) => b.kind !== 'quick') ?? mine[0];
};
export const sourcesOf = (board: Board | undefined): TaskBoardSource[] => (board && board.kind !== 'quick' ? board.sources : []);

export const QUICK_BOARD_NAME = 'Quick tasks';
export const LEGACY_BOARD_NAME = 'Tasks';

export type LegacySources = { blockId: BlockId; sources: TaskBoardSource[] };

// Makes the boards a company needs: a board of the block's old sources (once), and a quick board for every block that
// has none. Boards of a block that is gone are dropped. Running it on its own output changes nothing.
export function ensureBoards(blocks: readonly BlockId[], boards: readonly Board[], legacy: readonly LegacySources[], newId: () => BoardId): { boards: Board[]; changed: boolean } {
  const live = new Set(blocks);
  const out = boards.filter((b) => live.has(b.blockId));
  for (const blockId of blocks) {
    const old = legacy.find((l) => l.blockId === blockId);
    if (old?.sources.length && !out.some((b) => b.blockId === blockId && b.kind !== 'quick')) {
      const made = makeBoard(newId(), blockId, LEGACY_BOARD_NAME, { kind: 'feature', sources: old.sources });
      if (made.ok) out.push(made.board);
    }
    if (!out.some((b) => b.blockId === blockId && b.kind === 'quick')) out.push({ id: newId(), blockId, name: QUICK_BOARD_NAME, kind: 'quick' });
  }
  return { boards: out, changed: out.length !== boards.length || out.some((b, i) => b !== boards[i]) };
}

// ───────────────────────────── Tasks ─────────────────────────────

// `number` comes from the store's counter. A task built outside the store, as checks do, gets 0.
export function newTask(a: { id: TaskId; number?: number; boardId: BoardId; title: string; notes?: string; origin: TaskOrigin; stage: TaskStage; now: number }): Task {
  return { id: a.id, number: a.number ?? 0, boardId: a.boardId, title: a.title, ...(a.notes ? { notes: a.notes } : {}), origin: a.origin, stage: a.stage, assignees: [], runs: [], createdAt: a.now, updatedAt: a.now };
}

// What a person is told at the end of a task's request about its card. A model reads this where it is working far more
// reliably than in the persona.
const MOVE_CARD_NOTE = 'Before you settle this, move its card with moveTask and say why in a sentence: to review when the work is ready for the owner, or to done only when nothing is left for them to check.';

// The one request a person is given when a task is assigned to them.
export function runRequest(task: Task, board: Board): { title: string; text: string } {
  const o = task.origin;
  const source = o.kind === 'manual' ? '' : `\n\nFrom ${o.sourceLabel}: ${o.identifier}${o.url ? ` ${o.url}` : ''}`;
  const where = task.git ? `\n\nThis task has its own git branch, ${task.git.branch}. Whatever you and your team finish is merged into it for you and sent to GitHub as a pull request for the owner to review, so the block's main folder stays as it is.` : '';
  return { title: task.title, text: `${task.title}${task.notes ? `\n\n${task.notes}` : ''}${source}${where}\n\nTask board: ${board.name}. ${MOVE_CARD_NOTE}` };
}

// ───────────────────────────── Git ─────────────────────────────

// What a task branch name ends with, and what finds the branch again when the title has changed since.
export const taskKey = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'task';

export const taskBranchName = (title: string, id: string): string => {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
  return `task/${slug || 'task'}-${taskKey(id)}`;
};

// What the pull request says: the task's notes, where it came from, and who is on it.
export function prBody(task: Task, people: readonly string[]): string {
  const o = task.origin;
  const rows = [
    ...(o.kind === 'manual' ? [] : [`**From ${o.sourceLabel}:** ${o.url ? `[${o.identifier}](${o.url})` : o.identifier}`]),
    ...(people.length ? [`**People:** ${people.join(', ')}`] : []),
  ];
  return [task.notes?.trim(), rows.join('\n'), 'Opened by Online Office. The work of each person on this task is merged into this branch as they finish it.'].filter(Boolean).join('\n\n');
}

export const prIsOpen = (pr: TaskPr | undefined): boolean => pr?.state === 'draft' || pr?.state === 'open';

// The task once its pull request is known. A merged pull request is the owner's word that the work is done, and the move
// is on the task's history like any other the owner makes.
export function withPr(task: Task, pr: TaskPr, now: number): Task {
  if (!task.git) return task;
  const { note: _, ...git } = task.git;
  const next = { ...git, pr };
  const moved = pr.state === 'merged' ? restage(task, 'done', 'owner', now) : task;
  if (JSON.stringify(next) === JSON.stringify(task.git) && moved === task) return task;
  return { ...moved, git: next, updatedAt: now };
}

// The task with a note about its branch, or with the note cleared.
export function withGitNote(task: Task, note: string | undefined, now: number): Task {
  if (!task.git || task.git.note === note) return task;
  const { note: _, ...git } = task.git;
  return { ...task, git: note ? { ...git, note } : git, updatedAt: now };
}

const sourceKey = (o: ProviderOrigin) => `${o.kind}:${o.externalId}`;

// Provider cards become tasks, keyed by (board, provider, externalId). A card's status sets the stage only while the office
// has no say: once the task has runs or the owner pinned its stage, the office knows better. A card that is gone upstream
// takes its task with it unless the task has runs, and only when every source answered, so a source that failed cannot
// empty the board.
export function syncCards(board: Board, tasks: readonly Task[], cards: readonly TaskCard[], opt: { now: number; complete: boolean; newId: () => TaskId; nextNumber: () => number }): { tasks: Task[]; changed: boolean } {
  const mine = new Map<string, Task>();
  for (const t of tasks) if (t.boardId === board.id && t.origin.kind !== 'manual') mine.set(sourceKey(t.origin), t);
  const next = new Map<TaskId, Task>();
  const seen = new Set<string>();
  let changed = false;
  for (const card of cards) {
    const origin: ProviderOrigin = {
      kind: card.provider,
      externalId: card.externalId,
      identifier: card.identifier,
      ...(card.url ? { url: card.url } : {}),
      ...(card.priority ? { priority: card.priority } : {}),
      providerStatus: card.status,
      sourceLabel: card.sourceLabel,
    };
    const key = sourceKey(origin);
    if (seen.has(key)) continue;
    seen.add(key);
    const had = mine.get(key);
    if (!had) {
      const id = opt.newId();
      next.set(id, newTask({ id, number: opt.nextNumber(), boardId: board.id, title: card.title, origin, stage: stageOfStatus(card.status), now: opt.now }));
      changed = true;
      continue;
    }
    const stage = had.runs.length === 0 && !had.stagePinned ? stageOfStatus(card.status) : had.stage;
    if (JSON.stringify([had.title, had.origin, had.stage]) !== JSON.stringify([card.title, origin, stage])) {
      next.set(had.id, { ...had, title: card.title, origin, stage, updatedAt: opt.now });
      changed = true;
    }
  }
  const out: Task[] = [];
  for (const t of tasks) {
    const replaced = next.get(t.id);
    if (replaced) {
      out.push(replaced);
      next.delete(t.id);
      continue;
    }
    const gone = opt.complete && t.boardId === board.id && t.origin.kind !== 'manual' && !seen.has(sourceKey(t.origin)) && t.runs.length === 0;
    if (gone) changed = true;
    else out.push(t);
  }
  // What is left in `next` are tasks that did not exist yet.
  out.push(...next.values());
  return { tasks: out, changed };
}

// ───────────────────────────── Time ─────────────────────────────

// Who was in a turn and when, rebuilt entry by entry from the ledger. A turn starts at its first delivery and goes on
// taking deliveries until it ends. `marks` are those deliveries, with the root of every message each one brought.
type Mark = { at: number; roots: MessageId[] };
export type TurnSpan = { to: EmployeeId; start: number; end: number | null; marks: Mark[] };
export type TurnLog = { rootOf: Map<MessageId, MessageId>; turns: Map<TurnId, TurnSpan>; lastAt: number };

export const emptyTurnLog = (): TurnLog => ({ rootOf: new Map(), turns: new Map(), lastAt: 0 });

// Applies one ledger entry. Mutates and returns `log`, like the mailroom's own fold, and replaying an entry changes nothing.
export function foldTurn(log: TurnLog, entry: LedgerEntry): TurnLog {
  switch (entry.t) {
    case 'post':
      log.rootOf.set(entry.msg.id, entry.msg.rootId);
      log.lastAt = Math.max(log.lastAt, entry.msg.at);
      return log;
    case 'deliver': {
      log.lastAt = Math.max(log.lastAt, entry.at);
      if (entry.to === 'owner' || entry.to === 'mailroom') return log;
      let span = log.turns.get(entry.turn);
      if (span && span.end !== null) return log;
      if (!span) {
        span = { to: entry.to, start: entry.at, end: null, marks: [] };
        log.turns.set(entry.turn, span);
      }
      const roots = entry.ids.flatMap((id) => log.rootOf.get(id) ?? []);
      const last = span.marks.at(-1);
      if (last && last.at === entry.at && roots.every((r) => last.roots.includes(r))) return log;
      span.marks.push({ at: entry.at, roots });
      return log;
    }
    case 'turn_end': {
      log.lastAt = Math.max(log.lastAt, entry.at);
      const span = log.turns.get(entry.turn);
      if (span && span.end === null) span.end = Math.max(span.start, entry.at);
      return log;
    }
    case 'recover':
      // A turn the process died in has no end of its own. The last moment the ledger knew the office was alive is the
      // fairest one: the time the app was closed is not anyone's work.
      for (const span of log.turns.values()) if (span.end === null) span.end = Math.max(span.start, log.lastAt);
      return log;
  }
}

export const turnLogOf = (ledger: readonly LedgerEntry[]): TurnLog => ledger.reduce(foldTurn, emptyTurnLog());

// A stretch of one person's turn that counts for one task. When the turn serves several tasks at once, each gets an equal
// `share` of the stretch, so no minute is billed twice. `open` is the stretch that runs to now.
export type Slice = { employeeId: EmployeeId; from: number; to: number; share: number; open: boolean };

// Splits every turn at each delivery. From a delivery on, the turn serves every task whose root has been delivered into it.
export function sliceTasks(log: TurnLog, tasks: readonly Pick<Task, 'id' | 'runs'>[], now: number): Map<TaskId, Slice[]> {
  const out = new Map<TaskId, Slice[]>(tasks.map((t) => [t.id, []]));
  const taskOfRoot = new Map<MessageId, TaskId>();
  for (const t of tasks) for (const r of t.runs) taskOfRoot.set(r, t.id);
  if (!taskOfRoot.size) return out;
  for (const span of log.turns.values()) {
    const end = span.end ?? now;
    const serving = new Set<TaskId>();
    span.marks.forEach((mark, i) => {
      for (const r of mark.roots) {
        const t = taskOfRoot.get(r);
        if (t) serving.add(t);
      }
      const last = i === span.marks.length - 1;
      const from = Math.min(mark.at, end);
      const to = last ? end : Math.min(Math.max(span.marks[i + 1]!.at, from), end);
      if (!serving.size || to <= from) return;
      for (const t of serving) out.get(t)!.push({ employeeId: span.to, from, to, share: 1 / serving.size, open: last && span.end === null });
    });
  }
  return out;
}

// What the owner sees of a task's time. `at` is when it was measured: a person in `running` keeps counting from there,
// at `share` of wall time while their turn is split across tasks.
// `unsent` is the closed time of a CronoSpark task that no hours entry covers yet, per person. It is absent when there is none.
export type TaskTime = { at: number; totalMs: number; byEmployee: Record<EmployeeId, number>; running: { employeeId: EmployeeId; share: number }[]; unsent?: Partial<Record<EmployeeId, number>> };

export function timeFromSlices(slices: readonly Slice[], at: number): TaskTime {
  const ms = new Map<EmployeeId, number>();
  const running = new Map<EmployeeId, number>();
  for (const s of slices) {
    ms.set(s.employeeId, (ms.get(s.employeeId) ?? 0) + (s.to - s.from) * s.share);
    if (s.open) running.set(s.employeeId, s.share);
  }
  const byEmployee = Object.fromEntries([...ms].map(([who, v]) => [who, Math.round(v)])) as Record<EmployeeId, number>;
  return { at, totalMs: Object.values(byEmployee).reduce((a, b) => a + b, 0), byEmployee, running: [...running].map(([employeeId, share]) => ({ employeeId, share })) };
}

// What a person has on the task at `now`: what was measured, plus the time since for someone still in a turn.
export const workedMs = (time: TaskTime, who: EmployeeId, now: number): number => {
  const live = time.running.find((r) => r.employeeId === who);
  return (time.byEmployee[who] ?? 0) + (live ? Math.max(0, now - time.at) * live.share : 0);
};
export const totalWorkedMs = (time: TaskTime, now: number): number => time.running.reduce((sum, r) => sum + Math.max(0, now - time.at) * r.share, time.totalMs);

export function timesOf(tasks: readonly Pick<Task, 'id' | 'runs'>[], log: TurnLog, now: number): Record<TaskId, TaskTime> {
  const slices = sliceTasks(log, tasks, now);
  return Object.fromEntries([...slices].map(([id, s]) => [id, timeFromSlices(s, now)])) as Record<TaskId, TaskTime>;
}

// ───────────────────────────── Hours ─────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
export const localDate = (ms: number): LocalDate => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` as LocalDate;
};
const nextMidnight = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

export type DayWork = { employeeId: EmployeeId; date: LocalDate; ms: number };

// A person's time on one task per local day, counting only stretches that have ended. A stretch over midnight is cut there.
export function closedDayWork(slices: readonly Slice[]): DayWork[] {
  const by = new Map<string, DayWork & { exact: number }>();
  for (const s of slices) {
    if (s.open) continue;
    for (let at = s.from; at < s.to; ) {
      const cut = Math.min(s.to, nextMidnight(at));
      const date = localDate(at);
      const key = `${s.employeeId}|${date}`;
      const row = by.get(key) ?? { employeeId: s.employeeId, date, ms: 0, exact: 0 };
      row.exact += (cut - at) * s.share;
      by.set(key, row);
      at = cut;
    }
  }
  return [...by.values()].map(({ employeeId, date, exact }) => ({ employeeId, date, ms: Math.round(exact) })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.employeeId < b.employeeId ? -1 : 1));
}

const MS_PER_HOUR = 3_600_000;
// CronoSpark takes hours as a number above 0 and up to 24.
const MAX_HOURS = 24;
const HOURS_DECIMALS = 1e4;

// One hours entry to send: `ms` is exactly what the mark moves by, so the rounding left over goes out with the next one.
export type HoursEntry = { employeeId: EmployeeId; date: LocalDate; hours: number; ms: number };

// What is due is each person-day's closed time minus what its mark says was sent. A person-day is sent again only for time
// that closed after the last push, such as the end of a turn that outlived the reply which moved the task to review, and
// never for time already sent.
export function hoursDue(task: Task, work: readonly DayWork[]): HoursEntry[] {
  const out: HoursEntry[] = [];
  for (const w of work) {
    const done = task.hours?.pushed[w.employeeId]?.[w.date] ?? 0;
    const hours = Math.min(MAX_HOURS, Math.round(((w.ms - done) / MS_PER_HOUR) * HOURS_DECIMALS) / HOURS_DECIMALS);
    if (hours > 0) out.push({ employeeId: w.employeeId, date: w.date, hours, ms: Math.round(hours * MS_PER_HOUR) });
  }
  return out;
}

// What `hoursDue` adds up to per person, or undefined when nothing is due.
export function unsentOf(task: Task, slices: readonly Slice[]): Partial<Record<EmployeeId, number>> | undefined {
  const out: Partial<Record<EmployeeId, number>> = {};
  for (const e of hoursDue(task, closedDayWork(slices))) out[e.employeeId] = (out[e.employeeId] ?? 0) + e.ms;
  return Object.keys(out).length ? out : undefined;
}

// The hours log with one entry's time added to its mark (sign 1) or taken back off it (sign -1). Nothing is mutated.
export function moveMark(hours: HoursLog | undefined, e: HoursEntry, sign: 1 | -1): HoursLog {
  const log: HoursLog = hours ?? { pushed: {} };
  const person = log.pushed[e.employeeId] ?? {};
  const was = person[e.date] ?? 0;
  return { ...log, pushed: { ...log.pushed, [e.employeeId]: { ...person, [e.date]: Math.max(0, was + sign * e.ms) } } };
}
