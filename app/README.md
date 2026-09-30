# Online Office (beta)

A 3D office where you are the owner and each employee is a live coding-agent session on your machine. Employees work at their desks. When one needs a decision, it walks to you and asks out loud. Walk up to an employee and talk to give it work or to interrupt it.

## Run it

```sh
pnpm install
pnpm dev
```

An Electron window opens with the office. On first run, click **Choose a folder** and pick a project folder. That folder becomes a block, and its employees work inside it. Then click **Hire**.

`pnpm start` builds the app and runs it without the dev server.

To talk to employees on a Mac, start the app with `pnpm beta`. It builds, then opens `Electron.app` through `open`, so macOS asks about the microphone for Electron itself. When a terminal starts Electron (`pnpm dev`, `pnpm start`), that terminal is the app macOS asks about. A terminal that cannot show the permission dialog, such as the one inside T3 Code, VS Code or Cursor, makes macOS hand the app silence, and the HUD says so. The app's console output goes to `~/Library/Logs/Online Office/beta.log`. Quit a copy that `pnpm dev` started first, because a second instance hands over to the first and quits.

| Variable | Default | Effect |
| --- | --- | --- |
| `OFFICE_START_LEVEL` | `1` | Level (and seat count) of a freshly created company. |
| `OFFICE_CLAUDE_MODEL` | `claude-sonnet-5-5` | Model a new Claude Code employee starts on when nobody picks one. An employee keeps the model it was hired with. Use `claude-haiku-4-5-20251001` for cheap runs. |
| `OFFICE_BASH=allow` | unset | Skip asking the owner before shell commands. |
| `OFFICE_DEBUG=1` | unset | Log MCP tool calls, each Claude session start with its memory digest, owner answers, and every message from the window. |
| `OFFICE_DATA_DIR` | Electron `userData` | Where the company, the memory notes, and the app profile live. Tests point it at a scratch folder. |
| `OFFICE_TEST_PICK_FOLDER` | unset | Tests only. The folder picker returns this path instead of opening. |
| `OFFICE_TEST_AUDIO` | unset | Tests only, with `OFFICE_TEST_RUN`. Chromium plays this 16 kHz mono WAV as the microphone. Without it a test run gets Chromium's own beep, so a test never opens the real microphone or makes macOS ask for it. |
| `OFFICE_TEST_RUN` | unset | Tests only. The window is never shown, the Dock icon is hidden, and the page shows an "Automated test" banner. `verify/cdp.mjs` sets it. |
| `OFFICE_CDP_PORT` | `9333` | Tests only. The DevTools port `verify/cdp.mjs` uses. Give each worktree its own when tests run in parallel. |
| `OFFICE_OUT_DIR` | `out` | Tests only. The build folder `verify/cdp.mjs` launches. |
| `OFFICE_LONG_WAIT_S` | `150` | Tests only. How long `verify/e2e-long-wait.mjs` leaves the owner silent. |

## Install and updates

Download `Online-Office-<version>-arm64.dmg` from the [latest release](https://github.com/FelipeGazapina/online-office/releases/latest) and drag Online Office to Applications. It needs an Apple Silicon Mac. Open it from Applications, not from the disk image, because an app that runs from the image cannot replace itself.

The build is signed ad hoc and not notarized, because the repo has no Apple Developer identity, so macOS blocks the first open. Open System Settings > Privacy & Security, scroll to Security, and click **Open Anyway** next to Online Office. You do this once.

After that, updates arrive in the app. It checks for a newer release when it starts and every hour. When one exists, a button appears at the top right of the office. Click it to download the update, quit, and reopen on the new version. Employees' sessions stop when the app restarts. In the follow and first-person cameras the mouse is captured, so press **C** to free it before you click. A failed update turns the button red. Click it to check again, which reads the release from scratch. The Settings window on the office computer has an **Updates** row that checks by hand. `pnpm dev` and `pnpm start` never show any of this, because only an installed Mac build can update itself.

**Releases.** Every push to `main` that touches `app/` or `.github/workflows/release.yml` publishes a release, and CI is the only thing that writes to GitHub Releases. The version is the `major.minor` in `app/package.json` plus the number of commits on `main`, so it follows the commit and a re-run of the same commit never makes a second release. Change `major.minor` to start a new line. The `version` in `package.json` is only the placeholder for local builds. The workflow unzips the build before it publishes and checks the signature, the bundle version, and that `latest-mac.yml` names the same version and the zip's sha512. `pnpm package` builds into `dist/` and never publishes.

To prove the whole path on this machine, run `pnpm build` and then `node verify/e2e-update.mjs`. See Verify below.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows, Shift | Walk, run |
| 1 / 2 / 3 | Camera: follow, overview, first person |
| Enter | Type to the nearest employee |
| V (hold) | Push-to-talk, in either mic mode. Releasing sends what you said, and pressing it stops an employee who is talking |
| H | Key help |

When you sit at the owner's desk and press **F**, Online Office becomes a live, click-through mirror of the Mac desktop. Safari, Slack, Finder, Terminal, and every other native app stay real: mouse clicks and keyboard input reach the Mac underneath the mirror. If the office is in native macOS fullscreen, the portal temporarily leaves that separate Space, fills the current desktop by maximizing in place, and restores fullscreen when you stand up. Press **F** again (or **⌘⇧O** after a native app takes focus) to return to the office. macOS may ask for Screen Recording access the first time.

Click an employee, on the avatar or the name tag, for a menu with **Open chat** and **Go to**. In the Overview camera, click the floor to walk there and drag to turn the view. Click a whiteboard to enlarge it. Click **Reveal** on a block to open its folder in Finder.

The project computer's **Task boards** app has a CronoSpark credentials section. Enter `CRONOSPARK_MCP_API_KEY` as the API key and `CRONOSPARK_MCP_USER_ID` as the MCP user ID, then click **Save CronoSpark**. The key is kept in the app's private credentials file (encrypted with the macOS keychain when available), never in `company.json` or renderer storage. A key already supplied in the app's environment can be kept by leaving the API key field blank.

## How it works

- `src/shared/protocol.ts` is the contract. The main process owns logical state. The renderer derives every avatar from it: `blocked_on_owner` walks to the owner, anything else walks back to the desk.
- `src/main/` owns the company and the agent sessions, and talks to the renderer over IPC through the preload's `window.office`. Company state lives in `company.json` under the app's data folder.
- The office holds every question an employee asks you. `src/main/office/inbox.ts` keeps a first-in-first-out line per employee, so a harness that asks permission for two tools at once shows one card at a time. When the harness cancels a call, the card is withdrawn.
- Every employee reaches the office through one MCP server, whatever harness it runs on. Notes come from one store. Both are described below.
- Each Claude Code employee is one long-lived Agent SDK session that connects to the office MCP server over HTTP. Shell commands also become questions ("Can I run `npm test`?"). Claude's own auto memory is off.
- `src/main/office/adapters/types.ts` is the contract for a harness (`Harness`, `SessionHost`, `EmployeeSession`). Its comments say what each call must do, so an adapter can be written from that file alone.
- ChatGPT (Codex) and Hermes show in the hire menu when installed, but cannot be hired until their adapters land.
- Your voice is transcribed on this Mac by whisper.cpp, and it reaches an employee the way typed text does. The employees' voices use `speechSynthesis`. See Voice below.

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

## Models, permissions and sessions

Every employee carries the model its harness runs on, a permission policy (`{ mode, alwaysAllow }`) and the subagents running for it. `company.json` also holds the company settings. Those are the seat ceiling for the company's level, a default model for each provider, and the default mode for new hires, which is `inherit`. The window changes them with these messages, which `src/main/ipc.ts` validates.

| Message | Effect |
| --- | --- |
| `hire` with `model` | The new employee starts on that model. Without one, it starts on the company default for its provider, then on the harness default (`OFFICE_CLAUDE_MODEL` for Claude Code). |
| `set_model` | Changes the employee's model. A live session switches from its next turn. Claude refuses a model its bundled Claude Code does not describe, and the log says so. |
| `set_permissions` | Changes the employee's mode (`inherit`, `ask`, `auto` or `yolo`). |
| `answer` with `always` | On a permission card, adds an Always-allow rule for that employee. |
| `remove_allow_rule` | Removes one rule from the employee. |
| `load_models` | Asks a harness for its model list. Each snapshot carries a catalog per provider, either `unknown`, `loading`, `ready` or `error`. |
| `fresh_session` | Stops the employee's session, drops its open questions, clears its `sessionId` and starts a new session with no memory of the conversation. Notes, model and rules stay. |

Until the four modes map onto Claude Code's own permission modes (unit F1 in `docs/beta-plan.md`), a Claude Code employee runs in `acceptEdits` mode whatever its mode says.

### Always allow

An answer that allows a permission card can carry `always: true`. The office then adds a rule for that employee. It checks the employee's rules before it puts any permission card on the desk, so every harness behaves the same. A request that a rule covers is answered Allow at once, with no card, and the log names the rule.

- A shell command makes a `command` rule from its executable and its subcommand when it has one. `npm test -- --watch` gives `npm test`, and `git status --short` gives `git status`. A rule covers every command that starts with the same words.
- A program that can run any code or destroy data makes an `exact` rule instead, which covers only a command with the same words. `EXACT_ONLY` in `src/shared/permissions.ts` lists them. They are the shells and interpreters (`bash`, `node`, `python` and the like), wrappers such as `env`, `xargs` and `time`, and `find`, `rm`, `chmod` and other destructive programs. A path, upper case or a version number does not hide one, so `/bin/bash`, `NODE` and `python3.12` count. An exact rule for `rm -rf dist` does not cover `rm -rf ~`, and one for `bash -c 'x; y'` covers only that script.
- `sudo` and `doas` make no rule, not even an exact one, because they run the rest of the command as someone else. Always allow on them allows the command once.
- Any other tool makes a `tool` rule, which covers every use of that tool.
- A command that can chain, substitute or redirect never makes a rule, and no rule covers it, because a rule for `npm test` must not allow `npm test && curl example.com | sh`. That covers `; & | < > ( ) $`, backticks, backslashes and line breaks, except where quotes hold them as plain text. Single quotes hold all of them, and double quotes hold all but `$`, backticks and backslashes. Always allow on such a command allows it once.
- A harness sends a shell command as the tool `Bash` with the bare command in `detail`. `src/shared/permissions.ts` holds the rules and their matching, so the card can import them too.

### Subagents

A subagent that an employee starts is listed in `employee.subagents` while it runs, in start order, each with the id of its parent or `null`. The office never writes them to `company.json` and clears them when a session starts over.

The Claude adapter reports each `Agent` or `Task` tool call as a subagent, labelled with its description. It ends the subagent at the `task_notification` for that call. It does not end it at the tool result, because Claude runs subagents in the background by default and the tool result only says the subagent launched. A subagent can therefore run while its employee is idle.

## Company file

`company.json` migrates when the app loads it. A file from before models, permissions and settings gets each new field from one function, `migrate` in `src/main/office/company.ts`. Each employee gets the harness default model (`OFFICE_CLAUDE_MODEL` for Claude Code), the `inherit` mode and no rules, and the company gets settings with seats at the ceiling of its level. The app writes the migrated file back, and loading that file again writes the same bytes. `verify/fixtures/company-v1.json` is a real file from before the change.

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

## Voice

Install whisper.cpp once with `brew install whisper-cpp`.

- `src/main/voice/` runs `whisper-server` on `127.0.0.1`, on a random port and behind a random request path. It imports nothing from Electron, so `verify/voice-check.ts` runs it. It finds the binary on `PATH`, in the Homebrew folders, or through your login shell. Models live in `~/Library/Caches/online-office/whisper/` and download on first use, with resume and a SHA-256 check. The server runs under a shell that holds a pipe to the app, so it ends when the app dies, whatever killed the app, in about 0.4 s. Windows has no `sh`, so there a killed app leaves the server until the next launch kills it through the pid file in the app's data folder.
- **Voice: Fast** runs `small-q5_1` (190 MB, about 0.3 s an utterance). **Accurate** runs `large-v3-turbo-q5_0` (574 MB, about 1.4 s), and is best with a fixed language, because **Auto** makes whisper encode twice.
- The HUD chip shows one line for whatever is in the way: whisper is missing, a model is downloading, macOS denies the microphone, or the microphone is silent.
- The microphone is open only while you stand within 1.5 m of an employee. The renderer captures 16 kHz audio through an AudioWorklet into a 60 second ring. **Hold V** sends the slice from 0.2 s before the press to the release. **Proximity** mode cuts utterances with Silero, through `@ricky0123/vad-web`. Nothing is transcribed while an employee speaks, or for 0.4 s after.
- The page reads the worklet, the Silero model and onnxruntime-web through the `office-voice://assets` protocol, because `fetch` does not work on `file://`. `src/main/voice/assets.ts` serves only those five files, found by module resolution from the main bundle, so it does not matter which folder the app was started from.

## Verify

```sh
pnpm typecheck
pnpm build
node verify/nav-check.ts
node --no-warnings verify/walk-check.mjs
node --no-warnings verify/chat-check.mjs
node verify/voice-check.ts
node verify/voice-logic-check.ts
node verify/mcp-check.ts
node verify/office-check.ts
node verify/claude-check.ts
node verify/e2e-update.mjs
node verify/cdp.mjs verify/e2e-real.mjs
node verify/cdp.mjs verify/e2e-nav.mjs
node verify/cdp.mjs verify/e2e-contract.mjs
node verify/cdp.mjs verify/e2e-memory.mjs
node verify/cdp.mjs verify/e2e-queue.mjs
node verify/cdp.mjs verify/e2e-long-wait.mjs
node verify/cdp.mjs verify/e2e-voice.mjs
```

- `verify/nav-check.ts` needs no model or Electron. It builds the walkable grid for one, two and three blocks and checks every path against an independent oracle that samples the segments: a route from the owner's seat to a talk spot at every bench seat and at the head desk, a route to every exit, no segment inside an obstacle grown by the owner's radius, everything inside the walls, a goal in the middle of a desk snapping outside it, and a sealed pocket having no route. It also checks the bench itself: each person faces their own desk, the two seats of a pair face each other, the six desks are flush with no overlap, the head desk closes the east end, every desk and chair is on the rug, and no level's per-block seat ceiling exceeds the bench.
- `verify/walk-check.mjs` needs no model or Electron. It runs the real sim and store. It checks click walks that detour around desks, employees sitting facing their own desk whichever way it faces, steering keys winning over a walk, going to an employee and re-planning when they move, and employees routing around the meeting room: a new hire sits, a blocked employee arrives with the owner outside or inside, and a closed door keeps everyone at their desk until it opens.
- `verify/chat-check.mjs` needs no model or Electron. It checks that what the owner says and what an employee says land in that employee's transcript, in order, capped at 200 lines.
- `verify/voice-check.ts` runs the real whisper service against the real `whisper-server` and models, with clips made by `say`. It checks English and Portuguese, that requests wait their turn, downloads that resume, and that no server outlives the service. It needs macOS and whisper-cpp. `--offline` skips the one download from Hugging Face.
- `verify/voice-logic-check.ts` needs neither. It checks the ring buffer, the half-duplex gate, and the line the HUD chip shows for every state.
- `verify/mcp-check.ts` needs no model. It starts the MCP server, the inbox, and the memory store in a scratch folder, and drives them with an MCP client. It checks the Origin, Host, and token rules, `ask_owner` waiting, cancelling, and queueing, and the memory limits, secret refusal, block visibility, firing, and the digest size. It exits 1 on any failed check.
- `verify/office-check.ts` needs no model or Electron either. It runs the real `Office` with a scripted stand-in for a harness and checks what you would see: the cards, their order, where an employee goes back to after an answer or a cancel, and what firing and resetting do to sessions and notes. It also migrates `verify/fixtures/company-v1.json`, tables how a card becomes an Always-allow rule and what a rule covers, and checks each message in the table above, subagents, and that nothing ephemeral reaches the file.
- `verify/claude-check.ts` needs no model or network. It runs the real Claude adapter against a scripted stand-in for the Agent SDK's `query()`. It checks what the adapter starts the SDK with, the permission card bodies, how it delivers a model switch and a rule change, and how it reports subagents. The foreground, background and interrupted subagent streams follow what a real Haiku session sent with SDK 0.3.283. The nested one follows the SDK's documented shapes.
- `verify/e2e-update.mjs` needs no model. Run it by itself, not through `cdp.mjs`. It packages two versions of the app with this repo's build config under a test identity (`com.gazapina.onlineoffice.e2e`, `Online Office E2E`), installs the older one into a scratch folder, and serves the newer one from a local feed. It launches the installed app and drives the update button through CDP. A feed with a wrong sha512 must end in "Update failed. Check again". After the real feed comes back, checking again must reach the update, and one more click must download it, quit the app, and relaunch the bundle at the same path as the newer version, still signed and pinned to its bundle identifier. It packages twice, so it needs Apple Silicon, about 4 GB free and about three minutes, and it stops before the first build if less than 4 GB is free. It removes its builds, the updater and Squirrel caches, and the test profile on success and on failure. The relaunched app does not get the test environment, so its window opens for a moment until the script closes it.
- `verify/e2e-real.mjs` launches the built app against a scratch data folder and a scratch git repo, then does everything through the UI. It creates a block through the stubbed picker, hires a Claude Code employee, and gives it a task by typing. The employee walks over to ask, the script answers on the card, and then checks the file the agent wrote. It also checks the main log for `ask_owner` arriving over HTTP. A second task covers a shell permission card. A third makes the employee use its `Agent` tool once, and checks that the subagent shows on the employee while it runs, for as long as it runs, and is gone after, and that `company.json` never holds it. A whiteboard diagram closes the run. Screenshots land in `/tmp/office-shots`.
- `verify/e2e-nav.mjs` uses real mouse and key events only. In the Overview it clicks the floor across a desk and checks the owner arrives, drags to turn the view without walking, and cancels a walk with a key. It clicks an employee's avatar and name tag for the menu, closes it with Esc and with a click elsewhere, walks to the employee with "Go to", and opens the chat, sends a message and waits for the real reply. Screenshots of the marker, the menu and the chat land in `/tmp/office-shots`.
- `verify/e2e-contract.mjs` starts the app on the old-format company file and drives the messages above through the real IPC boundary with real Claude employees. It checks the migration, a refused bad mode, Always allow (an exact rule for a `node` command, with no card for the identical command and a card for a different one), `remove_allow_rule`, a live `set_model` (the next turn's `init` shows the new model), a refused model reported in the log, a `fresh_session` on a stale `sessionId`, and a background subagent that outlives the turn that launched it.
- `verify/e2e-memory.mjs` tells an employee a fact, quits the app, deletes the employee's `sessionId`, starts the app again on the same data folder, and asks a question only the notes can answer.
- `verify/e2e-queue.mjs` makes two subagents ask permission at the same moment, and checks that the second card waits behind the first.
- `verify/e2e-voice.mjs` plays clips made with `say` into the microphone through Chromium's fake capture device (`OFFICE_TEST_AUDIO`). A real Claude employee receives the right words in English and Portuguese, by hold-V and by proximity, and the script reads them from the main process, the employee's answer and the employee's own session log. It also checks that a clip played while an employee is talking never arrives (the same clip arrives when the employee is silent), that pressing V stops an employee who is talking, Voice: Accurate, Language: Auto, a microphone that only reads zeros, and every state of the HUD chip. It prints the time from releasing V to the text. It needs whisper-cpp, the models, and Portuguese and English macOS voices.
- `verify/e2e-long-wait.mjs` leaves the owner silent for 150 seconds before answering. Run it with `OFFICE_LONG_WAIT_S=330` to go past Claude Code's 5 minute default.

`pnpm build` rewrites `out/`, which is what `pnpm start` runs. If you use the beta while the tests run, build the tests to their own folder with `pnpm build:verify` and set `OFFICE_OUT_DIR=out/verify` when you run `verify/cdp.mjs`.

The end-to-end scripts run the app with `OFFICE_TEST_RUN=1`, so their window is never shown, has no Dock icon, and does not take focus. A window that did become visible would be titled "Online Office (automated test)" and carry a banner across the top, so nobody mistakes it for the office. To watch a run by eye, set `OFFICE_TEST_RUN=` to an empty value in the scenario's `env`. `node verify/screen-watch.mjs node verify/cdp.mjs verify/e2e-real.mjs` runs any command and fails if a process it started is ever the frontmost app or owns a window on screen (macOS, needs `swiftc`). All scripts use Haiku and take a few seconds of model time, except for the wait.
