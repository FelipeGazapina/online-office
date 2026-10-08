// No browser. The sentences the task screens print about the people on a task and the entries of its log, from the pure
// helpers in hud/tasks/activityView.ts. A person who is waiting must read as waiting on whom for what, never as idle.
// Run from app/: node verify/activity-view-check.ts   Exits 1 on any failed check.
import type { ActivityEntry, OpenQuestion, PersonLive, TaskLive } from '../src/shared/activity.ts';
import type { MessageId } from '../src/shared/mail.ts';
import type { EmployeeId } from '../src/shared/protocol.ts';
import type { HandoffId, HandoffStep } from '../src/shared/tasks.ts';
import { answerKind, breakdownOf, cardLine, cut, questionCount, sayEntry, sayLive } from '../src/renderer/src/hud/tasks/activityView.ts';
import { check, finish } from './check.ts';

const e = (s: string) => s as EmployeeId;
const m = (s: string) => s as MessageId;
const names: Record<string, string> = { owner: 'You', mailroom: 'The office', rui: 'Rui', tess: 'Tess', jo: 'Jo', quin: 'Quin' };
const name = (id: string) => names[id] ?? id;
const piece = (title: string) => ({ id: m('p'), title, intent: 'work' as const });

const waiting: PersonLive = {
  employeeId: e('rui'),
  state: 'waiting',
  piece: piece('Team meeting'),
  since: 0,
  on: [
    { who: e('tess'), piece: piece('Piece 1 of 4: the office side'), state: 'building', round: 1, since: 0 },
    { who: e('jo'), piece: piece('Piece 2 of 4: the scene'), state: 'working', since: 0 },
  ],
};
const said = sayLive(waiting, name).text;
check(/^Waiting since \d.* on\n• Tess \(building round 1\) for “Piece 1 of 4: the office side”\n• Jo for “Piece 2 of 4: the scene”$/.test(said), 'a waiting person reads as waiting on whom, doing what, for which piece', said);
check(sayLive({ ...waiting, on: [] } as PersonLive, name).text.startsWith('Holding “Team meeting”'), 'a person holding a request with nothing out says so');
const working = sayLive({ employeeId: e('tess'), state: 'working', piece: piece('Piece 1'), since: 0, on: [] }, name);
check(working.state === 'working' && /^Working on “Piece 1” since \d/.test(working.text), 'working says on what and since when', working.text);
check(/, waiting on Jo$/.test(sayLive({ employeeId: e('tess'), state: 'working', piece: piece('Piece 1'), since: 0, on: [{ who: e('jo'), piece: piece('x'), state: 'queued', since: 0 }] }, name).text), 'a person who works while a teammate holds their piece says both');
const question: OpenQuestion = { ref: { kind: 'mail', id: m('q1') }, asker: e('quin'), to: 'owner', at: 0, text: 'Chefe, which one do you want, the first or the second option we talked about earlier today in the meeting?', how: 'blocked', piece: piece('README') };
const blocked = sayLive({ employeeId: e('quin'), state: 'blocked', question }, name).text;
check(blocked.startsWith('Blocked: “Chefe, which one') && blocked.endsWith('…”'), 'blocked carries the question, cut to a line', blocked);
check(sayLive({ employeeId: e('quin'), state: 'queued', piece: piece('README'), since: 0, behind: 'Another task' }, name).text === 'Next up: “README”, after “Another task”', 'queued says what it is behind');
check(sayLive({ employeeId: e('quin'), state: 'done', piece: piece('README'), at: 0, artifact: ['a', 'b'] }, name).text === 'Done “README”, 2 files', 'done counts the files');
check(sayLive({ employeeId: e('quin'), state: 'stopped', outcome: 'failed', piece: piece('README'), at: 0 }, name).text === 'Failed: “README”', 'a stopped person says how it ended');
check(sayLive({ employeeId: e('quin'), state: 'idle' }, name).text === 'Idle', 'idle is idle only when nothing else is true');

const live = (...people: PersonLive[]): TaskLive => ({ people, questions: [], open: 0 });
check(cardLine(undefined, name) === undefined && cardLine(live({ employeeId: e('rui'), state: 'idle' }), name) === undefined, 'a task nobody is on says nothing on its card');
check(cardLine(live(waiting, { employeeId: e('tess'), state: 'working', piece: piece('p'), since: 0, on: [] }, { employeeId: e('jo'), state: 'working', piece: piece('p'), since: 0, on: [] }), name)?.text === 'Tess, Jo working', 'the card names who is working before who waits');
check(cardLine(live(waiting), name)?.text === 'Rui waiting on Tess, Jo', 'with nobody working the card says who waits on whom');
check(cardLine(live({ ...waiting, on: [] } as PersonLive), name)?.text === 'Rui holding', 'and what a holder holds');
check(cardLine(live({ employeeId: e('quin'), state: 'queued', piece: piece('p'), since: 0 }), name)?.text === 'Quin queued', 'queued shows too');
check(cardLine(live(...['a', 'b', 'c', 'd'].map((id): PersonLive => ({ employeeId: e(id), state: 'working', piece: piece('p'), since: 0, on: [] }))), name)?.text === 'a, b +2 working', 'a crowd is cut to two names');
check(questionCount(undefined) === 0 && questionCount({ ...live(), questions: [question, question] }) === 2, 'the badge counts the questions');

check(answerKind(question) === 'text', 'a blocked question takes words');

const told = breakdownOf({ ...question, text: 'I stopped. The README needs a decision.', blocker: { why: 'Two layouts fit the README.', question: 'Do you want the short or the long README?', next: 'I write the one you pick and send it for review.' } } as OpenQuestion, name);
check(told.why === 'Two layouts fit the README.' && told.question === 'Do you want the short or the long README?', 'a blocked reply with a breakdown shows its why and its question as given');
check(told.next === 'I write the one you pick and send it for review.' && /new request/.test(told.then) && /Quin picks “README” up again/.test(told.then), 'its next step is theirs, and apart from it what the owner\'s answer does', JSON.stringify(told));
check(told.full === 'I stopped. The README needs a decision.', 'and the whole reply is kept behind it');
const old = breakdownOf({ ...question, text: 'The tests fail on main. Should I fix them first or skip them? I can do either.' }, name);
check(old.why === 'The tests fail on main. Should I fix them first or skip them? I can do either.' && old.question === 'Should I fix them first or skip them?' && old.next === 'Quin did not say.' && old.full === undefined, 'an old blocked reply keeps its text as the why and leads with the sentence that asks', JSON.stringify(old));
check(breakdownOf({ ...question, text: 'End now. Which colour should colour.txt hold, red or blue?' }, name).question === 'Which colour should colour.txt hold, red or blue?', 'a full stop inside a file name does not cut the question');
const silent = breakdownOf({ ...question, text: 'The build server is down.' }, name);
check(/^Quin did not ask anything\. What should Quin do next on “README”\?$/.test(silent.question), 'one that asked nothing says so, and asks what Quin should do next', silent.question);
const viaPo = breakdownOf({ ...question, to: e('rui'), text: 'stuck' }, name);
check(/goes to Rui, who asked Quin for it/.test(viaPo.then), 'a block that went to the PO says the answer goes through the PO', viaPo.then);
const perm = breakdownOf({ ...question, how: 'permission', tool: 'Bash', detail: 'rm -rf build' } as OpenQuestion, name);
check(perm.question === 'Allow Bash?' && /Allow lets it run/.test(perm.then) && perm.full === 'rm -rf build', 'a permission card asks allow or deny and says what each does');
const pick = breakdownOf({ ...question, how: 'ask', text: 'Which port?', options: ['3000', '8080'] } as OpenQuestion, name);
check(pick.question === 'Which port?' && /^Pick one/.test(pick.then), 'an ask with options says to pick one');
check(sayLive({ employeeId: e('quin'), state: 'blocked', question: { ...question, blocker: { why: 'w', question: 'Short or long?', next: 'n' } } as OpenQuestion }, name).text === 'Blocked: “Short or long?”', 'the person line leads with the question, not the whole reply');
check(answerKind({ ...question, how: 'ask', options: ['A', 'B'] } as OpenQuestion) === 'options', 'a question with options takes a choice');
check(answerKind({ ...question, how: 'ask' } as OpenQuestion) === 'text', 'an ask with no options takes words');
check(answerKind({ ...question, how: 'permission', tool: 'Bash', detail: 'ls' } as OpenQuestion) === 'permission', 'a permission card takes allow or deny');

const stamp = { id: 'x', at: 1, n: 1 };
type Body<T> = T extends unknown ? Omit<T, 'id' | 'at' | 'n'> : never;
const entry = (x: Body<ActivityEntry>): ActivityEntry => ({ ...stamp, ...x }) as ActivityEntry;
const request = sayEntry(entry({ kind: 'request', msg: m('r'), from: 'owner', to: e('rui'), intent: 'work', title: 'Do it', text: 'Do it', parent: null }), name);
check(request.head === 'You asked Rui' && request.title === 'Do it', 'a request reads as who asked whom');
const gauntlet = sayEntry(entry({ kind: 'request', msg: m('r'), from: 'mailroom', to: e('tess'), intent: 'work', title: 'Piece', text: 't', parent: m('g'), round: { gauntlet: m('g'), n: 2, role: 'build' } }), name);
check(gauntlet.head === 'The office asked Tess' && gauntlet.tag === 'Build round 2', 'a gauntlet round is tagged');
const pass = sayEntry(entry({ kind: 'reply', msg: m('a'), request: m('r'), title: 'Review', from: e('jo'), to: 'mailroom', outcome: 'done', text: 'ok', verdict: { pass: true, findings: [] }, round: { gauntlet: m('g'), n: 1, role: 'review' } }), name);
const fail = sayEntry(entry({ kind: 'reply', msg: m('a'), request: m('r'), title: 'Review', from: e('jo'), to: 'mailroom', outcome: 'done', text: 'no', verdict: { pass: false, findings: ['gap'] } }), name);
check(pass.head === 'Jo passed it' && pass.tone === 'ok' && pass.tag === 'Review round 1' && fail.head === 'Jo failed it' && fail.tone === 'bad', 'a verdict reads as a pass or a fail, in its own tone');
const blockedReply = sayEntry(entry({ kind: 'reply', msg: m('a'), request: m('r'), title: 'x', from: e('quin'), to: 'owner', outcome: 'blocked', text: 'q' }), name);
check(blockedReply.head === 'Quin is blocked' && blockedReply.tone === 'warn', 'a blocked reply is a warning, not a failure');
check(sayEntry(entry({ kind: 'stage', from: 'doing', to: 'review', by: 'mailroom' }), name).head === 'Moved to In Review by the office', 'a stage move says who made it');
check(sayEntry(entry({ kind: 'stage', from: 'todo', to: 'doing', by: 'owner' }), name).head === 'Moved to In Progress by you', 'the owner\'s own move is "you"');
check(sayEntry(entry({ kind: 'hours', employeeId: e('tess'), date: '2026-10-06', hours: 0.25 }), name).head === 'Sent 0.25 h for Tess (2026-10-06) to CronoSpark', 'an hours send is in the log');
const failedHours = sayEntry(entry({ kind: 'hours', employeeId: e('tess'), date: '2026-10-06', hours: 0.25, error: 'offline' }), name);
check(/^Could not send 0\.25 h/.test(failedHours.head) && failedHours.tone === 'bad', 'a failed send is in the log as one');
check(/^The app restarted\. Back in the queue: Tess’s “Piece”/.test(sayEntry(entry({ kind: 'recovered', requeued: [{ msg: m('r'), who: e('tess'), title: 'Piece' }] }), name).head), 'a restart says what went back in the queue');
check(sayEntry(entry({ kind: 'started', msg: m('r'), who: e('tess'), title: 'Piece', again: true }), name).head === 'Tess picked it up again', 'a second pickup says again');
const hand = (step: HandoffStep, by: string, from = 'rui') => sayEntry(entry({ kind: 'handoff', handoff: 'h-1' as HandoffId, step, from: e(from), to: e('tess'), by: e(by) }), name);
check(hand('proposed', 'rui').head === 'Rui asked to hand this to Tess' && hand('proposed', 'jo').head === 'Jo asked Rui to hand this to Tess', 'a handoff proposal says who asked to hand the task to whom, and whom the PO asked to give it up');
check(hand('accepted', 'jo').head === 'Jo agreed: Tess has it now' && hand('accepted', 'jo').tone === 'ok', 'an agreement says who agreed and who has the task now');
check(hand('declined', 'jo').head === 'Jo declined the handoff to Tess' && hand('declined', 'jo').tone === 'warn', 'a decline is a warning that names the handoff');
check(hand('withdrawn', 'rui').head === 'Rui withdrew the handoff to Tess' && hand('dropped', 'rui').head === 'The office dropped the handoff to Tess', 'a withdrawal is the proposer\'s, and a dropped handoff is the office\'s whoever proposed it');
check(cut('a  b\n c', 20) === 'a b c' && cut('x'.repeat(50), 10) === `${'x'.repeat(9)}…`, 'cut flattens white space and ends with an ellipsis');

finish();
