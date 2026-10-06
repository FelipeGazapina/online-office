// No model, no network. The acknowledger's triage call against a scripted stand-in for the Agent SDK's query(): what the
// owner's message becomes, when the answer is not usable, and what process answers it.
// Run from app/: node verify/ack-check.ts   Exits 1 on any failed check.
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Acknowledger } from '../src/main/office/ack.ts';
import { PushQueue, type ClaudeRun } from '../src/main/office/adapters/claude.ts';
import { check, finish } from './check.ts';

type Process = { options: Options; sent: string[]; closed: boolean };
const processes: Process[] = [];
// What the stand-in says to the next prompt. A function decides, so a check can answer late, wrongly, or not at all.
let say: (prompt: string) => string | 'never' | 'error' = () => 'WORK';

const run: ClaudeRun = ({ prompt, options }) => {
  const p: Process = { options, sent: [], closed: false };
  processes.push(p);
  const out = new PushQueue<SDKMessage>();
  void (async () => {
    for await (const m of prompt as AsyncIterable<SDKUserMessage>) {
      const text = String((m.message as { content: unknown }).content);
      p.sent.push(text);
      const word = say(text);
      if (word === 'never') continue;
      out.push((word === 'error' ? { type: 'result', subtype: 'error_during_execution', is_error: true } : { type: 'result', subtype: 'success', is_error: false, result: word }) as unknown as SDKMessage);
    }
  })();
  return { [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](), close: () => void (p.closed = true, out.close()) } as unknown as ReturnType<ClaudeRun>;
};

delete process.env.OFFICE_ACK;
delete process.env.OFFICE_TRIAGE;
const desk = new Acknowledger(run);

check(desk.triage('which file handles login?') === undefined && processes.length === 0, 'before warm() there is no triage and no process');

desk.warm();
check(processes.length === 2, 'warm() starts one spare for the acknowledgement and one for triage', String(processes.length));
check(new Set(processes.map((p) => String(p.options.systemPrompt))).size === 2 && /QUESTION or WORK/.test(String(processes[1]!.options.systemPrompt)), 'each spare carries its own system prompt');
check(processes.every((p) => Array.isArray(p.options.tools) && p.options.tools.length === 0 && (p.options.thinking as { type: string }).type === 'disabled' && p.options.maxTurns === 1), 'and both are tool-free with thinking off and one turn');

say = () => 'QUESTION';
check((await desk.triage('which file handles login?')) === 'help', 'QUESTION is help');
check(processes.length === 3 && processes[1]!.closed && !processes[2]!.closed, 'the spare that answered is closed and a fresh one takes its place', `${processes.length} processes`);
say = () => 'WORK';
check((await desk.triage('add a logout button')) === 'work', 'WORK is work');
say = () => 'Question.';
check((await desk.triage('what is this?')) === 'help', 'the answer is read case-blind');
say = () => 'I think it is a question about login';
check((await desk.triage('which file handles login?')) === undefined, 'an answer that is not one of the two words is no answer');
say = () => 'error';
check((await desk.triage('which file handles login?')) === undefined, 'a failed call is no answer');
say = () => 'never';
const t0 = Date.now();
check((await desk.triage('which file handles login?', 60)) === undefined && Date.now() - t0 < 1000, 'a call that never answers gives up at the leash');

say = () => 'WORK';
const long = `${'a'.repeat(3000)}THE-END-QUESTION?`;
await desk.triage(long);
const sentLong = processes.flatMap((p) => p.sent).at(-1)!;
check(sentLong.length < 2300 && sentLong.includes('THE-END-QUESTION?') && sentLong.startsWith('The boss wrote:'), 'a long message is clipped from the middle, so its first and last words are both seen', String(sentLong.length));

process.env.OFFICE_TRIAGE = '0';
const before = processes.length;
check(desk.triage('which file handles login?') === undefined && processes.length === before, 'OFFICE_TRIAGE=0 asks nobody');
delete process.env.OFFICE_TRIAGE;

desk.stop();
check(processes.every((p) => p.closed) && desk.triage('which file handles login?') === undefined, 'stop() closes every spare and ends triage');

finish();
