// No model, no Electron. The real Office, MCP server, inbox and memory store, with a scripted stand-in for the harness.
// It checks what the owner would see: cards, the order they come in, and where an employee goes back to afterwards.
// Run from app/: node verify/office-check.ts   Exits 1 on any failed check.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Employee, EmployeeId, EmployeeStatus, Question } from '../src/shared/protocol.ts';
import { HARNESSES } from '../src/main/office/adapters/index.ts';
import type { SessionHost } from '../src/main/office/adapters/types.ts';
import { Office, OfficeError } from '../src/main/office/company.ts';
import { startOfficeMcp } from '../src/main/office/mcp.ts';
import { MemoryStore } from '../src/main/office/memory.ts';
import { check, finish, until } from './check.ts';

process.env.OFFICE_START_LEVEL = '3';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'office-check-')));
const repo = join(dir, 'repo');
mkdirSync(repo);
const memRoot = join(dir, 'memory');
const memory = MemoryStore.open(memRoot);
const mcp = await startOfficeMcp();

// What a harness adapter does, reduced to its calls into the host.
type Fake = { host: SessionHost; assigned: string[]; interjected: string[]; stopped: boolean };
const fakes: Fake[] = [];
HARNESSES['claude-code'] = {
  detect: async () => 'fake',
  session: (host) => {
    const fake: Fake = { host, assigned: [], interjected: [], stopped: false };
    fakes.push(fake);
    return {
      assign: (task) => {
        fake.assigned.push(task);
        host.setStatus({ kind: 'working', task, startedAt: Date.now() });
        host.setActivity('Getting started');
      },
      interject: (text) => void fake.interjected.push(text),
      stop: () => void (fake.stopped = true),
    };
  },
};

const logs: string[] = [];
const office = new Office(
  join(dir, 'company.json'),
  { 'claude-code': { kind: 'ready', version: 'fake' }, codex: { kind: 'missing' }, hermes: { kind: 'missing' } },
  { changed() {}, said() {}, log: (_id, line) => void logs.push(line) },
  { mcp, memory },
);

const company = () => office.snapshot().company;
const who = (id: EmployeeId): Employee => company().employees.find((e) => e.id === id)!;
const statusOf = (id: EmployeeId): EmployeeStatus => who(id).status;
const shown = (id: EmployeeId): Question | undefined => {
  const s = company().employees.find((e) => e.id === id)?.status;
  return s?.kind === 'blocked_on_owner' ? s.question : undefined;
};
const answer = (id: EmployeeId, text: string) => office.handle({ type: 'answer', employeeId: id, questionId: shown(id)!.id, text });
const detailOf = (q: Question | undefined) => (q?.kind === 'permission' ? q.detail : undefined);
const perm = (detail: string) => ({ kind: 'permission' as const, text: 'Can I run a shell command?', tool: 'Bash', detail });

console.log('# hire');
office.handle({ type: 'create_block', cwd: repo });
const block = company().blocks[0]!;
office.handle({ type: 'hire', provider: 'claude-code', blockId: block.id, name: 'Ana' });
office.handle({ type: 'hire', provider: 'claude-code', blockId: block.id, name: 'Ben' });
const ana = company().employees[0]!.id;
const ben = company().employees[1]!.id;
const [fa, fb] = fakes as [Fake, Fake];
check(fakes.length === 2, 'each hire builds a session from the harness factory');
check(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{64}$/.test(fa.host.mcp.url) && fa.host.mcp.name === 'office' && fa.host.mcp.url !== fb.host.mcp.url, 'each host carries its own office MCP URL');
check(fa.host.memoryDigest() === '', 'the digest is empty before any note is saved');

console.log('\n# owner questions');
office.handle({ type: 'assign', employeeId: ana, task: 'Refactor billing' });
fa.host.setActivity('Running npm test');
const xp0 = company().xp;
const ac1 = new AbortController();
const p1 = fa.host.ask(perm('npm test'), ac1.signal);
const p2 = fa.host.ask(perm('git push'));
const s1 = statusOf(ana);
check(s1.kind === 'blocked_on_owner' && s1.task === 'Refactor billing' && s1.question.kind === 'permission' && s1.question.detail === 'npm test', 'the first question blocks the employee and the card shows it');
check(who(ana).activity === 'Asking the boss' && logs.includes('Asking permission: Bash npm test'), 'the desk says asking, and the log line names the tool and command');
check(detailOf(shown(ana)) === 'npm test' && !logs.includes('Asking permission: Bash git push'), 'the second question waits behind the first, out of sight');

fa.host.setActivity('Both helpers are running');
fa.host.setStatus({ kind: 'idle' });
check(detailOf(shown(ana)) === 'npm test', 'the turn ending while questions wait does not take the card away');

answer(ana, 'Allow');
check((await p1) === 'Allow', 'the first caller gets the answer');
check(detailOf(shown(ana)) === 'git push' && logs.includes('Asking permission: Bash git push'), 'the second question shows once the first is answered');
check(company().xp === xp0 + 3, `a quick answer earns XP (${xp0} to ${company().xp})`);
answer(ana, 'Deny');
check((await p2) === 'Deny', 'the second caller gets its own answer');
const back = statusOf(ana);
check(back.kind === 'idle' && who(ana).activity === 'Both helpers are running', 'with the line empty the employee goes back to what the adapter last reported (idle)');

office.handle({ type: 'assign', employeeId: ana, task: 'Second task' });
const p3 = fa.host.ask({ kind: 'ask', text: 'Which database?', options: ['pg', 'sqlite'] });
check(shown(ana)?.kind === 'ask' && logs.includes('Asking the boss: Which database? [pg / sqlite]'), 'an ask_owner style question shows as an ask card with its options');
office.handle({ type: 'interject', employeeId: ana, text: 'use pg', style: 'next' });
check((await p3) === 'use pg' && fa.interjected.length === 0, 'talking to a blocked employee answers the shown question and does not reach the harness');
const resumed = statusOf(ana);
check(resumed.kind === 'working' && resumed.task === 'Second task' && who(ana).activity === 'Got the answer, back to work', 'they go back to the same task after an answer');

fa.host.setActivity('Editing billing.ts');
const ac2 = new AbortController();
const p4 = fa.host.ask({ kind: 'ask', text: 'Withdraw me' }, ac2.signal);
check(shown(ana)?.text === 'Withdraw me', 'a question is on the card');
ac2.abort();
check((await p4) === '' && statusOf(ana).kind === 'working', 'the harness cancelling withdraws the card and the employee is working again');
check(who(ana).activity === 'Editing billing.ts', 'a question taken back returns to the step they were on, not to "got the answer"');

const ac3 = new AbortController();
const p5 = fa.host.ask(perm('first'), ac3.signal);
const p6 = fa.host.ask(perm('second'));
ac3.abort();
check((await p5) === '' && detailOf(shown(ana)) === 'second', 'withdrawing the front question brings the next one forward');
answer(ana, 'Allow');
await p6;

let stale = '';
try {
  office.handle({ type: 'answer', employeeId: ana, questionId: 'no-such-question' as Question['id'], text: 'x' });
} catch (e) {
  stale = e instanceof OfficeError ? e.message : String(e);
}
check(/no open question/.test(stale), `an answer to a card that is not there is refused (${stale})`);
office.handle({ type: 'interject', employeeId: ana, text: 'tap tap', style: 'next' });
check(fa.interjected.join() === 'tap tap', 'talking to a working employee still reaches the harness');

console.log('\n# over the office MCP server');
const client = new Client({ name: 'office-check', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(fa.host.mcp.url)));
const call = client.callTool({ name: 'ask_owner', arguments: { question: 'Ship it?', options: ['Yes', 'No'] } });
check(await until(() => shown(ana)?.text === 'Ship it?'), 'ask_owner over HTTP puts the card on the employee whose URL it used');
check(shown(ben) === undefined, 'a teammate is not blocked by it');
answer(ana, 'Yes');
const shipped = (await call).content as { text: string }[];
check(shipped[0]?.text === 'Yes', 'the owner answer comes back as the tool result');

const ac4 = new AbortController();
const dropped = client.callTool({ name: 'ask_owner', arguments: { question: 'Never mind' } }, undefined, { signal: ac4.signal }).catch(() => undefined);
check(await until(() => shown(ana)?.text === 'Never mind'), 'a second ask_owner is on the card');
ac4.abort();
await dropped;
check(await until(() => statusOf(ana).kind === 'working'), 'the client cancelling the MCP call withdraws the card');

await client.callTool({ name: 'draw_diagram', arguments: { title: 'Flow', mermaid: 'flowchart LR\n A-->B' } });
const board = company().blocks[0]!.whiteboard;
check(board?.title === 'Flow' && board.by === ana, 'draw_diagram lands on the block whiteboard, signed by the caller');

const saved = await client.callTool({ name: 'remember', arguments: { scope: 'block', title: 'Standup is at 09:40', body: 'Daily.' } });
check((saved.content as { text: string }[])[0]!.text.includes('"ok":true'), 'remember saves a note under the block');
check(fb.host.memoryDigest().includes('- Standup is at 09:40') && fb.host.memoryDigest().includes('About the repo team'), "a teammate's next session starts with the block title in its digest");
await client.callTool({ name: 'remember', arguments: { scope: 'me', title: 'Ana likes short plans', body: 'x' } });
check(fa.host.memoryDigest().includes('About you\n- Ana likes short plans') && !fb.host.memoryDigest().includes('short plans'), 'personal notes reach only their owner');
await client.close().catch(() => undefined);

console.log('\n# fire, reset, shutdown');
const pending = fa.host.ask({ kind: 'ask', text: 'Any last words?' });
check(shown(ana)?.text === 'Any last words?', 'a question is open when the employee is fired');
const urlA = fa.host.mcp.url;
office.handle({ type: 'fire', employeeId: ana });
check((await pending) === '' && fa.stopped, 'firing releases the open question and stops the session');
check(company().employees.length === 1, 'the employee is gone from the company');
const res = await fetch(urlA, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
check(res.status === 404, `a fired employee's MCP URL is dead (${res.status})`);
check((await fa.host.ask(perm('late'))) === '', 'a question from a stopped session is dropped at once');
check(await until(() => existsSync(join(memRoot, 'alumni', ana))), "the fired employee's notes moved to alumni/");
check(!existsSync(join(memRoot, 'employees', ana)) && existsSync(join(memRoot, 'blocks', block.id, 'standup-is-at-09-40.md')), 'their folder is gone and the block notes stayed');

office.handle({ type: 'reset_company' });
check(company().employees.length === 0 && company().blocks.length === 0 && fb.stopped, 'reset stops every session and empties the company');
check(await until(() => ['employees', 'blocks', 'alumni'].every((d) => readdirSync(join(memRoot, d)).length === 0)), 'reset wipes the memory notes');

office.handle({ type: 'create_block', cwd: repo });
office.handle({ type: 'hire', provider: 'claude-code', blockId: company().blocks[0]!.id, name: 'Cara' });
const fc = fakes.at(-1)!;
const urlC = fc.host.mcp.url;
office.shutdown();
check(fc.stopped, 'shutdown stops the sessions');
check((await fetch(urlC, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })).status === 404, 'shutdown detaches their MCP URLs');

await mcp.close();
rmSync(dir, { recursive: true, force: true });
finish();
