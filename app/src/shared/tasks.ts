// Tasks: what the owner wants done, how it is grouped on boards, and what working on it cost. Plain types and pure
// functions. The main process owns the state (main/office/tasks.ts) and this file never reads a clock or a disk.
//
// Time is not state. The mailroom's ledger says who was in a turn and when, and every message carries the root request
// of its chain, so a task's time is a fold over that ledger. The one thing a task stores is the root requests it started.
import type { LedgerEntry, MessageId, Outcome, TurnId } from './mail.ts';
import { taskBoardStatusLabel, type BlockId, type EmployeeId, type TaskBoardSource, type TaskCard, type TaskProvider } from './protocol.ts';

export type BoardId = string & { readonly __brand: 'BoardId' };
export type TaskId = string & { readonly __brand: 'TaskId' };
// A calendar day in the owner's time zone, as CronoSpark takes it.
export type LocalDate = `${number}-${number}-${number}`;

// A quick board is for tasks that came off the top of the owner's head. It cannot be linked to Linear or CronoSpark, so
// it has no sources to hold, and nothing to log hours into.
export type BoardSpec = { kind: 'quick' } | { kind: 'feature' | 'bug'; sources: TaskBoardSource[]; logHours: boolean };
export type Board = { id: BoardId; blockId: BlockId; name: string } & BoardSpec;
export type BoardPatch = { name?: string; sources?: TaskBoardSource[]; logHours?: boolean };

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

export type Task = {
  id: TaskId;
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
};

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

// ───────────────────────────── Boards ─────────────────────────────

export type Refused = { ok: false; reason: string };
export type BoardResult = { ok: true; board: Board } | Refused;

// What a source may hold. The same rules the old board configuration had, now in one place.
function cleanSources(sources: readonly TaskBoardSource[]): TaskBoardSource[] | Refused {
  const clean = sources.map((s) => ({ provider: s.provider, projectId: s.projectId.trim(), ...(s.label?.trim() ? { label: s.label.trim() } : {}) }));
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

export function makeBoard(id: BoardId, blockId: BlockId, name: string, spec: BoardSpec): BoardResult {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'A board needs a name.' };
  if (spec.kind === 'quick') return { ok: true, board: { id, blockId, name: trimmed, kind: 'quick' } };
  const sources = cleanSources(spec.sources);
  if (refusedSources(sources)) return sources;
  return { ok: true, board: { id, blockId, name: trimmed, kind: spec.kind, sources, logHours: spec.logHours } };
}

export function patchBoard(board: Board, patch: BoardPatch): BoardResult {
  const name = patch.name === undefined ? board.name : patch.name.trim();
  if (!name) return { ok: false, reason: 'A board needs a name.' };
  if (board.kind === 'quick') {
    if (patch.sources !== undefined || patch.logHours !== undefined) return { ok: false, reason: 'A quick board holds tasks from your head. It takes no sources and logs no hours.' };
    return { ok: true, board: { ...board, name } };
  }
  const sources = patch.sources === undefined ? board.sources : cleanSources(patch.sources);
  if (refusedSources(sources)) return sources;
  return { ok: true, board: { ...board, name, sources, logHours: patch.logHours ?? board.logHours } };
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
      const made = makeBoard(newId(), blockId, LEGACY_BOARD_NAME, { kind: 'feature', sources: old.sources, logHours: true });
      if (made.ok) out.push(made.board);
    }
    if (!out.some((b) => b.blockId === blockId && b.kind === 'quick')) out.push({ id: newId(), blockId, name: QUICK_BOARD_NAME, kind: 'quick' });
  }
  return { boards: out, changed: out.length !== boards.length || out.some((b, i) => b !== boards[i]) };
}

// ───────────────────────────── Tasks ─────────────────────────────

export function newTask(a: { id: TaskId; boardId: BoardId; title: string; notes?: string; origin: TaskOrigin; stage: TaskStage; now: number }): Task {
  return { id: a.id, boardId: a.boardId, title: a.title, ...(a.notes ? { notes: a.notes } : {}), origin: a.origin, stage: a.stage, assignees: [], runs: [], createdAt: a.now, updatedAt: a.now };
}

// The one request a person is given when a task is assigned to them.
export function runRequest(task: Task, board: Board): { title: string; text: string } {
  const o = task.origin;
  const source = o.kind === 'manual' ? '' : `\n\nFrom ${o.sourceLabel}: ${o.identifier}${o.url ? ` ${o.url}` : ''}`;
  return { title: task.title, text: `${task.title}${task.notes ? `\n\n${task.notes}` : ''}${source}\n\nTask board: ${board.name}.` };
}

const sourceKey = (o: ProviderOrigin) => `${o.kind}:${o.externalId}`;

// Provider cards become tasks, keyed by (board, provider, externalId). A card's status sets the stage only while the office
// has no say: once the task has runs or the owner pinned its stage, the office knows better. A card that is gone upstream
// takes its task with it unless the task has runs, and only when every source answered, so a source that failed cannot
// empty the board.
export function syncCards(board: Board, tasks: readonly Task[], cards: readonly TaskCard[], opt: { now: number; complete: boolean; newId: () => TaskId }): { tasks: Task[]; changed: boolean } {
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
      next.set(id, newTask({ id, boardId: board.id, title: card.title, origin, stage: stageOfStatus(card.status), now: opt.now }));
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
export type TaskTime = { at: number; totalMs: number; byEmployee: Record<EmployeeId, number>; running: { employeeId: EmployeeId; share: number }[] };

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

// The hours log with one entry's time added to its mark (sign 1) or taken back off it (sign -1). Nothing is mutated.
export function moveMark(hours: HoursLog | undefined, e: HoursEntry, sign: 1 | -1): HoursLog {
  const log: HoursLog = hours ?? { pushed: {} };
  const person = log.pushed[e.employeeId] ?? {};
  const was = person[e.date] ?? 0;
  return { ...log, pushed: { ...log.pushed, [e.employeeId]: { ...person, [e.date]: Math.max(0, was + sign * e.ms) } } };
}
