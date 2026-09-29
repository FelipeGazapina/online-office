# Online Office (prototype v0)

A 3D office where you are the owner and each employee is a live coding-agent session. Employees work at their desks. When one needs a decision, it walks to you and asks out loud. Walk up to an employee and talk to give it work or to interrupt it.

This is a throwaway prototype. It exists to decide how the loop should feel, not to be the codebase.

## Run it

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173 in Chrome or Safari and allow the microphone. Press any key once so audio can play.

To try the feel without spending tokens, open http://localhost:5173/?demo=1. It uses a fake in-browser bridge.

The company starts at level 1 with one seat. To start bigger, set `OFFICE_START_LEVEL=3`.

| Variable | Default | Effect |
| --- | --- | --- |
| `OFFICE_START_LEVEL` | `1` | Level (and seat count) of a freshly seeded company. |
| `OFFICE_CLAUDE_MODEL` | `claude-sonnet-5-5` | Model for Claude Code employees. Use `claude-haiku-4-5-20251001` for cheap runs. |
| `OFFICE_BASH=allow` | unset | Skip asking the owner before shell commands. |
| `OFFICE_DEBUG=1` | unset | Log Claude session events in the bridge. |

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows, Shift | Walk, run |
| 1 / 2 / 3 | Camera: follow, overview, first person |
| Enter | Type to the nearest employee |
| V (hold) | Push-to-talk, when mic mode is "Hold V" |
| H | Key help |

Click a name tag to open that employee's log. Click a whiteboard to enlarge it.

## How it works

- `shared/protocol.ts` is the contract. The bridge owns logical state. The world derives every avatar from it: `blocked_on_owner` walks to the owner, anything else walks back to the desk.
- `bridge/` is a WebSocket server on port 4800. Each Claude Code employee is one long-lived Agent SDK session with two in-process tools. `ask_owner` blocks until you answer. `draw_diagram` puts mermaid on the block whiteboard. Shell commands also become questions ("Can I run `npm test`?").
- `world/` is React Three Fiber. Speech uses the browser Web Speech API for listening and `speechSynthesis` for voices.
- Codex, Cursor and Grok employees are simulated. Only Claude Code is a real agent today.
- Company state persists in `.office-data/company.json`. Each block works in `~/online-office/workspaces/<block>` unless you give it another folder.

## Verify

With `OFFICE_START_LEVEL=3 OFFICE_CLAUDE_MODEL=claude-haiku-4-5-20251001 pnpm dev` running:

```sh
node world/verify/cdp.mjs world/verify/e2e-real.mjs
```

It hires three employees through the HUD, walks up to the Claude one, and gives it a task by typing. When the employee walks over to ask, it answers on the card, then checks the file the agent wrote. Screenshots land in `/tmp/office-shots`. `bridge/smoke.ts` runs bridge-only scenarios.
