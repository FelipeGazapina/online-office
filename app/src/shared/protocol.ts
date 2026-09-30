// Contract between the main process (owns agent sessions + company state) and the renderer (owns space, avatars, voice).
// Main is the source of truth for *logical* state. The renderer derives every avatar pose from it:
// an employee whose status is `blocked_on_owner` walks to the owner; everyone else walks back to their desk.

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
  desk: number;
  status: EmployeeStatus;
  activity: string;
  // What the harness runs on from the next turn. Chosen at hire, changed with `set_model`.
  model: ModelId;
  permissions: PermissionPolicy;
  // The subagents running now. They live and die with the session, so company.json never holds them.
  subagents: Subagent[];
  completedAt?: number;
  sessionId?: string;
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

export type ProjectBlock = {
  id: BlockId;
  name: string;
  cwd: string;
  color: string;
  slot: number;
  githubRepo?: string;
  whiteboard?: Whiteboard;
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
// The bench seats in renderer/layout.ts. The head desk is not one of them.
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
  | { type: 'hire'; provider: Provider; blockId: BlockId; name?: string; model?: ModelId; role?: EmployeeRole; bypassLimit?: boolean }
  | { type: 'fire'; employeeId: EmployeeId }
  | { type: 'create_block'; cwd: string; name?: string; githubRepo?: string }
  | { type: 'update_block'; blockId: BlockId; name?: string; cwd?: string; githubRepo?: string }
  | { type: 'assign'; employeeId: EmployeeId; task: string }
  // `always` counts only on a permission card, and only when `text` allows it. The office then adds a rule for that
  // employee that covers the same command or tool from now on.
  | { type: 'answer'; employeeId: EmployeeId; questionId: QuestionId; text: string; always?: boolean }
  | { type: 'interject'; employeeId: EmployeeId; text: string; style: InterruptStyle }
  | { type: 'meeting_door'; state: MeetingDoor }
  // Asks a harness for its model list. The answer arrives as that provider's catalog in the next snapshots.
  | { type: 'load_models'; provider: Provider }
  | { type: 'set_model'; employeeId: EmployeeId; model: ModelId }
  | { type: 'set_permissions'; employeeId: EmployeeId; mode: PermissionMode }
  | { type: 'remove_allow_rule'; employeeId: EmployeeId; rule: AllowRule }
  // Stops the employee's session and starts another with no memory of the conversation. Notes, model and rules stay.
  | { type: 'fresh_session'; employeeId: EmployeeId }
  | { type: 'reset_company' };

export type Snapshot = {
  type: 'snapshot';
  company: Company;
  harnesses: Record<Provider, HarnessStatus>;
  catalogs: Record<Provider, ModelCatalog>;
  meetingDoor: MeetingDoor;
};

export type ServerMessage =
  | Snapshot
  | { type: 'said'; employeeId: EmployeeId; text: string }
  | { type: 'log'; employeeId: EmployeeId; line: string; at: number }
  | { type: 'error'; message: string };

// What the preload exposes as `window.office`. Main validates every ClientMessage, so the renderer can send freely.
export type OfficeApi = {
  getSnapshot(): Promise<Snapshot>;
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
  send: 'office:send',
  event: 'office:event',
  pickFolder: 'office:pick-folder',
  revealFolder: 'office:reveal-folder',
  portalEnter: 'office:portal-enter',
  portalLeave: 'office:portal-leave',
  portalOpenHome: 'office:portal-open-home',
  portalOpenTerminal: 'office:portal-open-terminal',
  updateCheck: 'office:update-check',
  updateInstall: 'office:update-install',
  updateSubscribe: 'office:update-subscribe',
  updateEvent: 'office:update-event',
} as const;
