// No model, no network. The real Claude adapter against a scripted stand-in for the Agent SDK's query(): what the
// adapter starts the SDK with, what it sends it, and what it tells the office about what comes back.
// Run from app/: node verify/claude-check.ts   Exits 1 on any failed check.
import type { CanUseTool, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSession, PushQueue, type ClaudeRun } from '../src/main/office/adapters/claude.ts';
import type { SessionHost } from '../src/main/office/adapters/types.ts';
import type { BlockId, Employee, EmployeeId, ModelId, PermissionPolicy, QuestionBody, Subagent } from '../src/shared/protocol.ts';
import { check, finish, sleep, until } from './check.ts';

// One per SDK process the adapter starts. `out` is what the SDK streams back.
type Process = { options: Options; sent: SDKUserMessage[]; calls: string[]; out: PushQueue<SDKMessage> };
const processes: Process[] = [];
const run: ClaudeRun = ({ prompt, options }) => {
  const p: Process = { options, sent: [], calls: [], out: new PushQueue() };
  processes.push(p);
  void (async () => {
    for await (const m of prompt) p.sent.push(m);
  })();
  return {
    [Symbol.asyncIterator]: () => p.out[Symbol.asyncIterator](),
    interrupt: async () => void p.calls.push('interrupt'),
    setModel: async (model) => {
      p.calls.push(`setModel ${model}`);
      if (model === 'refused') throw new Error("Model 'refused' not found");
    },
    setPermissionMode: async (mode) => void p.calls.push(`setPermissionMode ${mode}`),
    close: () => void (p.calls.push('close'), p.out.close()),
  };
};

// Only the fields the adapter reads, in the shape the SDK sends them.
const sdk = (m: unknown) => m as SDKMessage;
const init = (sessionId: string) => sdk({ type: 'system', subtype: 'init', session_id: sessionId, model: 'm', tools: [], skills: [], plugins: [], mcp_servers: [] });

function scripted(model = 'm1', policy: PermissionPolicy = { mode: 'inherit', alwaysAllow: [] }) {
  const employee: Employee = {
    id: 'e1' as EmployeeId,
    name: 'Ana',
    provider: 'claude-code',
    blockId: 'b1' as BlockId,
    desk: 0,
    status: { kind: 'idle' },
    activity: '',
    model: model as ModelId,
    permissions: policy,
    subagents: [],
    hiredAt: 0,
  };
  const asked: QuestionBody[] = [];
  const said: string[] = [];
  const logs: string[] = [];
  const started: Subagent[] = [];
  const finished: string[] = [];
  let answer = 'Allow';
  let rules = '';
  const host: SessionHost = {
    employee,
    block: { id: employee.blockId, name: 'repo', cwd: '/work/repo', color: '#000', slot: 0 },
    companyName: 'Gazapina Labs',
    get model() {
      return employee.model;
    },
    get permissions() {
      return employee.permissions;
    },
    setStatus: (status) => void (employee.status = status),
    setActivity: (text) => void (employee.activity = text),
    setSessionId: (id) => void (employee.sessionId = id),
    said: (text) => void said.push(text),
    log: (line) => void logs.push(line),
    ask: async (body) => (asked.push(body), answer),
    mcp: { url: 'http://127.0.0.1:1/mcp/scripted', name: 'office' },
    memoryDigest: () => '',
    rules: () => rules,
    taskCompleted() {},
    subagentStarted: (subagent) => void started.push(subagent),
    subagentFinished: (id) => void finished.push(id),
  };
  return { employee, host, asked, said, logs, started, finished, answers: (text: string) => void (answer = text), setRules: (text: string) => void (rules = text), session: new ClaudeSession(host, run) };
}
const canUse = (p: Process) => async (name: string, input: Record<string, unknown>) => {
  const decision = await p.options.canUseTool!(name, input, { signal: new AbortController().signal, toolUseID: 'toolu_x' } as Parameters<CanUseTool>[2]);
  if (!decision) throw new Error(`canUseTool gave no decision for ${name}`);
  return decision;
};

console.log('# starting a process');
const ana = scripted();
ana.session.assign('hello');
const first = processes[0]!;
check(processes.length === 1 && (await until(() => first.sent.length === 1)) && first.sent[0]!.message.content === 'hello', 'the first message starts one SDK process and reaches it');
check(first.options.model === 'm1' && first.options.permissionMode === 'acceptEdits' && !('resume' in first.options), 'it starts on the employee model, in acceptEdits mode, with nothing to resume');
check(JSON.stringify(first.options.mcpServers).includes('http://127.0.0.1:1/mcp/scripted') && first.options.strictMcpConfig === true, 'it connects to the office MCP server and nothing else');

console.log('\n# model');
first.out.push(init('sess-1'));
await until(() => ana.employee.sessionId === 'sess-1');
ana.employee.model = 'm2' as ModelId;
ana.session.setModel('m2' as ModelId);
check(first.calls.join() === 'setModel m2', 'a live session switches models through the SDK');
ana.employee.model = 'refused' as ModelId;
ana.session.setModel('refused' as ModelId);
check((await until(() => ana.logs.length === 1)) && ana.logs[0] === "Could not switch to refused, still on the previous model: Model 'refused' not found", 'a switch the SDK refuses is told to the owner in the log');
ana.employee.model = 'm2' as ModelId;
const idle = scripted('m1');
idle.employee.model = 'm3' as ModelId;
idle.session.setModel('m3' as ModelId);
check(processes.length === 1, 'setModel on a session with no process starts nothing');
idle.session.assign('later');
check(processes.length === 2 && processes[1]!.options.model === 'm3', 'the next process starts on the new model');

console.log('\n# permissions');
ana.employee.permissions = { mode: 'yolo', alwaysAllow: [] };
ana.session.permissionsChanged(ana.employee.permissions);
check(first.calls.at(-1) === 'setPermissionMode bypassPermissions', 'a switch to yolo reaches the live process as bypassPermissions');
const yoloAsked = ana.asked.length;
const yolo = await canUse(first)('Bash', { command: 'rm -rf build' });
check(yolo.behavior === 'allow' && ana.asked.length === yoloAsked, 'in yolo a shell command runs without a card');
ana.employee.permissions = { mode: 'ask', alwaysAllow: [] };
ana.session.permissionsChanged(ana.employee.permissions);
check(first.calls.at(-1) === 'setPermissionMode default', 'ask maps to the default mode');
ana.employee.permissions = { mode: 'auto', alwaysAllow: [] };
ana.session.permissionsChanged(ana.employee.permissions);
check(first.calls.at(-1) === 'setPermissionMode auto', 'auto maps to the auto mode');
first.out.close();
await until(() => ana.employee.status.kind === 'error');
ana.session.assign('again');
const second = processes[2]!;
check(processes.length === 3 && second.options.permissionMode === 'auto' && second.options.resume === 'sess-1' && second.options.model === 'm2', 'a restart starts in the mode picked since, resumes the conversation and starts on the model picked since');
const stillYolo = scripted('m1', { mode: 'yolo', alwaysAllow: [] });
stillYolo.session.assign('go');
const yoloStart = processes.at(-1)!.options;
check(yoloStart.permissionMode === 'bypassPermissions' && yoloStart.allowDangerouslySkipPermissions === true, 'a yolo employee starts in bypassPermissions');

console.log('\n# permission cards');
const ask = canUse(second);
const allowed = await ask('Bash', { command: '  npm test  ' });
check(JSON.stringify(ana.asked.at(-1)) === JSON.stringify({ kind: 'permission', text: 'Can I run a shell command?', tool: 'Bash', detail: 'npm test' }) && allowed.behavior === 'allow', 'a shell command asks as the shell tool with the bare command in detail');
const edited = await ask('Write', { file_path: '/work/repo/src/a.ts' });
check(JSON.stringify(ana.asked.at(-1)) === JSON.stringify({ kind: 'permission', text: 'Can I use Write?', tool: 'Write', detail: 'src/a.ts' }) && edited.behavior === 'allow', 'a file tool asks with its path relative to the block');
ana.answers('no thanks');
const refused = await ask('Bash', { command: 'git push' });
check(refused.behavior === 'deny' && /no thanks/.test(refused.message), 'an answer that is not an allow denies and carries the owner words back');
const before = ana.asked.length;
const quiet = [await ask('Read', { file_path: '/work/repo/a.ts' }), await ask('mcp__office__ask_owner', { question: 'x' })];
check(quiet.every((r) => r.behavior === 'allow') && ana.asked.length === before, 'reading and the office tools never ask');

console.log('\n# subagents, as the SDK 0.3.283 streams them');
const assistant = (content: unknown[], parent: string | null = null) => sdk({ type: 'assistant', parent_tool_use_id: parent, message: { content } });
const agentCall = (id: string, description: string, input: Record<string, unknown> = {}, name = 'Agent') => ({ type: 'tool_use', id, name, input: { description, prompt: 'p', ...input } });
const taskStarted = (toolUseId: string, background: boolean) => sdk({ type: 'system', subtype: 'task_started', task_id: `task-${toolUseId}`, tool_use_id: toolUseId, is_backgrounded: background, task_type: 'local_agent' });
const taskEnded = (toolUseId: string, status = 'completed') => sdk({ type: 'system', subtype: 'task_notification', task_id: `task-${toolUseId}`, tool_use_id: toolUseId, status });
const toolResult = (toolUseId: string, isError = false, parent: string | null = null) =>
  sdk({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'x' }], is_error: isError }] } });
const turnEnd = () => sdk({ type: 'result', subtype: 'success', is_error: false, result: 'done', terminal_reason: 'completed' });
const feed = async (p: Process, ...messages: SDKMessage[]) => {
  for (const m of messages) p.out.push(m);
  await sleep(30);
};
const sub = scripted();
sub.session.assign('use a helper');
const stream = processes.at(-1)!;
const ids = (list: Subagent[]) => list.map((s) => `${s.id}<${s.parentId ?? ''}`).join(' ');

await feed(stream, init('sess-sub'), assistant([agentCall('fg', 'Count total lines in three files', { run_in_background: false })]));
check(ids(sub.started) === 'fg<' && sub.started[0]!.label === 'Count total lines in three files' && sub.finished.length === 0, 'an Agent tool call starts a subagent, labelled with its description');
await feed(stream, taskStarted('fg', false), assistant([{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: '/work/repo/a.txt' } }], 'fg'));
check(sub.started.length === 1, 'the subagent own tool calls are not subagents');
await feed(stream, taskEnded('fg'), toolResult('fg'));
check(sub.finished.join() === 'fg', 'a foreground subagent ends at its task_notification, and the tool_result after it ends nothing twice');

await feed(stream, assistant([agentCall('bg', 'Read three files')]), taskStarted('bg', true), toolResult('bg'));
check(ids(sub.started) === 'fg< bg<' && sub.finished.join() === 'fg', 'a background subagent is still running when the tool_result says it launched');
await feed(stream, assistant([{ type: 'text', text: 'I launched it.' }]), turnEnd());
check(sub.employee.status.kind === 'idle' && sub.finished.join() === 'fg', 'and when the turn that launched it is over');
await feed(stream, sdk({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }), taskEnded('bg'));
check(sub.finished.join() === 'fg,bg', 'it ends at its task_notification, later');

await feed(stream, assistant([agentCall('outer', 'Plan the work')]), assistant([agentCall('inner', 'Check one file', {}, 'Task')], 'outer'));
check(ids(sub.started) === 'fg< bg< outer< inner<outer', 'a subagent started inside another names it as its parent');
await feed(stream, assistant([{ type: 'tool_use', id: 'sh1', name: 'Bash', input: { command: 'ls' } }], 'outer'), sdk({ type: 'system', subtype: 'task_notification', task_id: 'bash-task', tool_use_id: 'sh1', status: 'completed' }));
check(sub.started.length === 4 && sub.finished.join() === 'fg,bg', 'a Bash call and the end of its background task are not subagents');
await feed(stream, toolResult('inner', true, 'outer'), taskEnded('inner', 'failed'));
check(sub.finished.join() === 'fg,bg,inner', 'a tool_result that is an error ends a subagent, once');
await feed(stream, assistant([agentCall('halted', 'Slow job')]), taskEnded('halted', 'stopped'), toolResult('halted', true));
check(sub.finished.join() === 'fg,bg,inner,halted', 'an interrupted subagent sends both signals and ends once');
stream.out.close();
await until(() => sub.employee.status.kind === 'error');
check(sub.finished.join() === 'fg,bg,inner,halted,outer', 'a process that dies takes its open subagents with it');

console.log('\n# rules');
const persona = (p: Process) => (p.options.systemPrompt as { append: string }).append;
check(!persona(first).includes('rules your boss'), 'a session with no rules has no rules section in its persona');
const ruled = scripted();
ruled.setRules('- Never touch the billing folder');
ruled.session.assign('start');
const ruledProc = processes.at(-1)!;
check(persona(ruledProc).includes('The rules your boss set for you') && persona(ruledProc).includes('- Never touch the billing folder'), 'the rules in scope are in the persona the session starts with');
await until(() => ruledProc.sent.length === 1);
ruled.session.rulesChanged('New rule: answer in Portuguese');
await until(() => ruledProc.sent.length === 2);
const notice = ruledProc.sent[1]!;
check(notice.priority === 'next' && typeof notice.message.content === 'string' && notice.message.content.includes('New rule: answer in Portuguese') && ruled.employee.status.kind === 'working', 'a rule change while the employee works goes to the live session as a next-priority message');
await feed(ruledProc, init('sess-rules'), turnEnd());
check(ruled.employee.status.kind === 'idle', 'the turn ends');
ruled.session.rulesChanged('First change');
ruled.session.rulesChanged('Second change');
await sleep(30);
check(ruledProc.sent.length === 2, 'a rule change between tasks sends nothing');
ruled.session.assign('the next task');
await until(() => ruledProc.sent.length === 3);
const carried = ruledProc.sent[2]!.message.content as string;
check(carried.indexOf('First change') < carried.indexOf('Second change') && carried.endsWith('\n\nthe next task') && ruledProc.sent[2]!.priority === undefined, 'both changes go in front of the next task, in order');
await feed(ruledProc, turnEnd());
ruled.session.assign('a third task');
await until(() => ruledProc.sent.length === 4);
check(ruledProc.sent[3]!.message.content === 'a third task', 'and only once');
await feed(ruledProc, turnEnd());
ruled.session.rulesChanged('Held for the boss to walk over');
ruled.session.interject('hey', 'next');
await until(() => ruledProc.sent.length === 5);
check((ruledProc.sent[4]!.message.content as string).startsWith('[Your boss changed the rules') && (ruledProc.sent[4]!.message.content as string).endsWith('said out loud]: hey'), 'a message that wakes an idle employee carries the held change too');

const cold = scripted();
cold.session.rulesChanged('Nobody is running');
cold.session.assign('first task');
const coldProc = processes.at(-1)!;
await until(() => coldProc.sent.length === 1);
check(coldProc.sent[0]!.message.content === 'first task', 'with no process running a rule change is dropped, because the next start reads the rules');
await feed(coldProc, turnEnd());
cold.session.rulesChanged('Held, then the process dies');
coldProc.out.close();
await until(() => cold.employee.status.kind === 'error');
cold.session.assign('after the crash');
const revived = processes.at(-1)!;
await until(() => revived.sent.length === 1);
check(revived.sent[0]!.message.content === 'after the crash', 'a change held when the process died is dropped with it');

ana.session.stop();
idle.session.stop();
sub.session.stop();
ruled.session.stop();
cold.session.stop();
finish();
