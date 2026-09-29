# R3. Employee memory across sessions

Research unit R3 for the beta. Written 2026-09-28. Versions checked: claude-mem 13.28.0 (`main` at `ade13f3`), Claude Agent SDK 0.3.283, codex-cli 0.158.0, Hermes v0.21.5.

The question was whether to use claude-mem so employees remember things between sessions, and whether the same works for ChatGPT (Codex).

## Answer

Do not install claude-mem. Build office-owned memory instead (option c). Each employee and each block gets a small set of notes that the office stores. Employees read and write them through `remember`, `recall` and `forget` MCP tools, and the office injects a short digest when a session starts. Turn each harness's own memory off for employees.

claude-mem does not earn its place here, for five reasons in order of weight.

1. **It does not cover our harnesses.** Its capture path is Claude Code hooks. Codex has a second hook file, but the maintainers' own plan says non-Claude adapters are unvalidated and lists a bug where their observations "are queued but never generate". Hermes has no adapter. The repo description says it works with Hermes. The source and the closed issue say otherwise. So "the same for ChatGPT" is not true today, and Hermes is out.
2. **It keys memory by folder name, not by employee.** The project key is the basename of the git root. Nothing in it can be per-employee, follow a fire and rehire, or move to another harness. Two blocks whose folders share a name would share memory.
3. **It makes extra model calls on every tool call.** A long-lived observer Claude session (Haiku 4.5 by default) reads each tool event. Unless you pick the hosted observer, it runs on the same Claude login the employees use.
4. **It adds a runtime.** Bun, uv, Python 3.13, Chroma and a daemon on `127.0.0.1:37701` on this Mac, installed by a command that writes into `~/.claude` and, when Codex is detected, `~/.codex`.
5. **It works against isolation.** The worker has no request authentication and returns every project's observations to any local process. Employees run shell commands.

What claude-mem does that nothing else here does is capture automatically, without the model deciding to save. Option (c) depends on the model calling `remember`. If the owner later wants an activity timeline, build it from the events the adapters already see instead of adopting the daemon.

The premise "Claude Code doesn't carry lots of memory" is half right. Claude employees already get two mechanisms. The Agent SDK resumes a session by id, and auto memory is on by default. Neither is owned by the office, and neither is per employee. Codex and Hermes have their own, different mechanisms. In the 13 v0 sessions in that workspace the auto memory directory stayed empty, so nothing had been saved.

## What I verified and what I did not

| Claim | How I know |
| --- | --- |
| Claude auto memory is active in office-style SDK sessions | Observed. The v0 transcripts contain a 12,860 character `# auto memory` section in the system prompt. |
| `autoMemoryDirectory` passed through the SDK `settings` option redirects it, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns it off | Observed with a probe (see the Claude Code section). |
| A local plugin passed in `plugins` fires `SessionStart` and `PostToolUse` hooks and injects context in a session with the office's options | Observed with a stand-in plugin. |
| The real claude-mem plugin does the same | Not tested. It needs `npx claude-mem install`, which writes to `~/.claude`, `~/.codex` and `~/.claude-mem`. I was told not to change those. |
| claude-mem behavior (model calls, storage, ports, privacy) | Read in source and docs. Not run. |
| Codex memories are on locally, and `-c features.memories=false` turns them off | Observed with `codex features list`. |
| A Codex fact saved in a short session is there at the next start | Not tested. The docs describe background generation that skips short sessions. |
| Hermes memory files, limits and per-profile scope | Observed locally and read in the Hermes source and docs. |
| Hermes ACP sessions load memory | Read in source (`acp_adapter/session.py` sets no memory override). Not run end to end. |

The scratch probe is at `/tmp/office-research/memory/probe.mjs`, with a stand-in plugin in `/tmp/office-research/memory/probe-plugin/`. I removed the one session transcript the probes wrote under `~/.claude/projects/`. Any Claude session also writes small runtime files under `~/.claude/session-env/` and `~/.claude/sessions/`, and I did not clean those. `~/.claude.json` has no entry for the probe directory.

## claude-mem

The repo is `thedotmack/claude-mem`. I confirmed the owner and name through the GitHub API. It has about 94,900 stars, and v13.28.0 was released on 2026-09-26. The repo is 505 MB, so I read files over the API instead of cloning.

### How it works

Claude Code runs seven hook entries from `plugin/hooks/hooks.json`. Each one runs `node bun-runner.js worker-service.cjs hook claude-code <event>`.

| Hook | What it does |
| --- | --- |
| `Setup` | Checks an install marker. It never installs anything. |
| `SessionStart` | Starts the worker, then calls `hook claude-code context` to inject memory. |
| `UserPromptSubmit` | Creates the session row and saves the prompt for full-text search. |
| `PreToolUse` (matcher `Read`) | Adds file context. |
| `PostToolUse` (matcher `*`) | Sends each tool call to the worker. The docs say it fires "100+ times" in a session. |
| `Stop` | Asks for a session summary. |
| `SessionEnd` | Marks the session complete. |

The worker is an Express server on `127.0.0.1`. It runs under Bun and serves the viewer UI, server-sent events and the search API. A stdio MCP server (`mcp-search`) proxies three tools to it, `search`, `timeline` and `get_observations`.

Storage is SQLite with FTS5 at `~/.claude-mem/claude-mem.db`. Settings live in `~/.claude-mem/settings.json`. A Chroma vector index is on by default (`CLAUDE_MEM_CHROMA_ENABLED: 'true'`, mode `local`, run through `uvx chroma-mcp`).

Compression works like this. The worker feeds each tool event into a long-lived observer conversation. `ClaudeProvider.ts` runs it as a Claude Agent SDK `query()` that resumes across prompts. The observer returns structured observations with a title, narrative, facts, files and concepts. `Stop` produces a summary.

Injection works like this. The `SessionStart` hook calls `/api/context/inject` on the worker and returns the result as `hookSpecificOutput.additionalContext`. The defaults are the 50 most recent observations drawn from 10 sessions, plus the last summary. The agent can pull more through the MCP tools. Per-prompt semantic injection exists but is off by default.

### Dependencies and ports

| Item | Detail |
| --- | --- |
| Runtimes | Node 20 or newer, Bun (auto-installed), uv (auto-installed), Python 3.13 through uv. SQLite is bundled. |
| Worker port | `37700 + (uid % 100)`. That is 37701 for uid 501 on this Mac. Override with `CLAUDE_MEM_WORKER_PORT`. |
| Chroma | Defaults to `127.0.0.1:8000`. Local mode starts `chroma-mcp` through `uvx`. |
| Install | `npx claude-mem install` or `/plugin install`. The README warns that `npm install -g claude-mem` installs the SDK only, with no hooks and no worker. |

### License

Apache-2.0. The `LICENSE` file is the Apache 2.0 text, the GitHub API reports `Apache-2.0`, and the README says the same. The project is open core. `docs/ip-boundary.md` reserves hosted cloud, team and org memory sync, and enterprise features outside the public repo. So team-shared memory is the paid part.

### Model calls and cost

The observer is a separate Claude Agent SDK subprocess. The defaults from `SettingsDefaultsManager.ts` are these.

| Setting | Default |
| --- | --- |
| `CLAUDE_MEM_PROVIDER` | `claude` |
| `CLAUDE_MEM_CLAUDE_AUTH_METHOD` | `subscription` (the logged-in Claude auth) |
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5-20251001` |
| `CLAUDE_MEM_TIER_SMART_MODEL` | `sonnet` |
| `CLAUDE_MEM_MAX_CONCURRENT_AGENTS` | `2` |
| `CLAUDE_MEM_SKIP_TOOLS` | `ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion` |

Every other tool call is sent to the observer. Cost scales with tool calls. I found no per-session figure in the repo or docs, so I have no measured dollar cost. The installer labels the default choice "Use your Anthropic Max Plan (no cloud sync, uses tokens for observations)". The README says its hosted observer runs "off-plan ... so you get up to 100% more usage from your plan". That is a vendor claim, but it implies the observer uses a large share of plan usage.

For the office this means the observer competes with the employees for the same Claude quota. With five employees working in parallel and at most two observer agents, observation would likely lag behind the work.

The alternatives are also model calls. Gemini and OpenRouter providers send tool inputs and outputs to those services. The hosted observer sends them to `cmem.ai` (`CMEM_PRO_BASE_URL`, model `cmem-observer`). The installer prompt defaults to that hosted choice in interactive installs, while headless installs default to `claude`.

### Privacy

- The observer sees everything an employee reads, runs and gets back, including file contents and command output.
- The worker has no request authentication. The docs say "the loopback bind is its only defence." `GET /api/observations` returns full bodies "for every project on the box". `GET /api/settings` returns the provider API keys, and `POST /api/settings` is unauthenticated. Any process that can make a local HTTP request, including a shell command an employee runs, can read every block's memory.
- Cloud sync is opt-in. The docs warn it "uploads your observation narratives and your full prompt text" to the sync hub.
- Telemetry is on by default (opt-out). It is anonymous. `telemetry.ts` lists the fields.
- The `<private>` tag strips content from storage, but only if the user or model writes the tag. `src/utils/tag-stripping.ts` implements it.

### Which harnesses it supports

The GitHub repo description says "Works with Claude Code, OpenClaw, Codex, Gemini, Hermes, Copilot, OpenCode + More". The README heading says "Persistent memory compression system built for Claude Code", and its footer says "Works with Claude Code". The docs introduction lists "Claude Code (or another supported IDE: Cursor, Windsurf, OpenCode, Codex CLI, Antigravity CLI, OpenClaw)".

The installer list in `src/npx-cli/commands/ide-detection.ts` is the source of truth. It has these entries, with the hint text from the source.

| Host | Hint in source | Capture |
| --- | --- | --- |
| Claude Code | recommended | Hooks |
| Codex CLI | native hooks integration | Hooks (`codex-hooks.json`) |
| Cursor, Antigravity | hooks + MCP integration | Hooks and MCP |
| OpenCode, OpenClaw | plugin-based integration | Plugin |
| Grok Bot | transcript watch + MCP integration | Log watcher |
| Copilot CLI, Goose, Roo Code, Warp | MCP-based integration | Search tools only |
| Windsurf | none | Hooks (from the installer name `WindsurfHooksInstaller.ts`) |

There is no Hermes entry and no Gemini CLI entry. A GitHub code search for "hermes" in the repo returns one file, `plans/23-host-integration-contracts.md`. It says "Net-new hosts (Hermes #2825, Goose #3329, ...) are tracked on the roadmap master #2785". Issue #2825 ("Add native Hermes Agent integration") was closed as `not_planned` and consolidated into #2785. The issue text says Hermes could reach claude-mem only through MCP and a hand-built bridge.

For Codex, plan 23 says of every non-Claude adapter that "None of them is checked against the host's real loader/hook/tool schema". It lists a Codex defect (`codex-hooks.json` emits a key Codex rejects). Issue #3585 says observations from non-Claude-Code platforms "are queued but never generate". It was closed and folded into the still-open plan-23 tracker, #3611. Its Codex transcript ingestion setting, `CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION`, defaults to `false`.

I could not test whether Codex hooks fire inside `codex app-server` threads. `codex features list` shows `hooks` as stable, so it may work. The installer defines paths in `~/.codex/AGENTS.md` and `~/.codex/config.toml`, so an install likely edits the owner's global Codex config.

### Attaching to Agent SDK sessions

The SDK `plugins` option is `{ type: 'local', path }`, and the docs say plugins can carry hooks. A user-scope `/plugin install` records the plugin in user settings, which `settingSources: ['project']` does not load, so I expect it would not reach employees. I did not test that with a real install. The office would have to pass the plugin path itself, and the claude-mem files must already be on disk from an install.

I tested the mechanism with a stand-in plugin in a session that uses the office's options (`settingSources: ['project']`, `strictMcpConfig`, the `claude_code` preset).

- The init message listed `probe-mem@inline` as loaded.
- A `SessionStart` hook returned `additionalContext` with a made-up codename, and the model repeated it.
- A `PostToolUse` hook received JSON with these keys: `cwd`, `duration_ms`, `hook_event_name`, `permission_mode`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `tool_response`, `tool_use_id`, `transcript_path`.

So the attach mechanism works. The payload also shows the identity problem. It carries a session id and a working directory, and no employee. claude-mem would attribute everything to the folder.

## Built-in memory in each harness

### Claude Code

The docs (`code.claude.com/docs/en/memory`) say auto memory is on by default and stores one directory per project at `~/.claude/projects/<project>/memory/`. `<project>` comes from the git repository, so "all worktrees and subdirectories within the same repo share one auto memory directory". A `MEMORY.md` index (first 200 lines or 25 KB) loads at every session start. Topic files load on demand. Claude writes them itself with the normal file tools.

The Agent SDK page lists auto memory as an input that `settingSources` does not control. It is "Loaded into the system prompt at session start" and can be disabled with `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. The same page warns against relying on default `query()` options for isolation because "an SDK process can pick up ... per-directory memory".

`sdk.d.ts` matches. It has `autoMemoryEnabled`, `autoMemoryDirectory` ("Ignored if set in projectSettings ... defaults to `~/.claude/projects/<sanitized-cwd>/memory/`"), `autoDreamEnabled`, and an `SDKMemoryRecallMessage` with scopes `personal`, `team` and `organization`. I did not exercise the recall message.

CLAUDE.md files load with `settingSources: ['project']`. That already works for the office and needs no change.

**What I observed.**

1. The v0 employee transcripts (in the `~/.claude/projects/` directory for the v0 workspace folder) contain the auto memory instructions in the prompt snapshot. They are 12,860 characters, about 3,200 tokens, in every Claude employee's system prompt. The memory directory those sessions created is empty.
2. A probe with no `systemPrompt` set got no auto memory. The model answered "NONE" when asked for a memory path. With `systemPrompt: { type: 'preset', preset: 'claude_code' }`, as the office sets it, auto memory is present. A custom string prompt would presumably drop it too.
3. With `settings: { autoMemoryDirectory: '<scratch dir>' }`, the model reported that scratch path as its memory directory. Asked to remember a fact, it wrote `team-processes.md` and `MEMORY.md` there in 4 turns (about $0.02 on Haiku 4.5). The `canUseTool` callback was never called for those writes under `permissionMode: 'acceptEdits'`, so the owner would not see a permission card.
4. A fresh session with the same directory answered "The team standup is at 09:40 and the release branch is named release-teal" with zero tool calls. The one-line `MEMORY.md` index entry was enough.
5. A fresh session with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and the same directory answered `UNKNOWN`.

**What it means for the office.** Native memory is keyed by repo. In the beta a block folder is the owner's real project folder, so every Claude employee in a block shares one memory directory with each other and with the owner's interactive sessions. On this Mac the owner's directory for one real project has 11 files. Those would flow into employees, and employees could overwrite them. That is the "leaking config" blocker again. It has a benefit, since employees would inherit the owner's stated preferences, but only for Claude.

### Codex

The docs (`developers.openai.com/codex/memories`, which redirects to `learn.chatgpt.com/docs/customization/memories`) say local memories are off by default and turn on with `[features] memories = true`. Codex converts eligible earlier chats into files under `~/.codex/memories/`. The docs say "Codex skips active or short-lived sessions, redacts secrets from generated memory fields, and updates memories in the background instead of immediately at the end of every chat." `memories.use_memories` controls injection and `memories.generate_memories` controls creation. The docs add "Keep required team guidance in `AGENTS.md` or checked-in documentation."

**What I observed.**

- `codex features list` shows `memories  stable  true`. `~/.codex/config.toml` has `[features] memories = true` and `[memories] disable_on_external_context = false`.
- `~/.codex/memories/` is one store for all projects. It holds `MEMORY.md` (276 KB), `memory_summary.md` (8 KB), `raw_memories.md` (349 KB), 89 `rollout_summaries/` files and a `skills/` directory. It is its own git repo. `memory_summary.md` opens with a "User Profile" section about the owner and their preferences across several projects.
- `codex -c features.memories=false features list` reports `memories  stable  false`. A per-process config override is enough to switch it off for an employee.

**What it means for the office.** A Codex employee would likely receive the owner's cross-project profile, though I did not test injection inside an app-server thread. Generation is asynchronous and skips short sessions, so beta item 6 ("save a fact, restart, get it back") is not guaranteed. The docs describe no way to scope memory to a block or an employee.

### Hermes

`hermes memory --help` says built-in memory (`MEMORY.md` and `USER.md`) "is always active" and that one external provider can run alongside it. `hermes memory status` on this Mac reports built-in memory injection, user profile and memory tool all enabled, and no external provider.

The source (`tools/memory_tool.py`) and docs agree. Both files sit in `<HERMES_HOME>/memories/`. They "enter the system prompt as a FROZEN snapshot at session start; mid-session writes hit disk but never change the prompt". The agent manages them with one `memory` tool (add, replace, remove). Default limits are 2,200 and 1,375 characters, and this machine's config raises the first to 6,400. "Memory does not auto-compact: when a write would exceed the limit, the `memory` tool returns an error instead of silently dropping entries." The agent gets a nudge every 10 user turns (`nudge_interval`). The docs say memory is scoped per profile. `hermes profile` and `HERMES_HOME` give each employee an isolated store.

The ACP adapter builds its `AIAgent` from config and passes no memory override, so ACP sessions should load memory as configured. I did not run one.

Hermes is the closest of the three to what the office needs. It is small, bounded, frozen per session, per profile and error-on-overflow. Option (c) copies that design.

## Options

| | (a) claude-mem | (b) Each harness's memory | (c) Office-owned | (d) Mix of (b) and (c) |
| --- | --- | --- | --- | --- |
| Works across harnesses | Claude yes. Codex partial and unvalidated. Hermes no. | Three mechanisms with three scopes | Identical | Two mechanisms |
| Extra cost | One observer call per tool call, on the employees' own Claude quota | Codex consolidation in the background. Claude adds about 3,200 tokens of instructions per session. | None. About 1,000 to 1,500 tokens of digest per session. | Both costs |
| Setup burden | High. Bun, uv, Python, Chroma, a daemon and a global install. | Low. It is already on. | Medium. One store, three tools, one injection point per adapter. U1 already plans the MCP server. | Medium plus configuration of each native store |
| Privacy | Observer sees all tool I/O. The worker has no auth and lists every project. Hosted and cloud options upload data. | Leaks the owner's Codex profile and Claude project notes into employees. Files sit in three home directories. | Files in app data, outside the repo. The owner can read and delete them. Nothing leaves the machine except inside prompts. | Same leaks as (b) unless switched off |
| Fired and rehired | Keyed by folder, so there is no employee to fire | Dies with the harness identity. Claude memory is shared by every employee in the repo. | Keyed by employee id and block id. Survives a harness swap and a moved folder. | Partly |
| Verdict | Reject | Reject as the design | Recommend | Reject |

Option (b) fails its own goal. Turning native memory off to stop the leaks leaves nothing, and leaving it on gives three mechanisms with three scopes and three timings, so no single check covers them. Option (d) keeps two sources of truth for one employee and inherits every leak in (b).

One exception is worth keeping in reserve. If `remember` proves weaker than Claude's own memory prompts, the office can point `autoMemoryDirectory` at an office-owned per-employee directory. I observed that this works. Use it only as a fallback for Claude, because it does not help Codex or Hermes.

The honest weakness of (c) is that the model must decide to save. The v0 sessions saved nothing. A direct "remember this" worked at once in the probe. The persona has to say when to save, and the acceptance check below has to prove it per harness. Claude's own memory prompt has good rules to reuse, because the v0 transcripts contain them. It says what not to save (anything derivable from code or git, and task-in-progress state), and it says to verify a remembered fact before acting on it.

## Design sketch for option (c)

### Data shape

```ts
type NoteId = string & { readonly __brand: 'NoteId' }; // slug of the title, stable

type MemoryScope =
  | { kind: 'employee'; employeeId: EmployeeId }
  | { kind: 'block'; blockId: BlockId };

type Note = {
  id: NoteId;
  title: string;    // 60 characters at most, written as a complete fact
  body: string;     // 500 characters at most, read through recall
  author: { employeeId: EmployeeId; provider: Provider };
  createdAt: number; // ms, like Employee.hiredAt
  updatedAt: number;
};
```

The digest shows titles only, so a title must state the fact, as in "Release branch is release-teal". There is no `kind` field and no `pinned` flag. Rules that must always apply belong in the repo's `CLAUDE.md` or `AGENTS.md`, which Claude and Codex already load. Add a field only when a real need shows up.

### Files on disk

Everything lives under Electron's `userData` directory, never in the block folder. The block folder is the owner's real project, and a memory directory there would end up in commits.

```
<userData>/memory/
  employees/<employeeId>/<noteId>.md
  blocks/<blockId>/<noteId>.md
  alumni/<employeeId>/<noteId>.md      # a fired employee's notes move here
```

One Markdown file per note, with frontmatter that mirrors the fields above. That copies the shape Claude writes itself (`name`, `description`, `modified`), so owners can read and edit notes in Finder.

```
---
id: release-branch
title: Release branch is release-teal
author: { employeeId: emp_ana, provider: claude-code }
createdAt: 1790644491683
updatedAt: 1790644491683
---
Cut releases from release-teal, not main. Tag each release vYYYY.MM.DD.
```

### Tools

The office MCP server (U1) exposes three tools. The beta plan lists `remember` for U1 already. This adds `recall` and `forget`. The endpoint is per employee, for example `/mcp/<employeeToken>`, so the server knows the caller. Do not infer identity from the working directory or session id, as the hook payload above shows.

| Tool | Input | Behavior |
| --- | --- | --- |
| `remember` | `scope: 'me' \| 'block'`, `title`, `body` | Upserts by `slug(title)`, so calling it twice is safe. Returns `{ ok, id, used, cap }`. When a cap or length limit would be exceeded it returns `{ ok: false, reason, titles }` and the agent must forget or merge first. It also rejects text that looks like a secret (`sk-`, `ghp_`, private key headers). |
| `recall` | `query?`, `scope?: 'me' \| 'block' \| 'both'` | Keyword match over title and body, titles weighted higher. Returns at most 5 full notes. With no query it lists titles. No model call, no embeddings. |
| `forget` | `scope`, `id` | Deletes the file. |

### Injection

The office builds the digest when it starts a harness process or thread, and appends it to whatever instruction channel that adapter already uses. For Claude that is `systemPrompt.append`, next to the persona. On a resumed Claude session the earlier digest is already in the history. I did not test whether the appended prompt is re-applied on resume, and it matters little because `recall` reads live files. For Codex and Hermes the channel is a finding for R1 and R2. If a harness has no system-prompt field, prepend the digest to the first prompt.

```
What you remember (call recall for details)

About you
- The owner wants a short plan before any refactor

About the client-apps team
- Release branch is release-teal
- Standup is at 09:40
```

Each line is `- title`. The digest is frozen for the session, as in Hermes, so mid-session writes never change the prompt and the prompt cache stays intact. `recall` reads live files, which is how an employee sees a teammate's new block note mid-task.

The persona needs four short rules, taken from the parts of Claude's own memory prompt that the v0 transcripts show working. Save when the owner states a preference or a decision, or when you learn a non-obvious fact that would cost the next person time. Write each title as a complete fact. Never save what the code or git history already shows, or the state of a task in progress. Check a remembered fact against the current code before acting on it.

### Limits

| Limit | Employee | Block |
| --- | --- | --- |
| Notes | 25 | 40 |
| Digest size (derived) | 1,600 characters at most | 2,600 characters at most |
| Title / body | 60 / 500 characters | 60 / 500 characters |

A digest line is at most 63 characters (`- ` plus a 60 character title plus a newline). The note caps are sized so that every title always fits, which removes any ordering or truncation logic. The two digests total at most 4,200 characters, about 1,000 to 1,500 tokens. Writes over a cap fail with an error and do not evict silently. Hermes documents the same behavior. Compare that with today's Claude employees, who carry 12,860 characters of auto memory instructions before any memory loads.

### Employee memory versus block memory

| | Employee | Block |
| --- | --- | --- |
| Key | `EmployeeId` | `BlockId` |
| Holds | How this person works with the owner, lessons from their own tasks, preferences the owner told them | Facts a newcomer needs, such as decisions, gotchas, commands and constraints |
| Read by | That employee only | Every employee in the block, at session start |
| Written by | That employee (`scope: 'me'`) and the owner | Any employee in the block (`scope: 'block'`) and the owner |
| Fired | Moves to `alumni/` | Untouched |
| Folder moved or renamed | No effect | No effect |

Employee directories are never shared, so those writes need no coordination. Block memory has several writers, and the office main process is the one real writer. Every `remember` call reaches the store through the MCP server in main. The store takes a per-scope mutex and writes each file to a temp name and renames it, as `company.ts` already does for its state. On startup it deletes leftover temp files. Instructions to the model are not what keeps writers apart.

### Firing and rehiring

A fire moves `employees/<id>/` to `alumni/<id>/` and leaves the block's notes alone. That is reversible, and the files are small. Rehiring from the alumni list moves the directory back. The rehired employee can run on a different harness, because the notes are plain files. Hiring someone new starts with an empty personal memory and inherits the block's. A session id cannot carry memory across a folder move, because Claude stores sessions per directory (see the comment in `company.ts`). Notes keyed by id survive the move.

Two product calls for the owner. Should fire mean archive (recommended) or forget? Should `reset_company` wipe the memory directory? It matches the existing reset, but confirm.

### Turning off native memory

| Harness | Switch | Status |
| --- | --- | --- |
| Claude Code | `env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }` on `query()` | Observed. |
| Claude Code | `settings: { autoMemoryEnabled: false }` | Documented, not tested. |
| Codex | `-c features.memories=false` (the docs also list `memories.use_memories` and `memories.generate_memories`) | Observed that the effective state flips. Not tested inside an app-server thread. |
| Hermes | A per-employee `HERMES_HOME`, or `memory.memory_enabled: false` and `user_profile_enabled: false` | Read in source and docs. Not tested. |

Disabling Claude's auto memory also removes the 12,860 characters of instructions from each Claude session.

### Acceptance check for beta item 6

One script per harness, run against the real app, using the same steps for all three.

1. Hire the employee into a block that points at a scratch git repo.
2. Assign "Use the remember tool with scope block. Title: Release branch is release-teal. Body: Tag each release vYYYY.MM.DD."
3. Assert that the note file exists with that content. Read the file, not the model's reply.
4. Quit the app. Relaunch it. Clear the employee's `sessionId` so the next session is fresh.
5. Assign "Which branch do we cut releases from? Answer with the branch name only." Assert the reply contains `release-teal`. Only the digest can supply this.
6. Assign "What tag format do releases use? Answer with the format only." Assert the reply contains `vYYYY.MM.DD`. Only a `recall` call can supply this, because the digest holds titles only.

## Risks and open questions

- The model may not call `remember` unprompted. Mitigate with a persona rule and the acceptance check. Watch this in real use before adding an automatic end-of-task prompt, which costs a turn.
- Codex and Hermes must accept a custom instruction channel and an HTTP MCP endpoint with a per-employee URL. R1 and R2 own those answers. `remember` and `recall` return instantly, so the `ask_owner` timeout blocker does not apply to them.
- Whether Hermes ACP sessions honor the memory switches needs one real run before U3.
- Whether Claude employees should inherit the owner's interactive project memory is a product call. This design says no.
- I did not run claude-mem. The rejection rests on structure (coverage, keying, model calls, runtime, worker authentication), which does not depend on a run.
- If the owner later wants a searchable timeline of what employees did, the adapters already emit every tool event. A small summarizer over those events costs less to own than claude-mem's daemon.

## Sources

I read every URL below during this research. Local files and command output are listed after the web sources.

**claude-mem** (repo `main` at `ade13f3`, 2026-09-28)

- https://github.com/thedotmack/claude-mem
- https://docs.claude-mem.ai/
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/introduction.mdx
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/README.md
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/LICENSE
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/NOTICE
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/license.md
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/ip-boundary.md
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/architecture/overview.mdx
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/configuration.mdx
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cloud-sync.mdx
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/plugin/hooks/hooks.json
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/plugin/hooks/codex-hooks.json
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/plugin/.claude-plugin/plugin.json
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/plugin/.codex-plugin/plugin.json
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/plugin/.mcp.json
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/src/shared/SettingsDefaultsManager.ts
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/src/services/worker/ClaudeProvider.ts
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/src/cli/handlers/context.ts
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/src/utils/project-name.ts
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/src/utils/tag-stripping.ts
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/src/npx-cli/commands/ide-detection.ts
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/src/npx-cli/commands/telemetry.ts
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/src/npx-cli/cmem-pro-costs.ts
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/src/services/integrations/CodexCliInstaller.ts
- https://raw.githubusercontent.com/thedotmack/claude-mem/main/plans/23-host-integration-contracts.md
- GitHub API for `thedotmack/claude-mem`, its latest release and `main` commit, issues 2785, 2825, 3585 and 3611, and code search for "hermes" (queried with `gh api`)

**Claude Code and Agent SDK**

- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/agent-sdk/claude-code-features
- https://code.claude.com/docs/en/agent-sdk/plugins

**Codex**

- https://developers.openai.com/codex/memories (redirects to the next URL)
- https://learn.chatgpt.com/docs/customization/memories?surface=app

**Hermes**

- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory

**Local evidence**

- `app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.283_.../sdk.d.ts` (options `settingSources`, `settings`, `plugins`, `persistSession`, `autoMemoryEnabled`, `autoMemoryDirectory`, `SDKMemoryRecallMessage`)
- `app/src/main/office/adapters/claude.ts` (office SDK options) and `app/src/shared/protocol.ts` (`Employee`, `ProjectBlock`, `ClientMessage`)
- v0 employee transcripts and the empty memory directory under `~/.claude/projects/` for the v0 workspace (read only)
- `codex --version`, `codex features list`, `codex -c features.memories=false features list`, and `~/.codex/config.toml` and the `~/.codex/memories/` listing (read only)
- `hermes --version`, `hermes memory --help`, `hermes memory status`, `hermes profile --help`, the `memory` block of `~/.hermes/config.yaml`, `~/.hermes/hermes-agent/tools/memory_tool.py`, `cli-config.yaml.example` and `acp_adapter/session.py` (read only)
- Probe results from `/tmp/office-research/memory/probe.mjs` (scratch, not in the repo)
