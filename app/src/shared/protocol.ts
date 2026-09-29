// Contract between the main process (owns agent sessions + company state) and the renderer (owns space, avatars, voice).
// Main is the source of truth for *logical* state. The renderer derives every avatar pose from it:
// an employee whose status is `blocked_on_owner` walks to the owner; everyone else walks back to their desk.

export type EmployeeId = string & { readonly __brand: 'EmployeeId' };
export type BlockId = string & { readonly __brand: 'BlockId' };
export type QuestionId = string & { readonly __brand: 'QuestionId' };

export type Provider = 'claude-code' | 'codex' | 'hermes';

export const PROVIDERS: Record<Provider, { label: string; color: string }> = {
  'claude-code': { label: 'Claude Code', color: '#d97757' },
  codex: { label: 'ChatGPT (Codex)', color: '#10a37f' },
  hermes: { label: 'Hermes', color: '#7c5cff' },
};

// Whether an employee of this provider can be hired on this machine right now.
// `not_wired` means the CLI is installed but the office has no adapter for it yet.
export type HarnessStatus = { kind: 'ready'; version: string } | { kind: 'missing' } | { kind: 'not_wired' };

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
  blockId: BlockId;
  desk: number;
  status: EmployeeStatus;
  activity: string;
  sessionId?: string;
  hiredAt: number;
};

export type Whiteboard = {
  title: string;
  mermaid: string;
  by: EmployeeId;
  at: number;
};

export type ProjectBlock = {
  id: BlockId;
  name: string;
  cwd: string;
  color: string;
  slot: number;
  whiteboard?: Whiteboard;
};

export type Company = {
  name: string;
  level: number;
  xp: number;
  blocks: ProjectBlock[];
  employees: Employee[];
};

export const MAX_LEVEL = 5;
export const XP_FOR_LEVEL = [0, 0, 30, 80, 150, 250] as const;
export const DESKS_PER_BLOCK = 5;
export const headcountCap = (level: number) => Math.min(level, MAX_LEVEL);

// How an interjection from the owner lands in a running session.
// `next`: tap on the shoulder, the agent reads it at its next step.
// `now`: hard stop, the agent drops the current step and listens.
export type InterruptStyle = 'next' | 'now';

export type ClientMessage =
  | { type: 'hire'; provider: Provider; blockId: BlockId; name?: string }
  | { type: 'fire'; employeeId: EmployeeId }
  | { type: 'create_block'; cwd: string; name?: string }
  | { type: 'update_block'; blockId: BlockId; name?: string; cwd?: string }
  | { type: 'assign'; employeeId: EmployeeId; task: string }
  | { type: 'answer'; employeeId: EmployeeId; questionId: QuestionId; text: string }
  | { type: 'interject'; employeeId: EmployeeId; text: string; style: InterruptStyle }
  | { type: 'reset_company' };

export type Snapshot = { type: 'snapshot'; company: Company; harnesses: Record<Provider, HarnessStatus> };

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
};

export const IPC = {
  snapshot: 'office:snapshot',
  send: 'office:send',
  event: 'office:event',
  pickFolder: 'office:pick-folder',
  revealFolder: 'office:reveal-folder',
} as const;
