# Log in with Cursor to hire

Cursor employees run through the `@cursor/sdk` package, in the block folder. The Cursor CLI login does not count. The SDK keeps its own key at `~/.cursor/sdk/auth.json`.

## Hire card

Detection reads the installed SDK version. `Cursor.auth.status()` decides the card.

- Logged out: `needs_login`. The card stays clickable. The note is "Log in with Cursor to hire". The button is "Log in with Cursor".
- Logged in: `ready`. The button is Hire, and the model list comes from `Cursor.models.list()`.
- The package will not load: `missing`. The card is disabled.

The button sends `{ type: 'login_cursor' }`. The office calls `Cursor.auth.login()`, opens the system browser, and writes the harness status back into the snapshot. The modal stays open. When the snapshot says ready, the button becomes Hire.

Hiring while the status is `needs_login` is refused with "Log in with Cursor to hire someone."

## Session

`Agent.create` and `Agent.resume` run locally with the block folder as `cwd` and the office MCP server attached. The persona is prepended on the first prompt of a new conversation. The agent id is the employee session id.

The SDK has no permission callback, so the office does not show a card for a Cursor tool call.

- ask, and inherit of an allowlist: sandbox on, writes stay in the project folder
- auto, and inherit of auto-review: `local.autoReview`
- yolo, and inherit of unrestricted: sandbox off and review off

A mode change applies on the next task. A resume that fails starts a new agent.

Local agents are stored with `JsonlLocalAgentStore` under the app user-data directory `cursor-agents`. The package is externalized in the Electron build, next to the Claude SDK, because it loads itself from `node_modules`.

## Checks

- `node verify/cursor-check.ts` uses a fake SDK for login, catalogs, and sessions, then asks the real SDK. On this machine that real check was logged out at version 1.0.36.
- `node verify/office-check.ts`
- `pnpm typecheck`
- `pnpm build:verify && OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-cursor-login.mjs` opened the hire modal. The Cursor card was selectable and the button said "Log in with Cursor". The browser login was not completed.
