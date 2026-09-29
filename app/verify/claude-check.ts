// No model, no network. The real Claude adapter against a scripted stand-in for the Agent SDK's query(): what the
// adapter starts the SDK with, what it sends it, and what it tells the office about what comes back.
// Run from app/: node verify/claude-check.ts   Exits 1 on any failed check.
import type { CanUseTool, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSession, PushQueue, type ClaudeRun } from '../src/main/office/adapters/claude.ts';
import type { SessionHost } from '../src/main/office/adapters/types.ts';
import type { BlockId, Employee, EmployeeId, ModelId, PermissionPolicy, QuestionBody } from '../src/shared/protocol.ts';
import { check, finish, until } from './check.ts';

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
    setModel: async (model) => void p.calls.push(`setModel ${model}`),
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
  let answer = 'Allow';
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
    taskCompleted() {},
  };
  return { employee, host, asked, said, logs, answers: (text: string) => void (answer = text), session: new ClaudeSession(host, run) };
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
const idle = scripted('m1');
idle.employee.model = 'm3' as ModelId;
idle.session.setModel('m3' as ModelId);
check(processes.length === 1, 'setModel on a session with no process starts nothing');
idle.session.assign('later');
check(processes.length === 2 && processes[1]!.options.model === 'm3', 'the next process starts on the new model');

console.log('\n# permissions');
ana.employee.permissions = { mode: 'yolo', alwaysAllow: [] };
ana.session.permissionsChanged(ana.employee.permissions);
check(first.calls.join() === 'setModel m2', 'a policy change touches no live process yet');
first.out.close();
await until(() => ana.employee.status.kind === 'error');
ana.session.assign('again');
const second = processes[2]!;
check(processes.length === 3 && second.options.permissionMode === 'acceptEdits' && second.options.resume === 'sess-1' && second.options.model === 'm2', 'a restart keeps acceptEdits until F1 maps the modes, resumes the conversation and starts on the model picked since');

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

ana.session.stop();
idle.session.stop();
finish();
