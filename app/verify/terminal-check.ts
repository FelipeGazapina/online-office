// No app, no model. The terminal's shape (src/shared/terminal.ts): how events fold into blocks, how a block wraps to a width, what
// the screen shows under it, and how a window keeps up with the pushes. The session itself is checked in claude-check.ts.
// Run from app/: node verify/terminal-check.ts   Exits 1 on any failed check.
import type { EmployeeStatus, Question, QuestionId } from '../src/shared/protocol.ts';
import { applyPush, footerOf, optionsOf, rowText, screenOf, TERMINAL_LINES, TerminalBuffer, toolLines, wrap, type TermBlock, type TermEvent, type TerminalLine } from '../src/shared/terminal.ts';
import { check, finish } from './check.ts';

const text = (rows: { spans: { t: string }[] }[]) => rows.map((r) => r.spans.map((s) => s.t).join(''));
const plain = (t: string, hang = 0): TerminalLine => ({ spans: [{ t }], hang });

console.log('# wrapping');
let rows = text(wrap(plain('● one two three four five six seven', 2), 14));
check(rows.every((r) => r.length <= 14) && rows.join('|') === '● one two|  three four|  five six|  seven', `a line breaks at spaces and the next rows hang under the text (${rows.join('|')})`);
rows = text(wrap(plain('abcdefghijklmnopqrstuvwxyz', 4), 10));
check(rows.every((r) => r.length <= 10) && rows.join('').replace(/ /g, '') === 'abcdefghijklmnopqrstuvwxyz', `a word longer than the width is cut where it must (${rows.join('|')})`);
const styled = wrap({ spans: [{ t: 'aaa ', c: 'ok' }, { t: 'bbb ccc', c: 'err' }] }, 8);
check(styled.length === 2 && styled[0]!.spans.map((s) => s.c).join() === 'ok,err' && styled[1]!.spans[0]!.c === 'err', 'each part of a wrapped line keeps its colour');
check(wrap({ spans: [] }, 20).length === 1 && wrap({ spans: [{ t: 'x' }], fill: 'add' }, 20)[0]!.fill === 'add', 'an empty line is one empty row, and a diff row keeps its tint');

console.log('\n# folding events');
const t = new TerminalBuffer('/work/repo', 'Claude Code', 'm');
const events: TermEvent[] = [
  { k: 'prompt', text: 'Add a README' },
  { k: 'text', id: 'a', text: 'I will start' },
  { k: 'text', id: 'a', text: 'I will start by reading the **package.json** and `index.ts`.' },
  { k: 'tool', id: 't1', name: 'Read', input: { file_path: '/work/repo/package.json' } },
];
for (const e of events) t.apply(e);
let blocks = t.all();
check(blocks.length === 4 && blocks.map((b) => b.n).join() === '0,1,2,3', 'the banner, the prompt, one text and one call are four blocks, in order');
check(text(blocks[2]!.lines)[0] === '● I will start by reading the package.json and index.ts.', 'the same text id again replaces the block, with bold and code folded into styled parts');
check(blocks[2]!.lines[0]!.spans.some((s) => s.b && s.t === 'package.json') && blocks[2]!.lines[0]!.spans.some((s) => s.c === 'info' && s.t === 'index.ts'), 'bold is bold, code is its own colour');
check(blocks[3]!.lines.length === 1 && blocks[3]!.lines[0]!.spans[0]!.c === 'dim', 'a call still waiting for its result has a dim dot');
t.apply({ k: 'result', id: 't1', ok: true, text: '1\t{}', data: { file: { numLines: 46 } } });
blocks = t.all();
check(blocks.length === 4 && text(blocks[3]!.lines).join('|') === '● Read(package.json)|  ⎿  Read 46 lines' && blocks[3]!.lines[0]!.spans[0]!.c === 'ok', 'its result lands in the same block, and the dot turns green');
t.apply({ k: 'tool', id: 't2', name: 'Bash', input: { command: 'npm   test\n --silent' } });
t.apply({ k: 'result', id: 't2', ok: false, text: 'FAIL src/a.test.ts\nexpected 1\nreceived 2\nat line 4' });
blocks = t.all();
check(text(blocks[4]!.lines).join('|') === '● Bash(npm test --silent)|  ⎿  Error: FAIL src/a.test.ts|     expected 1|     received 2|     … +1 line' && blocks[4]!.lines[0]!.spans[0]!.c === 'err', 'a failed command shows its first lines in red and how many it left out');
t.apply({ k: 'tool', id: 't3', name: 'mcp__office__message', input: { to: 'owner', text: 'Starting now' } });
check(text(t.all()[5]!.lines)[0] === '● office - message (MCP)(to: "owner", text: "Starting now")', 'the office tools read like any MCP server');
t.apply({ k: 'tool', id: 't4', name: 'Bash', input: { command: 'sleep 99' } });
t.apply({ k: 'end', how: 'interrupted' });
blocks = t.all();
check(blocks.at(-1)!.lines[0]!.spans[0]!.c === 'err' && text(blocks.at(-1)!.lines).join('|') === '● Bash(sleep 99)|  ⎿  Interrupted · What should Claude do instead?', 'an interrupted turn closes the call that never returned and says so under it');
const quiet = new TerminalBuffer('/work/repo');
quiet.apply({ k: 'text', id: 'q', text: 'thinking out loud' });
quiet.apply({ k: 'end', how: 'interrupted' });
check(text(quiet.all().at(-1)!.lines)[0] === '  ⎿  Interrupted · What should Claude do instead?' && quiet.all().length === 3, 'an interruption with no call in flight is a line of its own');
const stopped = new TerminalBuffer('/work/repo');
stopped.apply({ k: 'tool', id: 's', name: 'Bash', input: { command: 'make' } });
stopped.apply({ k: 'result', id: 's', ok: false, text: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)." });
stopped.apply({ k: 'end', how: 'interrupted' });
check(stopped.all().length === 2 && text(stopped.all()[1]!.lines).join('|') === '● Bash(make)|  ⎿  Interrupted · What should Claude do instead?', 'the SDK\'s rejection of a stopped call reads as the interruption, and the end of the turn does not say it twice');
check(text(toolLines('Edit', { file_path: '/work/repo/a.ts' }, '/work/repo', { ok: true, text: 'x', data: { structuredPatch: [{ oldStart: 9, newStart: 9, lines: [' a', '-b', '+c', '+d'] }] } })).join('|') === '● Update(a.ts)|  ⎿  Updated a.ts with 2 additions and 1 removal|      9   a|     10 - b|     10 + c|     11 + d', 'an edit counts what it added and removed and numbers its diff rows from the patch');

const thoughts = new TerminalBuffer('/work/repo');
thoughts.apply({ k: 'thinking', id: 'a:0' });
thoughts.apply({ k: 'thinking', id: 'a:0', secs: 2 });
thoughts.apply({ k: 'thinking', id: 'b:0' });
thoughts.apply({ k: 'thinking', id: 'b:0', secs: 1 });
check(thoughts.all().length === 2 && text(thoughts.all()[1]!.lines)[0] === '∴ Thought for 1s', 'thoughts with nothing printed between them are one line');
thoughts.apply({ k: 'text', id: 'c', text: 'hello' });
thoughts.apply({ k: 'thinking', id: 'd:0', secs: 3 });
check(thoughts.all().length === 4, 'a thought after some text is a new line');
thoughts.apply({ k: 'tool', id: 'm', name: 'mcp__office__reply', input: { requestId: 'abc123', outcome: 'done', text: 'ok' } });
thoughts.apply({ k: 'result', id: 'm', ok: true, text: '{"ok":true}' });
check(text(thoughts.all().at(-1)!.lines).join('|') === '● office - reply (MCP)(outcome: "done", text: "ok")', 'an office tool that only says ok has no result line, and its ids stay out of the call');

console.log('\n# pushes');
const fresh = new TerminalBuffer('/work/repo');
const first = fresh.take();
check(first?.reset === true && first.blocks.length === 1, 'the first push carries everything and says it starts over');
check(fresh.take() === undefined, 'nothing changed, nothing to push');
fresh.apply({ k: 'prompt', text: 'hi' });
fresh.apply({ k: 'text', id: 'x', text: 'hello' });
const second = fresh.take()!;
check(second.reset === undefined && second.blocks.map((b) => b.n).join() === '1,2', 'the next push carries the blocks that changed and no more');
fresh.apply({ k: 'text', id: 'x', text: 'hello there' });
check(fresh.take()!.blocks.map((b) => b.n).join() === '2', 'a text that grew is one block');
fresh.apply({ k: 'tokens', out: 120 });
const tok = fresh.take()!;
check(tok.blocks.length === 0 && tok.live.tokens === 120, 'the token count rides along without a block');
const held = new Map<number, TermBlock>();
for (const push of [first!, second]) applyPush(held, push);
check([...held.keys()].join() === '0,1,2', 'a window that applies the pushes in order holds the same blocks');

console.log('\n# the ring');
const big = new TerminalBuffer('/work/repo');
const sent = new Map<number, TermBlock>();
applyPush(sent, big.take()!);
for (let i = 0; i < 400; i++) {
  big.apply({ k: 'text', id: `m${i}`, text: `line a ${i}\nline b ${i}` });
  big.apply({ k: 'tool', id: `c${i}`, name: 'Bash', input: { command: `echo ${i}` } });
  if (i % 37 === 0) applyPush(sent, big.take()!);
}
applyPush(sent, big.take()!);
const total = big.all().reduce((n, b) => n + b.lines.length, 0);
check(total <= TERMINAL_LINES && big.all()[0]!.n === 0, `it keeps ${total} lines at most ${TERMINAL_LINES} and the banner`);
check(text(big.all().at(-2)!.lines)[0] === '● line a 399' && text(big.all().at(-1)!.lines)[0] === '● Bash(echo 399)', 'what it drops is the oldest');
check(JSON.stringify([...sent.values()].sort((a, b) => a.n - b.n)) === JSON.stringify(big.all()), 'a window that only got pushes holds what the buffer holds, drops included');
const reopened = new Map<number, TermBlock>();
applyPush(reopened, big.full());
check(JSON.stringify([...reopened.values()].sort((a, b) => a.n - b.n)) === JSON.stringify(big.all()), 'a window opened late gets all of it in one push');

console.log('\n# the screen');
const idle: EmployeeStatus = { kind: 'idle' };
const empty = new TerminalBuffer('/work/repo', 'Claude Code', 'haiku');
let screen = text(screenOf({ blocks: empty.all(), live: empty.live, status: idle, now: 0, cols: 60, rows: 14, who: 'Ana', model: 'haiku' }));
check(screen.length === 14 && screen[0]!.includes('▐▛███▜▌') && screen.some((r) => r.startsWith('❯ ')) && screen.filter((r) => r.startsWith('────')).length === 2, 'an idle employee shows the header and an empty prompt box, not a black screen');
check(screen.some((r) => r.startsWith('  ? for shortcuts') && r.endsWith('Ana · haiku')), 'the status line names who it is');
const edits = text(screenOf({ blocks: empty.all(), live: empty.live, status: idle, now: 0, cols: 70, rows: 10, mode: 'inherit' }));
check(edits.some((r) => r.startsWith('  ▸▸ accept edits on (shift+tab to cycle)')), 'and the mode the employee works in, in Claude Code words');
const manual = text(screenOf({ blocks: empty.all(), live: empty.live, status: idle, now: 0, cols: 70, rows: 10, mode: 'ask' }));
check(manual.some((r) => r.startsWith('  ⏸ manual mode on · ? for shortcuts')), 'an employee who asks for everything is in manual mode');
const took = new TerminalBuffer('/work/repo');
took.apply({ k: 'end', how: 'done', ms: 41_000 });
took.apply({ k: 'end', how: 'done', ms: 2_000 });
check(took.all().length === 2 && /^✻ [A-Z][a-z]+ for 41s$/.test(text(took.all()[1]!.lines)[0]!), 'a turn that took a while says for how long, and a short one says nothing');
const working: EmployeeStatus = { kind: 'working', task: 't', startedAt: 10_000 };
screen = text(screenOf({ blocks: t.all(), live: { tokens: 1234 }, status: working, now: 16_000, cols: 80, rows: 20 }));
const spin = screen.find((r) => /esc to interrupt/.test(r));
check(!!spin && /\(6s · ↑ 1\.2k tokens · esc to interrupt\)/.test(spin), `a working employee shows the spinner with the seconds and the tokens (${spin})`);
const cut = screenOf({ blocks: t.all(), live: t.live, status: idle, now: 0, cols: 40, rows: 6 });
check(cut.length === 6 && text(cut).some((r) => r.startsWith('❯ ')) && text(cut).at(-1)!.startsWith('  ? for shortcuts') && text(cut).join('|').includes('Interrupted'), 'a screen too short for the log keeps the prompt and the newest row, and drops the oldest');
const compact = footerOf({ blocks: [], live: t.live, status: working, now: 0, cols: 30, rows: 8, compact: true });
check(compact.length === 4 && rowText(compact[2]!).startsWith('❯ ') && /esc to interrupt/.test(rowText(compact[0]!)), 'the compact footer on a desk monitor is the spinner and the prompt box');

console.log('\n# questions on the screen');
const q = (body: object): Question => ({ id: 'q' as QuestionId, askedAt: 0, ...body }) as Question;
const run = q({ kind: 'permission', text: 'Can I run a shell command?', tool: 'Bash', detail: 'npm test -- --watch' });
check(optionsOf(run).map((o) => `${o.key}:${o.label}`).join('|') === "1:Yes|2:Yes, and don't ask again for npm test commands|3:No, and tell the employee what to do differently (esc)", 'a command asks Yes, Yes and do not ask again for that command, and No');
check(optionsOf(q({ kind: 'permission', text: '', tool: 'Bash', detail: 'a && b' })).map((o) => o.key).join() === '1,3' || optionsOf(q({ kind: 'permission', text: '', tool: 'Bash', detail: 'a && b' })).map((o) => o.key).join() === '1,2', 'a command no rule can stand for has no do-not-ask-again');
check(optionsOf(q({ kind: 'permission', text: '', tool: 'Bash', detail: 'a && b' })).every((o) => !o.always), 'and offers no always option');
const blocked: EmployeeStatus = { kind: 'blocked_on_owner', task: 't', question: run };
screen = text(screenOf({ blocks: t.all(), live: t.live, status: blocked, now: 0, cols: 70, rows: 40 }));
const at = screen.findIndex((r) => r.includes('Bash command'));
check(at > 0 && screen[at + 2]!.includes('npm test -- --watch') && screen.some((r) => r.includes('Do you want to proceed?')) && screen.some((r) => r.includes('❯ 1. Yes')) && screen.some((r) => r.includes('3. No, and tell')), 'a permission card is a dialog on the screen with its command and numbered choices');
check(!screen.some((r) => /\(esc to interrupt/.test(r)), 'the dialog replaces the spinner');
const ask = q({ kind: 'ask', text: 'Which colour?', options: ['red', 'blue'] });
screen = text(screenOf({ blocks: [], live: t.live, status: { kind: 'blocked_on_owner', task: 't', question: ask }, now: 0, cols: 50, rows: 20 }));
check(screen.some((r) => r.includes('Which colour?')) && screen.some((r) => r.includes('1. red')) && screen.some((r) => r.includes('2. blue')), 'a question to the owner lists its options');

finish();
