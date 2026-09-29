// Contract between the bridge (owns agent sessions + company state) and the world (owns space, avatars, voice).
// The bridge is the source of truth for *logical* state. The world derives every avatar pose from it:
// an employee whose status is `blocked_on_owner` walks to the owner; everyone else walks back to their desk.

export type EmployeeId = string & { readonly __brand: 'EmployeeId' };
export type BlockId = string & { readonly __brand: 'BlockId' };
export type QuestionId = string & { readonly __brand: 'QuestionId' };

export type Provider = 'claude-code' | 'codex' | 'cursor' | 'grok';

export const PROVIDERS: Record<Provider, { label: string; color: string; real: boolean }> = {
  'claude-code': { label: 'Claude Code', color: '#d97757', real: true },
  codex: { label: 'Codex (ChatGPT)', color: '#10a37f', real: false },
  cursor: { label: 'Cursor', color: '#6b7cff', real: false },
  grok: { label: 'Grok', color: '#9aa0a6', real: false },
};

export type Question = {
  id: QuestionId;
  text: string;
  options?: string[];
  askedAt: number;
};

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
  | { type: 'create_block'; name: string; cwd?: string }
  | { type: 'update_block'; blockId: BlockId; name?: string; cwd?: string }
  | { type: 'assign'; employeeId: EmployeeId; task: string }
  | { type: 'answer'; employeeId: EmployeeId; questionId: QuestionId; text: string }
  | { type: 'interject'; employeeId: EmployeeId; text: string; style: InterruptStyle }
  | { type: 'reset_company' };

export type ServerMessage =
  | { type: 'snapshot'; company: Company }
  | { type: 'said'; employeeId: EmployeeId; text: string }
  | { type: 'log'; employeeId: EmployeeId; line: string; at: number }
  | { type: 'error'; message: string };

export const BRIDGE_PORT = 4800;
