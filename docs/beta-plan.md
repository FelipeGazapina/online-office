# Beta plan

Goal: turn the v0 prototype into an app you use every day. It runs in Electron, and every employee is a real harness on this machine.

## Done means

Each item is checked on the real Electron app, not on a mock.

1. `pnpm dev` in `app/` opens an Electron window with the office. No browser, no separate server port.
2. **New block** opens the OS folder picker. The chosen folder becomes the block's working folder, and the block name defaults to the folder name. The block can reveal its folder in Finder.
3. **Hire** offers Claude Code, ChatGPT (Codex) and Hermes. No simulated employee or demo mode remains in the code.
4. For each of the three harnesses, a script does all of the following in one run and exits 0:
   - hires the employee into a block that points at a scratch git repo
   - gives it a task by typing next to it
   - sees it call `ask_owner` and walk to the owner
   - answers on the card
   - sees it write a file in the block folder and go idle
5. Talking to a busy employee reaches its running session, and the log shows the agent acknowledging it.
6. **Memory.** An employee saves a fact in one session. After the app restarts and the employee gets a fresh session, it answers with that fact. This holds for every harness.
7. **Voice.** A clip made with macOS `say` goes through the push-to-talk pipeline and reaches the agent as the right text, in English and Portuguese.
8. **Models.** Hiring offers each harness's own model list, fetched from the harness. The employee drawer changes the model, and the next turn runs on it. The log shows the model id.
9. **Rules.** Rules exist at four scopes: office, block, employee and session. A rule added on its board, typed or dictated, reaches every running session in its scope, and the agent acknowledges it. Editing a rule file in any editor updates the board and the sessions. A session rule is gone once that employee starts a fresh session.
10. **Memory scopes.** Employees save notes for themselves, their block or the whole office. The boards show those notes, and the owner can edit or delete them.
11. **Owner's computer.** Sitting at the owner's desk offers two areas.
    - **My Mac** hides the office behind a small floating panel, so the owner works on the real computer. An employee who needs the owner shows up in that panel, speaks, and can be answered from it. One click or a global shortcut returns to the office.
    - **Company** sets the seat count for the company and per block, up to the ceiling the current level unlocks. Blocks lay out as many desks as their seats.
12. **Subagents.** A subagent that an employee spawns appears as a matryoshka doll on that employee's desk. A nested subagent is a smaller doll. Dolls do not count as employees and disappear when the subagent finishes.
13. **Permissions.** Each employee runs with the owner's permission settings for its harness (see Rigor). A command those settings allow runs without a card. A command they leave to "ask" walks to the owner.
14. Every unit is committed and pushed to `main`.

## Running the beta

The owner runs the beta from `~/projetos/online-office-beta/app`, a git worktree detached at the last verified commit on `main`. Agents never write there. The orchestrator moves it forward after each verified unit, so `pnpm dev` there always runs code that passed its checks.

## Known blockers

- **Speech recognition.** The browser speech API does not work inside Electron, so listening needs local whisper.cpp or another engine.
- **Tool timeouts.** `ask_owner` blocks until you answer, which can take minutes. Codex and Hermes may time out MCP tool calls first.
- **Leaking config.** Employees inherit your permission settings, but not your connectors, MCP servers, plugins, hooks, skills or memory. v0 already found connectors leaking with Claude Code.
- **Tooling version.** electron-vite 5 supports Vite up to 7, and the repo is on Vite 8.

## Rigor

Medium-high. Everything is reversible through git, but employees run real commands in your real project folders.

Employees inherit the owner's own permission settings for their harness, read when each session starts:

- **Claude Code** takes the permission rules, `defaultMode` and `autoMode` from `~/.claude/settings.json`, plus the block folder's `.claude/settings*.json`. It does not take the owner's plugins or hooks.
- **Codex** takes `approval_policy`, `sandbox_mode` and `~/.codex/rules/` from `~/.codex`.
- **Hermes** takes `approvals` and `command_allowlist` from `~/.hermes/config.yaml`.

Whatever that policy leaves to "ask" becomes a walk to the owner. Tools, MCP servers, skills and memory stay isolated. The gates are:

- research findings with observed output before any adapter is designed
- one end-to-end script per harness against the real app

## Units

Research agents write only to `docs/research/`. From U2 on, every implementation agent works in its own git worktree, and the orchestrator merges its branch after reviewing the diff and running its check.

| Unit | What | Depends on | Status |
| --- | --- | --- | --- |
| R1 | Research: drive Codex through `codex app-server` | none | done |
| R2 | Research: drive Hermes through ACP | none | done |
| R3 | Research: memory, and what the office should own | none | done |
| R4 | Research: whisper.cpp on this Mac, and speech inside Electron | none | running |
| U0 | Electron shell: office in the main process, IPC, folder picker, fakes deleted | none | done |
| U1 | Office MCP server over local HTTP, the owner's question inbox, the memory store, Claude moved onto them | U0, R1, R2, R3 | running |
| C1 | Contract v2: the types below, the `company.json` migration, and no-op stubs. No behavior change | U1 | |
| U2 | Real ChatGPT (Codex) employee: app-server, isolation, inherited approvals, model list, subagent events | C1 | |
| U3 | Real Hermes employee: ACP, office profile, inherited approvals, model list, subagent events | C1 | |
| F1 | Claude employee v2 and its UI: inherited permissions, model picker and live switch, subagent dolls on the desk | C1 | |
| F2 | Rules and boards: rule files with a watcher, delivery to live sessions, office and block boards, sticky notes on desks, notes on boards, fresh session | F1 | |
| F3 | Owner's computer: the My Mac portal with its floating panel, the Company area with seats and level ceilings, desks per block from seats | F1 | |
| U5 | Voice through whisper.cpp: push-to-talk, proximity, dictating a rule to a board | R4, F2 | |
| U6 | README, then the full end-to-end run for all three harnesses | all | |

C1 runs alone because every later unit builds on its types. Then U2, U3 and F1 run in parallel. Then F2, F3 and U5. At most three implementation agents run at once, which keeps the session under its rate limit. The decision trail lives in `docs/decisions.tsv`.

## Contract v2

C1 adds these shapes to `src/shared/protocol.ts` and the adapter interfaces. Later units fill them in. The names reconcile with whatever U1 lands.

```ts
// Seats. The level unlocks a ceiling, and the owner picks a number up to it in the Company area.
export const SEAT_CEILING = [
  { total: 0, perBlock: 0 },
  { total: 1, perBlock: 1 },
  { total: 2, perBlock: 2 },
  { total: 4, perBlock: 3 },
  { total: 6, perBlock: 5 },
  { total: 10, perBlock: 8 },
] as const; // indexed by level
export type Seats = { total: number; perBlock: number };

export type ModelId = string & { readonly __brand: 'ModelId' };
export type ModelOption = { id: ModelId; label: string };
export type ModelCatalog =
  | { kind: 'unknown' }
  | { kind: 'loading' }
  | { kind: 'ready'; models: ModelOption[]; defaultModel: ModelId }
  | { kind: 'error'; message: string };

export type CompanySettings = { seats: Seats; defaultModels: Partial<Record<Provider, ModelId>> };

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
export type NoteScope =
  | { kind: 'office' }
  | { kind: 'block'; blockId: BlockId }
  | { kind: 'employee'; employeeId: EmployeeId };
export type NoteSummary = { id: NoteId; scope: NoteScope; title: string; author: EmployeeId; updatedAt: number };

// A running subagent. `parentId` is null for one the employee spawned itself, or another subagent's id.
export type Subagent = { id: string; parentId: string | null; label: string; startedAt: number };
```

- `Employee` gains `model: ModelId` and `subagents: Subagent[]`. Subagents are never persisted.
- `Company` gains `settings: CompanySettings`. The snapshot gains `catalogs: Record<Provider, ModelCatalog>`, `rules: Rule[]` and `notes: NoteSummary[]`.
- `ClientMessage` gains `update_settings`, `load_models`, `set_model`, `fresh_session`, `add_rule`, `edit_rule`, `delete_rule`, `edit_note` and `delete_note`. `hire` gains an optional `model`.
- `OfficeApi` gains `openRulesFile(scope)`, which opens the scope's rule file in the OS editor, and `portal.enter()` and `portal.leave()`.
- `EmployeeSession` gains `setModel(model)`, applied from the next turn, and `rulesChanged(text)`, a notice delivered to a live session at its next step.
- `SessionHost` gains the rules in scope as text, frozen at session start, and `subagentStarted` and `subagentFinished`.
- Each harness entry gains `listModels(): Promise<ModelCatalog>`.

Rule files live in the app's data folder as `rules/office.md`, `rules/blocks/<blockId>.md` and `rules/employees/<employeeId>.md`, one rule per list item. The file is the source of truth. The boards edit it, the owner can edit it in any editor, and a watcher reloads it. Session rules live in `company.json` on the employee.
