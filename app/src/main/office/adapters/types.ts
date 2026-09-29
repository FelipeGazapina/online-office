import type {
  Employee,
  EmployeeStatus,
  InterruptStyle,
  ModelCatalog,
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
  // A permission body sends a shell command as `tool: SHELL_TOOL` with the bare command in `detail`, with no shell
  // wrapper around it. The office checks the employee's Always-allow rules against `tool` and `detail`, and resolves
  // with ALLOW_ANSWER at once, with no card, when one covers it. To tell an owner's allow from a deny, use
  // `isAllow(answer)` (shared/permissions.ts) and send the text back to the harness when it is a deny.
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
  // The owner picked another model. `host.model` already returns it. Apply it from the next turn, and never interrupt
  // the turn that is running. Claude switches the live session with `Query.setModel`, Codex sends `model` on the next
  // `turn/start`, and Hermes calls `session/set_model`. None of them validates the id up front, so a model the harness
  // rejects fails the next turn. Report that like any failed turn, with `setStatus({ kind: 'error' })`.
  setModel(model: ModelId): void;
  // The policy changed: the owner picked another mode, or an Always-allow rule was added or removed. `host.permissions`
  // already returns it. Apply a new `mode` as soon as the harness allows, live if it can and from the next turn or the
  // next session start if not (docs/beta-plan.md maps each mode onto each harness's switches). Ignore a change that is
  // only in `alwaysAllow`, because the office enforces those rules itself.
  permissionsChanged(policy: PermissionPolicy): void;
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
  // The models this harness offers, asked of the harness itself. The office calls it when the owner asks
  // (`load_models`), never twice at once, so it may start the CLI and take seconds. Resolve `ready` with every model
  // the owner can pick and the id the harness starts on when given none (Claude `Query.supportedModels()`, Codex
  // `model/list` with its `isDefault` entry, Hermes the `models` of `session/new`), or `error` with a reason the owner
  // can read. A rejection becomes `error` too. Leave it out until the harness can list its models.
  listModels?(): Promise<ModelCatalog>;
};
