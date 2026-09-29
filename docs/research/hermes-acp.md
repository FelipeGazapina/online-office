# R2. Driving Hermes through ACP

Research unit R2 for the beta. Written 2026-09-29. Versions checked: Hermes Agent v0.21.5+3807.g6e69a89 (2026.9.24), `@agentclientprotocol/sdk` 1.5.1 (the current npm release, published 2026-09-28), `@modelcontextprotocol/sdk` 1.31.0, Node 26.7.0, ACP protocol version 1. Every probe ran on `claude-haiku-4-5-20251001` unless the section says otherwise, through the owner's Claude login.

The question was whether the Electron main process can drive Hermes as an employee by running `hermes acp` over stdio, and whether one ACP adapter could later cover the other harnesses too.

## Answer

Yes. Hermes over ACP supports everything the beta needs from an employee: streamed output, MCP tools that block for minutes, owner approvals, interrupts, and resume after a crash. It needs a specific setup, and the six defaults below would hurt if the adapter took them as they are.

1. **Never use the owner's default Hermes home.** ACP loads whatever is in `HERMES_HOME`: MCP servers, SOUL.md, memory, skills, hooks. The owner's config also has `approvals.mode: off`, and in an earlier run an ACP session on that home ran `rm -rf` without asking. Use one dedicated profile, `~/.hermes/profiles/office`, made with `hermes profile create office --no-alias --no-skills`.
2. **Never point `HERMES_HOME` outside `~/.hermes`.** Hermes then treats the path as a second install root. Its first launch reinstalls dependencies and rebuilds the TUI, the web UI and the desktop app inside the shared checkout, and it rewrites `~/.hermes/hermes-agent/.hermes/bin/hermes` to point at the new home. I hit this by accident and had to repair the launchers (see "Side effects"). Profile paths under `~/.hermes/profiles/` are safe.
3. **Raise the MCP tool timeout.** A tool call fails after 300 s by default. `ask_owner` will exceed that. Set `timeouts.mcp.tool_call` in the profile's `config.yaml`. I observed a 150 s call succeed on both transports, a 320 s call fail at exactly 300.0 s by default, and the same call succeed with `timeouts.mcp.tool_call: 1800`.
4. **Shell commands do not ask by default.** In `approvals.mode: manual`, only commands that match a "dangerous" pattern raise `session/request_permission`. `date` ran silently. A `pre_tool_call` shell hook that returns `{"action":"approve"}` makes every command ask. The hook must also cover `execute_code`, or the model runs shell commands through Python without a prompt.
5. **MCP servers are shared by name across all sessions in one process.** Two sessions that both declare a server named `office` with different URLs end up on the first session's connection. Name each server `office_<employeeId>`.
6. **Run one `hermes acp` process per employee, with the block folder as the process cwd.** `accept_edits` resolves relative paths against the process cwd, not the session cwd. A process costs about 220 MB and one second to start.

Interrupts map cleanly. `session/cancel` stops a tool in 30 to 100 ms. A plain `session/prompt` sent during a turn is absorbed as a steer, so it neither errors nor queues. `session/load` restored a remembered word after `SIGKILL`.

## What I verified and what I did not

Evidence names are run tags. Logs are `/tmp/office-research/hermes/runs2/<tag>.wire.jsonl` (raw ACP traffic) and `<tag>.stderr.log` (Hermes logs). Tags marked "earlier" are in `/tmp/office-research/hermes/runs/`, from the cut-off attempt that preceded this run.

| Claim | How I know |
| --- | --- |
| `initialize` result and `hermes acp --check` | Observed (`s1-init-min`). `--check` printed `Hermes ACP check OK`, exit 0, at the start and the end of this unit. |
| Persona, model switching, update kinds, stop reasons | Observed (`p-*`, `s3-prompt`, `s14-plan`, `s20-think`, `s23-stops`, `bogus-model`). |
| MCP over http and stdio, 150 s and 320 s calls, timeout config | Observed (`s5-mcp-quick`, `s5-mcp-slow`, `s5-mcp-slow-stdio`, `s5-mcp-slow-long-*`, `s10-timeouts`). |
| Per-employee identity, shared-name collision, parallel sessions | Observed (`s9-two-sessions`, `s21-parallel`, `s21-parallel-distinct`, `s22-*`). |
| Permission requests, options, answers, timeouts, hook approval, `execute_code` bypass | Observed (`s4-perm`, `s4b-perm2`, `s13-profile`, `s11-longperm`, `s16-cwd`, `s19-bypass`, `s10-timeouts`). The narrow-matcher `execute_code` run was overwritten by the wide-matcher rerun under the same tag, so `s19-bypass` shows only the second. |
| `hermes -z` auto-approves | Observed with a marker file, no wire log (commands in section 4). |
| Cancel, mid-turn prompt, `/steer`, `/queue`, re-attached prompt | Observed (`s6-*`, `s18-reattach`, `s24-cancel-perm`). The stored message text is in `reattach-evidence.txt`. |
| `session/load` after `SIGTERM` and after `SIGKILL`, model kept, mode reset | Observed (`s7-*`, `s26-*`). |
| What ACP loads from a home, and what the flags disable | Observed on a profile with a config-defined MCP server, a SOUL.md, a MEMORY.md and a skill (`s25-flags-*`, `skills-probe`). |
| Memory persists and where, and how to turn it off | Observed (`mem2-*`). |
| ACP against the owner's default home | Not run this time. It would write into `~/.hermes`. The earlier attempt did (`runs/s8-default.out`, `runs/s13-default.wire.jsonl`, `runs/default-home-probe.wire.jsonl`). The last one is a model self-report, so I only lean on the first two. |
| Other CLIs' ACP support | `--help` checked this run. Handshakes come from the earlier attempt (`runs/s12-*`). I did not test the npm adapters for Codex and Claude Code. |
| `allow_always` and `deny_always` behavior, `delegate_task` under the hook, an unreachable MCP server at `session/new`, `mcp_servers.<name>.timeout`, `HERMES_DISABLE_LAZY_INSTALLS=1` as a workaround, `sse` transport | Not tested. |

The scratch code is in `/tmp/office-research/hermes/`. That folder disappears when the OS clears `/tmp`, so the snippets in this doc are the durable copy.

## 1. Handshake

`hermes acp --check` prints `Hermes ACP check OK` and exits 0. `hermes acp --version` prints `0.21.5+3807.g6e69a89`.

`initialize` took 0.94 s from process start (0.78 to 1.56 s over five runs). The client sent `clientCapabilities: {}`. With that, Hermes wrote files and ran commands itself, so the client does not need to implement `fs` or `terminal`.

```json
{
	"protocolVersion": 1,
	"agentInfo": { "name": "hermes-agent", "version": "0.21.5" },
	"agentCapabilities": {
		"loadSession": true,
		"promptCapabilities": { "image": true },
		"sessionCapabilities": { "fork": {}, "list": {}, "resume": {} }
	},
	"authMethods": [
		{ "id": "anthropic", "name": "anthropic runtime credentials" },
		{ "id": "hermes-setup", "type": "terminal", "args": ["--setup"], "name": "Configure Hermes provider" }
	]
}
```

- `loadSession` is true, and `session/resume` and `session/fork` are advertised.
- `mcpCapabilities` is absent, so Hermes advertises neither http nor sse. It still accepted `type: "http"` and stdio servers in `session/new` (section 3). Do not gate on that field for Hermes.
- Prompts accept text and images. Audio and embedded context are not advertised.
- `authMethods` lists `anthropic` because the runtime resolved credentials. The client never called `authenticate`, and `session/new` and `session/prompt` worked.

## 2. Sessions and prompts

### Persona and model

`session/new` takes only `cwd` and `mcpServers`. Its response has `sessionId`, `models` and `modes`. There is no system prompt field and no `configOptions`.

| Way to set a persona | Result |
| --- | --- |
| `session/new` with `_meta.systemPrompt` | Ignored. The reply was unchanged (`p-meta`). |
| `AGENTS.md` in the session cwd | Applied. The model named itself Rex and ended with the token from the file (`p-agentsmd`). |
| `.hermes.md` in the session cwd | Applied (`p-hermesmd`). |
| `SOUL.md` in `HERMES_HOME` | Applied (`p-soul`). |

`AGENTS.md` and `.hermes.md` live in the block folder, which is the owner's repo. Writing them there pollutes it. Put the persona in the first prompt of a session, or in `SOUL.md` if each employee gets a profile. The control reply was "I'm Claude Code, Anthropic's CLI for Claude". A Claude subscription login forces that identity prefix, and persona text layers on top of it ("I'm Claude Code, ... and I'm Nova").

The model is per session. `session/set_model` with `{ sessionId, modelId: "anthropic:claude-opus-4-7" }` returned `{}` in about 0.4 s. `models.availableModels` had 36 entries, 13 of them Anthropic, and `currentModelId` started at the profile's `model.default`. The method is not in the advertised capabilities but works. It does not validate. `anthropic:not-a-model` was accepted, and the next prompt failed after 9.1 s of retries with `HTTP 404: model: not-a-model` as ordinary message text (`bogus-model`). The model survives `session/load` (section 6).

Slash commands go in as prompt text. `available_commands_update` lists `help`, `model`, `tools`, `context`, `reset`, `compress`, `steer`, `queue` and `version`.

### Notifications

Update kinds seen across all the logs of this run:

| `sessionUpdate` | Shape and when it arrives |
| --- | --- |
| `available_commands_update` | `{ availableCommands: [{ name, description, input? }] }`. First update of a prompt, at +20 ms. |
| `usage_update` | `{ used: 11298, size: 200000 }`. Context window fill, not billing. |
| `session_info_update` | `{ title, updatedAt, _meta.hermes.sessionProvenance }`. Title is the first prompt text. |
| `agent_message_chunk` | `{ messageId, content: { type: "text", text } }`. A few characters to a few words per chunk. |
| `agent_thought_chunk` | Same shape. Only with `reasoning_effort: high` on Opus 4.7 (17 chunks in `s20-think`). None at `low`. |
| `tool_call` | `{ toolCallId, title, kind, rawInput?, locations?, content }`. No `status`, so it starts pending. |
| `tool_call_update` | `{ toolCallId, status, kind, content }`. Status was `completed` (72) or `failed` (15). No `in_progress`. |
| `user_message_chunk` | Only in `session/load` replay and when a queued prompt starts. |

There is no `plan` update. The `todo_list` tool arrives as a plain `tool_call` with `kind: "other"` and the task list in `content` (`s14-plan`). Tool kinds seen were `execute` (`terminal`), `edit` (`write_file`, `patch`), `read` (`read_file`) and `other` (MCP tools, `todo_list`). Titles look like `terminal: date -u +%Y`, `write_file: hello.txt` and `mcp__officehttp__echo: hi`. An MCP call carries its arguments in `rawInput`.

The order for a trivial turn was `available_commands_update` (+20 ms), `usage_update` (+22 ms), `session_info_update` (+372 ms), first `agent_message_chunk` (+1289 ms), response (+2034 ms).

### How a turn ends

`session/prompt` resolves with `{ stopReason, usage }` and `usage` is `{ inputTokens, outputTokens, thoughtTokens, cachedReadTokens, totalTokens }`. Three stop reasons occurred.

- `end_turn` for a normal finish.
- `cancelled` after `session/cancel`.
- `refusal` when the `sessionId` is unknown (`s23-stops`). Hermes answers with a normal result, not a JSON-RPC error.

Failures are also `end_turn`. A bad model, a rate limit or a crashed provider call ends the turn with the error text as message chunks and a response of `{ "stopReason": "end_turn" }` with no `usage` field. Treat a missing `usage` on a non-slash prompt as an error turn. The earlier attempt's log shows the worst case. With the Anthropic account rate limited, Hermes retried three times with a 600 s wait, and one `session/prompt` blocked for 1,202,865 ms before returning an "Anthropic rate-limited every one of 3 attempts" message (`runs/s15-opus47low2`). Employees share one Claude login, so the adapter must let `session/cancel` end such a wait.

## 3. MCP tools

The probe server (`mcp-common.ts`, `mcp-http.ts`, `mcp-stdio.ts`) has `echo` and `slow_wait(seconds)`, built with `@modelcontextprotocol/sdk` 1.31.0. It ran once as Streamable HTTP on `127.0.0.1:8766` and once as a stdio child.

### Passing servers and how Hermes calls them

```ts
const mcpServers: acp.McpServer[] = [
	{ type: "http", name: "officehttp", url: "http://127.0.0.1:8766/mcp/alice", headers: [{ name: "x-office-employee", value: "alice" }] },
	{ name: "officestdio", command: "/path/to/tsx", args: ["mcp-stdio.ts"], env: [{ name: "OFFICE_EMPLOYEE", value: "alice" }] },
];
await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers });
```

Both worked (`s5-mcp-quick`). Tool names are `mcp__<serverName>__<tool>`, for example `mcp__officehttp__echo`.

- Hermes connects at `session/new`, before the first prompt. For HTTP the server saw `HEAD`, `GET`, then `POST initialize`, `notifications/initialized`, `tools/list`, and later `POST tools/call`. The client is Python httpx and speaks MCP protocol 2025-11-25.
- `session/new` took 2.2 s for the first session with one HTTP server and 0.27 s for the second session in the same process.
- The stdio child started during `session/new`, with the session cwd. Of the `OFFICE_*` and `HERMES_*` variables, only the one I passed was in its env.

### Calls that block

| Transport | Call | Tool call started | Completed | Result |
| --- | --- | --- | --- | --- |
| http | `slow_wait` 150 s | 7.8 s | 157.8 s | `slow_wait finished after 150s: the owner says PINEAPPLE` |
| stdio | `slow_wait` 150 s | 7.7 s | 157.7 s | same |

Each turn took 153.5 s and ended `end_turn`. The server measured 149.99 s. Nothing between Hermes and the server needed a keep-alive.

The timeout is 300 s by default. From Hermes's source (`tools/mcp_tool_common.py`), the precedence is `mcp_servers.<name>.timeout`, then `timeouts.mcp.tool_call`, then 300 s. The ceiling is 365 days. Servers passed through ACP cannot carry a `timeout` field, so the profile's `timeouts.mcp.tool_call` is the control.

| Profile config | Call | Outcome |
| --- | --- | --- |
| no `timeouts` key | `slow_wait` 320 s | Failed at 300.0 s with `MCP call failed: TimeoutError: MCP call timed out after 300.0s (configured timeout: 300.0s)`. The turn still ended `end_turn` (`s5-mcp-slow-long-default`). |
| `timeouts.mcp.tool_call: 1800` | `slow_wait` 320 s | Completed after 320 s (`s5-mcp-slow-long-cfg1800`). |
| `timeouts.mcp.tool_call: 8` | `slow_wait` 15 s | Failed at 8.0 s with `configured timeout: 8.0s` (`s10-timeouts`). |

I did not test values above 1800 or a per-server `timeout` on a config-defined server.

### Who is calling

The server can tell. The URL path, a static header and, for stdio, an env var all arrived unchanged (`identity: {"employee":"alice","xEmployee":"alice"}` over http, `employee: "alice"` over stdio). The MCP `tools/call` carries `_meta: {}`, so the request names neither the ACP session nor the tool call. Identity has to be baked into the connection.

Hermes keys MCP connections by server name for the whole process. Two sessions in one process, both naming their server `office`, with URLs `/mcp/alice` and `/mcp/bob`, both reached the server as alice, and the two 12 s calls ran one after the other, 12 s apart, in 26.9 s (`s9-two-sessions`, `s21-parallel`, `mcp-http.log` lines for 05:10:30 and 05:10:42). With names `office_alice` and `office_bob`, each session reached its own URL, the calls started 35 ms apart and finished in 14.8 s (`s21-parallel-distinct`), and the bob session did not see `mcp__office_alice__echo` (`s22-distinct-names`).

## 4. Permissions

Hermes sends `session/request_permission` in three cases, and it does not send it for others.

| Situation (`approvals.mode: manual`) | Request? | Title and options |
| --- | --- | --- |
| Shell command that matches a dangerous pattern (`rm -rf`) | Yes | `recursive delete: <full command>`. Five options. |
| Benign shell command (`date -u +%Y`) | **No**. It ran. | |
| File edit in mode `default` | Yes | `Approve edit: <path>`. Two options. `content` is a `diff` block, `rawInput` has the path and content. |
| Shell command with a `pre_tool_call` hook that returns `approve` | Yes | The hook's message, then `: <terminal> (plugin approval rule)`. Five options. |
| `execute_code` (Python that calls `subprocess`) with a hook on `terminal` only | **No**. It ran. | |

The five shell options are `allow_once` (kind `allow_once`), `allow_session` and `allow_always` (kind `allow_always`), `deny` (kind `reject_once`) and `deny_always` (kind `reject_always`). Edits offer only `allow_once` and `deny`.

### Answering

The client returns `{ outcome: { outcome: "selected", optionId } }` for the option id.

- `deny` fails the tool call. The model sees the block message, for example `The command was blocked with the error: "office policy: every shell command needs the owner"`.
- `{ outcome: { outcome: "cancelled" } }` behaves like `deny`.
- `allow_session` allowed the command and the next command in that session did not ask. I did not test `allow_always` or `deny_always`. They may write a persistent allowlist, so the office should offer only `allow_once` and `deny`.
- A command that is both hooked and dangerous asked twice, once per gate (`s13-profile`).

The wait has a limit. `approvals.timeout` is 300 s by default (source, `tools/approval_context.py`). With `approvals.timeout: 5` and a client that answered at 9 s, Hermes blocked the command at 5 s with `BLOCKED: Command timed out without user response. The user has NOT consented to this action` and ignored the late answer (`s10-timeouts`). With `timeout: 600`, a client that held the request for 150 s and then allowed it got the command run (`s11-longperm`).

### Edits inside the working folder

`session/set_mode` accepts `default` (ask before edits), `accept_edits` (auto-allow edits in the workspace and the temp dir, ask for sensitive paths) and `dont_ask` (auto-allow edits everywhere except sensitive paths). It returns `{}`.

In `accept_edits` with session cwd `work1` and a process started in another folder (`s16-cwd`):

| Edit | Asked? |
| --- | --- |
| absolute path inside `work1` | No |
| relative path (`rel1.txt`) | **Yes**. Hermes resolved it against the process cwd for the check, though the file landed in `work1`. |
| absolute path in a sibling folder | Yes |
| absolute path in the home folder | Yes |
| `.env` inside `work1` (`s4-perm`) | Yes. `.git`, `.ssh` and sensitive file names always ask. |

With the process cwd equal to the session cwd, the relative path was allowed silently (`s4b-perm2`). Spawn `hermes acp` with `cwd` set to the block folder.

### Making shell commands ask

Add a `pre_tool_call` shell hook to the profile config:

```yaml
hooks:
  pre_tool_call:
    - matcher: "terminal|execute_code|process_manage"
      command: /path/to/office-approve-hook
      timeout: 30
hooks_auto_accept: true
```

`hooks_auto_accept` matters because there is no TTY for the consent prompt. `hermes acp --accept-hooks` does the same. Hermes runs the hook with a JSON payload on stdin and reads `{"action":"approve","message":"..."}` from stdout. The payload has `tool_name`, `tool_input` (`{ command }` for `terminal`), `cwd`, `profile` and a `session_id` that equals the ACP session id (checked against `s4b-perm2`). According to the Hermes hook docs, `block` with a message denies without asking and other output is ignored. I only ran `approve`.

The ACP request itself shows only `<terminal> (plugin approval rule)` as the command. Put the command in the hook's `message` so the owner card can show it. This hook did that and the request title became `owner approval needed for terminal: date -u +%Y: <terminal> (plugin approval rule)`:

```sh
#!/bin/sh
exec /usr/bin/python3 -c '
import json, sys
p = json.load(sys.stdin)
cmd = (p.get("tool_input") or {}).get("command") or json.dumps(p.get("tool_input"))[:300]
print(json.dumps({"action": "approve", "message": "owner approval needed for " + p["tool_name"] + ": " + str(cmd)[:300]}))
'
```

With `matcher: "terminal"` only, `execute_code` ran a `subprocess` call with no request. Widening the matcher to `terminal|execute_code|process_manage` made it ask (`s19-bypass`). I did not test whether `delegate_task` children go through the hook.

### `-z` is different

`hermes -z` auto-approves. With `approvals.mode: manual`, `hermes -z "run mkdir -p zdir && touch zdir/marker && rm -rf zdir && echo RAN-OK > zran.txt"` ran the whole command and wrote `zran.txt`. With the approve hook active, `-z` still ran `echo RAN-OK > zran.txt`. ACP mode does not do this.

## 5. Interrupting

| Action | What happened |
| --- | --- |
| `session/cancel` during an MCP call | `tool_call_update` with `status: failed` and text `MCP call interrupted: user sent a new message`, 29 ms later. The prompt returned `cancelled` after 39 ms (`s6-cancel-mcp`). |
| `session/cancel` during `sleep 47` | The command was killed (`[Command interrupted]`, `exit_code: 130`). The prompt returned `cancelled` after 98 ms (`s6-cancel-shell`). |
| `session/cancel` while a permission request was unanswered | The prompt returned `cancelled` after 4.0 s. The client's request stayed open, and the late answer was ignored (`s24-cancel-perm`). Answer `cancelled` yourself when you send the cancel. |
| A plain `session/prompt` while a turn runs | It does not error and does not queue. The call returned `end_turn` after 3 ms with the message `Redirected the active turn with your correction.` The running turn applied the text after its tool finished: the final reply came out in French and mentioned BANANA, as asked (`s6-second-prompt`). |
| `/steer text` while a turn runs | Returned at once with `⏩ Steer queued for the active turn: ...`. It took effect at the next model step, 17 s later, after the running tool returned. The final reply was in capitals and mentioned BANANA (`s6-steer`). |
| `/queue text` while a turn runs | Returned `Queued for the next turn. (1 queued)`. The queued text ran after the turn inside the same `session/prompt` call, echoed as a `user_message_chunk`. |

Mid-turn injection therefore exists in two spellings, and both wait for the next model step. An employee blocked in a long `ask_owner` call does not see a steer until that call returns. The office should end its own pending `ask_owner` with the interjection as the result.

The redirect is text-only. Hermes redirects only when the prompt has no image blocks and the runtime supports it (`acp_adapter/server.py`, `_claim_turn_or_queue`), and otherwise queues. I saw the redirect path only on Anthropic.

The acknowledgement messages arrive as `agent_message_chunk` on the same session while the second `session/prompt` is in flight. They are system text, not the employee speaking. Filter chunks that arrive during a second in-flight prompt.

After a cancel, the next plain-text prompt gets the cancelled request re-attached. The stored user message was `Use the terminal tool to run exactly: sleep 15 && echo done\n\nUser correction/guidance after interrupt: Reply with exactly: fresh` (`reattach-evidence.txt`). `/reset` does not clear it. In one variant the model re-ran the cancelled command after `/reset` (`s18-reattach`). The behavior suits "stop and redirect". For an unrelated task after a stop, open a new session.

On cancel Hermes also sends `notifications/cancelled` to the MCP server as a separate POST. My probe server built a new server instance per request, so it could not match that notification to the running handler, and the handler ran to the end (59.99 s). A stateful server that tracks in-flight calls per employee can abort the call. Cancel on the office side either way, because the office knows it sent the cancel.

## 6. Resume

`session/list` returned the sessions of the profile with `cwd`, `title` and `updatedAt`. A session appears only after its first prompt.

The seed process asked "Remember this secret word ... ZEPHYR-42" and replied `noted`. The process was then killed, once with `SIGTERM` and once with `SIGKILL` right after the turn. A fresh process ran `session/load { sessionId, cwd, mcpServers: [] }`, which took 1.2 to 2.4 s. Hermes replayed the history as `user_message_chunk` and `agent_message_chunk` updates. The next prompt "What was the secret word?" was answered `ZEPHYR-42` both times (`s7-seed`, `s7-load`, `s7-resume`). `session/resume` also worked and replayed the history in this run.

State after `session/load` in a fresh process (`s26-*`), when the seed session had `set_model` to `claude-sonnet-5-5` and `set_mode` to `accept_edits`:

| State | After load |
| --- | --- |
| model | `anthropic:claude-sonnet-5-5`. Kept. |
| mode | `default`. **Reset.** Send `session/set_mode` again. |
| MCP servers | Not restored. Pass `mcpServers` in the load request. |

The office must store the `sessionId` per employee. Sessions are per profile, so the office profile must survive app restarts, which it does because it is a normal directory under `~/.hermes/profiles/`.

## 7. Isolation and memory

### What ACP loads from the home

Everything below comes from `HERMES_HOME`. I tested each on a profile with a config-defined stdio MCP server (`mcp_servers.cfgtest`), a SOUL.md, a `memories/MEMORY.md` and a skill, and sessions created with `mcpServers: []` (`s25-flags-plain`, `skills-probe`).

| Item | Loaded in ACP? | Evidence |
| --- | --- | --- |
| MCP servers in `config.yaml` | Yes | `mcp__cfgtest__echo` and `mcp__cfgtest__slow_wait` in `/tools` |
| `SOUL.md` | Yes | Reply ended with the token from the file |
| `memories/MEMORY.md` | Yes | Reply quoted the fact from the file |
| Skills in `skills/` | Yes | `skills_list` returned the probe skill |
| `hooks` in `config.yaml` | Yes | The hook ran (`s4b-perm2`) |
| `AGENTS.md`, `.hermes.md` in the cwd | Yes | Section 2 |

So an ACP session on the default home gets the owner's personal config. That home has `mcp_servers` entries named `composio` and `linear`, a `mcp.json` naming `composio` and `higgsfield`, `memory_enabled: true` with entries in `MEMORY.md` and `USER.md`, a SOUL.md, about 170 skills and `approvals.mode: off` (names and sizes only, no contents). The earlier attempt's `/tools` on that home listed 17 entries, 14 direct tools plus `tool_search`, `tool_describe` and `tool_call` (`runs/s8-default.out`).

The launch flags are not isolation in ACP mode. Same profile, four launches (`s25-flags-*`):

| Launch | Tools | Config MCP tools | Memory and SOUL applied |
| --- | --- | --- | --- |
| `hermes acp` | 35 | 2 | yes |
| `hermes --ignore-user-config acp` | 35 | 2 | yes |
| `hermes --ignore-rules acp` | 35 | 2 | yes |
| `hermes --safe-mode acp` | 31 | 0 | yes |

### Profiles

`hermes profile create office --no-alias --no-skills` made `~/.hermes/profiles/office` with its own `config.yaml` (model `claude-opus-4-7`, provider `anthropic`), default `SOUL.md`, an empty `.env` template, and empty `memories/`, `sessions/`, `skills/` and `state.db`. `--no-alias` skips the wrapper script in `~/.local/bin`. `hermes -p office <command>` selects the same home, according to `hermes --help`. I launched with `HERMES_HOME=~/.hermes/profiles/<name>` in the environment.

Do not use `--clone`. It copied the owner's `config.yaml`, `.env` (15 variables), `SOUL.md`, skills and also both memory files (`MEMORY.md` 6,295 bytes and `USER.md` 1,405 bytes, same sizes and dates as the default's). I deleted that profile without launching it.

Two processes on one profile ran at the same time without trouble (the two 150 s runs and the 320 s runs). Their `state.db` is SQLite.

**What auth needs.** Nothing was copied. The fresh profile had an empty `.env` and no `auth.json`, and Hermes resolved `provider: anthropic`, `source: claude_code`:

```
{'provider': 'anthropic', 'api_mode': 'anthropic_messages', 'base_url': 'https://api.anthropic.com', 'api_key': '<set, len 108>', 'source': 'claude_code', ...}
```

On this Mac the source is Claude Code's login, which is the Keychain item `Claude Code-credentials` (there is no `~/.claude/.credentials.json`). In profile mode Hermes also reads the root `~/.hermes/auth.json` as a read-only fallback per provider (docstring in `hermes_cli/auth.py`). That fits the fresh profile listing 36 models across providers. It follows that an employee run consumes the owner's Claude subscription and its rate limit, and that Hermes and Claude Code employees compete for the same limit.

**The outside-`~/.hermes` trap.** Hermes treats a `HERMES_HOME` under `~/.hermes` as the same root, and any other path as a new root (`get_default_hermes_root` in `hermes_constants.py`). A new root has no install stamp, so the launcher's `prepare_launch` runs a source-update completion. With `HERMES_HOME=/tmp/office-research/hermes/home-min` the first `hermes acp` printed `hermes: completing source-update dependencies...`, built a 683 MB environment and a 430 MB tool copy under the new home, then rebuilt the TUI, the web UI and the desktop app. Those builds write into `~/.hermes/hermes-agent`, and `publish_launchers` rewrote `.hermes/bin/hermes` and `hermes-acp` with the scratch interpreter path. Setting `HERMES_DISABLE_LAZY_INSTALLS=1` makes `prepare_launch` return early (source, `hermes_cli/venv_sync.py`). I did not test it as a workaround. Profiles avoid the whole problem.

### Memory

Hermes memory persists across sessions and processes once the model saves something. On the office profile (`mem2-*`):

| Step | Result |
| --- | --- |
| "Please save to your persistent memory: the office wifi hint is saffron-otter-88" | Reply `Saved.` `~/.hermes/profiles/<name>/memories/MEMORY.md` held `Office wifi hint: saffron-otter-88` (34 bytes). |
| "By the way, my dog is called Biscuit" | Reply `ok`. Nothing was saved. |
| New process, "What is the office wifi hint, and my dog's name?" | `saffron-otter-88` and `unknown`. |
| Same, with `memory.memory_enabled: false` | The fact was not recalled, and the `memory` tool was missing from `/tools`. |

So memory is automatic only when the model decides to call the `memory` tool. It lives in `<HERMES_HOME>/memories/MEMORY.md`, and `USER.md` holds the user profile (`memory.user_profile_enabled`). To turn it off for employees, set `memory.memory_enabled: false` in the office profile. R3 recommends office-owned memory, so turn it off. Hermes also has a `session_search` tool over past sessions in the profile's `state.db`. I did not test disabling it.

## 8. Latency and cost

Times from the process start of a fresh `hermes acp`, prompt "Reply with exactly: pong", `reasoning_effort: low`, no MCP servers (`s15-*`, milliseconds):

| Model | `initialize` | `session/new` | `set_model` | First chunk | Prompt total | Input tokens (cached) |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku 4.5 (default), run 1 | 972 | 1295 | 0 | 1018 | 1662 | 15,840 (14,841) |
| Haiku 4.5, run 2 | 1118 | 1092 | 0 | 1106 | 1710 | 15,840 (15,837) |
| Opus 4.7, run 1 | 857 | 1110 | 411 | 1591 | 1806 | 21,256 (0) |
| Opus 4.7, run 2 | 784 | 1330 | 418 | 1496 | 1606 | 21,256 (21,250) |
| Sonnet 5.5 | 1557 | 2191 | 388 | 1835 | 2395 | 20,866 (0) |

The first `session/new` in a profile took 6.4 s once and 1.1 to 1.9 s afterwards. With one HTTP MCP server it took 2.2 s, and the second session in the same process 0.27 s.

- A "pong" costs 15.8 to 21.3 thousand input tokens because the system prompt and 33 to 35 tool schemas ride along. Most of it is cached from the second turn on.
- With the default `tools.tool_search` setting, MCP tools are deferred. `/tools` showed 32 tools with no `office_alice` entry, and the model called `tool_describe` before `mcp__office_alice__echo` (`s27-toolsearch`). Set `tools.tool_search.enabled: "off"` so `ask_owner` is a direct tool. That is what the other probes ran with.
- Each process used 210 to 235 MB of RSS.
- The owner's own default config uses `reasoning_effort: max`. A "pong" on Opus 4.7 with that config took 9.5 s (`runs/s15-default-opus47-effortmax`, earlier).

## 9. ACP as a common protocol

Quick check only. `--help` this run, handshake from the earlier attempt's logs (`runs/s12-*`).

| CLI on this Mac | ACP entry point | Handshake (`runs/s12-*`) |
| --- | --- | --- |
| Hermes 0.21.5 | `hermes acp` | `loadSession`, no `mcpCapabilities`, image |
| Gemini CLI 0.40.1 | `gemini --acp` (`--experimental-acp` deprecated) | `loadSession`, mcp http and sse, image, audio, embeddedContext |
| OpenCode 1.18.33 | `opencode acp` | `loadSession`, mcp http and sse, session `close`, `fork`, `list`, `resume` |
| Cursor Agent 2026.07.01 | `cursor-agent acp` | `loadSession`, mcp http and sse, image, session `list` |
| Kimi Code CLI 1.50.0 | `kimi acp` | `loadSession`, mcp http only, session `list`, `resume` |
| Codex | none. `codex app-server` is a different protocol (R1). | |
| Claude Code | none. It has no ACP flag. | |

Adapters exist on npm. `@agentclientprotocol/claude-agent-acp` 0.84.0 (Claude Agent SDK, published 2026-09-28) and `@agentclientprotocol/codex-acp` 2.0.0 (2026-09-28). The older `@zed-industries/claude-code-acp`, `@zed-industries/claude-agent-acp` and `@zed-industries/codex-acp` carry deprecation notices pointing at those names. I did not install or run them.

One generic ACP client can cover Hermes, Gemini, OpenCode, Cursor and Kimi as they are, and Codex and Claude Code through the adapters. The shared part is `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load`, `session/update` and `session/request_permission`. The parts that differ, and would need a small per-harness table, are:

- How the model is switched (`session/set_model` is not advertised by Hermes but works).
- Mode ids (`default`, `accept_edits`, `dont_ask` for Hermes).
- Permission option ids and kinds.
- Whether a mid-turn prompt steers, queues or errors.
- Whether `mcpCapabilities` tells the truth.
- Where persona and memory come from.
- What `stopReason` means after an error.

R1 covers Codex through `app-server`. Compare `codex-acp` against it before committing to one path.

## Recommended adapter design

### Process and profile

- **One profile for all employees**, `~/.hermes/profiles/office`, created by the app once. The app owns its `config.yaml`. It has the office's settings (below), no `mcp_servers`, `memory.memory_enabled: false`, no skills. Persona and memory digest go in the first prompt of a session, which fits R3's office-owned memory. If you want `SOUL.md` per employee, use one profile per employee. A fresh profile is about 2 MB on disk.
- **One `hermes acp` child per employee**, spawned with `cwd` set to the block folder and `HERMES_HOME` set to the profile. The child count is small (about 220 MB each). This gives per-employee crash isolation and the right relative-path behavior.
- **One MCP server for the app**, on a local port, with one URL per employee (`/mcp/<employeeId>/<secret>`) and server name `office_<employeeId>`. It must be stateful so it can abort an in-flight call.

Profile `config.yaml` (each key was tested at the value shown or a smaller one):

```yaml
model:
  default: claude-opus-4-7
  provider: anthropic
  base_url: https://api.anthropic.com
  api_mode: anthropic_messages
approvals:
  mode: manual
  timeout: 3600
memory:
  memory_enabled: false
timeouts:
  mcp:
    tool_call: 86400
tools:
  tool_search:
    enabled: "off"
hooks:
  pre_tool_call:
    - matcher: "terminal|execute_code|process_manage"
      command: /path/to/office-approve-hook
      timeout: 30
hooks_auto_accept: true
```

`approvals.timeout` was tested at 5 and 600, and `timeouts.mcp.tool_call` at 8 and 1800. Larger values follow the same code path and the source caps them at 365 days.

### Verb mapping

| Office verb | ACP calls | Notes |
| --- | --- | --- |
| `assign` | Spawn the child if needed, `initialize`, then `session/new { cwd, mcpServers }`, `session/set_model`, `session/set_mode accept_edits`, `session/prompt` with persona, memory digest and task | Store the `sessionId`. The turn ends when the request resolves. Map `tool_call.kind` to the employee animation and `agent_message_chunk` to the log. |
| `interject`, tap on the shoulder | While a normal tool or model call runs, send a plain `session/prompt` (or `/steer text`). If the employee is blocked in `ask_owner`, resolve that pending call with the interjection as its result | The steer lands at the next model step. Hide the `Redirected` and `Steer queued` chunks as system acks. |
| `interject`, hard stop | `session/cancel`, then wait for `stopReason: "cancelled"`. Answer any pending permission with `cancelled` and end any pending `ask_owner`. Optionally follow with a `session/prompt` carrying the new instruction | Takes 30 to 100 ms mid-tool. Hermes re-attaches the stopped prompt to the follow-up. |
| `answer` to `ask_owner` | No ACP call. Resolve the held MCP HTTP request | Hermes waits up to `timeouts.mcp.tool_call`. |
| `answer` to a permission | Return `{ outcome: { outcome: "selected", optionId: "allow_once" } }` or `"deny"` from the `session/request_permission` handler | Show the command from the title and `rawInput`. Offer only these two options. |
| `stop` | Same as a hard stop without the follow-up. Keep the child warm or `kill()` it | For an unrelated next task, use a new session. |
| `resume` | New child, `initialize`, `session/load { sessionId, cwd, mcpServers }`, `session/set_mode accept_edits`, then prompt | The history replays as updates. Skip them in the UI or use them to rebuild the log. |
| fire, quit the app | `SIGTERM` the child | |

When the owner's approvals card, the permission request and `ask_owner` all wait on a person, the employee walks to the owner in all three cases. The app sees each one directly, as an incoming `session/request_permission` or an incoming MCP `tools/call`.

### Minimal client that ran

`office-hermes.ts` (typechecked with `tsc --strict`) runs one turn. The demo asked the employee to call the office `echo` tool, write `snippet-ok.txt` in the block folder, and run `echo shell-ok`.

```ts
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface Employee {
	id: string;
	profileHome: string; // ~/.hermes/profiles/<name>: config, SOUL.md, memories, sessions
	blockDir: string; // process cwd and session cwd, so accept_edits resolves relative paths
	mcpUrl: string; // per-employee URL on the office MCP server
	model: string; // e.g. "anthropic:claude-haiku-4-5-20251001"
	resumeSessionId?: string;
}
export interface Owner {
	decide(title: string, options: { optionId: string; kind: string }[]): Promise<string | null>; // optionId, or null = cancel
}

export async function runTurn(e: Employee, task: string, owner: Owner, onText: (t: string) => void) {
	const child = spawn("/Users/feliperico/.local/bin/hermes", ["acp"], {
		cwd: e.blockDir, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, HERMES_HOME: e.profileHome },
	});
	const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
	const app = acp
		.client({ name: "online-office" })
		.onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
			const optionId = await owner.decide(ctx.params.toolCall.title ?? "", ctx.params.options);
			return { outcome: optionId ? { outcome: "selected" as const, optionId } : { outcome: "cancelled" as const } };
		})
		.onNotification(acp.methods.client.session.update, (ctx) => {
			const u = ctx.params.update;
			if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") onText(u.content.text);
		});
	try {
		return await app.connectWith(stream, async (ctx) => {
			await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
			const mcpServers: acp.McpServer[] = [{ type: "http", name: `office_${e.id}`, url: e.mcpUrl, headers: [] }];
			let sessionId: string;
			if (e.resumeSessionId) {
				sessionId = e.resumeSessionId;
				await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: e.blockDir, mcpServers });
			} else {
				({ sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: e.blockDir, mcpServers }));
			}
			await ctx.request("session/set_model", { sessionId, modelId: e.model });
			await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: "accept_edits" }); // mode resets to "default" on load
			const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: task }] });
			return { sessionId, stopReason };
		});
	} finally {
		child.kill();
	}
}
```

Typing note. `mcpServers` needs the `acp.McpServer[]` annotation. Without it, TypeScript falls back to the untyped `request` overload and `sessionId` becomes `unknown`.

Result of the demo run (the profile's hook then said `office policy: every shell command needs the owner`):

```json
{
 "res": { "sessionId": "8fff2f9e-464c-4b1c-a0f3-a67c9cfd2145", "stopReason": "end_turn" },
 "permissionsAsked": [
  "office policy: every shell command needs the owner: <terminal> (plugin approval rule) [allow_once,allow_session,allow_always,deny,deny_always]"
 ],
 "reply": "I'll execute these three tasks together:\n\nfinished"
}
```

`snippet-ok.txt` contained `hello from alice`. Hermes logged `Auto-approved ACP edit under policy workspace_session: snippet-ok.txt` for the write, and the echo call reached the MCP server as `alice`. The shell command asked once, and the demo answered `allow_once`.

### Open items before U3

- Test `allow_always`, `deny_always` and `delegate_task` under the hook, or remove `delegate_task` from the profile's toolsets.
- Test an unreachable MCP server at `session/new` (the office server will be up first, but the failure mode is unknown).
- Decide the persona route (first prompt or per-employee `SOUL.md`) and the stop-then-new-task rule.
- Measure a raised `timeouts.mcp.tool_call` with a call longer than 320 s if `ask_owner` may block for hours.
- Handle the 429 case. A rate-limited turn can block for 20 minutes, and it ends as a normal `end_turn` with error text.
- Decide whether the app should require and verify a Claude login, since every Hermes employee runs on it.

## Side effects and cleanup

These are the things this run and the earlier attempt touched outside `/tmp/office-research/hermes/`. `~/.hermes/config.yaml` and `~/.hermes/SOUL.md` are unchanged. Their mtimes are still 1790570359 and 1788268742, the values at the start of this run.

1. **A shared install was rebuilt, and I repaired the launchers.** My first launch with `HERMES_HOME` set to a scratch folder triggered the completion described in section 7. I killed it during desktop packaging. It had already rewritten build outputs under `~/.hermes/hermes-agent` (`hermes_cli/web_dist`, `ui-tui/dist`, `apps/desktop/dist`, `apps/desktop/build`) from the same source, and it had republished `.hermes/bin/hermes` and `.hermes/bin/hermes-acp` pointing at `/tmp/office-research/hermes/home-min/tools/.../python3`. I replaced that interpreter path with `/Users/feliperico/.hermes/tools/python-3.14.7+20260901-darwin-arm64/bin/python3`, which is the path the running gateway's command line showed for the same launcher before the incident. `hermes --version`, `hermes acp --check` and the dashboard on port 9119 answered normally afterwards, and `apps/desktop/release/` (the packaged app) was untouched. I have no copy of the old build outputs. If the dashboard or the TUI misbehaves, `hermes update` rebuilds them.
2. **The earlier attempt ran against the default home.** Five ACP sessions (`source = acp`, started 2026-09-28 22:20 to 22:49) remain in `~/.hermes/state.db`, along with one `request_dump_*.json` in `~/.hermes/sessions/`. I did not delete them because that means writing to the owner's database.
3. **One probe of this run also hit the default home.** `s2-new.ts` launched without a profile once. It created no session row, and Hermes read the default `.env` and config. I then made `lib.ts` refuse to launch unless `HERMES_HOME` is an `office-r2*` profile.
4. **Profiles.** I used `office-r2` and `office-r2b`, created a `--clone` profile `office-r2c` that copied user data (deleted before it ran), and found `officetmp` from the earlier attempt. All four were removed with `hermes profile delete -y`. Each left an 8-byte tombstone in `~/.hermes/profiles/.deleted/`. The delete command warned that the gateway is running and will be stopped. The owner's gateway (PID 4565) kept running and its heartbeat stayed fresh. While they existed, the owner's multiplexed gateway listed my temporary profiles as running.
5. **A stray file.** The `accept_edits` probe wrote `/Users/feliperico/office-probe-outside.txt` after my test client allowed it. I deleted it.
6. **Credentials.** No credential file was copied for any experiment. Auth came from the Claude Code login (source `claude_code`). The only credential file names touched by a cloned profile were `.env` and, indirectly, the root `auth.json` fallback. No contents were printed.

All processes I started (probe servers, `hermes acp` children, `tsx` runs) were stopped and I confirmed none remain. The one `node mcp-http.ts` still running belongs to R1 (its cwd is `/tmp/office-research/codex`) and I left it alone.
