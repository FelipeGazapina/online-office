# Online Office (beta)

A 3D office where you are the owner and each employee is a live coding-agent session on your machine. Employees work at their desks. When one needs a decision, it walks to you and asks out loud. Walk up to an employee and talk to give it work or to interrupt it.

## Run it

```sh
pnpm install
pnpm dev
```

An Electron window opens with the office. On first run, click **Choose a folder** and pick a project folder. That folder becomes a block, and its employees work inside it. Then click **Hire**.

`pnpm start` builds the app and runs it without the dev server.

| Variable | Default | Effect |
| --- | --- | --- |
| `OFFICE_START_LEVEL` | `1` | Level (and seat count) of a freshly created company. |
| `OFFICE_CLAUDE_MODEL` | `claude-sonnet-5-5` | Model for Claude Code employees. Use `claude-haiku-4-5-20251001` for cheap runs. |
| `OFFICE_BASH=allow` | unset | Skip asking the owner before shell commands. |
| `OFFICE_DEBUG=1` | unset | Log MCP tool calls, each Claude session start with its memory digest, owner answers, and every message from the window. |
| `OFFICE_DATA_DIR` | Electron `userData` | Where the company, the memory notes, and the app profile live. Tests point it at a scratch folder. |
| `OFFICE_TEST_PICK_FOLDER` | unset | Tests only. The folder picker returns this path instead of opening. |
| `OFFICE_TEST_RUN` | unset | Tests only. The window is never shown, the Dock icon is hidden, and the page shows an "Automated test" banner. `verify/cdp.mjs` sets it. |
| `OFFICE_CDP_PORT` | `9333` | Tests only. The DevTools port `verify/cdp.mjs` uses. Give each worktree its own when tests run in parallel. |
| `OFFICE_OUT_DIR` | `out` | Tests only. The build folder `verify/cdp.mjs` launches. |
| `OFFICE_LONG_WAIT_S` | `150` | Tests only. How long `verify/e2e-long-wait.mjs` leaves the owner silent. |

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows, Shift | Walk, run |
| 1 / 2 / 3 | Camera: follow, overview, first person |
| Enter | Type to the nearest employee |
| V (hold) | Push-to-talk, when mic mode is "Hold V" |
| H | Key help |

Click an employee, on the avatar or the name tag, for a menu with **Open chat** and **Go to**. In the Overview camera, click the floor to walk there and drag to turn the view. Click a whiteboard to enlarge it. Click **Reveal** on a block to open its folder in Finder.

## How it works

- `src/shared/protocol.ts` is the contract. The main process owns logical state. The renderer derives every avatar from it: `blocked_on_owner` walks to the owner, anything else walks back to the desk.
- `src/main/` owns the company and the agent sessions, and talks to the renderer over IPC through the preload's `window.office`. Company state lives in `company.json` under the app's data folder.
- The office holds every question an employee asks you. `src/main/office/inbox.ts` keeps a first-in-first-out line per employee, so a harness that asks permission for two tools at once shows one card at a time. When the harness cancels a call, the card is withdrawn.
- Every employee reaches the office through one MCP server, whatever harness it runs on. Notes come from one store. Both are described below.
- Each Claude Code employee is one long-lived Agent SDK session that connects to the office MCP server over HTTP. Shell commands also become questions ("Can I run `npm test`?"). Claude's own auto memory is off.
- ChatGPT (Codex) and Hermes show in the hire menu when installed, but cannot be hired until their adapters land.
- Voice input does not work yet: Electron has no speech recognition backend. Type with Enter for now. Voices use `speechSynthesis`.

## The office MCP server

`src/main/office/mcp.ts` starts a Streamable HTTP server on `127.0.0.1` at an ephemeral port before the first session. It imports nothing from Electron, so a Node script can run it.

- Each employee gets its own URL, `http://127.0.0.1:<port>/mcp/<token>`. The token is 32 random bytes in hex. It is minted when the employee's session starts and dropped when the session stops. The URL is the identity, and no tool takes an employee id. An unknown token gets a 404.
- A request with an `Origin` header, or with a `Host` other than `127.0.0.1:<port>`, gets a 403. MCP clients in agents send neither.
- The server is stateful. When a harness cancels a call with `notifications/cancelled`, or drops the HTTP request, the office withdraws the owner's card.
- Adapters receive `host.mcp` (`{ url, name: 'office' }`), and `host.ask(body, signal)` for questions of their own, such as permission cards. The tools are:

| Tool | Input | Effect |
| --- | --- | --- |
| `ask_owner` | `question`, `options?` | Blocks until you answer on the card, then returns your answer. |
| `draw_diagram` | `title`, `mermaid` | Draws on the block's whiteboard. |
| `remember` | `scope` (`me` or `block`), `title`, `body` | Saves a note, or updates the note with the same title. |
| `recall` | `query?`, `scope?` | Returns up to 5 matching notes, or lists every title when `query` is empty. |
| `forget` | `scope`, `id` | Deletes a note. |

Claude Code aborts an HTTP MCP call that sends no response or progress for 5 minutes. Setting `MCP_TOOL_TIMEOUT` alone does not lift that limit. The Claude adapter sets a per-server `timeout` of one day, which does. It also sets `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, because a shell that exports `CLAUDE_AUTO_BACKGROUND_TASKS` makes Claude background any call that runs past 2 minutes. `verify/claude-timeout-probe.ts` shows both behaviors against a real session.

## Memory

The office owns employee memory. Notes are Markdown files under `<data dir>/memory/`, never inside a project folder.

```
memory/
  employees/<employeeId>/<note id>.md   one employee's own notes
  blocks/<blockId>/<note id>.md         shared by everyone in the block
  alumni/<employeeId>/                  a fired employee's notes
```

A note has a title of at most 60 characters, written as a complete fact ("Release branch is release-teal"), and a body of at most 500. The note id is the slug of the title, so saving the same title again updates the note. An employee holds 25 notes and a block holds 40. A write over the limit fails and lists the titles, so the employee forgets or merges one first. A note that looks like a credential (an API key, a GitHub token, a private key header) is refused.

When a harness session starts, the persona carries the titles of the employee's notes and the block's notes, at most 4,200 characters. The digest is read once, so a note saved mid-session changes nothing until the next session. `recall` reads the files as they are now, which is how an employee sees a teammate's new block note. Every write goes through the main process, one at a time per folder, and lands with a temporary file and a rename.

Firing an employee moves their notes to `alumni/`. Notes of the block stay. Resetting the company deletes all notes.

## Verify

```sh
pnpm typecheck
pnpm build
node verify/mcp-check.ts
node verify/office-check.ts
node verify/cdp.mjs verify/e2e-real.mjs
node verify/cdp.mjs verify/e2e-memory.mjs
node verify/cdp.mjs verify/e2e-queue.mjs
node verify/cdp.mjs verify/e2e-long-wait.mjs
```

- `verify/mcp-check.ts` needs no model. It starts the MCP server, the inbox, and the memory store in a scratch folder, and drives them with an MCP client. It checks the Origin, Host, and token rules, `ask_owner` waiting, cancelling, and queueing, and the memory limits, secret refusal, block visibility, firing, and the digest size. It exits 1 on any failed check.
- `verify/office-check.ts` needs no model or Electron either. It runs the real `Office` with a scripted stand-in for a harness and checks what you would see: the cards, their order, where an employee goes back to after an answer or a cancel, and what firing and resetting do to sessions and notes.
- `verify/e2e-real.mjs` launches the built app against a scratch data folder and a scratch git repo, then does everything through the UI. It creates a block through the stubbed picker, hires a Claude Code employee, and gives it a task by typing. The employee walks over to ask, the script answers on the card, and then checks the file the agent wrote. It also checks the main log for `ask_owner` arriving over HTTP. A second task covers a shell permission card and a whiteboard diagram. Screenshots land in `/tmp/office-shots`.
- `verify/e2e-memory.mjs` tells an employee a fact, quits the app, deletes the employee's `sessionId`, starts the app again on the same data folder, and asks a question only the notes can answer.
- `verify/e2e-queue.mjs` makes two subagents ask permission at the same moment, and checks that the second card waits behind the first.
- `verify/e2e-long-wait.mjs` leaves the owner silent for 150 seconds before answering. Run it with `OFFICE_LONG_WAIT_S=330` to go past Claude Code's 5 minute default.

`pnpm build` rewrites `out/`, which is what `pnpm start` runs. If you use the beta while the tests run, build the tests to their own folder with `pnpm build:verify` and set `OFFICE_OUT_DIR=out/verify` when you run `verify/cdp.mjs`.

The end-to-end scripts run the app with `OFFICE_TEST_RUN=1`, so their window is never shown, has no Dock icon, and does not take focus. A window that did become visible would be titled "Online Office (automated test)" and carry a banner across the top, so nobody mistakes it for the office. To watch a run by eye, set `OFFICE_TEST_RUN=` to an empty value in the scenario's `env`. `node verify/screen-watch.mjs node verify/cdp.mjs verify/e2e-real.mjs` runs any command and fails if a process it started is ever the frontmost app or owns a window on screen (macOS, needs `swiftc`). All scripts use Haiku and take a few seconds of model time, except for the wait.
