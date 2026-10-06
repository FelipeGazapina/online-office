// Contract between the main process (owns agent sessions + company state) and the renderer (owns space, avatars, voice).
// Main is the source of truth for *logical* state. The renderer derives every avatar pose from it:
// an employee whose status is `blocked_on_owner` walks to the owner; everyone else walks back to their desk.

import type { Building, BuildOp, ItemId, Violation } from './space/types.ts';
import type { MailClientMessage, MailServerMessage, MailView } from './mail.ts';
import type { Board, BoardId, BoardPatch, BoardSpec, BoardSync, Priority, Task, TaskId, TaskStage, TaskTime } from './tasks.ts';
import type { VoiceApi } from './voice.ts';

export type EmployeeId = string & { readonly __brand: 'EmployeeId' };
export type BlockId = string & { readonly __brand: 'BlockId' };
export type QuestionId = string & { readonly __brand: 'QuestionId' };

export type Provider = 'claude-code' | 'codex' | 'hermes';
export type EmployeeRole = 'employee' | 'orchestrator';

// The owner meeting room is session-scoped. Main owns this value and sends it in every snapshot.
export type MeetingDoor = 'open' | 'closed';

export const PROVIDERS: Record<Provider, { label: string; color: string }> = {
  'claude-code': { label: 'Claude Code', color: '#d97757' },
  codex: { label: 'ChatGPT (Codex)', color: '#10a37f' },
  hermes: { label: 'Hermes', color: '#7c5cff' },
};

// Whether an employee of this provider can be hired on this machine right now.
// `not_wired` means the CLI is installed but the office has no adapter for it yet.
export type HarnessStatus = { kind: 'ready'; version: string } | { kind: 'missing' } | { kind: 'not_wired' };

// A model id in the harness's own words, as its own model list gives it.
export type ModelId = string & { readonly __brand: 'ModelId' };
export type ModelOption = { id: ModelId; label: string };

// What one harness offers. `unknown` until someone asks (`load_models`), `loading` while the harness answers.
export type ModelCatalog =
  | { kind: 'unknown' }
  | { kind: 'loading' }
  | { kind: 'ready'; models: ModelOption[]; defaultModel: ModelId }
  | { kind: 'error'; message: string };

// How much an employee may do without asking. `inherit` follows the owner's own settings for the harness.
export type PermissionMode = 'inherit' | 'ask' | 'auto' | 'yolo';

// Added by Always allow on a permission card. The office checks these before it shows a card, for every harness.
// A `command` rule covers every command that starts with its words, an `exact` rule only that command, and a `tool`
// rule every use of the tool.
export type AllowRule = { kind: 'command'; prefix: string } | { kind: 'exact'; command: string } | { kind: 'tool'; name: string };

export type PermissionPolicy = { mode: PermissionMode; alwaysAllow: AllowRule[] };

// A running subagent. `parentId` is null for one the employee spawned itself, or the id of the subagent that spawned it.
export type Subagent = { id: string; parentId: string | null; label: string; startedAt: number };

// `text` is what the employee says out loud. A permission also carries what it wants to touch, so the card can show it verbatim.
export type QuestionBody = { text: string } & (
  | { kind: 'ask'; options?: string[] }
  | { kind: 'permission'; tool: string; detail: string }
);

// The office stamps an id and a time on a body when it puts the question on the owner's desk.
export type Question = QuestionBody & { id: QuestionId; askedAt: number };

export type EmployeeStatus =
  | { kind: 'idle' }
  | { kind: 'working'; task: string; startedAt: number }
  | { kind: 'blocked_on_owner'; task: string; question: Question }
  | { kind: 'error'; message: string };

export type Employee = {
  id: EmployeeId;
  name: string;
  provider: Provider;
  role?: EmployeeRole;
  blockId: BlockId;
  // The desk item this employee sits at, or null when the block had no room for another. Main assigns it.
  seat: ItemId | null;
  status: EmployeeStatus;
  activity: string;
  // What the harness runs on from the next turn. Chosen at hire, changed with `set_model`.
  model: ModelId;
  permissions: PermissionPolicy;
  // The subagents running now. They live and die with the session, so company.json never holds them.
  subagents: Subagent[];
  completedAt?: number;
  sessionId?: string;
  // The employee's own git worktree and branch of the block's repo. Absent when the block folder is not a git repo.
  workspace?: { path: string; branch: string };
  hiredAt: number;
};

// Rules are the owner's instructions. Every session loads the rules of its office, block and employee in full.
// A session rule belongs to one employee's current session and is dropped when that employee starts fresh.
export type RuleId = string & { readonly __brand: 'RuleId' };
export type RuleScope =
  | { kind: 'office' }
  | { kind: 'block'; blockId: BlockId }
  | { kind: 'employee'; employeeId: EmployeeId }
  | { kind: 'session'; employeeId: EmployeeId };
export type Rule = { id: RuleId; scope: RuleScope; text: string; updatedAt: number };

// Notes are what employees save with `remember`. Sessions see their titles and fetch bodies with `recall`.
export type NoteId = string & { readonly __brand: 'NoteId' };
export type NoteScope = { kind: 'office' } | { kind: 'block'; blockId: BlockId } | { kind: 'employee'; employeeId: EmployeeId };
export type NoteSummary = { id: NoteId; scope: NoteScope; title: string; author: EmployeeId; updatedAt: number };

export type Whiteboard = {
  title: string;
  mermaid: string;
  page?: { kind: 'html'; html: string; source: string } | { kind: 'url'; url: string };
  by: EmployeeId;
  at: number;
};

export type TaskProvider = 'linear' | 'cronospark';
export type TaskBoardSource = {
  provider: TaskProvider;
  projectId: string;
  label?: string;
};
// A card as a provider lists it. A board turns each card into a task (shared/tasks.ts), keyed by `externalId`.
export type TaskCard = {
  id: string;
  provider: TaskProvider;
  externalId: string;
  identifier: string;
  title: string;
  status: string;
  priority?: string;
  url?: string;
  sourceLabel: string;
};

const TASK_BOARD_STATUS_ORDER = ['Open', 'In Design', 'In Dev', 'In Progress', 'Ready to Review', 'Done', 'Deferred'] as const;
const TASK_BOARD_STATUS_ALIASES: Record<string, (typeof TASK_BOARD_STATUS_ORDER)[number]> = {
  backlog: 'Open',
  canceled: 'Done',
  cancelled: 'Done',
  implementedelsewhere: 'Done',
  inapproval: 'Ready to Review',
  closed: 'Done',
  complete: 'Done',
  completed: 'Done',
  design: 'In Design',
  development: 'In Dev',
  dev: 'In Dev',
  deferred: 'Deferred',
  done: 'Done',
  indevelopment: 'In Dev',
  indev: 'In Dev',
  indesign: 'In Design',
  inprogress: 'In Progress',
  inreview: 'Ready to Review',
  open: 'Open',
  pending: 'Open',
  progress: 'In Progress',
  qa: 'Ready to Review',
  readyforreview: 'Ready to Review',
  readytoreview: 'Ready to Review',
  review: 'Ready to Review',
  started: 'In Progress',
  todo: 'Open',
  working: 'In Progress',
};

const taskBoardStatusKey = (status: string) => status.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

export function taskBoardStatusLabel(status: string): string {
  const trimmed = status.trim();
  return TASK_BOARD_STATUS_ALIASES[taskBoardStatusKey(trimmed)] ?? (trimmed || 'Open');
}

// The user id is safe to show back in the settings UI. The API key never crosses the main-process boundary in a snapshot.
export type TaskConnectionState = { kind: 'ready' | 'connecting' | 'needs_auth' | 'missing' | 'error'; message?: string; userId?: string; hasApiKey?: boolean };

export type ProjectBlock = {
  id: BlockId;
  name: string;
  cwd: string;
  color: string;
  slot: number;
  githubRepo?: string;
  whiteboard?: Whiteboard;
  linearBoardUrl?: string;
};

export type Company = {
  name: string;
  level: number;
  xp: number;
  settings: CompanySettings;
  blocks: ProjectBlock[];
  employees: Employee[];
};

export const MAX_LEVEL = 5;
export const XP_FOR_LEVEL = [0, 0, 30, 80, 150, 250] as const;
// The bench desks a team starts with (space/kit.ts). The PO desk is not one of them.
export const DESKS_PER_BLOCK = 6;
export const headcountCap = (level: number) => (level >= MAX_LEVEL ? Infinity : Math.min(level, MAX_LEVEL));

// The level unlocks a ceiling, and the owner picks a number up to it in the Company area. Indexed by level.
// No level's perBlock exceeds DESKS_PER_BLOCK, because a block has no more bench seats than that.
export const SEAT_CEILING = [
  { total: 0, perBlock: 0 },
  { total: 1, perBlock: 1 },
  { total: 2, perBlock: 2 },
  { total: 4, perBlock: 3 },
  { total: 6, perBlock: 5 },
  { total: 10, perBlock: 6 },
] as const;
export type Seats = { total: number; perBlock: number };
// A copy, so the seats a company holds are never the shared constant.
export const seatCeiling = (level: number): Seats => ({ ...SEAT_CEILING[Math.min(Math.max(level, 0), MAX_LEVEL)]! });

export type CompanySettings = {
  seats: Seats;
  // What a new hire of each provider starts on when the owner picks nothing at hire.
  defaultModels: Partial<Record<Provider, ModelId>>;
  defaultPermissions: PermissionMode;
};

// How an interjection from the owner lands in a running session.
// `next`: tap on the shoulder, the agent reads it at its next step.
// `now`: hard stop, the agent drops the current step and listens.
export type InterruptStyle = 'next' | 'now';

export type ClientMessage =
  // `deskId` is the desk the new hire sits at, when it is free and of the right kind. `taskId` assigns them that task
  // the moment they are hired, exactly as `assign_task` would.
  | { type: 'hire'; provider: Provider; blockId: BlockId; name?: string; model?: ModelId; role?: EmployeeRole; bypassLimit?: boolean; deskId?: ItemId; taskId?: TaskId }
  | { type: 'fire'; employeeId: EmployeeId }
  | { type: 'create_block'; cwd: string; name?: string; githubRepo?: string }
  | { type: 'update_block'; blockId: BlockId; name?: string; cwd?: string; githubRepo?: string }
  // Fires everyone in the block, then drops it. The folder on disk is never touched.
  | { type: 'remove_block'; blockId: BlockId }
  | { type: 'configure_linear_board'; blockId: BlockId; url: string }
  | { type: 'connect_task_provider'; provider: TaskProvider }
  | { type: 'configure_task_provider'; provider: 'cronospark'; apiKey: string; userId: string }
  // Boards and tasks. A block always keeps at least one board. A quick board takes no sources, so `spec` and `update_board`
  // refuse them on one.
  | { type: 'create_board'; blockId: BlockId; name: string; spec: BoardSpec }
  | ({ type: 'update_board'; boardId: BoardId } & BoardPatch)
  // Refused while a task on it is in `doing`, and for the last board of a block. Takes the board's tasks with it.
  | { type: 'delete_board'; boardId: BoardId }
  // Pulls the board's sources again. A quick board has none.
  | { type: 'refresh_board'; boardId: BoardId }
  // `stage` is the column the task starts in, todo when absent. `assignee` is the block's PO or one of its employees: the task
  // is made and handed to them in one step, so they start at once and it begins in doing, whatever `stage` says.
  | { type: 'create_task'; boardId: BoardId; title: string; notes?: string; stage?: TaskStage; assignee?: EmployeeId; priority?: Priority }
  // `notes: ''` clears the notes and `priority: null` the priority, which only a task made by hand has. The owner may set any
  // stage, and done is only ever the owner's call.
  | { type: 'update_task'; taskId: TaskId; title?: string; notes?: string; stage?: TaskStage; priority?: Priority | null }
  // Cancels the runs still open, then drops the task.
  | { type: 'delete_task'; taskId: TaskId }
  // `employeeId` is the block's PO or any employee of the block. Posts one root request to them, so they start at once.
  | { type: 'assign_task'; taskId: TaskId; employeeId: EmployeeId }
  // Sends the time a CronoSpark task has worked and not sent yet: closed time only, one hours entry per person and day, and the
  // same time never twice. This is the only way hours leave the app.
  | { type: 'send_hours'; taskId: TaskId }
  // `always` counts only on a permission card, and only when `text` allows it. The office then adds a rule for that
  // employee that covers the same command or tool from now on.
  | { type: 'answer'; employeeId: EmployeeId; questionId: QuestionId; text: string; always?: boolean }
  | { type: 'meeting_door'; state: MeetingDoor }
  // Asks a harness for its model list. The answer arrives as that provider's catalog in the next snapshots.
  | { type: 'load_models'; provider: Provider }
  | { type: 'set_model'; employeeId: EmployeeId; model: ModelId }
  | { type: 'set_permissions'; employeeId: EmployeeId; mode: PermissionMode }
  | { type: 'remove_allow_rule'; employeeId: EmployeeId; rule: AllowRule }
  // Stops the employee's session and starts another with no memory of the conversation. Notes, model and rules stay.
  | { type: 'fresh_session'; employeeId: EmployeeId }
  | { type: 'reset_company' }
  // Edits to the building. Main applies them all or none and answers a refusal with `build_rejected`.
  | { type: 'build'; ops: BuildOp[] }
  | { type: 'undo' }
  | { type: 'redo' }
  // Everything the owner says to anyone, a task or a word, goes through the mailroom.
  | MailClientMessage;

export type Snapshot = {
  type: 'snapshot';
  company: Company;
  harnesses: Record<Provider, HarnessStatus>;
  catalogs: Record<Provider, ModelCatalog>;
  meetingDoor: MeetingDoor;
  // Changes whenever the building does. The building itself arrives on its own channel.
  buildingRev: number;
  // Every block has at least one board, in the order the owner sees them.
  boards: Board[];
  tasks: Task[];
  // How the last pull of a board's sources went. A quick board has no entry.
  boardSync: Record<BoardId, BoardSync>;
  // Time worked per task with at least one run, derived from the mailroom's ledger. A person in `running` keeps counting
  // after `at`, at `share` of wall time.
  taskTime: Record<TaskId, TaskTime>;
  taskConnections: Record<TaskProvider, TaskConnectionState>;
  mail: MailView;
};

export type ServerMessage =
  | Snapshot
  | { type: 'said'; employeeId: EmployeeId; text: string }
  | { type: 'log'; employeeId: EmployeeId; line: string; at: number }
  | { type: 'building'; building: Building; rev: number }
  | { type: 'build_rejected'; violations: readonly Violation[] }
  | { type: 'error'; message: string }
  | MailServerMessage;

// What the preload exposes as `window.office`. Main validates every ClientMessage, so the renderer can send freely.
export type OfficeApi = {
  getSnapshot(): Promise<Snapshot>;
  getBuilding(): Promise<{ building: Building; rev: number }>;
  send(msg: ClientMessage): void;
  subscribe(cb: (msg: ServerMessage) => void): () => void;
  // The OS folder picker. Resolves null when the owner cancels.
  pickFolder(): Promise<string | null>;
  revealFolder(path: string): void;
  portal: {
    enter(): void;
    leave(): void;
    openHome(): void;
    openTerminal(): void;
    openSlack(): void;
    onExit(cb: () => void): () => void;
  };
  update: {
    // Acts only from `current`, `check-failed` and `update-failed`.
    check(): void;
    // Downloads the update and relaunches into it. Acts only from `available`.
    install(): void;
    // Calls back with the current state right away, then on every change. Never calls back in a build that cannot
    // update itself (unpackaged, or not the Mac app).
    subscribe(cb: (state: UpdateState) => void): () => void;
  };
  voice: VoiceApi;
};

export type UpdateState =
  | { status: 'checking' }
  | { status: 'current'; version: string }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'installing'; version: string }
  | { status: 'check-failed'; message: string }
  | { status: 'update-failed'; version: string; message: string };

export const IPC = {
  snapshot: 'office:snapshot',
  building: 'office:building',
  send: 'office:send',
  event: 'office:event',
  pickFolder: 'office:pick-folder',
  revealFolder: 'office:reveal-folder',
  portalEnter: 'office:portal-enter',
  portalLeave: 'office:portal-leave',
  portalOpenHome: 'office:portal-open-home',
  portalOpenTerminal: 'office:portal-open-terminal',
  portalOpenSlack: 'office:portal-open-slack',
  portalExit: 'office:portal-exit',
  updateCheck: 'office:update-check',
  updateInstall: 'office:update-install',
  updateSubscribe: 'office:update-subscribe',
  updateEvent: 'office:update-event',
} as const;
