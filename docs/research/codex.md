# R1. Driving Codex CLI from the Electron main process

Research unit R1 for the beta. Written 2026-09-29 by resuming a cut-off attempt. Versions checked: codex-cli 0.158.0 (`/Users/feliperico/.local/bin/codex`, a Node wrapper around a native binary), Node 26.7.0, macOS 26.6.2 arm64, ChatGPT login (plan `prolite`), `@modelcontextprotocol/sdk` 1.31.

The question was whether each employee can be a real Codex session driven from our Electron main process, and how interrupt, approvals, MCP timeouts, isolation and resume behave.

## Answer

Drive `codex app-server` over stdio. It speaks newline-delimited JSON-RPC (without the `"jsonrpc"` field). One process can host many employee threads, and every thread event carries a `threadId`. The protocol source of truth is `codex app-server generate-ts --experimental --out <dir>`, which produced 102 top-level entries and 772 `v2` type files in this run.

The default model is `gpt-6-astra` (medium reasoning effort). That is what `model/list` marks `isDefault` and what `thread/start` returns when you pass no model. The owner's own `~/.codex/config.toml` overrides it to `gpt-5.6-sol` at `xhigh`, so an unisolated employee would not get the default. The cheapest fast model that worked is `gpt-6-luna` ("Fast and affordable model for easier tasks") with `effort: "low"` on each turn.

Eight findings change the plan.

1. **The MCP tool timeout is 300 seconds by default, not 60.** The same 330 second call fails at 300005 ms with the default and succeeds with `tool_timeout_sec=900`. The beta plan's "Codex may time out `ask_owner`" blocker is real only past 5 minutes, and one config key fixes it.
2. **MCP tool calls fail under `approvalPolicy: "never"`** unless the server sets `default_tools_approval_mode="approve"`. Without it the call errors with "MCP tool call requires approval, but approval policy is never".
3. **Interrupt is instant but does not kill the running command.** `turn/interrupt` completes the turn as `interrupted` in about 5 ms, and the `sleep` keeps running. `thread/backgroundTerminals/terminate` kills it.
4. **Interjecting has three real paths.** `turn/steer` injects into the running turn. A second `turn/start` on a running turn does the same. `thread/queue/add` runs after the turn ends.
5. **`approvalPolicy: "untrusted"` with `sandbox: "workspace-write"` gives the requested behavior.** Every shell command asks the owner. Every patch asks too, and our client auto-accepts patches whose paths are inside the block folder.
6. **A clean `CODEX_HOME` alone is not isolation.** You also need `--disable apps --disable plugins --disable remote_plugin`, and an empty `HOME` to hide `~/.agents/skills`. The owner's config would otherwise hand employees `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`.
7. **Resume works across a hard kill, with three traps.** The sandbox is not restored (a `read-only` thread came back `workspace-write`), per-thread MCP `config` is not restored, and a thread that never ran a turn cannot be resumed.
8. **Codex has a built-in memories feature and it is off by default in a clean home.** The owner's config turns it on. Keep it off with `-c features.memories=false`.

## What I verified and what I did not

Scratch work lives in `/tmp/office-research/codex/`. Log names below are files in `/tmp/office-research/codex/logs/`. Files starting `r1-` come from this run. Files starting `p` come from the cut-off attempt and are cited only where I read the log itself in this run. I never started Codex against the real `~/.codex`. I only read its `config.toml` (names and plain settings), the file listing of its `memories/` folder, and the metadata of `auth.json`.

| Claim | How I know |
| --- | --- |
| Handshake, thread start, turn start, event shapes, turn summary | Observed. `r1-shapes.out`, `r1-shapes.jsonl`. |
| Persona through `developerInstructions`, `cwd`, `model` per thread | Observed. Reply ended with the requested signature `-- Ada` (`r1-shapes.out`). |
| Default model | Observed. `r1-models.out`, `r1-defaults.out`. |
| Interrupt mid-command, process survival, terminate | Observed. `r1-interrupt.out`, `r1-interrupt-noterm.out`, `r1-interrupt-nounified.out`. |
| Steer, start-while-running, queue | Observed. `p10-steer.out`, `p10-startwhile.out` (earlier attempt), `r1-steer-dyn.out`, `r1-queue.out`. |
| Approval matrix across policies and sandboxes | Observed in the earlier attempt (`p8-*.out`, `p9-*.out`), and re-observed for `untrusted` with `workspace-write` (`r1-approvals-instant.out`, `r1-approvals-wait.out`). |
| MCP over HTTP, timeout default and override, identity | Observed. `r1-mcp-*.out`, `r1-mcp-thread.out`, `mcp-http.jsonl`. |
| MCP over stdio | Observed. `r1-mcp-stdio.out`. |
| Client-hosted tools (`dynamicTools`) | Observed. `r1-dyntool.out`, `r1-dyntool-330.out`, `r1-tools-resume.out`. |
| Isolation recipe and leak inventory | Observed on a sanitized copy of the owner's config. `r1-iso-*.out`, `r1-agents-*.out`. |
| ChatGPT login through a symlinked `auth.json` | Observed. Every turn ran on it. Token refresh through the symlink was not triggered, so it is untested. |
| Resume after SIGKILL | Observed. `r1-resume.out`, `r1-resume-policy.out`, `r1-tools-resume.out`. |
| Memories feature | Config and switch observed (`r1-memory-off.out`). The background pipeline did not finish in my window (`r1-memory.out`). |
| `experimentalApi: true` is required for `dynamicTools` | Not tested. I always sent it. |
| `baseInstructions`, `acceptForSession`, `acceptWithExecpolicyAmendment`, sandbox `writableRoots` and network settings | Read in the schema only. Not run. |
| More than two concurrent threads in one process | Not tested. Two ran together (`r1-mcp-thread.out`). |
| Linux and Windows | Not tested. |

The earlier attempt left an MCP test server running on port 47831 (pid 72401). I stopped it. Its approval probes had `touch`ed files in `$HOME`, and none were left when I looked.

## 1. Handshake and turns

### Calls

All frames are one JSON object per line. Requests carry a numeric `id`. Notifications have no `id`. Server requests (approvals, tool calls) arrive with a numeric `id` starting at 0, and we answer with `{ id, result }`.

1. Spawn `codex app-server`. Send `initialize` with `{ clientInfo: { name, title: null, version }, capabilities: { experimentalApi: true, requestAttestation: false } }`. The result is `{ userAgent, codexHome, platformFamily, platformOs }`. Then send the notification `initialized`.
2. Send `thread/start`. The result has `thread` (`id`, `path`, `cwd`, `model`, `status`, and more), plus `model`, `modelProvider`, `cwd`, `approvalPolicy`, `sandbox`, `reasoningEffort` and `instructionSources`.
3. Send `turn/start` with `{ threadId, input: [{ type: "text", text, text_elements: [] }], effort? }`. The result is `{ turn: { id, status: "inProgress", items: [], ... } }` about 14 ms later. Events follow.

`thread/start` does not validate the model. A bad model name fails at the first turn instead, with an `error` notification (`willRetry: false`) and then `turn/completed` with `status: "failed"` and `turn.error.message` (`r1-failed-turn.jsonl`).

### Per-thread settings

| Setting | Where | Observed |
| --- | --- | --- |
| Working folder | `thread/start.cwd` (also `turn/start.cwd` for later turns) | `commandExecution.cwd` and patch paths use it. |
| Model | `thread/start.model`, override per turn with `turn/start.model` | `gpt-6-luna` ran. Reasoning effort is `turn/start.effort` (`low` to `ultra`). |
| Persona | `thread/start.developerInstructions` | Applied. The reply ended with `-- Ada`. |
| Approval and sandbox | `thread/start.approvalPolicy`, `thread/start.sandbox` | See section 3. |
| Extra config | `thread/start.config` (a map of config keys) | Used for per-employee MCP servers. See section 4. |
| Client-hosted tools | `thread/start.dynamicTools` | See section 4. |

Codex also loads `AGENTS.md` from the working folder. A marker line in a folder-level `AGENTS.md` showed up in the reply on both a clean and a copied home (`r1-agents-retry.out`).

### Events

The stream for a turn that edits a file and runs a command (`r1-shapes.out`), in arrival order.

| Notification | Shape (key fields) | Notes |
| --- | --- | --- |
| `thread/status/changed` | `{ threadId, status: { type: "active" \| "idle", activeFlags } }` | Use it as the busy flag. |
| `turn/started` | `{ threadId, turn: { id, status: "inProgress", startedAt } }` | |
| `item/started`, `item/completed` | `{ item, threadId, turnId, startedAtMs \| completedAtMs }` | `item.type` picks the payload, below. |
| `item/agentMessage/delta` | `{ threadId, turnId, itemId, delta }` | Streaming text. 44 deltas for one short message. |
| `turn/diff/updated` | `{ threadId, turnId, diff }` | Aggregated unified diff of the turn so far. |
| `thread/tokenUsage/updated` | `{ threadId, turnId, tokenUsage: { total, last } }` | Each has `totalTokens`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`. Also `modelContextWindow` (258400). |
| `account/rateLimits/updated` | `{ rateLimits: { primary: { usedPercent, windowDurationMins, resetsAt }, planType } }` | The plan window was weekly and 17 percent used. |
| `turn/completed` | `{ threadId, turn }` | See "Turn finish". |

Item payloads.

| `item.type` | Fields |
| --- | --- |
| `userMessage` | `content: [{ type: "text", text }]` |
| `reasoning` | `summary: []`, `content: []`. Empty in every run. |
| `agentMessage` | `text`, `phase` (`"commentary"` while it works, `"final_answer"` at the end), `memoryCitation` (always null) |
| `fileChange` | `changes: [{ path, kind: { type: "add" \| ... }, diff }]`, `status` |
| `commandExecution` | `command` (`"/bin/zsh -lc ls"`), `cwd`, `processId`, `source`, `status`, `commandActions`, `aggregatedOutput`, `exitCode`, `durationMs` |
| `mcpToolCall` | `server`, `tool`, `arguments`, `status`, `result`, `error`, `durationMs` |
| `dynamicToolCall` | `namespace`, `tool`, `arguments`, `status`, `contentItems`, `success`, `durationMs` |

The schema also lists `item/commandExecution/outputDelta`. I never saw it. My commands were short, so output arrived only in `aggregatedOutput` on `item/completed`. MCP servers announce readiness with `mcpServer/startupStatus/updated { threadId, name, status: "starting" \| "ready" }`. Wait for `ready` before the first turn if a tool must exist.

### Turn finish

`turn/completed` is the only reliable end signal.

```json
{"threadId":"01a0eb7e-e504-…","turn":{"id":"01a0eb7e-e5a7-…","items":[{"type":"agentMessage","text":"Created `hello.txt` containing `hi`.\n\n`ls` shows: …\n\n-- Ada","phase":"final_answer","memoryCitation":null}],"itemsView":"summary","status":"completed","error":null,"startedAt":1790657357,"completedAt":1790657377,"durationMs":20454}}
```

`status` is `completed`, `interrupted` or `failed`. `error` is set only for `failed`. `items` holds only the final `agentMessage` (`itemsView: "summary"`), so collect `item/completed` events for the full record. `thread/read` with `includeTurns: true` works but Codex now emits a `deprecationNotice` for it. Page history with `thread/turns/list` and `thread/items/list` instead.

## 2. Interrupting and interjecting

### Interrupt mid-command

`turn/interrupt { threadId, turnId }` (`r1-interrupt.out`, task `sleep 139`).

- The response is `{}` after 4 ms. `turn/completed` with `status: "interrupted"` arrives in the same millisecond, and the thread goes `idle`.
- The interrupted `commandExecution` gets an `item/started` and never an `item/completed`, so mark it stopped yourself. `thread/read` shows only `userMessage`, `reasoning` and `agentMessage` for that turn.
- **The `sleep 139` process kept running.** It showed up in `thread/backgroundTerminals/list` (`{ itemId, processId, command, cwd }`). `thread/backgroundTerminals/terminate { threadId, processId }` returned `{ terminated: true }` and the process was gone a second later.
- The same survival happens with `--disable unified_exec` (`r1-interrupt-nounified.out`, alive 12 seconds after the interrupt), but that mode has no terminal list to clean up, so keep the default.
- Closing stdin and sending SIGTERM to the wrapper killed leftover commands (`r1-interrupt-noterm.out`, `sleepers=0`). SIGKILL of the wrapper also took the native process and the commands down (`r1-resume.out`, phases A and D).
- The thread stays usable. A follow-up turn correctly answered that it had been running `sleep 139`.

### Injecting a message without aborting

Three mechanisms exist, and all three are safe for the running turn.

| Mechanism | Call | Observed behavior |
| --- | --- | --- |
| Steer | `turn/steer { threadId, expectedTurnId, input }` | Returns `{ turnId }` in about 1 ms. The `userMessage` item appears roughly 28 seconds later, then the model acts on it. In `p10-steer.out` the final message included the steered `BANANA` and `steered.txt` was written. |
| Start while running | `turn/start` on a busy thread | Returns the same `turn.id`. The text is merged into the running turn (`p10-startwhile.out`, final reply "DONE KIWI", one turn). The schema says `turnTrigger` is "ignored when this request steers an already-active turn". |
| Queue | `thread/queue/add { threadId, input, clientUserMessageId }` | Not injected. Returns `queuedSubmission`, emits `thread/queue/changed`, and starts as a new turn 5 ms after the current one completes (`r1-queue.out`). |

Steer errors. A wrong `expectedTurnId` returns code -32600 with "expected active turn id `not-the-turn` but found `01a0eb89-…`". Steering with no active turn returns -32600 with "no active turn to steer". A steer that races with the turn ending therefore fails, and the adapter should fall back to `turn/start`.

The roughly 28 second delay was the same in two tests (a running shell command in `p10-steer.out`, and a blocked `ask_owner` in `r1-steer-dyn.out`). It matches 30 seconds after the tool call began. I did not find the cause. Treat a steer as "seen within about 30 seconds while a tool runs", and use hard stop when the owner needs it now.

## 3. Approvals

### When Codex asks

Same three-step task in each row (patch a file in the folder, run `git status --short .`, `touch` a file outside the folder), client answering `accept` (`p8-*.out`).

| `approvalPolicy` | `sandbox` | Requests | What asked |
| --- | --- | --- | --- |
| `never` | `workspace-write` | 0 | Nothing. The outside `touch` failed with "Operation not permitted". |
| `on-request` | `workspace-write` | 1 | Only the outside `touch`. The patch and `git status` ran without asking. |
| `untrusted` | `workspace-write` | 3 | The patch, `git status`, and the outside `touch`. |
| `on-request` | `read-only` | 2 | The patch and the outside `touch`. |
| `untrusted` | `read-only` | 3 | Same as `untrusted` with `workspace-write`. |
| `{ granular: { sandbox_approval, rules, skill_approval: false, request_permissions, mcp_elicitations } }` | `workspace-write` | 1 | Same as `on-request`. |

Under `untrusted` even read-only commands ask. `ls .` and `cat fruit.txt` both did (`r1-approvals-instant.out`, `adapter-min.out`). Once the client accepts, the command or patch runs outside the sandbox. In every row that asked and got `accept`, the outside file existed afterwards, and in the `read-only` rows the patch landed too. An owner's `accept` is therefore full trust for that one action.

### Request and response shapes

Command approval, from `r1-approvals-instant.out`.

```json
{"id":1,"method":"item/commandExecution/requestApproval","params":{"kind":"command","threadId":"…","turnId":"…","itemId":"exec-…","startedAtMs":1790644383281,"environmentId":"local","command":"/bin/zsh -lc 'git status --short .'","cwd":"/tmp/…/work","commandActions":[{"type":"unknown","command":"git status --short ."}],"proposedExecpolicyAmendment":["git","status","--short","."],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git","status","--short","."]}},"cancel"]}}
```

`reason` is set when the sandbox blocks the action, for example "The requested command writes a file outside the current workspace." File approval has almost no detail.

```json
{"id":0,"method":"item/fileChange/requestApproval","params":{"threadId":"…","turnId":"…","itemId":"exec-3cb0…","startedAtMs":1790644378746,"reason":null,"grantRoot":null}}
```

The paths come from the `item/started` event with `item.type: "fileChange"` and the same `itemId`, which arrives 1 ms earlier. Keep a map from `itemId` to `changes[].path`.

Responses.

| Request | Allow | Deny | Abort the turn |
| --- | --- | --- | --- |
| `item/commandExecution/requestApproval` | `{ decision: "accept" }` | `{ decision: "decline" }` | `{ decision: "cancel" }` |
| `item/fileChange/requestApproval` | `{ decision: "accept" }` | `{ decision: "decline" }` | `{ decision: "cancel" }` |
| `mcpServer/elicitation/request` (MCP approval) | `{ action: "accept", content: null }` | `{ action: "decline", content: null }` | `{ action: "cancel", content: null }` |

For the MCP prompt I ran only `accept`. The other two values come from the schema (`McpServerElicitationAction`).

`decline` marks the item `declined` (`exit` null), the turn continues, and the model reports that the step was refused (`p9-decline.out`, `r1-approvals-instant.out`). `cancel` ends the turn as `interrupted` (`p9-cancel.out`). `decline` is accepted even though `availableDecisions` lists only `accept`, the amendment and `cancel`. After each answer Codex emits `serverRequest/resolved { threadId, requestId }`. The schema adds `acceptForSession` and `applyNetworkPolicyAmendment`, which I did not run.

Approvals wait as long as the owner takes. A command approval answered after 200 seconds still ran (`r1-approvals-wait.out`, `serverRequest/resolved` at 208764 ms).

### Recommended settings

Use `approvalPolicy: "untrusted"` and `sandbox: "workspace-write"` on `thread/start`, and repeat both on every `thread/resume`. The client then does the following (`r1-approvals-instant.out`, `r1-approvals-wait.out`).

- Auto-accepts `item/fileChange/requestApproval` when every path for that `itemId` resolves inside the block folder. In the run it accepted `notes.txt` in the folder and declined a patch to `/tmp/office-research/codex/outside-r1-patch.txt`, which was not created.
- Forwards every `item/commandExecution/requestApproval` to the owner's card, and declines a command that touches something outside the folder.

`on-request` prompts far less, because commands inside the sandbox run silently, and it does not meet "shell commands ask the owner". Resolve paths with `realpath` before comparing. I did not test symlinks. The default `workspace-write` sandbox also allows writes to the temp directories and has network off (`networkAccess: false` in the `thread/start` reply). I did not test narrowing it.

## 4. MCP tools

### The test servers

`mcp-http.ts` is a stateless Streamable HTTP server (`express` plus `@modelcontextprotocol/sdk`) with three tools. `echo` returns instantly. `slow_wait(seconds)` sleeps, then returns text. `whoami` returns what the server can see about the caller. `mcp-stdio.ts` has an `echo` tool and reads `EMPLOYEE` from its environment.

### Attaching a server

Both attach forms work.

- Process-wide flags on the app-server command line, for example `-c mcp_servers.office.url="http://127.0.0.1:47831/mcp/ada"`.
- **Per thread**, in `thread/start.config`. This is the better fit. Two threads in one process got two different URLs and headers, and each `whoami` returned its own employee (`r1-mcp-thread.out`).

```json
{"config":{"mcp_servers":{"office":{"url":"http://127.0.0.1:47831/mcp/ada","http_headers":{"X-Employee":"ada-hdr"},"tool_timeout_sec":900,"default_tools_approval_mode":"approve"}}}}
```

A stdio server works the same way. `config.mcp_servers.stdiotest = { command: "node", args: ["…/mcp-stdio.ts"], env: { EMPLOYEE: "ada-stdio" }, default_tools_approval_mode: "approve" }` returned `stdio-echo:ping (employee=ada-stdio)` (`r1-mcp-stdio.out`), and the child exited with the app-server.

`-c mcp_servers={}` does not remove servers that come from `config.toml`. Tables merge (`r1-iso-leak-overrides.out`).

### Approval mode for MCP tools

Under `approvalPolicy: "never"` an unannotated MCP tool fails at once with "MCP tool call requires approval, but approval policy is never" (`r1-mcp-noapprove-never-s1.out`). Two fixes exist.

- Set `default_tools_approval_mode="approve"` on our own server. I ran this value. The binary also contains `auto`, `prompt` and `writes`, which I did not run.
- Under `untrusted`, Codex sends `mcpServer/elicitation/request` with `mode: "form"`, `message: "Allow the office MCP server to run tool \"slow_wait\"?"` and `_meta.codex_approval_kind: "mcp_tool_call"`. Answering `{ action: "accept", content: null }` ran the tool (`r1-mcp-a5-untrusted-noapprove.out`).

### The timeout

The per-server key is `tool_timeout_sec`. The default is 300 seconds.

| Run | `tool_timeout_sec` | `slow_wait` | Result | Log |
| --- | --- | --- | --- | --- |
| default | unset | 150 s | succeeded, 150008 ms | `r1-mcp-a1-default-150.out` |
| default | unset | 330 s | **failed at 300005 ms** | `r1-mcp-a8-default-wait330.out` |
| default | unset | 400 s | failed at 300006 ms | `r1-mcp-a4-default-wait400.out` |
| raised | 900 | 330 s | **succeeded, 330015 ms** | `r1-mcp-a6-t900-wait330.out` |
| lowered | 30 | 45 s | failed at 30001 ms | `r1-mcp-a2-t30-wait45.out` |
| lowered, with `thread/increment_elicitation` | 30 | 45 s | still failed at 30002 ms | `r1-mcp-a7-t30-wait45-elicit.out` |

The failure text is `tool call error: tool call failed for \`office/slow_wait\`\n\nCaused by:\n    timed out awaiting tools/call after 300s`. The model receives it as the tool result. The timeout ends the call but not the turn. `thread/increment_elicitation` reports `paused: true` but does not pause MCP timeouts. `startup_timeout_sec` is a separate key that I did not vary.

So a 150 second `ask_owner` works with no change, and a call longer than 5 minutes needs `tool_timeout_sec`. Values up to 900 were run.

### Which employee is calling

Codex's MCP client is `codex-mcp-client/0.158.0`. The server can identify the employee three ways, and all three matched in `mcp-http.jsonl`.

1. **URL path.** `/mcp/ada` reached the handler with `req.params.employee === "ada"`. This costs nothing and needs no trust in the model.
2. **Static header.** `http_headers` `X-Employee` arrived on each request.
3. **`_meta` on every `tools/call`.** `params._meta` has `threadId`, `sessionId`, `windowId`, `itemId`, `callId`, `progressToken`, and `x-codex-turn-metadata` (`session_id`, `thread_id`, `turn_id`, `model`, `sandbox_mode`, `workspaces`). For the `bob` call, `_meta.threadId` equaled the `thread.id` that `thread/start` returned. Map `threadId` to the employee when one URL serves several employees.

### Interrupt while `ask_owner` is pending

Hard stop during a pending call (`r1-stop-pending.out`). The turn completed as `interrupted` in 4 to 5 ms and the follow-up turn worked. For MCP, the HTTP request aborted and the server's `extra.signal` fired 4904 ms after the call began (`r1-mcp-http2.jsonl`, `slow_wait:aborted`), so the office can withdraw the owner card at that moment. For a client-hosted tool, the `dynamicToolCall` item completed as `failed` with `success: false`, and answering the stale request late was ignored without an error.

### A second option, client-hosted tools

`thread/start.dynamicTools` declares tools the client itself runs, so no MCP server is needed. Codex sends the server request `item/tool/call { threadId, turnId, callId, namespace, tool, arguments }`, and we answer `{ contentItems: [{ type: "inputText", text }], success: true }` whenever the owner replies.

- A 330 second wait succeeded, which is past the 300 second MCP default (`r1-dyntool-330.out`). A 200 second wait also succeeded (`r1-dyntool.out`).
- Identity is implicit, because the request carries `threadId`.
- Tool definitions **persist across resume**. After a SIGKILL and `thread/resume` with no `dynamicTools`, `ask_owner` still worked (`r1-tools-resume.out`, phases B and C). Per-thread MCP `config` did not persist. Phase B answered `NO-MCP` until phase C sent `config` again.
- The API is marked experimental in the schema, and I always sent `experimentalApi: true`.

## 5. Isolation

### What the owner's config would leak

Names only, read from `~/.codex/config.toml` and from `mcpServerStatus/list`, `skills/list` and `plugin/list` on a sanitized copy of that home (`r1-iso-leak-default.out`).

| Source | What loads |
| --- | --- |
| Defaults | `model = "gpt-5.6-sol"`, `model_reasoning_effort = "xhigh"`, `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, `personality = "friendly"`. A `thread/start` with no overrides returned exactly these (`r1-defaults.out`). The clean home returned `gpt-6-astra`, `on-request` and `workspaceWrite`. |
| MCP servers in config | `node_repl`, `computer-use`, `pencil`, `higgsfield`, `crono-spark`, `posthog-bloom`, `cap`. Plugins add `posthog`. Several failed to start (no OAuth, a 401, a missing binary). Loading them still spawns processes and opens connections. |
| Plugins in config | `slack`, `stripe`, `github`, `semrush`, `vercel`, `linear`, `chrome`, `computer-use`, `documents`, `spreadsheets`, `presentations`, `pdf`, and others. |
| Account side, not from the file | An MCP server named `codex_apps` with 400 or more connector tools, and a remote plugin marketplace with 4927 plugins, of which `gmail`, `google-drive`, `github`, `slack`, `vercel`, `google-calendar` and `linear` were installed and enabled. These load even in a clean `CODEX_HOME` (`r1-iso-clean-noflags.out`). |
| Skills | 451 user-scope skills on the copy, 112 once plugins are disabled. Sources are plugin skills, `~/.codex/skills`, and `~/.agents/skills` (86 entries). That last folder loads under any `CODEX_HOME`. |
| `AGENTS.md` | `~/.codex/AGENTS.md` is empty today, but the mechanism is live. A marker I put in the copy's global `AGENTS.md` was obeyed (`r1-agents-retry.out`). |
| Memories | `[features] memories = true` in the owner's config. See section 7. |
| Project trust | `thread/start` writes `[projects."<cwd>"] trust_level = "trusted"` into `$CODEX_HOME/config.toml`. The clean home had 33 such entries when I counted. |

### What worked

Overrides alone do not isolate. `-c mcp_servers={}` plus the disable flags on the copied home still listed all seven config MCP servers.

A separate `CODEX_HOME` with the ChatGPT login symlinked in does isolate, once you add the account-side switches and an empty `HOME`.

```text
CODEX_HOME=<office data dir>/codex-home        # contains only auth.json -> ~/.codex/auth.json (symlink)
HOME=<empty dir>                                # hides ~/.agents/skills
codex app-server --disable apps --disable plugins --disable remote_plugin \
  -c features.memories=false \
  -c 'shell_environment_policy.set={HOME="/Users/feliperico"}'
```

Evidence, from `skills/list`, `mcpServerStatus/list` and `plugin/list` on the clean home (`r1-iso-clean-flags.out`, `r1-iso-clean-fakehome.out`).

| Setup | MCP servers | Plugins | User skills |
| --- | --- | --- | --- |
| Clean `CODEX_HOME`, no flags | `codex_apps` (400 tools) | 4927 remote | 199 |
| Plus `--disable apps --disable plugins --disable remote_plugin` | none | none | 86 (`~/.agents/skills`) |
| Plus `HOME` set to an empty dir | none | none | 0 (6 bundled system skills remain) |

- The login works. `account/read` returned `chatgpt` on the symlinked home, and every turn ran on it.
- With `HOME` emptied, the shell tool still saw the real home, because `shell_environment_policy.set` restores it (`echo $HOME` returned `/Users/feliperico`, `r1-agents-clean-fakehome.out`).
- Skills cost tokens on every turn. The trivial turn used 17113 input tokens with 86 user skills, 12447 with none, and 18586 on the copy of the owner's home (`r1-agents-*.out`).
- Folder-level `AGENTS.md` still loads, which is wanted for block folders.

The symlink was my choice because `auth.json` then has one owner. Its `last_refresh` is `2026-09-25` and its mtime did not change during any run, so no refresh happened. If Codex refreshes by replacing the file, the symlink in the office home would be replaced by a regular file and the owner's own login would keep an old refresh token. I did not test that. Check it before shipping, or copy `auth.json` and accept two logins.

One caution. In my first parallel isolation run, two of five app-server processes died before answering `initialize`, and both used the same copied home. Sequential reruns passed (`r1-iso-leak-cleanflags.out`). I did not find the cause. A single shared app-server avoids the question.

## 6. Resume

Test script `r1-resume.ts`, output `r1-resume.out`. Process A starts a thread with a persona and is told the word `ZEBRA-4417`. I SIGKILL it. A new process B resumes by thread id.

| Step | Observed |
| --- | --- |
| B: `thread/resume { threadId, cwd, approvalPolicy, sandbox, model }` | Returned `thread` with `turns: 1`, `status: idle`, same id. History shows the remembered-word exchange. |
| B: "What was the secret word, and what is your name?" | `ZEBRA-4417; Ada -- Ada`. Context and persona both survived, and the persona was not re-sent. |
| C: resume with new `developerInstructions` "You are Bob now" | Still `Ada -- Ada`. Persona set at `thread/start` sticks. |
| D: SIGKILL in the middle of `sleep 47`, then E: resume | Thread `idle`. Last turn `interrupted` with the command item `failed`. The model answered "I was running `sleep 47` when it was interrupted". No leftover processes. |

The thread lives on disk in `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, so resume needs the same `CODEX_HOME`. Three traps.

1. **The sandbox is not restored** (`r1-resume-policy.out`). A thread started `untrusted` with `read-only` resumed with no overrides as `untrusted` and `workspaceWrite`. The approval policy and model came back, the sandbox did not. Send `approvalPolicy` and `sandbox` on every resume.
2. **Per-thread MCP `config` is not restored.** Send it again (section 4).
3. **A thread that never ran a turn has no rollout.** `thread/resume` failed with "no rollout found for thread id …". Run one turn before you rely on resume, or call `thread/start` again.

## 7. Memory

Codex has a built-in memories feature. `codex features list` shows `memories  stable  false` in a clean home. The owner's config sets `[features] memories = true` and a `[memories]` table.

- **Where it persists.** `$CODEX_HOME/memories/` is a git repository. The owner's copy holds `MEMORY.md` (about 276 KB), `memory_summary.md` (about 8 KB), `raw_memories.md`, `rollout_summaries/<timestamp>-<slug>.md` (one per past thread), `skills/<name>/` and `extensions/ad_hoc/{instructions.md,notes}`. A separate `memories_1.sqlite` has the tables `stage1_outputs` (`thread_id`, `raw_memory`, `rollout_summary`, `usage_count`), `jobs` and `consolidation_progress`. Names only. I did not read the contents.
- **How it works.** Stage 1 extracts a raw memory and summary from idle past sessions, and stage 2 consolidates them (job `memory_consolidate_global`). Config keys under `[memories]` include `generate_memories`, `use_memories`, `min_rollout_idle_hours`, `max_rollouts_per_startup`, `max_unused_days`, `extract_model` and `consolidation_model`.
- **It is not session recall.** In `r1-memory.out` I enabled it in a scratch home with `min_rollout_idle_hours=0`, planted a fact, restarted, and waited 120 seconds. The `memories/` folder was created within 10 seconds, but `stage1_outputs` stayed empty, the consolidation job ended `error` with `failed_agent`, and a fresh thread answered `UNKNOWN`. I did not get the pipeline to finish, so I cannot say what it needs.
- **Turn it off.** `-c features.memories=false` or `--disable memories`. I confirmed both flip the owner's `features.memories` from true to false (`r1-memory-off.out`). In a fresh home with memories off, a full session created no `memories/` folder, only the empty `memories_1.sqlite`. `thread/memoryMode/set { threadId, mode: "disabled" }` returned `{}`, and I did not observe its effect.
- **Why it matters here.** With the owner's real home, employees would read the owner's personal memory and write their own sessions into it. The office should own employee memory (see R3), so keep this off.

## 8. Cost and latency

Trivial task "Reply with the single word PONG", three turns on one thread, effort as shown (`r1-latency.out`). Times run from sending `turn/start`.

| Model, effort | Turn | First token | Finish | Input tokens (cached) |
| --- | --- | --- | --- | --- |
| `gpt-6-astra` (default), medium | 1 | 4057 ms | 4682 ms | 17868 (0) |
| | 2 | 1293 ms | 1895 ms | 17888 (17152) |
| | 3 | 1075 ms | 1706 ms | 17908 (17152) |
| `gpt-6-luna`, low | 1 | 2672 ms | 3301 ms | 17240 (0) |
| | 2 | 1154 ms | 2212 ms | 17260 (16128) |
| | 3 | 890 ms | 1518 ms | 17280 (16128) |
| `gpt-6-sol`, low | 1 | 7206 ms | 7752 ms | 17419 (0) |
| | 2 | 4530 ms | 5093 ms | 17439 (17152) |
| | 3 | 5066 ms | 5745 ms | 17459 (17152) |

- Warm turns on `gpt-6-luna` at low effort take about 1 second to the first token and 1.5 to 2.2 seconds to finish. The first turn on a new thread costs 2.7 to 4 seconds to the first token, and 7 seconds on `gpt-6-sol`.
- A tool-using turn (patch a file, run `ls`, reply) on `gpt-6-luna` at low effort took 20454 ms end to end, with the first streamed text at 8.9 seconds (`r1-shapes.out`). It used 17414 input tokens and 129 output tokens.
- Every turn sends about 17000 input tokens of fixed prompt. It drops to about 12400 without `~/.agents/skills`. The first turn is uncached. Later turns are 93 to 96 percent cached.
- Billing is the ChatGPT plan, not per token. `account/rateLimits/updated` reported a weekly window at 17 percent used.
- One app-server process is about 148 MB resident (54 MB for the Node wrapper, 94 MB for the native binary). `initialize` answered 45 ms after spawn and `thread/start` took 55 ms (`r1-rss.out`). Earlier runs measured 185 to 260 ms for `initialize`.

## Recommended adapter design

### Process model

Run one shared `codex app-server` for the office, with the flags from section 5. Give every employee a thread with its own `config.mcp_servers.office` URL. Two concurrent threads worked in one process, each with its own identity. If the process dies, respawn it and `thread/resume` every employee that was working. A shared process avoids the startup failure I saw with parallel processes on one home, and it costs one 150 MB process instead of one per employee. The price is that a crash interrupts every employee at once. Spawn the wrapper at `/Users/feliperico/.local/bin/codex` or the native binary under `@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`. Killing the wrapper took the native process with it.

### Verb mapping

| Office verb | Protocol |
| --- | --- |
| `hire` | `thread/start { cwd: <block folder>, model: "gpt-6-luna", developerInstructions: <persona>, approvalPolicy: "untrusted", sandbox: "workspace-write", config: { mcp_servers: { office: { url: ".../mcp/<employeeId>", tool_timeout_sec: 3600, default_tools_approval_mode: "approve" } } } }`. Store `thread.id`. Run one turn early so resume works. |
| `assign` | If the thread is `idle`, `turn/start { threadId, input, effort }` and store `turn.id`. If it is `active`, treat it as `interject`. Map events to the office log. `turn/completed` is done. |
| `interject`, tap on shoulder | `turn/steer { threadId, expectedTurnId, input }`. The agent's acknowledgment shows up in a later `agentMessage`, up to about 30 seconds later while a tool runs. On "no active turn to steer", fall back to `turn/start`. |
| `interject`, hard stop | `turn/interrupt`, wait for `turn/completed` with `interrupted`, then `thread/backgroundTerminals/list` and `terminate` each entry. Withdraw pending owner cards for that thread. Then `turn/start` with the new instruction. The model knows what it was doing. |
| `answer`, `ask_owner` | Resolve the blocked HTTP handler for that `threadId` with the owner's text. If the office uses the client-hosted tool instead, answer the pending `item/tool/call` with `{ contentItems: [{ type: "inputText", text }], success: true }`. |
| `answer`, approval | Reply to the held server request. Command or patch, `{ decision: "accept" \| "decline" \| "cancel" }`. MCP prompt, `{ action, content: null }`. Auto-accept patches inside the block folder. |
| `stop` | Same as hard stop without the follow-up turn. The thread stays `idle` and reusable. |
| `resume` (app restart) | Spawn the app-server, `initialize`, then `thread/resume { threadId, cwd, model, approvalPolicy: "untrusted", sandbox: "workspace-write", config: <the same mcp_servers> }`. On "no rollout found", the thread never ran a turn, so call `thread/start` again. |
| quit | End stdin and SIGTERM the wrapper. Leftover commands die with it. |

### Config flags

- Process, once: `--disable apps --disable plugins --disable remote_plugin -c features.memories=false -c 'shell_environment_policy.set={HOME="<real home>"}'`, with `CODEX_HOME` pointing at an office directory holding only a symlink `auth.json`, and `HOME` pointing at an empty directory.
- Thread, always explicit. `approvalPolicy`, `sandbox`, `model`, `cwd`, `developerInstructions`. Never rely on defaults, because a leaked home would default to `never` plus `danger-full-access`.
- `tool_timeout_sec` well above the longest owner wait, and `default_tools_approval_mode: "approve"` on our own server only.
- Use `thread/turns/list` for history, not `thread/read` with `includeTurns` (the list call is from the schema and was not run).

### Which `ask_owner` path

Use the office MCP server for Codex, so one server serves Claude Code, Hermes and Codex, and it runs on the stable interface. Identify the caller by the URL path and check `_meta.threadId`. Keep the client-hosted tool as the fallback. It needs no port and had no timeout in a 330 second test, but its API is marked experimental.

### Minimal client

This is the file `/tmp/office-research/codex/adapter-min.ts`. I ran it with `node adapter-min.ts` (Node 26.7 strips the types). The demo hires Ada, and Ada asks the owner for a fruit through a client-hosted `ask_owner`. The client auto-accepts a patch inside the folder and accepts a command. Ada then starts `sleep 60`. The demo interjects, hard-stops, SIGKILLs the process, resumes in a new process, and asks for the fruit again. Output from `logs/adapter-min.out`.

```text
  5729ms ask_owner({"question":"What is your favourite fruit?"}) -> owner thinks 3s
 11792ms patch approval accept
 11817ms command started: /bin/zsh -lc 'cat fruit.txt'
 11817ms command approval accept: /bin/zsh -lc 'cat fruit.txt'
 13342ms agent (final_answer): DONE BLUEBERRY
 13359ms turn 1 completed; fruit.txt=BLUEBERRY
 16370ms command started: /bin/zsh -lc 'sleep 60'
 16370ms command approval accept: /bin/zsh -lc 'sleep 60'
 16371ms interject -> {"turnId":"01a0eb9a-0f77-7120-b8b1-102360d218a3"}
 16378ms turn 2 interrupted (hard stop)
 21213ms agent (final_answer): BLUEBERRY
 21225ms turn 3 after resume completed: BLUEBERRY
```

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

type Json = any
const CODEX = '/Users/feliperico/.local/bin/codex'
const CLEAN = ['--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin', '-c', 'features.memories=false']

export class CodexServer {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>()
  onNotification: (method: string, params: Json) => void = () => {}
  onServerRequest: (method: string, params: Json) => Promise<Json> = async (m) => { throw new Error(`unhandled ${m}`) }

  constructor(codexHome: string, home?: string) {
    this.proc = spawn(CODEX, ['app-server', ...CLEAN], {
      env: { ...process.env, CODEX_HOME: codexHome, ...(home ? { HOME: home } : {}) },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    createInterface({ input: this.proc.stdout }).on('line', (line) => void this.onFrame(JSON.parse(line)))
  }
  private write(frame: Json) { this.proc.stdin.write(JSON.stringify(frame) + '\n') }
  private async onFrame(f: Json) {
    if (f.method && f.id !== undefined) {
      try { this.write({ id: f.id, result: await this.onServerRequest(f.method, f.params) }) }
      catch (e) { this.write({ id: f.id, error: { code: -32000, message: String(e) } }) }
    } else if (f.method) this.onNotification(f.method, f.params)
    else if (f.id !== undefined) {
      const p = this.pending.get(f.id)!; this.pending.delete(f.id)
      f.error ? p.reject(new Error(`${f.error.code} ${f.error.message}`)) : p.resolve(f.result)
    }
  }
  request<T = Json>(method: string, params: Json): Promise<T> {
    const id = this.nextId++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.write({ id, method, params }) })
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'online-office', title: null, version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    this.write({ method: 'initialized' })
  }
  kill() { this.proc.kill('SIGKILL') }
}

const ASK_OWNER = { type: 'function', name: 'ask_owner', description: 'Ask the human owner a question and wait for the answer.', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } }
const text = (t: string) => [{ type: 'text', text: t, text_elements: [] }]

export class Employee {
  turnId: string | null = null
  private srv: CodexServer
  readonly threadId: string
  private done: Map<string, (t: Json) => void>
  private constructor(srv: CodexServer, threadId: string, done: Map<string, (t: Json) => void>) { this.srv = srv; this.threadId = threadId; this.done = done }
  static async hire(srv: CodexServer, o: { cwd: string; persona: string; model: string }) {
    const r = await srv.request('thread/start', { cwd: o.cwd, model: o.model, developerInstructions: o.persona, approvalPolicy: 'untrusted', sandbox: 'workspace-write', dynamicTools: [ASK_OWNER] })
    return Employee.attach(srv, r.thread.id)
  }
  static async resume(srv: CodexServer, threadId: string, o: { cwd: string; model: string }) {
    await srv.request('thread/resume', { threadId, cwd: o.cwd, model: o.model, approvalPolicy: 'untrusted', sandbox: 'workspace-write' })
    return Employee.attach(srv, threadId)
  }
  private static attach(srv: CodexServer, threadId: string) {
    const done = new Map<string, (t: Json) => void>()
    const prev = srv.onNotification
    srv.onNotification = (m, p) => { prev(m, p); if (m === 'turn/completed' && p.threadId === threadId) done.get(p.turn.id)?.(p.turn) }
    return new Employee(srv, threadId, done)
  }
  async assign(task: string): Promise<Json> {
    const { turn } = await this.srv.request('turn/start', { threadId: this.threadId, effort: 'low', input: text(task) })
    this.turnId = turn.id
    return new Promise((res) => this.done.set(turn.id, (t) => { this.turnId = null; res(t) }))
  }
  interject(msg: string) { return this.srv.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: text(msg) }) }
  async stop() {
    await this.srv.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
    const { data } = await this.srv.request('thread/backgroundTerminals/list', { threadId: this.threadId })
    for (const t of data) await this.srv.request('thread/backgroundTerminals/terminate', { threadId: this.threadId, processId: t.processId })
  }
}

// ---- demo (this is what was run) ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const { mkdirSync, rmSync, readFileSync } = await import('node:fs')
  const { execSync } = await import('node:child_process')
  const HOME = '/tmp/office-research/codex/home-clean', cwd = '/tmp/office-research/codex/work-adapter-min'
  rmSync(cwd, { recursive: true, force: true }); execSync(`cp -R /tmp/office-research/codex/scratch-repo ${cwd}`)
  const t0 = Date.now(), log = (s: string) => console.log(`${String(Date.now() - t0).padStart(6)}ms ${s}`)
  const fileChangePaths = new Map<string, string[]>()
  let onCommandStarted = () => {}
  const wire = (srv: CodexServer) => {
    srv.onNotification = (m, p) => {
      if (m === 'item/started' && p.item.type === 'fileChange') fileChangePaths.set(p.item.id, p.item.changes.map((c: Json) => c.path))
      if (m === 'item/started' && p.item.type === 'commandExecution') { log(`command started: ${p.item.command}`); onCommandStarted() }
      if (m === 'item/completed' && p.item.type === 'agentMessage') log(`agent (${p.item.phase}): ${p.item.text}`)
    }
    srv.onServerRequest = async (method, p) => {
      if (method === 'item/tool/call') { log(`ask_owner(${JSON.stringify(p.arguments)}) -> owner thinks 3s`); await new Promise((r) => setTimeout(r, 3000)); return { contentItems: [{ type: 'inputText', text: 'BLUEBERRY' }], success: true } }
      if (method === 'item/fileChange/requestApproval') { const ok = (fileChangePaths.get(p.itemId) ?? []).every((f) => f.startsWith(cwd + '/')); log(`patch approval ${ok ? 'accept' : 'decline'}`); return { decision: ok ? 'accept' : 'decline' } }
      if (method === 'item/commandExecution/requestApproval') { log(`command approval accept: ${p.command}`); return { decision: 'accept' } }
      throw new Error(`unhandled ${method}`)
    }
  }
  const srv1 = new CodexServer(HOME); wire(srv1); await srv1.initialize()
  const ada = await Employee.hire(srv1, { cwd, model: 'gpt-6-luna', persona: 'You are Ada, an employee at Online Office. Keep replies to one sentence.' })
  let turn = await ada.assign('Ask the owner for their favourite fruit with ask_owner, write it into fruit.txt with apply_patch, run `cat fruit.txt`, then reply DONE plus the fruit.')
  log(`turn 1 ${turn.status}; fruit.txt=${readFileSync(`${cwd}/fruit.txt`, 'utf8').trim()}`)
  const running = new Promise<void>((r) => { onCommandStarted = r })
  const slow = ada.assign('Run the shell command `sleep 60` then reply DONE.')
  await running
  log(`interject -> ${JSON.stringify(await ada.interject('Tap on the shoulder: the owner is watching.'))}`)
  await ada.stop(); turn = await slow
  log(`turn 2 ${turn.status} (hard stop)`)
  srv1.kill()
  const srv2 = new CodexServer(HOME); wire(srv2); await srv2.initialize()
  const ada2 = await Employee.resume(srv2, ada.threadId, { cwd, model: 'gpt-6-luna' })
  turn = await ada2.assign('Which fruit did the owner choose earlier? One word.')
  log(`turn 3 after resume ${turn.status}: ${turn.items.map((i: Json) => i.text)}`)
  srv2.kill()
}
```

### Open risks

- Token refresh through a symlinked `auth.json` is untested (section 5).
- Only two concurrent threads were run in one process. Load with a full office is unmeasured.
- Steer delivery takes about 30 seconds while a tool runs, and I do not know why.
- The memories pipeline never finished in my window, so its real behavior is unknown. The off switch is proven.
- `thread/memoryMode/set`, `baseInstructions`, `acceptForSession`, execpolicy amendments and narrowed sandboxes are in the schema and unrun.
- Everything here is for codex-cli 0.158.0 on macOS. The protocol is marked experimental, so pin the version and regenerate the types with `codex app-server generate-ts --experimental` on each upgrade.
