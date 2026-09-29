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
8. Every unit is committed and pushed to `main`.

## Known blockers

- **Speech recognition.** The browser speech API does not work inside Electron, so listening needs local whisper.cpp or another engine.
- **Tool timeouts.** `ask_owner` blocks until you answer, which can take minutes. Codex and Hermes may time out MCP tool calls first.
- **Leaking config.** Employees must not inherit your personal connectors, MCP servers or plugins. v0 already found this with Claude Code.
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

The first stage runs in parallel. Research agents write only to `docs/research/`. The shell agent is the only writer to `app/`.

| Unit | What | Depends on |
| --- | --- | --- |
| R1 | Research: drive Codex through `codex app-server` (interrupt, approvals, MCP, timeouts, resume) | none |
| R2 | Research: drive Hermes through ACP (`hermes acp`), and whether ACP fits other harnesses | none |
| R3 | Research: memory, meaning claude-mem, what each harness remembers, and what the office should own | none |
| R4 | Research: whisper.cpp speed and accuracy on this Mac, and speech inside Electron | none |
| U0 | Electron shell: the bridge moves into the main process, it talks over IPC, the folder picker lands, fakes are deleted | none |
| U1 | Office MCP server over local HTTP (`ask_owner`, `draw_diagram`, `remember`) plus a memory store | U0, R1, R2, R3 |
| U2 | Real ChatGPT (Codex) employee | U1 |
| U3 | Real Hermes employee | U1 |
| U5 | Voice through whisper.cpp: push-to-talk and proximity | U0, R4 |
| U6 | README, then the full end-to-end run for all three harnesses | all |

U2, U3 and U5 run in parallel in separate git worktrees. The orchestrator reviews each unit's diff, runs its check, then commits and pushes. The decision trail lives in `docs/decisions.tsv`.
