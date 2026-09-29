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
| `OFFICE_DEBUG=1` | unset | Log Claude session events in the main process. |
| `OFFICE_DATA_DIR` | Electron `userData` | Where the company and the app profile live. Tests point it at a scratch folder. |
| `OFFICE_TEST_PICK_FOLDER` | unset | Tests only. The folder picker returns this path instead of opening. |

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows, Shift | Walk, run |
| 1 / 2 / 3 | Camera: follow, overview, first person |
| Enter | Type to the nearest employee |
| V (hold) | Push-to-talk, when mic mode is "Hold V" |
| H | Key help |

Click a name tag to open that employee's log. Click a whiteboard to enlarge it. Click **Reveal** on a block to open its folder in Finder.

## How it works

- `src/shared/protocol.ts` is the contract. The main process owns logical state. The renderer derives every avatar from it: `blocked_on_owner` walks to the owner, anything else walks back to the desk.
- `src/main/` owns the company and the agent sessions, and talks to the renderer over IPC through the preload's `window.office`. Company state lives in `company.json` under the app's data folder.
- Each Claude Code employee is one long-lived Agent SDK session with two in-process tools. `ask_owner` blocks until you answer. `draw_diagram` puts mermaid on the block whiteboard. Shell commands also become questions ("Can I run `npm test`?").
- ChatGPT (Codex) and Hermes show in the hire menu when installed, but cannot be hired until their adapters land.
- Voice input does not work yet: Electron has no speech recognition backend. Type with Enter for now. Voices use `speechSynthesis`.

## Verify

```sh
pnpm build
node verify/cdp.mjs verify/e2e-real.mjs
```

It launches the built app against a scratch data folder and a scratch git repo, then does everything through the UI. It creates a block through the stubbed picker, hires a Claude Code employee, and gives it a task by typing. The employee walks over to ask, the script answers on the card, and then checks the file the agent wrote. A second task covers a shell permission card and a whiteboard diagram. Screenshots land in `/tmp/office-shots`.
