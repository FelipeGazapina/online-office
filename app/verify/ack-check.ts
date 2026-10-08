// No model, no network. The acknowledger against a scripted stand-in for the Agent SDK's query(): the one call that sorts the owner's
// message and writes the first words, what it does when the reply is odd, late or missing, and how many processes it ever holds.
// Run from app/: node verify/ack-check.ts   Exits 1 on any failed check.
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Acknowledger, type AckInput } from '../src/main/office/ack.ts';
import { PushQueue, type ClaudeRun } from '../src/main/office/adapters/claude.ts';
import { check, finish } from './check.ts';

type Process = { options: Options; sent: string[]; closed: boolean; end(): void };
const processes: Process[] = [];
const alive = () => processes.filter((p) => !p.closed).length;
// What the stand-in says to the next prompt, in pieces of `chunk` characters. A function decides, so a check can answer oddly,
// late, or not at all.
let say: (prompt: string) => string | 'never' | 'error' = () => 'WORK\nOn it.';
let chunk = 4;
let pieceDelayMs = 0;
let lastPrompt = '';
// A check can hold every answer back until it opens the gate.
let gate: Promise<void> = Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }) as unknown as SDKMessage;

const run: ClaudeRun = ({ prompt, options }) => {
  const out = new PushQueue<SDKMessage>();
  const p: Process = { options, sent: [], closed: false, end: () => out.close() };
  processes.push(p);
  void (async () => {
    for await (const m of prompt as AsyncIterable<SDKUserMessage>) {
      const text = String((m.message as { content: unknown }).content);
      p.sent.push(text);
      lastPrompt = text;
      await gate;
      const reply = say(text);
      if (reply === 'never') continue;
      if (reply === 'error') {
        out.push({ type: 'result', subtype: 'error_during_execution', is_error: true } as unknown as SDKMessage);
        continue;
      }
      for (let i = 0; i < reply.length; i += chunk) {
        out.push(delta(reply.slice(i, i + chunk)));
        if (pieceDelayMs) await sleep(pieceDelayMs);
      }
      out.push({ type: 'result', subtype: 'success', is_error: false, result: reply } as unknown as SDKMessage);
    }
  })();
  return { [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](), close: () => void (p.closed = true, out.close()) } as unknown as ReturnType<ClaudeRun>;
};

const input = (request: string, role = 'employee'): AckInput => ({ who: 'e1', name: 'Eli', role, company: 'Acme', block: 'Web', teammates: ['Pia (orchestrator)'], request });
// Hears a message, then claims it as the mailroom does once the request is delivered.
const hearAndAck = async (desk: Acknowledger, key: string, request: string) => {
  const sort = desk.hear(key, input(request));
  const heard: string[] = [];
  const sorted = await sort;
  const said = desk.ack(key, (d) => heard.push(d));
  return { sorted, said: await said, heard: heard.join('') };
};

delete process.env.OFFICE_ACK;
delete process.env.OFFICE_TRIAGE;
let desk = new Acknowledger(run);

check(desk.hear('k0', input('which file handles login?')) === undefined && processes.length === 0, 'before warm() nothing is heard and no process starts');
check(desk.ack('k0', () => {}) === undefined, 'and nothing is acknowledged');

desk.warm();
desk.warm();
check(processes.length === 1, 'warm() starts one spare process and a second warm() starts no other', String(processes.length));
const spare = processes[0]!;
check(Array.isArray(spare.options.tools) && spare.options.tools.length === 0 && (spare.options.thinking as { type: string }).type === 'disabled' && spare.options.maxTurns === 1 && spare.options.persistSession === false, 'it is tool-free with thinking off, one turn and no session');
check(/QUESTION/.test(String(spare.options.systemPrompt)) && /WORK/.test(String(spare.options.systemPrompt)), 'its system prompt asks for the sort word first');

say = () => 'QUESTION\nI will look at the login code and tell you which file it is in.';
const q = await hearAndAck(desk, 'k1', 'which file handles login?');
check(q.sorted === 'help', 'QUESTION is help');
check(q.said === 'I will look at the login code and tell you which file it is in.' && q.heard === q.said, 'the acknowledgement is what follows the sort word, whole and streamed', `${q.said} | ${q.heard}`);
await sleep(5);
check(processes.length === 2 && spare.closed && !processes[1]!.closed && alive() === 1, 'the process that answered is closed and a fresh spare takes its place', `${processes.length} started, ${alive()} alive`);

say = () => 'WORK\nStarting on the logout button now.';
const w = await hearAndAck(desk, 'k2', 'add a logout button');
check(w.sorted === 'work' && w.said === 'Starting on the logout button now.', 'WORK is work');

for (const [reply, intent] of [['question\nLooking.', 'help'], ['Question: Looking.', 'help'], ['work. Starting.', 'work'], ['  WORK\n\n  Starting.', 'work']] as const) {
  say = () => reply;
  const r = await hearAndAck(desk, `case-${reply}`, 'x');
  check(r.sorted === intent && /^(Looking\.|Starting\.)$/.test(r.said ?? ''), `the sort word is read case-blind and past punctuation and blanks (${JSON.stringify(reply)})`, JSON.stringify(r));
}

say = () => 'I will start on it now.';
const bare = await hearAndAck(desk, 'k3', 'add a logout button');
check(bare.sorted === undefined && bare.said === 'I will start on it now.' && bare.heard === 'I will start on it now.', 'a reply with no sort word has no sort, and all of it is the acknowledgement');
for (const reply of ['Working on it now.', 'Questions about login are on my list, so I will read the code.']) {
  say = () => reply;
  const r = await hearAndAck(desk, `word-${reply}`, 'x');
  check(r.sorted === undefined && r.said === reply && r.heard === reply, `a sentence that only starts like a sort word is not one (${reply.slice(0, 16)}...)`, JSON.stringify(r));
}

say = () => 'WORK';
const onlyWord = await hearAndAck(desk, 'k4', 'add a logout button');
check(onlyWord.sorted === 'work' && onlyWord.said === undefined && onlyWord.heard === '', 'a reply that is only the sort word sorts and says nothing');

say = () => 'error';
const failed = await hearAndAck(desk, 'k5', 'which file handles login?');
check(failed.sorted === undefined && failed.said === undefined, 'a failed call gives no sort and no words');

say = () => 'never';
const t0 = Date.now();
check((await desk.hear('k6', input('which file handles login?'), 60)) === undefined && Date.now() - t0 < 1000, 'a call that never answers gives up at the leash');
say = () => 'WORK\nOn it.';

// Words that came before anyone claimed the request are handed over whole, and what comes after streams.
chunk = 3;
pieceDelayMs = 4;
say = () => 'WORK\nI will read the header component first and then add the button.';
{
  const sort = desk.hear('k7', input('add a logout button'));
  await sort;
  const heard: string[] = [];
  const said = desk.ack('k7', (d) => heard.push(d));
  check(!!said, 'a heard request is claimed');
  const whole = await said;
  check(heard.join('') === whole && heard.length > 3 && !/WORK/.test(heard.join('')), 'claimed while it is still being written, the words stream and never carry the sort word', `${heard.length} deltas`);
}
chunk = 4;
pieceDelayMs = 0;
{
  const sort = desk.hear('k8', input('add a logout button'));
  await sort;
  await sleep(40);
  const heard: string[] = [];
  const whole = await desk.ack('k8', (d) => heard.push(d));
  check(heard.length === 1 && heard[0] === whole && whole === 'I will read the header component first and then add the button.', 'claimed after it was written, the words come at once, in one piece', JSON.stringify(heard));
}

const before = processes.length;
check(desk.ack('task:abc:eli:0', () => {}) === undefined && desk.ack(undefined, () => {}) === undefined && processes.length === before, 'a request nobody heard (a task the board starts) is not acknowledged and starts no process');

say = () => 'QUESTION\nLooking.';
{
  const a = desk.hear('same', input('which file?'));
  const startedForFirst = processes.length;
  const b = desk.hear('same', input('which file?'));
  check(processes.length === startedForFirst && (await a) === (await b), 'the same key heard twice is one call');
  await sleep(5);
  desk.ack('same', () => {});
}

// What the process is asked.
say = () => 'WORK\nOn it.';
await hearAndAck(desk, 'p1', 'Add a logout button');
await hearAndAck(desk, 'p2', 'Add a logout button');
const sentEmployee = lastPrompt;
const poDesk = new Acknowledger(run);
poDesk.warm();
void poDesk.hear('po', input('Which file handles login?', 'orchestrator'));
await sleep(5);
const sentPo = lastPrompt;
poDesk.stop();
check(/You are Eli, an employee\./.test(sentEmployee) && /Add a logout button/.test(sentEmployee) && /Pia \(orchestrator\)/.test(sentEmployee) && !/the PO/.test(sentEmployee), 'an employee is told who they are, their team and the message');
check(/You are Eli, the PO\./.test(sentPo) && /Which file handles login\?/.test(sentPo), 'the PO is told it is the PO');
say = () => 'WORK\nOn it.';
const long = `${'a'.repeat(3000)}THE-END-QUESTION?`;
await hearAndAck(desk, 'long', long);
const sentLong = lastPrompt;
check(sentLong.length < 2700 && sentLong.includes('THE-END-QUESTION?') && sentLong.includes('aaa'), 'a long message is clipped from the middle, so its first and last words are both seen', String(sentLong.length));

process.env.OFFICE_TRIAGE = '0';
{
  const r = await hearAndAck(desk, 'off', 'which file handles login?');
  check(r.sorted === undefined && r.said === 'On it.', 'OFFICE_TRIAGE=0 ignores the sort and still acknowledges');
}
delete process.env.OFFICE_TRIAGE;
desk.stop();
await sleep(5);
check(alive() === 0 && desk.hear('after', input('x')) === undefined, 'stop() closes every process and ends the calls');

// The ceiling: one answering and the spare behind it, never more, and a message that finds none is let go.
processes.length = 0;
desk = new Acknowledger(run);
desk.warm();
let open!: () => void;
gate = new Promise((r) => (open = r));
say = () => 'WORK\nOn it.';
const first = desk.hear('c1', input('one'));
const second = desk.hear('c2', input('two'));
const third = desk.hear('c3', input('three'));
check(processes.length === 2 && alive() === 2, 'two messages at once use the two processes there are', `${processes.length} started, ${alive()} alive`);
check(!!first && !!second && third === undefined, 'a third finds none free and is let go (posted as work, its real turn speaks for itself)');
check(desk.ack('c3', () => {}) === undefined, 'and it is not acknowledged');
open();
await Promise.all([first, second]);
await sleep(10);
check(processes.length === 3 && alive() === 1 && processes.filter((p) => p.closed).length === 2, 'when they are done both are closed and one spare is started', `${processes.length} started, ${alive()} alive`);
gate = Promise.resolve();
const again = await hearAndAck(desk, 'c4', 'four');
check(again.sorted === 'work' && again.said === 'On it.', 'and the next message is answered by it');
desk.stop();

// A call nobody claims is let go, and a spare that died is not used.
processes.length = 0;
desk = new Acknowledger(run, { unclaimedMs: 30 });
desk.warm();
say = () => 'WORK\nOn it.';
await desk.hear('lost', input('queued behind a long turn'));
await sleep(80);
check(desk.ack('lost', () => {}) === undefined, 'a call nobody claimed in time is let go');
processes.at(-1)!.end();
await sleep(5);
const startedBefore = processes.length;
const afterDeath = await hearAndAck(desk, 'dead', 'add a button');
check(processes.length > startedBefore && afterDeath.sorted === 'work' && afterDeath.said === 'On it.', 'a spare that died is dropped and the message gets a new process', `${processes.length - startedBefore} new`);
check(alive() <= 2, 'and there are never more than two alive', String(alive()));
desk.stop();

process.env.OFFICE_ACK = '0';
processes.length = 0;
const off = new Acknowledger(run);
off.warm();
check(processes.length === 0 && off.hear('x', input('hi')) === undefined, 'OFFICE_ACK=0 starts nothing');
delete process.env.OFFICE_ACK;

finish();
