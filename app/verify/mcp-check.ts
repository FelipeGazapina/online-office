// No model. Starts the real MCP server, inbox and memory store against a scratch folder, then drives them with an MCP client.
// Run from app/: node verify/mcp-check.ts   (Node runs the TypeScript directly). Exits 1 on any failed check.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BlockId, EmployeeId, Question } from '../src/shared/protocol.ts';
import { Inbox } from '../src/main/office/inbox.ts';
import { LIMITS, MemoryStore } from '../src/main/office/memory.ts';
import { mailTools } from '../src/main/office/mail-tools.ts';
import { startOfficeMcp } from '../src/main/office/mcp.ts';
import { PSTACK_WORKFLOW, persona, resolvePstackSkillsPath } from '../src/main/office/persona.ts';
import { check, finish, sleep, until } from './check.ts';
import { ANA, B1, BRUNO, PO, world } from './mail-world.ts';

const dir = mkdtempSync(join(tmpdir(), 'office-mcp-check-'));
const memRoot = join(dir, 'memory');
const memory = MemoryStore.open(memRoot);

type Event = { employeeId: string; head?: string; left?: string };
const events: Event[] = [];
const inbox = new Inbox({
  headChanged: (employeeId, head, left) => events.push({ employeeId, head: head?.text, left: left?.question.text }),
});
const diagrams: { employeeId: string; title: string }[] = [];
const mcp = await startOfficeMcp();

const mailWorld = world();
const nameOf = () => 'someone';

const A = 'emp-a' as EmployeeId;
const B = 'emp-b' as EmployeeId;
const C = 'emp-c' as EmployeeId;
const BLOCK1 = 'block-1' as BlockId;
const BLOCK2 = 'block-2' as BlockId;

const notebooks = new Map<string, ReturnType<MemoryStore['notebook']>>();
function attach(employeeId: EmployeeId, blockId: BlockId) {
  const memoryFor = memory.notebook({ employeeId, blockId, provider: 'claude-code' });
  notebooks.set(employeeId, memoryFor);
  return mcp.attach(employeeId, {
    ask: (body, signal) => inbox.ask(employeeId, body, signal),
    openBoard: async () => {},
    mail: mailTools(mailWorld.room, employeeId, nameOf, false),
    drawDiagram: (title) => diagrams.push({ employeeId, title }),
    memory: memoryFor,
  });
}
const urlA = attach(A, BLOCK1);
const urlB = attach(B, BLOCK1);
const urlC = attach(C, BLOCK2);

async function connect(url: string) {
  const client = new Client({ name: 'mcp-check', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport };
}
const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content as { type: string; text: string }[])[0]!.text;
  return { isError: r.isError === true, text: t, json: () => JSON.parse(t) as any };
};

// A raw HTTP request, so the check controls Host and Origin, which an SDK client never sets.
function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const u = new URL(url);
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...opts.headers } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } };
const pendingOf = (id: EmployeeId) => inbox.pending(id);

console.log(`\n# server on 127.0.0.1:${mcp.port}`);
check(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{64}$/.test(urlA), `per-employee URL carries a 64 hex char token (${urlA.replace(/[0-9a-f]{64}$/, '<token>')})`);
check(new Set([urlA, urlB, urlC]).size === 3, 'each employee gets a different token');

const good = await raw(urlA, { body: initBody });
check(good.status === 200, `valid token, no Origin, own Host answers initialize (${good.status})`);
const badToken = await raw(`http://127.0.0.1:${mcp.port}/mcp/${'0'.repeat(64)}`, { body: initBody });
check(badToken.status === 404, `unknown token is 404 (${badToken.status})`);
const shortToken = await raw(`http://127.0.0.1:${mcp.port}/mcp/abc`, { body: initBody });
check(shortToken.status === 404, `malformed token path is 404 (${shortToken.status})`);
const withOrigin = await raw(urlA, { headers: { origin: 'http://evil.example' }, body: initBody });
check(withOrigin.status === 403, `a request with an Origin header is rejected (${withOrigin.status})`);
const nullOrigin = await raw(urlA, { headers: { origin: 'null' }, body: initBody });
check(nullOrigin.status === 403, `even Origin: null is rejected (${nullOrigin.status})`);
const foreignHost = await raw(urlA, { headers: { host: `evil.example:${mcp.port}` }, body: initBody });
check(foreignHost.status === 403, `a foreign Host is rejected (${foreignHost.status})`);
const localhostHost = await raw(urlA, { headers: { host: `localhost:${mcp.port}` }, body: initBody });
check(localhostHost.status === 403, `Host localhost:port is rejected, only 127.0.0.1:port passes (${localhostHost.status})`);
const noSession = await raw(urlA, { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
check(noSession.status === 400, `a call with no session id is 400 (${noSession.status})`);
const probeGet = await raw(urlA, { method: 'GET', headers: { accept: 'text/event-stream' } });
const probeHead = await raw(urlA, { method: 'HEAD' });
check(probeGet.status === 405 && probeHead.status === 405, `a GET or HEAD without a session, which is how Hermes probes, is 405 (${probeGet.status}, ${probeHead.status})`);

console.log('\n# tools');
const a = await connect(urlA);
const b = await connect(urlB);
const c = await connect(urlC);
check(a.client.getServerVersion()?.name === 'office', `server name is "office" (${a.client.getServerVersion()?.name})`);
const listedTools = (await a.client.listTools()).tools;
const listed = listedTools.map((t) => t.name).sort();
check(JSON.stringify(listed) === JSON.stringify(['ask_owner', 'awaitReplies', 'cancelRequest', 'draw_diagram', 'forget', 'inbox', 'message', 'open_board', 'recall', 'remember', 'reply', 'request', 'requestGauntlet', 'team']), `tools: ${listed.join(', ')}`);
check(!listed.includes('delegate_to_teammate') && !listed.includes('hireTeammate'), 'delegate_to_teammate is gone and hireTeammate is not offered to an employee');
const askOwnerDescription = listedTools.find((t) => t.name === 'ask_owner')?.description ?? '';
check(/material .*decision|material .*product/i.test(askOwnerDescription) && /observable fact/i.test(askOwnerDescription) && /options.*tradeoffs/i.test(askOwnerDescription), 'ask_owner asks only material decisions and requests evidence-backed options');

const drawn = await call(a.client, 'draw_diagram', { title: 'Flow', mermaid: 'flowchart LR\n A-->B' });
check(drawn.text === 'Drawn on the whiteboard.' && diagrams.at(-1)?.employeeId === A, 'draw_diagram reaches the office under the caller\'s identity');

console.log('\n# ask_owner');
events.length = 0;
let settled = false;
const first = call(a.client, 'ask_owner', { question: 'Newline?', options: ['Newline', 'No newline'], employeeId: B });
void first.then(() => (settled = true));
check(await until(() => pendingOf(A).length === 1), 'the office sees the question');
await sleep(500);
check(!settled, 'ask_owner is still pending half a second later');
const q1 = pendingOf(A)[0] as Question;
const q1Options = q1.kind === 'ask' ? q1.options : undefined;
check(q1.kind === 'ask' && q1.text === 'Newline?' && q1Options?.join('|') === 'Newline|No newline', `question arrives as an ask card with its options (${JSON.stringify({ text: q1.text, options: q1Options })})`);
check(pendingOf(B).length === 0, 'a tool argument naming another employee changes nothing, the URL is the identity');
check(events.at(-1)?.employeeId === A && events.at(-1)?.head === 'Newline?', 'the card shows for the caller');
check(inbox.answer(A, q1.id, 'No newline'), 'the owner answers');
const answered = await first;
check(answered.text === 'No newline' && !answered.isError, `ask_owner returns the answer text (${JSON.stringify(answered.text)})`);
check(events.at(-1)?.head === undefined && events.at(-1)?.left === 'Newline?', 'the card clears once answered');

events.length = 0;
const ac = new AbortController();
const aborted = a.client.callTool({ name: 'ask_owner', arguments: { question: 'Withdraw me' } }, undefined, { signal: ac.signal }).then(
  () => 'resolved',
  () => 'rejected',
);
check(await until(() => pendingOf(A).length === 1), 'a second question is pending');
ac.abort();
check((await aborted) === 'rejected', 'the client call rejects on abort');
check(await until(() => pendingOf(A).length === 0), 'aborting the client call withdraws the question from the office');
check(events.some((e) => e.left === 'Withdraw me' && e.head === undefined), 'the withdrawal reaches the card (head cleared, left set)');

// abort through a dropped HTTP request, which is what Codex does on interrupt
events.length = 0;
const sessionId = a.transport.sessionId!;
const drop = await new Promise<{ req: ReturnType<typeof request> }>((resolve) => {
  const u = new URL(urlA);
  const req = request(
    { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId } },
    () => {},
  );
  req.on('error', () => {});
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 'ask_owner', arguments: { question: 'Drop me' } } }));
  resolve({ req });
});
check(await until(() => pendingOf(A).length === 1 && pendingOf(A)[0]!.text === 'Drop me'), 'a raw tools/call is pending');
drop.req.destroy();
check(await until(() => pendingOf(A).length === 0), 'dropping the HTTP connection withdraws the question');
check(events.some((e) => e.left === 'Drop me'), 'the withdrawal is visible to the office');

console.log('\n# FIFO');
events.length = 0;
const one = call(a.client, 'ask_owner', { question: 'First?' });
check(await until(() => pendingOf(A).length === 1), 'first question queued');
const two = call(a.client, 'ask_owner', { question: 'Second?' });
check(await until(() => pendingOf(A).length === 2), 'second concurrent question queued behind it');
check(pendingOf(A)[0]!.text === 'First?' && events.filter((e) => e.head).map((e) => e.head).join() === 'First?', 'only the first is shown');
const q2 = pendingOf(A)[1] as Question;
check(inbox.answer(A, q2.id, 'nope') === false && pendingOf(A).length === 2, 'the second cannot be answered before the first');
inbox.answer(A, pendingOf(A)[0]!.id, 'one');
check((await one).text === 'one', 'first answer goes to the first caller');
check(events.at(-1)?.head === 'Second?' && events.at(-1)?.left === 'First?', 'the second question shows once the first is answered');
inbox.answer(A, q2.id, 'two');
check((await two).text === 'two', 'second answer goes to the second caller');
check(pendingOf(A).length === 0 && events.at(-1)?.head === undefined, 'the line is empty after both');

const borrowed = await raw(urlB, { headers: { 'mcp-session-id': sessionId }, body: { jsonrpc: '2.0', id: 5, method: 'tools/list' } });
check(borrowed.status === 404, `employee B cannot use employee A's session id (${borrowed.status})`);

console.log('\n# memory');
const rel = await call(a.client, 'remember', { scope: 'me', title: 'Release branch is release-teal', body: 'Tag each release vYYYY.MM.DD.' });
check(rel.json().ok === true && rel.json().id === 'release-branch-is-release-teal' && rel.json().used === 1 && rel.json().cap === 25, `remember returns ok, id, used and cap (${rel.text})`);
const noteFile = join(memRoot, 'employees', A, 'release-branch-is-release-teal.md');
check(existsSync(noteFile), 'the note is a file under employees/<id>/');
console.log(readFileSync(noteFile, 'utf8').replace(/^/gm, '    | '));
const created = /createdAt: (\d+)/.exec(readFileSync(noteFile, 'utf8'))![1];
await sleep(15);
const up = await call(a.client, 'remember', { scope: 'me', title: 'Release  branch is   release-teal', body: 'Tags look like vYYYY.MM.DD. Cut from release-teal.' });
check(up.json().ok && up.json().used === 1, 'the same title upserts instead of adding a second note');
const upText = readFileSync(noteFile, 'utf8');
check(upText.includes('Cut from release-teal') && !upText.includes('Tag each release') && new RegExp(`createdAt: ${created}\\b`).test(upText), 'the body changed and createdAt survived');
check(readdirSync(join(memRoot, 'employees', A)).length === 1, 'still one file');

const before = readdirSync(join(memRoot, 'employees', A)).length;
const fakes: [string, string][] = [
  ['Anthropic key', 'key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['GitHub token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['PEM header', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc'],
  ['AWS key', 'AKIAABCDEFGHIJKLMNOP'],
  ['assignment', 'password = correcthorsebatterystaple'],
];
for (const [label, body] of fakes) {
  const r = await call(a.client, 'remember', { scope: 'me', title: `Secret ${label}`, body });
  check(r.json().ok === false && r.isError && /credential|secret/i.test(r.json().reason) && !r.text.includes(body.slice(0, 20)), `${label} is rejected without being echoed (${r.json().reason?.slice(0, 60)})`);
}
const inTitle = await call(a.client, 'remember', { scope: 'me', title: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', body: 'x' });
check(inTitle.json().ok === false, 'a secret in the title is rejected too');
check(readdirSync(join(memRoot, 'employees', A)).length === before, 'no rejected note left a file');

const longTitle = await call(a.client, 'remember', { scope: 'me', title: 'x'.repeat(61), body: 'b' });
check(longTitle.json().ok === false && /60/.test(longTitle.json().reason), `61 character title refused (${longTitle.json().reason?.slice(0, 50)})`);
const longBody = await call(a.client, 'remember', { scope: 'me', title: 'Long body', body: 'b'.repeat(501) });
check(longBody.json().ok === false && /500/.test(longBody.json().reason), `501 character body refused (${longBody.json().reason?.slice(0, 50)})`);
const edge = await call(a.client, 'remember', { scope: 'me', title: 'e'.repeat(60), body: 'b'.repeat(500) });
check(edge.json().ok === true, '60 character title and 500 character body are accepted');
await call(a.client, 'forget', { scope: 'me', id: edge.json().id });

const nbA = notebooks.get(A)!;
for (let i = 2; i <= 25; i++) {
  const r = await nbA.remember('me', `Personal fact number ${i}`, 'x');
  if (!r.ok) throw new Error(`fill ${i}: ${r.reason}`);
}
const over = await call(a.client, 'remember', { scope: 'me', title: 'One too many', body: 'x' });
check(over.json().ok === false && over.json().titles?.length === 25 && /full \(25/.test(over.json().reason), `26th personal note refused with the 25 titles listed (${over.json().reason})`);
const overwrite = await call(a.client, 'remember', { scope: 'me', title: 'Personal fact number 7', body: 'still updatable when full' });
check(overwrite.json().ok === true && overwrite.json().used === 25, 'a full notebook still accepts an update of an existing title');

const nbB = notebooks.get(B)!;
const burst = await Promise.all(Array.from({ length: 45 }, (_, i) => nbB.remember('block', `Block fact ${i}`, 'x')));
const okCount = burst.filter((r) => r.ok).length;
check(okCount === 40 && burst.filter((r) => !r.ok).length === 5, `45 concurrent block writes: exactly 40 land (${okCount}), the mutex holds the cap`);
check(readdirSync(join(memRoot, 'blocks', BLOCK1)).filter((f) => f.endsWith('.md')).length === 40 && !readdirSync(join(memRoot, 'blocks', BLOCK1)).some((f) => f.endsWith('.tmp')), '40 files on disk, no temp files left');

console.log('\n# recall and forget');
const rc = await call(a.client, 'recall', { query: 'release', scope: 'me' });
check(rc.json().mode === 'search' && rc.json().notes[0]?.title === 'Release branch is release-teal' && rc.json().notes[0]?.body.includes('Cut from release-teal'), 'recall finds the note by keyword, with its body');
const byBody = await call(a.client, 'recall', { query: 'vYYYY.MM.DD', scope: 'me' });
check(byBody.json().notes[0]?.id === 'release-branch-is-release-teal', 'recall finds a note by a word only its body has');
const accent = await call(a.client, 'recall', { query: 'RELEASE-TEAL cut' });
check(accent.json().total >= 1, 'recall is case-insensitive and multi-word');
const none = await call(a.client, 'recall', { query: 'zzzqqq' });
check(none.json().total === 0 && none.json().notes.length === 0, 'recall returns nothing for an unknown word');
const list = await call(a.client, 'recall', { scope: 'me' });
check(list.json().mode === 'list' && list.json().total === 25 && list.json().notes.every((n: any) => n.title && !('body' in n)), 'recall with no query lists titles only');
for (let i = 0; i < 8; i++) await nbB.forget('block', `block-fact-${i}`);
for (let i = 0; i < 8; i++) await nbB.remember('block', `Zebra sighting ${i}`, 'x');
const cap5 = await call(b.client, 'recall', { query: 'zebra', scope: 'block' });
check(cap5.json().notes.length === LIMITS.recallResults && cap5.json().total === 8, `recall returns at most ${LIMITS.recallResults} full notes (total ${cap5.json().total})`);

const gone = await call(a.client, 'forget', { scope: 'me', id: 'release-branch-is-release-teal' });
check(gone.json().ok === true && !existsSync(noteFile), 'forget deletes the file');
check((await call(a.client, 'recall', { query: 'release-teal', scope: 'me' })).json().total === 0, 'recall no longer finds a forgotten note');
const again = await call(a.client, 'forget', { scope: 'me', id: 'release-branch-is-release-teal' });
check(again.json().ok === false && again.isError, 'forgetting twice says the note is not there');
const traversal = await call(a.client, 'forget', { scope: 'block', id: '../../company' });
check(traversal.json().ok === false, 'a path-shaped id is refused');

console.log('\n# block scope');
for (const n of nbB.recall(undefined, 'block').notes) await nbB.forget('block', n.id);
check(nbB.recall(undefined, 'block').total === 0, 'cleared the block notebook the burst filled');
await call(a.client, 'remember', { scope: 'block', title: 'Standup is at 09:40', body: 'Daily, in the team channel.' });
await call(a.client, 'remember', { scope: 'me', title: 'Ana prefers short plans', body: 'x' });
const seenByB = await call(b.client, 'recall', { query: 'standup', scope: 'block' });
check(seenByB.json().notes[0]?.title === 'Standup is at 09:40', 'a block note is visible to another employee of the same block');
const seenByC = await call(c.client, 'recall', { query: 'standup', scope: 'both' });
check(seenByC.json().total === 0, 'the same note is not visible in another block');
const personalSeenByB = await call(b.client, 'recall', { query: 'plans', scope: 'both' });
check(personalSeenByB.json().total === 0, 'a personal note is not visible to a teammate');
const digestB = nbB.digest('Gazapina Web');
check(digestB.includes('- Standup is at 09:40') && !digestB.includes('Ana prefers'), 'the teammate\'s digest lists the block title and not the personal one');
const digestC = notebooks.get(C)!.digest('Other');
check(digestC === '', 'a block with no notes has an empty digest');

console.log('\n# digest');
const digestA = nbA.digest('client-apps');
console.log(digestA.split('\n').slice(0, 6).map((l) => `    | ${l}`).join('\n'));
check(digestA.startsWith('What you remember (call recall for details)\n\nAbout you\n- ') && digestA.includes('\n\nAbout the client-apps team\n- Standup is at 09:40'), 'digest has the heading, a personal part and a team part, titles only');
check(!digestA.includes('Daily, in the team channel'), 'bodies are not in the digest');
// worst case: 25 personal and 40 block titles at 60 characters, and a very long block name
const store2 = MemoryStore.open(join(dir, 'memory-full'));
const nb = store2.notebook({ employeeId: 'emp-full' as EmployeeId, blockId: 'blk-full' as BlockId, provider: 'codex' });
for (let i = 0; i < 25; i++) await nb.remember('me', `${String(i).padStart(2, '0')} ${'p'.repeat(57)}`, 'x');
for (let i = 0; i < 40; i++) await nb.remember('block', `${String(i).padStart(2, '0')} ${'q'.repeat(57)}`, 'x');
const full = nb.digest('a very very long project folder name that keeps going and going');
check(full.length <= LIMITS.digestChars && full.split('\n').filter((l) => l.startsWith('- ')).length === 65, `a full notebook digest is ${full.length} characters, cap ${LIMITS.digestChars}`);
const p = persona({ name: 'Ana', company: 'Gazapina Labs', block: 'Gazapina Web', digest: digestA, rules: '' });
check(p.includes('- Standup is at 09:40') && p.includes('remember, recall and forget') && p.includes('You are Ana'), 'the persona carries the memory rules and the digest');
const skillsPath = resolvePstackSkillsPath();
check(isAbsolute(skillsPath) && p.includes(`PStack is installed at ${skillsPath}`), 'the persona carries the absolute PStack skills path');
check(p.includes(`${join(skillsPath, 'poteto-mode', 'SKILL.md')}`), 'the persona points every provider at poteto-mode first');
check(Object.isFrozen(PSTACK_WORKFLOW) && PSTACK_WORKFLOW.every((phase) => Object.isFrozen(phase)), 'the PStack workflow phases are immutable');
check(PSTACK_WORKFLOW.every(({ name }, index) => p.indexOf(`${index + 1}. ${name}.`) < p.indexOf(`${index + 2}. `) || index === PSTACK_WORKFLOW.length - 1), 'the persona renders ordered PStack phases once');
check(/acceptance criteria/i.test(p) && /real matching surface/i.test(p) && /final diff/i.test(p) && /DONE.*BLOCKED.*NEEDS_DECISION/s.test(p), 'the persona requires acceptance, real-surface verification, diff review, and explicit final states');
check(/observable facts/i.test(p) && /evidence/i.test(p) && /options with their tradeoffs/i.test(p), 'the persona keeps owner questions material and evidence-backed');
const legacyHome = join(dir, 'legacy-home');
mkdirSync(join(legacyHome, '.cursor', 'skills'), { recursive: true });
check(resolvePstackSkillsPath(legacyHome) === join(legacyHome, '.cursor', 'skills'), 'PStack path falls back to the legacy skills directory');
mkdirSync(join(legacyHome, '.agents', 'skills'), { recursive: true });
check(resolvePstackSkillsPath(legacyHome) === join(legacyHome, '.agents', 'skills'), 'PStack path prefers the installed agents skills directory');
check(persona({ name: 'PO', company: 'x', block: 'y', role: 'orchestrator', digest: '', rules: '' }).includes('hireTeammate') && persona({ name: 'PO', company: 'x', block: 'y', role: 'orchestrator', digest: '', rules: '' }).includes('requestGauntlet'), 'the orchestrator persona explains planning, hiring and the gauntlet');
check(!persona({ name: 'Ana', company: 'x', block: 'y', digest: '', rules: '' }).includes('What you remember'), 'the persona omits the digest when nothing is saved');
const ruled = persona({ name: 'Ana', company: 'x', block: 'y', digest: digestA, rules: '- Never edit the billing folder' });
check(ruled.includes('The rules your boss set for you') && ruled.includes('- Never edit the billing folder') && ruled.indexOf('billing') < ruled.indexOf('What you remember'), 'the persona carries the owner rules ahead of the digest');
check(!persona({ name: 'Ana', company: 'x', block: 'y', digest: '', rules: '' }).includes('rules your boss'), 'the persona omits the rules heading when there are none');

console.log('\n# mailroom tools');
const mailUrl = (who: typeof PO) => mcp.attach(who, {
  ask: async () => '',
  openBoard: async () => {},
  drawDiagram: () => {},
  memory: memory.notebook({ employeeId: who, blockId: BLOCK1, provider: 'claude-code' }),
  mail: mailTools(mailWorld.room, who, (actor) => mailWorld.members.find((m) => m.id === actor)?.name ?? actor, who === PO),
});
const po = await connect(mailUrl(PO));
const ana = await connect(mailUrl(ANA));
const poTools = (await po.client.listTools()).tools.map((t) => t.name);
check(poTools.includes('hireTeammate') && !(await ana.client.listTools()).tools.some((t) => t.name === 'hireTeammate'), 'hireTeammate is offered to the PO only');
const gh = mailWorld.room.post({ from: 'owner', to: 'po', blockId: B1, body: { kind: 'request', text: 'build it' } });
const team = await call(po.client, 'team', {});
check(team.json().length === 4 && team.json().some((m: any) => m.name === 'Ana' && m.queued === 0), `team lists the block, not other blocks (${team.text.slice(0, 80)})`);
const sent = await call(po.client, 'request', { to: 'Ana', text: 'api piece', bar: ['returns csv'], title: 'API' });
check(sent.json().ok === true && sent.json().delivery === 'delivered', `request posts under the caller's identity (${sent.text})`);
const spread = await call(po.client, 'request', { to: 'Ana', text: 'second piece', key: 'k0' });
check(spread.json().ok === false && spread.json().reason === 'bad_request' && /Bruno/.test(spread.json().detail), 'a second piece for the same person is refused through the tool, naming a teammate with none', spread.text);
const second = await call(po.client, 'request', { to: 'Ana', text: 'api question', key: 'k', intent: 'help' });
check(second.json().ok === true && second.json().delivery === 'queued', 'a busy teammate queues the request instead of failing', second.text);
const wrong = await call(po.client, 'request', { to: 'Zed', text: 'x' });
check(wrong.json().ok === false && wrong.json().reason === 'cross_block', 'another block is refused with a reason');
const waiting = call(po.client, 'awaitReplies', { timeoutSec: 5 });
const reqId = sent.json().id as string;
mailWorld.fresh.add('src/csv.ts');
const replied = await call(ana.client, 'reply', { requestId: reqId, outcome: 'done', text: 'csv route done', artifact: ['src/csv.ts'] });
check(replied.json().ok === true, 'reply settles a request');
const got = (await waiting).json();
check(got.length === 1 && got[0].kind === 'reply' && got[0].text === 'csv route done' && got[0].artifact[0] === 'src/csv.ts', 'awaitReplies returns the reply with its artifact');
const hired = await call(po.client, 'hireTeammate', { key: 'h1', name: 'Dora' });
const hired2 = await call(po.client, 'hireTeammate', { key: 'h1', name: 'Dora' });
check(hired.json().ok === true && hired2.json().id === hired.json().id, 'hireTeammate hires once per key');
check(gh.ok && BRUNO !== ANA, 'the owner request reached the PO', JSON.stringify(gh));
await po.client.close();
await ana.client.close();

console.log('\n# lifecycle');
await memory.archive(A);
check(!existsSync(join(memRoot, 'employees', A)) && readdirSync(join(memRoot, 'alumni', A)).length >= 25, `fire moves the employee's notes to alumni/${A}`);
check(existsSync(join(memRoot, 'blocks', BLOCK1, 'standup-is-at-09-40.md')), 'block notes survive the fire');
await memory.archive(A);
check(true, 'archiving twice does not throw');
check(notebooks.get(B)!.recall('standup', 'block').total === 1, 'teammates still read the block note after the fire');

mcp.detach(B);
const stale = await raw(urlB, { body: initBody });
check(stale.status === 404, `a detached employee's URL is 404 (${stale.status})`);
// The harness is gone after a detach, so nobody answers this call. The client gives up by hand instead of waiting out its own timeout.
const giveUp = new AbortController();
const hang = c.client.callTool({ name: 'ask_owner', arguments: { question: 'Left hanging' } }, undefined, { signal: giveUp.signal }).catch(() => undefined);
check(await until(() => pendingOf(C).length === 1), 'C has a question in flight');
mcp.detach(C);
check(await until(() => pendingOf(C).length === 0), 'detaching an employee withdraws the question that is in flight');
giveUp.abort();
await hang;

mkdirSync(join(memRoot, 'employees', 'emp-z'), { recursive: true });
writeFileSync(join(memRoot, 'employees', 'emp-z', 'half.md.ab12cd34.tmp'), 'half a note');
MemoryStore.open(memRoot);
check(!existsSync(join(memRoot, 'employees', 'emp-z', 'half.md.ab12cd34.tmp')), 'opening the store deletes leftover temp files');

await memory.wipe();
check(readdirSync(join(memRoot, 'employees')).length === 0 && readdirSync(join(memRoot, 'blocks')).length === 0 && readdirSync(join(memRoot, 'alumni')).length === 0, 'wipe empties memory (reset_company)');

for (const x of [a, b, c]) await x.client.close().catch(() => undefined);
await mcp.close();
rmSync(dir, { recursive: true, force: true });
finish();
