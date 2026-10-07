// No app, no model. The terminal's shape (src/shared/terminal.ts): how events fold into blocks, how a block wraps to a width, what
// the screen shows under it, and how a window keeps up with the pushes. The session itself is checked in claude-check.ts.
// Run from app/: node verify/terminal-check.ts   Exits 1 on any failed check.
import type { AllowRule, EmployeeStatus, Question, QuestionId } from '../src/shared/protocol.ts';
import { covers, ruleFor, sameRule, type PermissionBody } from '../src/shared/permissions.ts';
import { applyPush, footerOf, layoutBlocks, layoutLog, optionsOf, questionRows, rowText, screenOf, spinnerRows, TERMINAL_LINES, TerminalBuffer, toolLines, wrap, type TermBlock, type TermEvent, type TerminalLine } from '../src/shared/terminal.ts';
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
check(blocks.length === 4 && text(blocks[3]!.lines).join('|') === '● Read(package.json)|  ⎿  Read 46 lines (click to expand)' && blocks[3]!.lines[0]!.spans[0]!.c === 'ok', 'its result lands in the same block, and the dot turns green');
t.apply({ k: 'tool', id: 't2', name: 'Bash', input: { command: 'npm   test\n --silent' } });
t.apply({ k: 'result', id: 't2', ok: false, text: 'FAIL src/a.test.ts\nexpected 1\nreceived 2\nat line 4' });
blocks = t.all();
check(text(blocks[4]!.lines).join('|') === '● Bash(npm test --silent)|  ⎿  Error: FAIL src/a.test.ts|     expected 1|     received 2|     … +1 line (click to expand)' && blocks[4]!.lines[0]!.spans[0]!.c === 'err', 'a failed command shows its first lines in red and how many it left out');
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
check(text(toolLines('Edit', { file_path: '/work/repo/a.ts' }, '/work/repo', { ok: true, text: 'x', data: { structuredPatch: [{ oldStart: 9, newStart: 9, lines: [' a', '-b', '+c', '+d'] }] } }).lines).join('|') === '● Update(a.ts)|  ⎿  Updated a.ts with 2 additions and 1 removal|      9   a|     10 - b|     10 + c|     11 + d', 'an edit counts what it added and removed and numbers its diff rows from the patch');

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
const compact = footerOf({ blocks: [], live: t.live, status: working, now: 0, cols: 60, rows: 8, compact: true });
check(compact.length === 4 && rowText(compact[2]!).startsWith('❯ ') && /… \(0s\)$/.test(rowText(compact[0]!)), 'the compact footer on a desk monitor is the spinner, without the hint a monitor cannot act on, and the prompt box');

console.log('\n# turns');
const convo = new TerminalBuffer('/work/repo');
convo.apply({ k: 'prompt', text: 'What word is in hello.txt? Answer with that word only.' });
convo.apply({ k: 'tool', id: 'r1', name: 'Read', input: { file_path: '/work/repo/hello.txt' } });
convo.apply({ k: 'result', id: 'r1', ok: true, text: '1\thi', data: { file: { numLines: 1 } } });
convo.apply({ k: 'text', id: 'a1', text: 'hi' });
convo.apply({ k: 'prompt', text: 'Run the tests' });
convo.apply({ k: 'tool', id: 'b1', name: 'Bash', input: { command: 'make' } });
convo.apply({ k: 'end', how: 'interrupted' });
convo.apply({ k: 'prompt', text: 'Create three files a.txt, b.txt and c.txt' });
convo.apply({ k: 'tool', id: 'w1', name: 'Write', input: { file_path: '/work/repo/a.txt', content: 'a' } });
const turnsOf = (v = {}) => layoutBlocks(convo.all(), 80, v);
let laid = turnsOf();
check(convo.all().map((b) => b.turn).join() === '0,1,1,1,2,2,3,3', 'a prompt opens a turn and the blocks after it belong to it');
check(text(laid).filter((r) => r.startsWith('▸ ')).length === 2, 'the turns before the current one are a row each');
check(text(laid).some((r) => r === '▸ ❯ What word is in hello.txt? Answer with that word only.  · 1 call  → hi'), `a row says what was asked, how many calls it took and what was answered (${text(laid).find((r) => r.startsWith('▸ '))})`);
check(text(laid).some((r) => /^▸ ❯ Run the tests {2}· 1 call · interrupted$/.test(r)), 'and an interrupted turn says so');
check(!text(laid).some((r) => r.includes('Read(hello.txt)')) && text(laid).some((r) => r.includes('Write(a.txt)')) && text(laid).some((r) => r === '❯ Create three files a.txt, b.txt and c.txt'), 'the current turn is printed in full, the old ones are not');
const summaries = laid.filter((r) => r.act && 'turn' in r.act);
check(summaries.map((r) => ('turn' in r.act! ? r.act.turn : -1)).join() === '1,2' && laid.findIndex((r) => r === summaries[1]) === laid.findIndex((r) => r === summaries[0]) + 1, 'a click on the row opens that turn, and the rows of old turns sit together');
laid = turnsOf({ turns: new Set([1]) });
check(text(laid).some((r) => r.startsWith('▾ ❯ What word')) && text(laid).some((r) => r.includes('Read(hello.txt)')) && laid.filter((r) => r.old).length === 4, 'an old turn the owner opened shows its blocks, drawn dimmer');
check(laid.filter((r) => r.old).every((r) => !text([r]).some((x) => x.includes('Write(a.txt)'))), 'and the current turn stays as it was');
const flatLog = layoutBlocks(convo.all(), 80, { compact: true });
check(!text(flatLog).some((r) => r === '') && text(flatLog).filter((r) => r.startsWith('▸ ')).length === 2, 'on a monitor there are no blank rows, and old turns are still a row each');
check(layoutBlocks(convo.all(), 80).length > flatLog.length, 'and a monitor takes fewer rows than the panel for the same log');

const parts = layoutLog(convo.all(), 80);
check(parts.head.length === 3 && parts.past.length === 2 && text(parts.now)[0] === '❯ Create three files a.txt, b.txt and c.txt', 'the log comes in three parts: the header, the turns before this one, and this one');
check(layoutBlocks(convo.all(), 80).length === parts.head.length + parts.past.length + parts.now.length + 2, 'and as one list they are the same rows with a blank row between the parts');
const busy = new TerminalBuffer('/work/repo');
busy.apply({ k: 'prompt', text: 'go' });
busy.apply({ k: 'thinking', id: 't', secs: 2 });
busy.apply({ k: 'tool', id: 'c1', name: 'TaskCreate', input: { subject: 'One' } });
busy.apply({ k: 'tool', id: 'c2', name: 'TaskCreate', input: { subject: 'Two' } });
busy.apply({ k: 'tool', id: 'w', name: 'Write', input: { file_path: '/work/repo/a', content: 'a' } });
check(text(layoutBlocks(busy.all().slice(1), 60)).join('|') === '❯ go||∴ Thought for 2s|● Add task(One)|● Add task(Two)||● Write(a)', 'a thought sits right above what it led to, and the owner\'s own bookkeeping calls sit together');
check(busy.all().filter((b) => b.kind === 'chore').length === 2 && text(layoutBlocks(busy.all().slice(1), 60, { compact: true })).join('|') === '❯ go|∴ Thought for 2s|● Write(a)', 'on a monitor the bookkeeping is left out, the list being in the spinner');
check(busy.all().find((b) => b.kind === 'chore')!.lines[0]!.spans.every((x) => x.c === 'dim' && !x.b), 'and it is dim, so the calls that did the work are the ones that stand out');

console.log('\n# results the owner can open');
const wrote = new TerminalBuffer('/work/repo');
wrote.apply({ k: 'prompt', text: 'go' });
wrote.apply({ k: 'tool', id: 'w', name: 'Write', input: { file_path: '/work/repo/n.txt', content: 'one\ntwo\nthree\nfour\nfive\nsix' } });
wrote.apply({ k: 'result', id: 'w', ok: true, text: 'ok' });
const wb = wrote.all().at(-1)!;
check(text(wb.lines).join('|') === '● Write(n.txt)|  ⎿  Wrote 6 lines to n.txt|       1  one|       2  two|       3  three|       4  four|     … +2 lines (click to expand)', `a long result is a count, a few lines and how many are left (${text(wb.lines).join('|')})`);
check(wb.lines.filter((l) => l.toggle).length === 2 && wb.full!.filter((l) => l.toggle).length === 2, 'the call and the line that says click to expand toggle it');
check(text(wb.full!).join('|').includes('6  six') && text(wb.full!).at(-1)!.includes('click to collapse'), 'opened, it holds every line and says how to close it');
const opened = layoutBlocks(wrote.all(), 60, { calls: new Set([wb.n]) });
check(text(opened).some((r) => r.includes('6  six')) && opened.find((r) => text([r])[0]!.includes('Write(n.txt)'))!.act !== undefined && ('block' in opened.find((r) => text([r])[0]!.includes('Write(n.txt)'))!.act!), 'the rows of a call the owner opened carry the click that closes it');
const body = wb.lines[2]!.spans.slice(-2);
check(body[0]!.c === 'dim' && body[1]!.c === 'fg', 'the text of a result is as bright as the words above it, and the line numbers are dim');
const mini = text(layoutBlocks(wrote.all(), 48, { compact: true })).slice(-3);
check(mini.join('|') === '❯ go|● Write(n.txt)|  ⎿  Wrote 6 lines to n.txt', `a monitor shows the call and its count (${mini.join('|')})`);
wrote.apply({ k: 'tool', id: 'r', name: 'Read', input: { file_path: '/work/repo/n.txt' } });
wrote.apply({ k: 'result', id: 'r', ok: true, text: '1\tone\n2\ttwo\n3\tthree', data: { file: { numLines: 3 } } });
check(text(wrote.all().at(-1)!.lines).join('|') === '● Read(n.txt)|  ⎿  Read 3 lines (click to expand)' && text(wrote.all().at(-1)!.full!).join('|').includes('2\ttwo'), 'a read says how many lines and holds them to open');
check(text(layoutBlocks(wrote.all().slice(-1), 60, { compact: true })).join('|') === '● Read(n.txt)|  ⎿  Read 3 lines', 'and a monitor leaves the hint out');
const fits = new TerminalBuffer('/work/repo');
fits.apply({ k: 'tool', id: 'b', name: 'Bash', input: { command: 'ls' } });
fits.apply({ k: 'result', id: 'b', ok: true, text: 'a.txt\nb.txt\nc.txt', data: { stdout: 'a.txt\nb.txt\nc.txt' } });
check(fits.all().at(-1)!.full === undefined && text(fits.all().at(-1)!.lines).join('|') === '● Bash(ls)|  ⎿  a.txt|     b.txt|     c.txt', 'a result that fits has nothing to open');

console.log('\n# what the employee is doing');
const planned = new TerminalBuffer('/work/repo');
planned.apply({ k: 'prompt', text: 'go' });
planned.apply({
  k: 'tool',
  id: 'p',
  name: 'TodoWrite',
  input: { todos: [{ content: 'Read the config', status: 'completed', activeForm: 'Reading the config' }, { content: 'Write the tests', status: 'in_progress', activeForm: 'Writing the tests' }, { content: 'Run the suite', status: 'pending', activeForm: 'Running the suite' }] },
});
check(planned.live.plan?.active === 'Writing the tests' && planned.live.plan.next === 'Run the suite', 'the todo list says what is being done and what comes next');
let spun = spinnerRows(10_000, 16_000, 1234, 80, 160, planned.live.plan);
check(text(spun).join('|').endsWith('Writing the tests… (6s · ↑ 1.2k tokens · esc to interrupt)|  ⎿  Next: Run the suite') && spun[0]!.spans[0]!.c === 'accent', 'the spinner line is the todo being done, in the accent colour, with the next one under it');
spun = spinnerRows(10_000, 16_000, 0, 80, 160);
check(spun.length === 1 && !text(spun)[0]!.includes('Next:'), 'an employee with no list has the verb and no hint');
planned.apply({ k: 'tool', id: 'p2', name: 'TodoWrite', input: { todos: [{ content: 'Run the suite', status: 'in_progress', activeForm: 'Running the suite' }] } });
check(planned.live.plan?.active === 'Running the suite' && planned.live.plan.next === undefined && spinnerRows(0, 1000, 0, 80, 160, planned.live.plan).length === 1, 'the last todo has nothing after it');
planned.apply({ k: 'tool', id: 'p3', name: 'TodoWrite', input: { todos: [{ content: 'Run the suite', status: 'completed', activeForm: 'Running the suite' }] } });
check(planned.live.plan === undefined, 'a list with nothing left to do says nothing');
planned.apply({ k: 'tool', id: 'p4', name: 'TodoWrite', input: { todos: [{ content: 'A very long thing to do next so that the active line has to wrap', status: 'in_progress', activeForm: 'Doing a very long thing so that the active line has to wrap inside forty columns' }] } });
check(spinnerRows(0, 5000, 0, 40, 160, planned.live.plan).every((r) => rowText(r).length <= 40), 'a long active line wraps inside the width');
planned.apply({ k: 'end', how: 'done' });
check(planned.live.plan === undefined, 'the list is gone when the turn ends');

const tasks = new TerminalBuffer('/work/repo');
tasks.apply({ k: 'prompt', text: 'go' });
const create = (id: string, subject: string, activeForm: string, result: { data?: unknown; text: string }) => {
  tasks.apply({ k: 'tool', id: `c${id}`, name: 'TaskCreate', input: { subject, description: 'x', activeForm } });
  tasks.apply({ k: 'result', id: `c${id}`, ok: true, ...result });
};
create('1', 'Write a.txt', 'Writing a.txt', { data: { task: { id: '1', subject: 'Write a.txt' } }, text: 'Task #1 created successfully: Write a.txt' });
create('2', 'Write b.txt', 'Writing b.txt', { text: 'Task #2 created successfully: Write b.txt' });
create('3', 'Run ls', 'Running ls', { text: 'created' });
check(planned.live.plan === undefined && tasks.live.plan?.active === 'Writing a.txt' && tasks.live.plan.next === 'Write b.txt', 'tasks made one at a time make the list too, whether their id comes as data, in the words or by count');
check(text(tasks.all().at(-1)!.lines).join('|') === '● Add task(Run ls)', `a created task is one line (${text(tasks.all().at(-1)!.lines).join('|')})`);
tasks.apply({ k: 'tool', id: 'u1', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } });
tasks.apply({ k: 'tool', id: 'u2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } });
tasks.apply({ k: 'tool', id: 'u3', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } });
check(tasks.live.plan?.active === 'Writing b.txt' && tasks.live.plan.next === 'Run ls' && text(tasks.all().at(-2)!.lines).join('|') === '● Update task(#1 · completed)', 'an update moves the list: the one being done, and the one after it');
tasks.apply({ k: 'tool', id: 'u4', name: 'TaskUpdate', input: { taskId: '3', status: 'deleted' } });
check(tasks.live.plan?.next === undefined, 'a deleted task is not next');
tasks.apply({ k: 'end', how: 'done' });
check(tasks.live.plan === undefined, 'and the list goes with the turn');

console.log('\n# the permission dialog');
const q = (body: object): Question => ({ id: 'q' as QuestionId, askedAt: 0, ...body }) as Question;
const perm = (tool: string, detail: string): Question => q({ kind: 'permission', text: 'Can I?', tool, detail });
const run = perm('Bash', 'npm test -- --watch');
check(optionsOf(run).map((o) => `${o.key}:${o.label}`).join('|') === "1:Yes|2:Yes, and don't ask again for: npm test *|3:No", 'a command asks Yes, Yes and do not ask again for the exact words it will store, and a plain No');
check(optionsOf(run).map((o) => o.kind).join() === 'allow,always,deny', 'each choice says what it does');
const noRule = perm('Bash', 'sudo make install');
check(optionsOf(noRule).map((o) => `${o.key}:${o.kind}`).join() === '1:allow,2:deny' && optionsOf(perm('Bash', 'a && b')).every((o) => o.kind !== 'always'), 'a command no rule can stand for has no do-not-ask-again, and No moves up to 2');

// The scope on the choice is the rule the office stores: what the label says is read back into a rule, and the two must be the same.
const readBack = (label: string): AllowRule | undefined => {
  const m = /^Yes, and don't ask again for( exactly)?: (.*)$/s.exec(label);
  if (!m) return undefined;
  if (m[1]) return { kind: 'exact', command: m[2]! };
  const tool = /^all (.+) calls$/.exec(m[2]!);
  if (tool) return { kind: 'tool', name: tool[1]! };
  return m[2]!.endsWith(' *') ? { kind: 'command', prefix: m[2]!.slice(0, -2) } : undefined;
};
const cases: [string, string][] = [
  ['Bash', 'npm test -- --watch'], ['Bash', 'git status --short'], ['Bash', 'touch permission-ok.txt'], ['Bash', 'ls -la'], ['Bash', 'pnpm build:verify'],
  ['Bash', 'node -e "setInterval(() => {}, 1000)" m1-slow'], ['Bash', 'rm -rf *'], ['Bash', 'python3 script.py --fast'], ['Write', '/work/repo/a.txt'], ['Edit', 'src/a.ts'],
];
for (const [tool, detail] of cases) {
  const question = perm(tool, detail);
  const always = optionsOf(question).find((o) => o.kind === 'always');
  const stored = ruleFor(question as PermissionBody);
  check(!!always && !!stored && sameRule(readBack(always.label)!, stored), `${tool} ${detail}: the choice says "${always?.label}" and the stored rule is ${JSON.stringify(stored)}`);
  const body = question as PermissionBody;
  check(!!stored && covers(stored, body), `${tool} ${detail}: the rule it stores covers the call on the card`);
}
const npm = ruleFor(perm('Bash', 'npm test -- --watch') as PermissionBody)!;
check(covers(npm, perm('Bash', 'npm test') as PermissionBody) && !covers(npm, perm('Bash', 'npm testing') as PermissionBody) && !covers(npm, perm('Bash', 'npm run build') as PermissionBody) && !covers(npm, perm('Bash', 'npm test && rm -rf /') as PermissionBody), '`npm test *` covers npm test with more words and nothing that merely starts with those letters or chains a second command');
const exact = ruleFor(perm('Bash', 'rm -rf *') as PermissionBody)!;
check(exact.kind === 'exact' && !covers(exact, perm('Bash', 'rm -rf node_modules') as PermissionBody) && /for exactly: rm -rf \*$/.test(optionsOf(perm('Bash', 'rm -rf *')).find((o) => o.kind === 'always')!.label), 'a command that can run anything is allowed exactly, and the choice says exactly, so a trailing * is not read as a wildcard');

const blocked: EmployeeStatus = { kind: 'blocked_on_owner', task: 't', question: run };
const dialogLive = { tokens: 0, asks: [{ detail: 'npm test -- --watch', description: 'Run the test suite' }] };
screen = text(screenOf({ blocks: t.all(), live: dialogLive, status: blocked, now: 0, cols: 70, rows: 40, who: 'Ana', model: 'Haiku 4.5', mode: 'ask' }));
const at = screen.findIndex((r) => r.includes('Bash command'));
check(at > 0 && screen[at - 1]!.startsWith('────'), 'a permission dialog opens with a rule over its title');
const want = ['Bash command', 'Run the test suite', '╌', 'npm test -- --watch', '╌', 'This command requires approval', '', 'Do you want to proceed?', '❯ 1. Yes', '2. Yes, and don\'t ask again for: npm test *', '3. No', '', 'Esc to cancel · Tab to amend'];
const got = screen.slice(at, at + want.length).map((r) => r.trim());
check(want.every((w, i) => (w === '' ? got[i] === '' : got[i]!.startsWith(w))), `the dialog reads title, description, the command between dashed rules, requires approval, the question, the choices and the footer (${got.join(' | ')})`);
check(/Ana · Haiku 4\.5$/.test(screen[at + want.length - 1]!), 'the footer names who is asking');
check(!screen.slice(at).some((r) => r.startsWith('❯ ') || r.startsWith('────')), 'no prompt box under the dialog: one input line at a time');
check(!screen.some((r) => /\(.*esc to interrupt/.test(r)), 'the dialog replaces the spinner');
check(!screen.some((r) => /tell them what to do differently/.test(r)), 'the No choice is plain, with no second line repeating it');
screen = text(screenOf({ blocks: [], live: dialogLive, status: blocked, now: 0, cols: 70, rows: 40 }));
check(screen.some((r) => r.includes('╌╌╌╌')) && screen.some((r) => r.includes('This command requires approval')), 'the rest of the dialog does not depend on who asks');
const noWords = text(screenOf({ blocks: [], live: { tokens: 0 }, status: blocked, now: 0, cols: 70, rows: 40 }));
check(!noWords.some((r) => r.trim() === 'Run the test suite') && noWords.some((r) => r.includes('npm test -- --watch')), 'a call that gave no description has none, and still shows its command');
const amended = text(questionRows(run, 70, { amend: 'use npm ci' }));
check(amended.some((r) => r.includes('3. No, and tell them what to do differently: use npm ci█')) && amended.some((r) => r.includes('Enter to send')), 'after Tab the words typed sit under No, on its own row');
const long = text(questionRows(perm('Bash', Array.from({ length: 14 }, (_, i) => `echo line ${i}`).join('\n')), 60));
check(long.some((r) => /… \+\d+ lines?$/.test(r.trim())) && long.length < 36, 'a long command keeps its first rows and says how many it left out');
const tall = text(questionRows(perm('Bash', 'node -e "' + 'x'.repeat(200) + '"'), 40));
check(tall.filter((r) => r.trim().startsWith('x') || r.includes('node -e')).length >= 3 && tall.every((r) => r.length <= 40), 'a long command wraps inside the width');
const small = questionRows(run, 48, { compact: true });
check(small.length <= 7 && text(small).some((r) => r.includes('2. Yes, and don\'t ask again for: npm test *')) && !text(small).some((r) => r.includes('requires approval')), `on a desk monitor the dialog is the command and the choices (${small.length} rows)`);
const edit = text(questionRows(perm('Write', '/work/repo/a.txt'), 60));
check(edit[1]!.trim() === 'Create file' && edit.some((r) => r.includes('This action requires approval')) && edit.some((r) => r.includes('for: all Write calls')), 'a file tool reads Create file, and its always-allow is every Write');
const ask = q({ kind: 'ask', text: 'Which colour?', options: ['red', 'blue'] });
screen = text(screenOf({ blocks: [], live: t.live, status: { kind: 'blocked_on_owner', task: 't', question: ask }, now: 0, cols: 50, rows: 20 }));
check(screen.some((r) => r.includes('Which colour?')) && screen.some((r) => r.includes('1. red')) && screen.some((r) => r.includes('2. blue')) && screen.some((r) => r.startsWith('❯ ')), 'a question to the owner lists its options, and keeps the prompt to answer in words');

console.log('\n# what a call says about itself');
const asked = new TerminalBuffer('/work/repo');
asked.apply({ k: 'approval', detail: 'npm test', description: 'Run the test suite', reason: 'Not in the allow list' });
check(asked.live.asks?.[0]?.description === 'Run the test suite' && asked.take()!.live.asks?.length === 1, 'an approval event rides along on the live part of the next push');
for (let i = 0; i < 6; i++) asked.apply({ k: 'approval', detail: `cmd ${i}` });
check(asked.live.asks?.length === 4 && asked.live.asks.at(-1)!.detail === 'cmd 5', 'it keeps the last few');
asked.apply({ k: 'end', how: 'done' });
check(asked.live.asks === undefined, 'and drops them when the turn ends');

finish();
