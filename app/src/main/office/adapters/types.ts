import type {
  Employee,
  EmployeeStatus,
  InterruptStyle,
  ModelId,
  PermissionPolicy,
  ProjectBlock,
  QuestionBody,
} from '../../../shared/protocol.ts';

// What the company hands each session. `employee` and `block` are live views of company state;
// every mutation goes back through the callbacks so persistence and broadcast stay in one place.
export type SessionHost = {
  readonly employee: Readonly<Employee>;
  readonly block: Readonly<ProjectBlock>;
  readonly companyName: string;
  // The model this employee runs on now, in the words of its harness. Read it whenever a session or a turn starts.
  readonly model: ModelId;
  // How much this employee may do without asking, now. `inherit` means the owner's own settings for the harness.
  // The office answers `alwaysAllow` itself, before a card reaches the owner, so an adapter only maps `mode` onto
  // its harness's switches.
  readonly permissions: PermissionPolicy;
  setStatus(status: EmployeeStatus): void;
  setActivity(text: string): void;
  setSessionId(id: string): void;
  said(text: string): void;
  log(line: string): void;
  // Puts a question on the owner's desk and resolves with what the owner answers. The office owns the question:
  // it shows the employee as blocked, and puts them back to working once the owner answers. An adapter uses this for
  // Permission cards. `ask_owner` reaches the same place through the office MCP server; while the meeting-room
  // door is closed, ask_owner returns do-not-disturb guidance but permission cards stay queued in the inbox.
  //
  // It never rejects. When `signal` aborts (the harness cancelled the tool call, or a hard stop) or the session ends
  // before an answer, the office withdraws the card and the promise resolves with '', which the caller has already
  // stopped listening for. One employee can have several questions open at once. The owner sees them first in,
  // first out: the next one shows when the one in front is answered.
  ask(body: QuestionBody, signal?: AbortSignal): Promise<string>;
  // The office MCP server, already scoped to this employee by its URL. Every harness connects to it under this
  // name, so tool ids read `mcp__office__ask_owner` and so on. It serves ask_owner, draw_diagram, remember, recall
  // and forget. The URL is only valid for this session and this run of the app.
  readonly mcp: { readonly url: string; readonly name: 'office' };
  // Titles of this employee's and this block's saved notes, read now. Call it once when the harness session starts and
  // reuse the string for that whole session, so a note saved mid-session changes nothing until the next one.
  memoryDigest(): string;
  // Company awards the XP. Adapters call this once per finished task.
  taskCompleted(): void;
};

// One per employee. Construction must be cheap: the real adapter starts its process on first message.
export interface EmployeeSession {
  assign(task: string): void;
  // Company routes interjections to a blocked employee into the question it is waiting on, so this only sees idle/working/error.
  interject(text: string, style: InterruptStyle): void;
  stop(): void;
}

export type SessionFactory = (host: SessionHost) => EmployeeSession;

// One entry per provider in HARNESSES, so adding a provider to the contract fails typecheck until it is described here.
export type Harness = {
  // Resolves to the harness version, or null when it is not installed.
  detect(): Promise<string | null>;
  // The model a new employee starts on when the owner picks none, in the harness's own words. A function so the
  // environment is read when someone is hired, not when the module loads.
  defaultModel(): ModelId;
  // A harness without a `session` factory is installed but not wired: the hire modal shows it, and hiring it is refused.
  session?: SessionFactory;
};
