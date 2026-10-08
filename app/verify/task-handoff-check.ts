// No model, no Electron. A task changes hands only when the person holding it and the block's PO both agree. The Tasks store
// on a real mailroom, a restart with a proposal open, and the real office with its tools on a scripted harness.
// Run from app/: node verify/task-handoff-check.ts   Exits 1 on any failed check.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { noInputs } from '../src/shared/activity.ts';
import type { LedgerEntry, MessageId, TurnId } from '../src/shared/mail.ts';
import type { EmployeeId } from '../src/shared/protocol.ts';
import { handoffsProposed, type HandoffId, type TaskId } from '../src/shared/tasks.ts';
import { HARNESSES } from '../src/main/office/adapters/index.ts';
import type { SessionHost } from '../src/main/office/adapters/types.ts';
import { Office } from '../src/main/office/company.ts';
import { startOfficeMcp } from '../src/main/office/mcp.ts';
import { MemoryStore } from '../src/main/office/memory.ts';
import { emptyMail, fold } from '../src/main/office/mail.ts';
import { Tasks, noticeSeen, type HandoffResult, type TasksHost } from '../src/main/office/tasks.ts';
import { check, finish } from './check.ts';
import { ANA, B1, B2, BRUNO, CLEO, OUTSIDER, PO, id, world } from './mail-world.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'task-handoff-check-')));
const T0 = new Date(2026, 9, 6, 10, 0, 0).getTime();
const TITLE = 'Fix invoice totals';
const NOTES = 'The totals drift by a cent.';
const WHY = 'Bruno owns the billing API this touches';

function taskWorld(file = join(dir, `tasks-${Math.random().toString(36).slice(2)}.json`), ledger: LedgerEntry[] = [], start = T0) {
  let now = start;
  const w = world(ledger, undefined, () => now, ledger.length);
  let ids = 0;
  // The branch each person works on, for the ones who have one.
  const branches = new Map<EmployeeId, string>();
  const host: TasksHost = {
    now: () => now,
    newId: () => `id${++ids}`,
    mail: () => w.room,
    blocks: () => [B1, B2],
    members: () => w.members.map((x) => ({ id: x.id, name: x.name, blockId: x.blockId, role: x.role })),
    branchOf: (who) => branches.get(who),
    provider: { fetchSources: async () => ({ cards: [], errors: [] }), linearPeople: async () => [], logHours: async () => {} },
    changed() {},
  };
  const tasks = new Tasks(file, host, ledger);
  tasks.recover([B1, B2], []);
  let fed = ledger.length;
  // What the office does on every ledger append: tell the tasks, then let them follow the mail.
  const sync = () => {
    for (const entry of w.persisted.slice(fed)) tasks.observe(entry);
    fed = w.persisted.length;
    tasks.onMail();
  };
  return { w, tasks, host, file, branches, sync, advance: (ms: number) => void (now += ms), now: () => now };
}
type TaskWorld = ReturnType<typeof taskWorld>;

// What the checks ask about one task, and the calls they make on it.
function on(x: TaskWorld, taskId: TaskId) {
  const mail = () => x.w.room.state;
  const view = () => x.tasks.view(x.now()).tasks.find((t) => t.id === taskId)!;
  // The say messages a person was sent, oldest first.
  const says = (who: EmployeeId) => [...mail().messages.values()].flatMap((m) => (m.kind === 'say' && m.to === who ? [m.text] : []));
  // How a run of the task ended: its outcome and the words it was settled with, or `open`.
  const ended = (run: MessageId) => {
    const life = mail().life.get(run);
    const reply = life?.s === 'settled' ? mail().messages.get(life.by) : undefined;
    return reply?.kind === 'reply' ? `${reply.outcome}: ${reply.text}` : 'open';
  };
  const runsOf = (who: EmployeeId) => view().runs.filter((r) => mail().messages.get(r)?.to === who);
  const requestText = (run: MessageId) => {
    const m = mail().messages.get(run);
    return m?.kind === 'request' ? m.text : '';
  };
  const handoffs = () => (view().history ?? []).flatMap((h) => (h.kind === 'handoff' ? [h] : []));
  // The steps of every handoff on the task, in order, each with who took it.
  const steps = () => handoffs().map((h) => `${h.step}:${h.by}`).join();
  const moves = () => (view().history ?? []).flatMap((h) => (h.kind === 'stage' ? [`${h.by}:${h.to}`] : []));
  const propose = (who: EmployeeId, a: Parameters<Tasks['proposeHandoff']>[1]) => x.tasks.proposeHandoff(who, a);
  const answer = (who: EmployeeId, a: Parameters<Tasks['answerHandoff']>[1]) => x.tasks.answerHandoff(who, a);
  return { x, id: taskId, view, says, ended, runsOf, requestText, handoffs, steps, moves, propose, answer };
}

// One task of the first block given to `holders`, each already working on it.
function scene(holders: EmployeeId[] = [ANA]) {
  const x = taskWorld();
  const quick = x.tasks.boardsOf(B1).find((b) => b.kind === 'quick')!;
  const made = x.tasks.createTask(quick.id, TITLE, { notes: NOTES });
  for (const who of holders) x.tasks.assign(made.id, who);
  x.sync();
  return on(x, made.id);
}

const settled = (r: HandoffResult) => {
  if (!r.ok) throw new Error(`refused ${r.reason}: ${r.detail}`);
  return r;
};
const proposal = (r: HandoffResult) => {
  const ok = settled(r);
  if (ok.state !== 'proposed') throw new Error(`not open: ${ok.state}`);
  return ok;
};
const why = (r: HandoffResult) => (r.ok ? `ok:${r.state}` : r.reason);

console.log('# Ana asks to hand a task to Bruno and the PO agrees');
{
  const s = scene();
  const { x } = s;
  const anaRun = s.view().runs[0]!;
  check(s.view().assignees.join() === ANA && s.view().stage === 'doing' && s.ended(anaRun) === 'open', 'the task starts with Ana, working on it');

  x.advance(60_000);
  const asked = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  check(/^h-/.test(asked.id) && asked.task === TITLE && asked.from === 'Ana' && asked.to === 'Bruno' && asked.awaits === 'Pia', 'proposing answers with the id and says who must agree', JSON.stringify(asked));
  check(/end your turn/.test(asked.next) && !/awaitReplies/.test(asked.next), 'and tells the giver to end the turn: they do not wait', asked.next);
  const open = s.view().handoff;
  check(open?.id === asked.id && open.from === ANA && open.to === BRUNO && open.by === ANA && open.awaits === PO && open.reason === WHY, 'the proposal sits on the task: who gives, who gets, who asked, who must agree, and why');
  check(s.view().assignees.join() === ANA && s.view().runs.length === 1 && s.runsOf(BRUNO).length === 0, 'Ana is still on the task while it waits, and Bruno has no run');
  check(/^cancelled: Handing over to Bruno; waiting on Pia\./.test(s.ended(anaRun)), 'but Ana steps off at once: her run ends, with the reason', s.ended(anaRun));
  check(x.w.steers.some((st) => st.to === ANA && /cancelled/.test(st.text)), 'and Ana, in the middle of her turn, is told to drop it');
  check(s.view().stage === 'todo' && s.view().lastOutcome?.outcome === 'cancelled', 'with nobody working on it the card goes to todo while the handoff waits');
  const told = s.says(PO);
  check(told.length === 1 && told[0]!.includes(asked.id) && told[0]!.includes('answerHandoff') && told[0]!.includes('Bruno') && told[0]!.includes(WHY), 'Pia is told, with the id, who and why, and the call that answers it', told[0]);
  check(x.w.prompts.get(PO)?.at(-1)?.includes(asked.id) === true, 'the message wakes her: it is the start of her turn');
  check(s.says(ANA).length === 0, 'Ana, who asked, is not messaged about her own proposal');
  check(s.steps() === 'proposed:ana', 'the task history records the proposal', s.steps());
  check(x.w.room.state.keys.has(`handoff:${asked.id}:proposed`), 'its message has a key made of the proposal and the step, so a retry never posts it twice');

  x.advance(30_000);
  const agreed = settled(s.answer(PO, { id: asked.id, answer: 'accept', reason: 'Agreed, Bruno has the context' }));
  x.sync();
  check(agreed.state === 'accepted' && agreed.id === asked.id && agreed.task === TITLE && agreed.from === 'Ana' && agreed.to === 'Bruno', 'the PO accepting is answered with who gave the task to whom', JSON.stringify(agreed));
  const after = s.view();
  check(after.assignees.join() === BRUNO && after.handoff === undefined, 'Bruno holds the task, Ana does not, and no proposal is left open');
  const brunoRun = s.runsOf(BRUNO)[0]!;
  const given = x.w.room.state.messages.get(brunoRun);
  check(s.runsOf(BRUNO).length === 1 && given?.kind === 'request' && given.intent === 'work' && given.from === 'owner' && given.title === TITLE, 'Bruno has one new work request of the task from the owner, like any assignment');
  check(x.w.room.state.keys.get(`task:${s.id}:bruno:${asked.id}`) === brunoRun, 'whose key is made of the task, the person and the handoff, so asking again finds it');
  const text = s.requestText(brunoRun);
  check(text.includes('Ana') && text.includes('Pia') && text.includes(WHY) && text.includes(NOTES), 'its text says who handed the task over, who agreed and why, and still carries the task itself', text);
  check(!/already holds/.test(text) && !/unfinished/.test(text), 'and claims nothing about where Ana\'s work is when she has no branch of her own');
  check(s.says(BRUNO).length === 0, 'a receiver given a new run needs no word on top of it');
  check(x.w.prompts.get(BRUNO)?.length === 1 && x.w.prompts.get(BRUNO)![0]!.includes(WHY), 'he starts on it at once, since he was free');
  check(s.steps() === 'proposed:ana,accepted:po', 'the history has the agreement under the name of whoever gave it', s.steps());
  const step = s.handoffs().at(-1)!;
  check(step.from === ANA && step.to === BRUNO && step.reason === 'Agreed, Bruno has the context' && step.at === x.now(), 'with who gave, who got, the reason and when', JSON.stringify(step));
  check(s.says(ANA).length === 1 && s.says(ANA)[0]!.includes('Bruno') && /No reply needed\./.test(s.says(ANA)[0]!), 'Ana is told the answer, and that no reply is owed', s.says(ANA)[0]);
  check(s.says(PO).length === 1, 'Pia, who gave the answer, is not told what she did');
  check(after.stage === 'doing' && s.moves().join() === 'mailroom:doing,mailroom:todo,mailroom:doing', 'the card is back in doing as soon as Bruno has the run', s.moves().join());
  const entries = x.tasks.activityOf(s.id, noInputs)!.entries;
  check(entries.flatMap((e) => (e.kind === 'handoff' ? [e.step] : [])).join() === 'proposed,accepted', 'the activity log tells both steps');
  check(entries.some((e) => e.kind === 'say' && e.to === PO && e.text.includes(asked.id)) && entries.some((e) => e.kind === 'say' && e.to === ANA && /No reply needed\./.test(e.text)), 'and carries the messages that went with them');

  x.advance(120_000);
  x.w.fresh.add('totals.ts');
  x.w.room.reply(BRUNO, brunoRun, { outcome: 'done', text: 'Totals fixed.', artifact: ['totals.ts'] });
  x.w.room.turnEnded(BRUNO, 'done', true);
  x.sync();
  check(s.view().stage === 'review' && s.view().lastOutcome?.text === 'Totals fixed.', 'the card then follows Bruno\'s work to review, with his result');
}

console.log('\n# the new holder\'s run lifts the owner\'s pin, like an assignment');
{
  const s = scene();
  s.x.tasks.updateTask(s.id, { stage: 'doing' });
  check(s.view().stagePinned === true, 'the owner moving the card pins it');
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  settled(s.answer(PO, { id: p.id, answer: 'accept' }));
  s.x.sync();
  const moved = s.x.tasks.moveByAgent(BRUNO, 'review', 'Ready.');
  check(s.view().stagePinned === undefined && moved.ok, 'a pinned card would keep the new holder from moving it, so it is free again', JSON.stringify(moved));
}

console.log('\n# Bruno was already on the task');
{
  const s = scene([ANA, BRUNO]);
  const brunoRun = s.runsOf(BRUNO)[0]!;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: 'Bruno has the numbers, I have nothing left' }));
  settled(s.answer(PO, { id: p.id, answer: 'accept' }));
  s.x.sync();
  check(s.runsOf(BRUNO).length === 1 && s.ended(brunoRun) === 'open' && s.view().runs.length === 2, 'no second run is posted for someone who holds an open one');
  check(s.view().assignees.join() === BRUNO && /^cancelled/.test(s.ended(s.runsOf(ANA)[0]!)), 'Ana still leaves the task, and her run ends');
  const word = s.says(BRUNO)[0] ?? '';
  check(s.says(BRUNO).length === 1 && word.includes('Ana') && word.includes('Bruno has the numbers, I have nothing left') && /yours alone/.test(word) && /No reply needed\./.test(word), 'Bruno, who got no new run, is told the task is his alone now, who gave it and why', word);
  const size = s.x.w.room.state.order.length;
  settled(s.answer(PO, { id: p.id, answer: 'accept' }));
  check(s.x.w.room.state.order.length === size, 'and answering again tells him nothing twice');
}

console.log('\n# the PO asks, and Ana agrees');
{
  const s = scene();
  const { x } = s;
  const anaRun = s.view().runs[0]!;
  const asked = proposal(s.propose(PO, { task: TITLE, to: 'Bruno', reason: 'Ana is needed on the invoice export' }));
  x.sync();
  check(asked.from === 'Ana' && asked.awaits === 'Ana' && s.view().handoff?.by === PO, 'a PO naming the task, with one person on it, may leave out who gives it: that person must agree');
  check(s.ended(anaRun) === 'open' && s.view().stage === 'doing' && /keeps working/.test(asked.next), 'Ana keeps working on it until she answers, and the PO is told so');
  check(s.says(ANA).length === 1 && s.says(ANA)[0]!.includes(asked.id) && s.says(ANA)[0]!.includes('answerHandoff') && s.says(PO).length === 0, 'Ana is told, with the id and the call, and the PO who asked is not');
  check(why(s.answer(PO, { id: asked.id, answer: 'accept' })) === 'not_yours', 'the PO cannot accept her own proposal');
  const agreed = settled(s.answer(ANA, { id: asked.id, answer: 'accept' }));
  x.sync();
  check(agreed.state === 'accepted' && s.view().assignees.join() === BRUNO && /^cancelled: Handed over to Bruno\./.test(s.ended(anaRun)), 'Ana accepting hands it over, and her run ends then');
  check(s.view().stage === 'doing' && s.moves().join() === 'mailroom:doing', 'the card does not bounce to todo: Bruno\'s run was open when Ana\'s ended', s.moves().join());
  check(s.says(PO).length === 1 && /No reply needed\./.test(s.says(PO)[0]!) && s.says(PO)[0]!.includes('Ana'), 'the PO who asked is told, and Ana, who answered, is not told again');
  check(s.says(ANA).length === 1, 'Ana has only the proposal');
  const text = s.requestText(s.runsOf(BRUNO)[0]!);
  check(text.includes('Pia') && text.includes('Ana') && text.includes('Ana is needed on the invoice export'), 'Bruno\'s request says the PO handed it over from Ana, and why', text);
  check(s.steps() === 'proposed:po,accepted:ana', s.steps());
}

console.log('\n# a PO needs to say whose part, when several people are on it');
{
  const s = scene([ANA, CLEO]);
  const unclear = s.propose(PO, { task: TITLE, to: 'Bruno', reason: 'Spread the load' });
  check(why(unclear) === 'bad_target' && !unclear.ok && unclear.detail.includes('Ana') && unclear.detail.includes('Cleo'), 'the refusal asks which of them, by name', JSON.stringify(unclear));
  const named = proposal(s.propose(PO, { task: TITLE, from: 'Cleo', to: 'Bruno', reason: 'Spread the load' }));
  check(named.from === 'Cleo' && named.awaits === 'Cleo', 'naming one makes that person the one who must agree');
}

console.log('\n# a PO names whose part when the task has more than one person on it');
{
  const s = scene([PO, ANA]);
  const vague = s.propose(PO, { task: TITLE, to: 'Bruno', reason: 'Ana is overloaded' });
  check(why(vague) === 'bad_target' && !vague.ok && vague.detail.includes('Pia') && vague.detail.includes('Ana'), 'the PO leaving out from is refused, and told who is on it', JSON.stringify(vague));
  check(s.view().handoff === undefined && s.runsOf(PO).every((r) => s.ended(r) === 'open') && s.view().assignees.join() === 'po,ana', 'and her own part is not handed over by accident');
  const own = s.propose(PO, { task: TITLE, from: 'Pia', to: 'Bruno', reason: 'I am needed on planning' });
  check(why(own) === 'ok:accepted' && s.view().assignees.join() === 'ana,bruno', 'the PO naming herself hands over her own part at once', JSON.stringify(own));
}
{
  const s = scene([ANA, CLEO]);
  const own = s.propose(ANA, { to: 'Bruno', reason: WHY });
  check(own.ok && own.from === 'Ana', 'an employee on a task with others hands over their own part without naming it', JSON.stringify(own));
}

console.log('\n# proposals are counted, whether or not they ended in a handoff');
{
  const s = scene();
  const { x } = s;
  for (let i = 0; i < 6; i++) {
    const p = proposal(s.propose(ANA, { to: 'Bruno', reason: `cycle ${i}` }));
    settled(s.answer(PO, { id: p.id, answer: 'decline', reason: 'No' }));
    x.w.room.turnEnded(ANA, 'Back to it.', true);
    x.sync();
  }
  check(s.steps().split(',').filter((st) => st.startsWith('proposed')).length === 6 && s.view().assignees.join() === ANA, 'six proposals that were all declined go through');
  const seventh = s.propose(ANA, { to: 'Bruno', reason: 'cycle 6' });
  check(why(seventh) === 'too_many' && !seventh.ok && /owner/.test(seventh.detail) && s.view().handoff === undefined, 'a seventh is refused, and the refusal sends the agent to the owner', JSON.stringify(seventh));
  check(why(s.propose(PO, { task: TITLE, to: 'Bruno', reason: 'x' })) === 'too_many', 'the PO is held to the same count');
  const task = s.x.tasks.view(x.now()).tasks.find((t) => t.id === s.id)!;
  const asked = { kind: 'handoff', handoff: 'h-1' as HandoffId, from: ANA, to: BRUNO, by: ANA, at: 1 } as const;
  const counted = (...steps: ('proposed' | 'accepted' | 'declined' | 'dropped')[]) => handoffsProposed({ ...task, history: steps.map((step) => ({ ...asked, step })) });
  check(counted('proposed', 'accepted') === 1 && counted('accepted') === 1 && counted('proposed', 'declined', 'proposed', 'dropped') === 2, 'a proposal counts once however it ended, and a handoff applied at once counts as one');
}

console.log('\n# the PO hands over her own task: nobody else has to agree');
{
  const s = scene([PO]);
  const { x } = s;
  const poRun = s.view().runs[0]!;
  const done = settled(s.propose(PO, { to: 'Cleo', reason: 'I am needed on planning' }));
  x.sync();
  check(done.state === 'accepted' && done.from === 'Pia' && done.to === 'Cleo', 'it applies at once and answers accepted', JSON.stringify(done));
  check(s.view().assignees.join() === CLEO && s.view().handoff === undefined && /^cancelled/.test(s.ended(poRun)), 'Cleo has the task, Pia does not, and Pia\'s run ends');
  check(s.runsOf(CLEO).length === 1 && s.requestText(s.runsOf(CLEO)[0]!).includes('I am needed on planning') && s.requestText(s.runsOf(CLEO)[0]!).includes('Pia'), 'Cleo\'s request says who handed it over and why');
  check(s.steps() === 'accepted:po' && s.handoffs()[0]!.reason === 'I am needed on planning', 'one step on the history, with the reason', s.steps());
  check(s.says(PO).length === 0 && s.says(CLEO).length === 0 && s.says(ANA).length === 0, 'and nobody is messaged: there was nobody to ask');
}

console.log('\n# the PO is a person of the block too');
{
  const s = scene();
  const p = proposal(s.propose(ANA, { to: 'po', reason: 'This is a planning question, not code' }));
  check(p.to === 'Pia' && p.awaits === 'Pia', '"po" names the block\'s PO');
  settled(s.answer(PO, { id: p.id, answer: 'accept' }));
  check(s.view().assignees.join() === PO, 'and the PO may take a task over');
}

console.log('\n# a decline gives the task back to the giver as a new request');
{
  const s = scene();
  const { x } = s;
  const anaRun = s.view().runs[0]!;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  x.w.room.turnEnded(ANA, 'I asked Pia to hand it over, so I stop here.', true);
  x.sync();
  x.advance(5_000);
  const no = settled(s.answer(PO, { id: p.id, answer: 'decline', reason: 'Bruno is full this week' }));
  x.sync();
  check(no.state === 'declined' && no.from === 'Ana' && no.to === 'Bruno', 'the PO declining says so');
  check(s.view().handoff === undefined && s.runsOf(BRUNO).length === 0 && s.view().assignees.join() === ANA, 'Bruno gets nothing, and Ana is still the only one on the task');
  const back = s.runsOf(ANA)[1];
  check(s.runsOf(ANA).length === 2 && /^cancelled/.test(s.ended(anaRun)) && !!back && s.ended(back) === 'open', 'Ana, who stepped off to ask, has the task back as a new request of her own');
  const text = s.requestText(back!);
  check(text.includes('Pia') && /declin/i.test(text) && text.includes('Bruno is full this week') && text.includes(NOTES), 'whose text says that Pia declined and why, and still carries the task', text);
  check(x.w.room.state.keys.get(`task:${s.id}:ana:${p.id}-back`) === back, 'its key is made of the task, the person and the handoff');
  check(x.w.prompts.get(ANA)!.at(-1)!.includes('Bruno is full this week') && s.view().stage === 'doing', 'she starts on it, and the card is back in doing');
  check(s.says(ANA).length === 0, 'and she is not messaged on top of it');
  check(s.steps() === 'proposed:ana,declined:po' && s.handoffs().at(-1)!.reason === 'Bruno is full this week', 'the history has the decline with its reason', s.steps());
}

console.log('\n# a decline by the giver, when the PO asked, only tells the PO');
{
  const s = scene();
  const p = proposal(s.propose(PO, { task: TITLE, to: 'Bruno', reason: 'Spread the load' }));
  s.x.sync();
  const no = settled(s.answer(ANA, { id: p.id, answer: 'decline', reason: 'I am almost done' }));
  s.x.sync();
  check(no.state === 'declined' && s.view().runs.length === 1 && s.view().assignees.join() === ANA, 'nothing changes on the task and nobody gets a new run');
  check(s.says(PO).length === 1 && s.says(PO)[0]!.includes('I am almost done') && /No reply needed\./.test(s.says(PO)[0]!), 'the PO is told why', s.says(PO)[0]);
}

console.log('\n# only the proposer withdraws, and gets the task back');
{
  const s = scene();
  const { x } = s;
  const anaRun = s.view().runs[0]!;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  x.w.room.turnEnded(ANA, 'I asked Pia to hand it over, so I stop here.', true);
  check(why(s.answer(PO, { id: p.id, answer: 'withdraw' })) === 'not_yours' && s.view().handoff?.id === p.id, 'the PO cannot withdraw it, and it stays open');
  const back = settled(s.answer(ANA, { id: p.id, answer: 'withdraw', reason: 'I will finish it myself' }));
  x.sync();
  check(back.state === 'withdrawn' && s.view().handoff === undefined && s.view().assignees.join() === ANA, 'Ana withdrawing closes it');
  check(s.runsOf(ANA).length === 2 && /^cancelled/.test(s.ended(anaRun)) && s.ended(s.runsOf(ANA)[1]!) === 'open' && /withdr/i.test(s.requestText(s.runsOf(ANA)[1]!)), 'and, having stepped off, she has the task back as a new request that says she withdrew');
  check(s.steps() === 'proposed:ana,withdrawn:ana', s.steps());
  check(s.says(PO).length === 2 && /withdr/i.test(s.says(PO)[1]!) && /No reply needed\./.test(s.says(PO)[1]!) && s.says(ANA).length === 0, 'the PO who was asked is told it is withdrawn, and Ana is not messaged');
  const late = s.answer(PO, { id: p.id, answer: 'accept' });
  x.sync();
  check(why(late) === 'settled' && !late.ok && /already ended: withdrawn by Ana/.test(late.detail), 'an accept that comes after is refused, and says it ended withdrawn, by Ana, not that it was accepted', JSON.stringify(late));
  check(s.runsOf(BRUNO).length === 0 && s.view().assignees.join() === ANA && s.runsOf(ANA).length === 2, 'and moves nothing');
  check(settled(s.answer(ANA, { id: p.id, answer: 'withdraw' })).state === 'withdrawn' && s.runsOf(ANA).length === 2, 'the same withdrawal again is ok and gives nothing back twice');
}

console.log('\n# one open proposal per task');
{
  const s = scene();
  const { x } = s;
  const first = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  const retry = proposal(s.propose(ANA, { to: 'Bruno', reason: 'Asking again, in other words' }));
  x.sync();
  check(retry.id === first.id && s.view().handoff?.reason === WHY, 'the same proposal again returns the open one unchanged');
  check(s.says(PO).length === 1 && s.steps() === 'proposed:ana', 'and posts and records nothing a second time');

  const other = s.propose(ANA, { to: 'Cleo', reason: 'Cleo is free' });
  check(why(other) === 'open_handoff' && !other.ok && other.detail.includes(first.id) && other.detail.includes('Pia'), 'a different proposal is refused, naming the open one and who it waits on', JSON.stringify(other));
  check(!other.ok && /answer: "withdraw"/.test(other.detail) && !/"accept"/.test(other.detail), 'Ana, who proposed it, is told to withdraw it first, and not to answer it', JSON.stringify(other));
  const byPo = s.propose(PO, { task: TITLE, to: 'Cleo', reason: 'Cleo is free' });
  check(why(byPo) === 'open_handoff' && s.view().handoff?.id === first.id, 'the PO\'s own proposal is refused the same way');
  const same = s.propose(PO, { task: TITLE, from: 'Ana', to: 'Bruno', reason: 'Yes, Bruno should have it' });
  check(why(same) === 'open_handoff' && !same.ok && same.detail.includes(first.id) && same.detail.includes('answerHandoff'), 'the PO, proposing what Ana asked for, is told to answer the open one with answerHandoff', JSON.stringify(same));

  x.w.members.splice(x.w.members.findIndex((m) => m.id === BRUNO), 1);
  x.advance(1_000);
  const next = proposal(s.propose(ANA, { to: 'Cleo', reason: 'Cleo is free' }));
  x.sync();
  check(next.id !== first.id && s.view().handoff?.id === next.id && s.view().handoff?.to === CLEO, 'a proposal that can no longer apply does not block a new one: it is replaced');
  check(s.steps() === 'proposed:ana,dropped:ana,proposed:ana', 'the old one is on the history as dropped', s.steps());
  check(s.runsOf(ANA).every((r) => s.ended(r) !== 'open'), 'and Ana, who stepped off again for the new one, is not left holding a run');
  check(why(s.answer(PO, { id: first.id, answer: 'accept' })) === 'stale', 'and accepting the old one is stale');
}

console.log('\n# only the right person answers, and answering twice is one answer');
{
  const s = scene();
  const { x } = s;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  check(why(s.answer(ANA, { id: p.id, answer: 'accept' })) === 'not_yours', 'the person asking cannot accept for the PO');
  check(why(s.answer(BRUNO, { id: p.id, answer: 'accept' })) === 'not_yours' && why(s.answer(CLEO, { id: p.id, answer: 'decline' })) === 'not_yours', 'nor can a teammate, the receiver included');
  check(why(s.answer(OUTSIDER, { id: p.id, answer: 'accept' })) === 'unknown_handoff' && why(s.answer(PO, { id: 'h-nope', answer: 'accept' })) === 'unknown_handoff', 'a proposal of another block, or one that never was, is unknown');
  check(s.view().handoff?.id === p.id && s.runsOf(BRUNO).length === 0 && s.view().assignees.join() === ANA, 'and none of that moved anything');

  const first = settled(s.answer(PO, { id: p.id, answer: 'accept', reason: 'Agreed' }));
  x.sync();
  const mailSize = x.w.room.state.order.length;
  const runs = s.view().runs.length;
  const again = settled(s.answer(PO, { id: p.id, answer: 'accept' }));
  const flipped = s.answer(PO, { id: p.id, answer: 'decline', reason: 'Changed my mind' });
  x.sync();
  check(first.state === 'accepted' && again.state === 'accepted', 'the same answer again is ok');
  check(why(flipped) === 'settled' && !flipped.ok && /already ended: accepted by Pia/.test(flipped.detail), 'a different answer is refused, and says how it ended: it is not told that it was declined', JSON.stringify(flipped));
  check(x.w.room.state.order.length === mailSize && s.view().runs.length === runs && s.runsOf(BRUNO).length === 1 && s.steps() === 'proposed:ana,accepted:po', 'and does nothing: no second run, no second message, no second step');
  check(why(s.answer(CLEO, { id: p.id, answer: 'accept' })) === 'not_yours', 'a teammate who is not a party cannot read how it ended');
}

console.log('\n# a proposal that can no longer apply is dropped when someone answers it');
{
  const s = scene();
  const { x } = s;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  // What the office does when it fires someone: remember their name first.
  x.tasks.rememberPerson(BRUNO, 'Bruno');
  x.w.members.splice(x.w.members.findIndex((m) => m.id === BRUNO), 1);
  const late = s.answer(CLEO, { id: p.id, answer: 'accept' });
  x.sync();
  check(why(late) === 'stale' && !late.ok && late.detail.length > 0, 'a teammate who could not answer is told it is stale, not that it is not theirs: it applies to nobody');
  check(s.view().handoff === undefined && s.view().assignees.join() === ANA && s.steps() === 'proposed:ana,dropped:ana', 'it was dropped, on the history under the name of whoever proposed it', s.steps());
  const back = s.runsOf(ANA)[1];
  check(s.runsOf(ANA).length === 2 && !!back && s.ended(back) === 'open' && /Bruno/.test(s.requestText(back)) && /dropped/i.test(s.requestText(back)), 'Ana, who stepped off for it, has the task back with a note that says why');
  check(s.says(ANA).length === 0, 'and the note is the only word she gets');
  check(why(s.answer(PO, { id: p.id, answer: 'accept' })) === 'stale' && why(s.answer(PO, { id: p.id, answer: 'decline' })) === 'stale', 'answering it again is stale again, never a transfer');
  check(s.runsOf(ANA).length === 2 && s.runsOf(BRUNO).length === 0, 'and gives her nothing more');
}

console.log('\n# the owner giving the task to someone drops the open proposal');
{
  const s = scene();
  const { x } = s;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  x.tasks.assign(s.id, CLEO);
  x.sync();
  check(s.view().handoff === undefined && s.steps() === 'proposed:ana,dropped:ana' && s.view().assignees.join() === 'ana,cleo', 'the owner assigning the task drops it, and Cleo is given the task as usual');
  check(s.runsOf(ANA).length === 1, 'Ana gets nothing back: the owner decided');
  check(s.says(ANA).length === 1 && /dropped/i.test(s.says(ANA)[0]!) && /the owner assigned the task/.test(s.says(ANA)[0]!), 'she is told, and by whom', s.says(ANA)[0]);
  const late = s.answer(PO, { id: p.id, answer: 'accept' });
  check(why(late) === 'stale' && !late.ok && late.detail.includes('the owner assigned the task') && s.runsOf(BRUNO).length === 0 && s.view().assignees.join() === 'ana,cleo', 'and the PO can no longer accept it, and is told why');
}

console.log('\n# the owner giving the task to someone who already holds it changes nothing');
{
  const s = scene();
  const { x } = s;
  const p = proposal(s.propose(PO, { task: TITLE, to: 'Bruno', reason: 'Spread the load' }));
  x.sync();
  x.tasks.assign(s.id, ANA);
  x.sync();
  check(s.view().handoff?.id === p.id && s.runsOf(ANA).length === 1 && s.steps() === 'proposed:po', 'the open handoff stays, since nothing was posted');
  check(settled(s.answer(ANA, { id: p.id, answer: 'accept' })).state === 'accepted' && s.view().assignees.join() === BRUNO, 'and Ana can still answer it');
}

console.log('\n# a finished task is not handed over');
{
  const s = scene();
  const { x } = s;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  x.tasks.updateTask(s.id, { stage: 'done' });
  const refusedNew = s.propose(ANA, { task: TITLE, to: 'Cleo', reason: 'x' });
  check(why(refusedNew) === 'done' && !refusedNew.ok && /reopen/.test(refusedNew.detail), 'a task the owner closed cannot be proposed, and the refusal says to ask the owner to reopen it', JSON.stringify(refusedNew));
  const late = s.answer(PO, { id: p.id, answer: 'accept' });
  x.sync();
  check(why(late) === 'done' && s.runsOf(BRUNO).length === 0 && s.view().assignees.join() === ANA && s.view().stage === 'done' && s.view().handoff?.id === p.id, 'nor accepted: the card stays closed, and the proposal waits for the owner to reopen it');
  const no = settled(s.answer(PO, { id: p.id, answer: 'decline', reason: 'Not now' }));
  x.sync();
  check(no.state === 'declined' && s.runsOf(ANA).length === 1 && s.view().stage === 'done', 'declining it is allowed, and does not start work on a card the owner closed');
  check(s.says(ANA).length === 1 && /declin/i.test(s.says(ANA)[0]!), 'Ana is told instead');
}

console.log('\n# a task changes hands three times at most');
{
  const s = scene();
  const { x } = s;
  const names: Record<string, string> = { [ANA]: 'Ana', [BRUNO]: 'Bruno' };
  let holder = ANA;
  let other = BRUNO;
  for (let i = 0; i < 3; i++) {
    const p = proposal(s.propose(holder, { to: names[other]!, reason: `round ${i}` }));
    settled(s.answer(PO, { id: p.id, answer: 'accept' }));
    while (x.w.room.state.active.has(holder)) {
      x.w.room.turnEnded(holder, 'Handed over, so I stop.', true);
      x.sync();
    }
    x.sync();
    [holder, other] = [other, holder];
  }
  check(s.steps().split(',').filter((st) => st.startsWith('accepted')).length === 3 && s.view().assignees.join() === BRUNO, 'three handoffs go through');
  const fourth = s.propose(holder, { to: names[other]!, reason: 'round 3' });
  check(why(fourth) === 'too_many' && !fourth.ok && /owner/.test(fourth.detail) && s.view().handoff === undefined, 'a fourth is refused, and the refusal sends the agent to the owner', JSON.stringify(fourth));
  check(why(s.propose(PO, { task: TITLE, from: 'Bruno', to: 'Cleo', reason: 'x' })) === 'too_many', 'the PO is held to the same count');
}

console.log('\n# a notice is seen when it is delivered to a turn, and heard when that turn is over');
{
  const key = 'handoff:h-1:proposed';
  const note: LedgerEntry = { t: 'post', msg: { id: 'n1' as MessageId, rootId: 'n1' as MessageId, parentId: null, from: 'mailroom', to: PO, at: 1, hops: 0, kind: 'say', text: 'Answer it.', wake: true, urgency: 'queue', key } };
  const turn = 't1' as TurnId;
  const deliver: LedgerEntry = { t: 'deliver', ids: ['n1' as MessageId], to: PO, turn, at: 2 };
  const end: LedgerEntry = { t: 'turn_end', turn, at: 3 };
  const after = (...log: LedgerEntry[]) => noticeSeen(log.reduce(fold, emptyMail()), key);
  check(noticeSeen(emptyMail(), key) === 'unseen' && after(note) === 'unseen', 'a notice nobody has a turn for is unseen');
  check(after(note, deliver) === 'seen_in_open_turn', 'delivered to a turn that goes on, it is seen in an open turn');
  check(after(note, deliver, end) === 'seen_in_ended_turn', 'and once that turn has ended, in an ended turn');
  check(after(note, deliver, { t: 'recover', at: 4 }) === 'unseen', 'a turn the app died in sends the notice back to the queue: unseen again');
}

console.log('\n# an unanswered proposal ends within two turns of the person it waits on');
{
  const s = scene();
  const { x } = s;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  const reminded = () => x.w.room.state.keys.has(`handoff:${p.id}:reminder`);
  check(/Answer before this turn ends/.test(s.says(PO)[0]!) && /reminds you once/.test(s.says(PO)[0]!), 'the notice says to answer before the turn ends, and that the office reminds once and then drops it', s.says(PO)[0]);
  check(!reminded() && s.view().handoff?.id === p.id, 'while Pia is in the turn that read the notice nothing is chased');
  x.w.room.turnEnded(PO, 'Noted.', true);
  x.sync();
  const note = s.says(PO)[1] ?? '';
  check(reminded() && s.says(PO).length === 2 && note.includes(p.id) && note.includes('answerHandoff') && /drops/.test(note), 'a turn that ends with the notice unanswered gets one reminder: the id, the call, and what happens next', note);
  check(!/No reply needed/.test(note), 'a reminder asks for an answer, unlike the word that closes one');
  check(x.w.prompts.get(PO)!.at(-1)!.includes(p.id) && s.view().handoff?.id === p.id, 'it wakes her in a turn of her own, and the handoff is still open');
  const size = x.w.room.state.order.length;
  x.sync();
  x.tasks.onMail();
  check(x.w.room.state.order.length === size && s.says(PO).length === 2 && s.steps() === 'proposed:ana', 'running onMail again posts nothing again');
  x.advance(5_000);
  x.w.room.turnEnded(PO, 'Noted again.', true);
  x.sync();
  check(s.view().handoff === undefined && s.steps() === 'proposed:ana,dropped:ana' && s.handoffs().at(-1)!.reason === 'Pia did not answer it.', 'a second turn that ends without an answer drops it, and the history says why');
  check(s.runsOf(ANA).length === 2 && s.ended(s.runsOf(ANA)[1]!) === 'open' && /Pia did not answer it/.test(s.requestText(s.runsOf(ANA)[1]!)), 'Ana, who stepped off, has the task back with a note that says Pia did not answer');
  const after = x.w.room.state.order.length;
  x.sync();
  x.tasks.onMail();
  check(x.w.room.state.order.length === after && s.runsOf(BRUNO).length === 0, 'and nothing more is posted, and Bruno has nothing');
  const late = s.answer(PO, { id: p.id, answer: 'accept' });
  check(why(late) === 'stale' && !late.ok && late.detail.includes('Pia did not answer it.'), 'an accept that comes after says why it was dropped: the reason on the history, not a guess', JSON.stringify(late));
}

console.log('\n# the proposer is told when the one asked never answers');
{
  const s = scene();
  const { x } = s;
  const p = proposal(s.propose(PO, { task: TITLE, to: 'Bruno', reason: 'Spread the load' }));
  x.sync();
  const reminded = () => x.w.room.state.keys.has(`handoff:${p.id}:reminder`);
  // Ana is in the turn that began with her task when the notice is queued, so ending it does not count.
  x.w.room.turnEnded(ANA, 'Paused.', true);
  x.sync();
  check(!reminded() && s.view().handoff?.id === p.id, 'a turn that was already running when the notice was queued does not count');
  x.w.room.turnEnded(ANA, 'Still no answer.', true);
  x.sync();
  check(reminded() && s.says(ANA).length === 2, 'the next turn, which read it, ends without an answer: one reminder');
  x.w.room.turnEnded(ANA, 'Nothing again.', true);
  x.sync();
  check(s.view().handoff === undefined && s.steps() === 'proposed:po,dropped:po', 'and the one after drops it');
  check(s.says(PO).length === 1 && /did not answer/.test(s.says(PO)[0]!) && /No reply needed\./.test(s.says(PO)[0]!), 'the PO who asked is told Ana did not answer', s.says(PO)[0]);
  check(s.runsOf(ANA).length === 1 && s.view().assignees.join() === ANA, 'Ana never stepped off, so nothing is given back and she keeps the task');
}

console.log('\n# an answer stops the chasing');
{
  const s = scene();
  const { x } = s;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  settled(s.answer(PO, { id: p.id, answer: 'decline', reason: 'Bruno is full' }));
  x.w.room.turnEnded(PO, 'Answered.', true);
  x.sync();
  check(!x.w.room.state.keys.has(`handoff:${p.id}:reminder`) && s.steps() === 'proposed:ana,declined:po', 'an answer in the turn that read the notice means no reminder');
}
{
  const s = scene();
  const { x } = s;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  x.w.room.turnEnded(PO, 'Noted.', true);
  x.sync();
  settled(s.answer(PO, { id: p.id, answer: 'accept' }));
  x.w.room.turnEnded(PO, 'Answered.', true);
  x.sync();
  check(s.steps() === 'proposed:ana,accepted:po' && s.view().assignees.join() === BRUNO, 'an answer after the reminder means the turn that follows drops nothing');
}

console.log('\n# a restart does not count a notice seen in a turn that died');
{
  const s = scene();
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  s.x.sync();
  s.x.advance(10_000);
  const r = on(taskWorld(s.x.file, s.x.w.persisted, s.x.now()), s.id);
  r.x.sync();
  check(!r.x.w.room.state.keys.has(`handoff:${p.id}:reminder`), 'the notice sits in a turn the old app never ended: not seen yet');
  r.x.w.room.recoverOnStart();
  r.x.sync();
  check(!r.x.w.room.state.keys.has(`handoff:${p.id}:reminder`) && r.view().handoff?.id === p.id, 'the dead turn is over, but the notice went back to the queue and is read again: still not chased');
  r.x.w.room.turnEnded(PO, 'Noted.', true);
  r.x.sync();
  check(r.x.w.room.state.keys.has(`handoff:${p.id}:reminder`) && r.says(PO).length === 2, 'it is chased only once the turn that read it again ends');
}

console.log('\n# who may propose, and for whom');
{
  const s = scene();
  const quiet = () => s.view().handoff === undefined && s.handoffs().length === 0 && s.says(PO).length === 0 && s.says(BRUNO).length === 0;
  check(why(s.propose(BRUNO, { task: TITLE, to: 'Cleo', reason: 'x' })) === 'not_on_task', 'someone who is neither on the task nor the PO cannot propose it');
  check(why(s.propose(BRUNO, { to: 'Cleo', reason: 'x' })) === 'no_task', 'and cannot say which task without naming it');
  check(why(s.propose(OUTSIDER, { task: TITLE, to: 'Cleo', reason: 'x' })) === 'unknown_task', 'a task of another block cannot be named');
  check(why(s.propose(ANA, { task: 'Not a task', to: 'Bruno', reason: 'x' })) === 'unknown_task', 'nor one that does not exist');
  check(why(s.propose(ANA, { to: 'Zed', reason: 'x' })) === 'bad_target', 'a person of another block cannot receive it');
  check(why(s.propose(ANA, { to: 'Nobody', reason: 'x' })) === 'bad_target', 'nor someone nobody knows');
  check(why(s.propose(ANA, { to: 'Ana', reason: 'x' })) === 'bad_target', 'nor the person giving it');
  check(why(s.propose(ANA, { from: 'Cleo', to: 'Bruno', reason: 'x' })) === 'bad_target', 'a teammate hands over only their own part');
  check(why(s.propose(PO, { task: TITLE, from: 'Cleo', to: 'Bruno', reason: 'x' })) === 'bad_target', 'and nobody gives away a task they are not on');
  check(quiet(), 'every refusal leaves the task and the mail as they were');
}

console.log('\n# a piece someone was given is not the task');
{
  const s = scene([PO]);
  const posted = s.x.w.room.post({ from: PO, to: 'Ana', body: { kind: 'request', intent: 'work', title: 'Totals piece', text: 'do the totals' } });
  if (!posted.ok) throw new Error(posted.detail);
  s.x.sync();
  const piece = s.propose(ANA, { to: 'Bruno', reason: 'Bruno owns billing' });
  const stranger = s.propose(BRUNO, { task: TITLE, to: 'Cleo', reason: 'x' });
  check(why(piece) === 'not_on_task' && !piece.ok && /piece/.test(piece.detail) && /blocked/.test(piece.detail), 'someone who holds a piece of the task is told it is a piece, and to reply blocked naming who should take it', JSON.stringify(piece));
  check(why(stranger) === 'not_on_task' && !stranger.ok && !/piece/.test(stranger.detail), 'and someone the task never reached is not told about pieces');
}

console.log('\n# nobody to give it away');
{
  const s = scene([]);
  const none = s.propose(PO, { task: TITLE, to: 'Bruno', reason: 'Take it' });
  check(why(none) === 'bad_target' && !none.ok && /Nobody is on this task/.test(none.detail) && !/: \./.test(none.detail), 'the PO proposing a card nobody holds is told so, without an empty list', JSON.stringify(none));
}

console.log('\n# a block with no PO has nobody to agree');
{
  const x = taskWorld();
  x.w.members.push({ id: id('yan'), name: 'Yan', role: 'employee', blockId: B2, status: 'idle' });
  const quick = x.tasks.boardsOf(B2).find((b) => b.kind === 'quick')!;
  const made = x.tasks.createTask(quick.id, 'Water the plants');
  x.tasks.assign(made.id, OUTSIDER);
  x.sync();
  const refused = x.tasks.proposeHandoff(OUTSIDER, { to: 'Yan', reason: 'Yan is nearer the plants' });
  check(!refused.ok && refused.reason === 'no_po' && /owner/i.test(refused.detail), 'the proposal is refused and the agent is told to message the owner', JSON.stringify(refused));
  check(x.tasks.view(x.now()).tasks.find((t) => t.id === made.id)!.handoff === undefined && x.w.prompts.get(id('yan')) === undefined, 'and nothing was opened or sent');
}

console.log('\n# a restart with a proposal open');
{
  const s = scene();
  const anaRun = s.view().runs[0]!;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  s.x.sync();
  s.x.advance(10_000);
  const r = on(taskWorld(s.x.file, s.x.w.persisted, s.x.now()), s.id);
  check(r.view().handoff?.id === p.id && r.view().handoff?.awaits === PO && r.view().assignees.join() === ANA, 'the proposal is still open after a restart: tasks.json kept it');
  const again = proposal(r.propose(ANA, { to: 'Bruno', reason: 'Asking again after the restart' }));
  check(again.id === p.id && r.says(PO).length === 1, 'asking again gets the same proposal, and the PO is not messaged a second time');
  const agreed = settled(r.answer(PO, { id: p.id, answer: 'accept', reason: 'Agreed' }));
  r.x.sync();
  check(agreed.state === 'accepted' && r.view().assignees.join() === BRUNO && r.runsOf(BRUNO).length === 1 && /^cancelled/.test(r.ended(anaRun)) && r.view().handoff === undefined, 'the PO accepts it in the restarted office: Bruno has the task and Ana\'s run ended');
  check(r.x.w.prompts.get(BRUNO)?.length === 1, 'and Bruno is started on it');
  r.x.advance(10_000);
  const second = on(taskWorld(r.x.file, r.x.w.persisted, r.x.now()), s.id);
  const twice = settled(second.answer(PO, { id: p.id, answer: 'accept' }));
  check(twice.state === 'accepted' && second.runsOf(BRUNO).length === 1 && second.view().assignees.join() === BRUNO && second.steps() === 'proposed:ana,accepted:po', 'accepting once more after another restart is read from the history and changes nothing');
}

console.log('\n# a crash in the middle of accepting');
{
  const s = scene();
  const anaRun = s.view().runs[0]!;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  s.x.sync();
  const beforeAccept = readFileSync(s.x.file, 'utf8');
  settled(s.answer(PO, { id: p.id, answer: 'accept', reason: 'Agreed' }));
  // The mail has Bruno's run, and tasks.json heard of nothing since the proposal.
  writeFileSync(s.x.file, beforeAccept);
  const reopened = new Tasks(s.x.file, s.x.host, s.x.w.persisted);
  reopened.recover([B1, B2], []);
  const r = on({ ...s.x, tasks: reopened }, s.id);
  const brunoRun = r.runsOf(BRUNO)[0]!;
  check(r.view().handoff?.id === p.id && r.runsOf(BRUNO).length === 1, 'the file shows the proposal still open, and a restart finds Bruno\'s run by its key');
  s.x.w.fresh.add('totals.ts');
  s.x.w.room.reply(BRUNO, brunoRun, { outcome: 'done', text: 'Totals fixed.', artifact: ['totals.ts'] });
  s.x.w.room.turnEnded(BRUNO, 'done', true);
  s.x.advance(1_000);
  const again = settled(r.answer(PO, { id: p.id, answer: 'accept', reason: 'Agreed' }));
  check(again.state === 'accepted' && r.view().assignees.join() === BRUNO && r.view().handoff === undefined && r.steps() === 'proposed:ana,accepted:po', 'accepting again, after Bruno has already finished, finishes the handoff once');
  const requests = [...s.x.w.room.state.messages.values()].filter((m) => m.kind === 'request' && m.to === BRUNO);
  check(requests.length === 1 && r.view().runs.length === 2 && s.x.w.room.state.keys.get(`task:${s.id}:bruno:${p.id}`) === brunoRun, 'Bruno is not given the task a second time: the retry finds his run by its key');
  check(/^cancelled/.test(r.ended(anaRun)) && r.says(ANA).length === 1, 'Ana\'s run was ended once, and she is told once');
}

console.log('\n# a crash in the middle of a decline');
{
  const s = scene();
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  s.x.sync();
  s.x.w.room.turnEnded(ANA, 'I asked Pia to hand it over, so I stop here.', true);
  const beforeDecline = readFileSync(s.x.file, 'utf8');
  settled(s.answer(PO, { id: p.id, answer: 'decline', reason: 'Bruno is full this week' }));
  writeFileSync(s.x.file, beforeDecline);
  const reopened = new Tasks(s.x.file, s.x.host, s.x.w.persisted);
  reopened.recover([B1, B2], []);
  const r = on({ ...s.x, tasks: reopened }, s.id);
  const again = settled(r.answer(PO, { id: p.id, answer: 'decline', reason: 'Bruno is full this week' }));
  const requests = [...s.x.w.room.state.messages.values()].filter((m) => m.kind === 'request' && m.to === ANA);
  check(again.state === 'declined' && r.view().handoff === undefined && requests.length === 2 && r.runsOf(ANA).length === 2, 'declining again gives Ana the task back once, not twice');
}

console.log('\n# a handoff whose people have left is dropped as soon as the office knows');
{
  const s = scene();
  const { x } = s;
  const p = proposal(s.propose(ANA, { to: 'Bruno', reason: WHY }));
  x.sync();
  x.w.room.turnEnded(ANA, 'I asked Pia to hand it over, so I stop here.', true);
  x.w.members.splice(x.w.members.findIndex((m) => m.id === PO), 1);
  x.w.members.push({ id: id('po2'), name: 'Pax', role: 'orchestrator', blockId: B1, status: 'idle' });
  x.tasks.reconcileHandoffs();
  x.sync();
  check(s.view().handoff === undefined && s.steps() === 'proposed:ana,dropped:ana', 'a proposal waiting on a PO who is gone is dropped at once, not when someone next touches it');
  check(s.runsOf(ANA).length === 2 && s.ended(s.runsOf(ANA)[1]!) === 'open', 'and Ana, who was left waiting, has the task back');
  check(why(s.answer(id('po2'), { id: p.id, answer: 'accept' })) === 'stale', 'the new PO is told it is stale');
  const size = x.w.room.state.order.length;
  x.tasks.reconcileHandoffs();
  check(x.w.room.state.order.length === size && s.steps() === 'proposed:ana,dropped:ana', 'running it again changes nothing');
}

console.log('\n# the giver leaves while the PO\'s request waits');
{
  const s = scene();
  const { x } = s;
  proposal(s.propose(PO, { task: TITLE, to: 'Bruno', reason: 'Spread the load' }));
  x.sync();
  x.w.members.splice(x.w.members.findIndex((m) => m.id === ANA), 1);
  x.tasks.reconcileHandoffs();
  x.sync();
  check(s.view().handoff === undefined && s.steps() === 'proposed:po,dropped:po', 'the proposal is dropped');
  check(s.says(PO).length === 1 && /dropped/i.test(s.says(PO)[0]!) && s.runsOf(ANA).length === 1, 'the PO who asked is told, and nothing is given back: Ana never stepped off');
}

console.log('\n# the receiver is told where the giver\'s unfinished work is');
{
  const s = scene();
  const stored = JSON.parse(readFileSync(s.x.file, 'utf8'));
  stored.tasks[0].git = { branch: 'task/fix-invoice-totals-1', base: 'main' };
  writeFileSync(s.x.file, JSON.stringify(stored));
  const r = on(taskWorld(s.x.file, s.x.w.persisted, s.x.now()), s.id);
  r.x.branches.set(ANA, 'ana/invoice-wip');
  const p = proposal(r.propose(ANA, { to: 'Bruno', reason: WHY }));
  settled(r.answer(PO, { id: p.id, answer: 'accept' }));
  const text = r.requestText(r.runsOf(BRUNO)[0]!);
  check(text.includes('ana/invoice-wip') && /not merged/.test(text), 'Bruno is told Ana\'s own branch, and that what is on it is not merged', text);
  check(text.includes('Finished work of this task is on task/fix-invoice-totals-1') && !/already holds/.test(text), 'and the task branch is named for finished work only');
}

console.log('\n# a cancel\'s reason reaches the pieces it cancels');
{
  const s = scene([PO]);
  const piece = s.x.w.room.post({ from: PO, to: 'Cleo', body: { kind: 'request', intent: 'work', title: 'Invoice export piece', text: 'build export' } });
  if (!piece.ok) throw new Error(piece.detail);
  s.x.sync();
  settled(s.propose(PO, { to: 'Bruno', reason: 'I am needed on planning' }));
  s.x.sync();
  const life = s.x.w.room.state.life.get(piece.id);
  const reply = life?.s === 'settled' ? s.x.w.room.state.messages.get(life.by) : undefined;
  check(reply?.kind === 'reply' && reply.outcome === 'cancelled' && /handed over to Bruno/i.test(reply.text), 'a piece the PO had handed out ends with the same reason, so its owner knows why', reply?.kind === 'reply' ? reply.text : 'open');
}

console.log('\n# the tools, through the real office');
{
  process.env.OFFICE_START_LEVEL = '5';
  delete process.env.OFFICE_CLAUDE_MODEL;
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  mkdirSync(join(dir, 'office'));
  const mcp = await startOfficeMcp();
  const memory = MemoryStore.open(join(dir, 'memory'));
  const acker = { warm() {}, ack: () => undefined, stop() {} };
  type Fake = { host: SessionHost; assigned: string[] };
  const fakes: Fake[] = [];
  HARNESSES['claude-code'] = {
    ...HARNESSES['claude-code'],
    session: (host) => {
      const fake: Fake = { host, assigned: [] };
      fakes.push(fake);
      return {
        assign: (taskText, title) => {
          fake.assigned.push(taskText);
          host.setStatus({ kind: 'working', task: title ?? taskText, startedAt: Date.now() });
        },
        interject() {},
        setModel() {},
        permissionsChanged() {},
        rulesChanged() {},
        stop() {},
      };
    },
  };
  const harnesses = { 'claude-code': { kind: 'ready' as const, version: 'fake' }, codex: { kind: 'missing' as const }, hermes: { kind: 'missing' as const } };
  const office = new Office(join(dir, 'office', 'company.json'), harnesses, { building() {}, rejected() {}, changed() {}, said() {}, log() {}, error() {} }, { mcp, memory, acker });
  office.handle({ type: 'create_block', cwd: repo });
  const blockId = office.snapshot().company.blocks[0]!.id;
  office.handle({ type: 'hire', provider: 'claude-code', blockId, name: 'Pia', role: 'orchestrator' });
  office.handle({ type: 'hire', provider: 'claude-code', blockId, name: 'Ana' });
  office.handle({ type: 'hire', provider: 'claude-code', blockId, name: 'Bruno' });
  const [poFake, anaFake, brunoFake] = fakes as [Fake, Fake, Fake];
  const idOf = (name: string) => office.snapshot().company.employees.find((e) => e.name === name)!.id;
  const ana = idOf('Ana');
  const bruno = idOf('Bruno');
  office.handle({ type: 'create_task', boardId: office.snapshot().boards[0]!.id, title: TITLE, notes: NOTES });
  const made = office.snapshot().tasks[0]!;
  office.handle({ type: 'assign_task', taskId: made.id, employeeId: ana });
  const now = () => office.snapshot().tasks[0]!;

  const connect = async (fake: Fake) => {
    const client = new Client({ name: 'task-handoff-check', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(fake.host.mcp.url)));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]!.text;
    return { isError: r.isError === true, text, json: () => JSON.parse(text) as any };
  };
  const pia = await connect(poFake);
  const anaTools = await connect(anaFake);
  const listed = (await anaTools.listTools()).tools;
  const spec = (name: string) => listed.find((t) => t.name === name);
  const props = (name: string) => (spec(name)?.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
  check(!!spec('handoffTask') && !!spec('answerHandoff'), 'both tools are offered next to moveTask', listed.map((t) => t.name).join(', '));
  check((spec('handoffTask')?.inputSchema.required ?? []).sort().join() === 'reason,to' && Object.keys(props('handoffTask')).sort().join() === 'from,reason,task,to', 'handoffTask takes to and reason, and optionally task and from');
  check((spec('answerHandoff')?.inputSchema.required ?? []).sort().join() === 'answer,id' && props('answerHandoff').answer?.enum?.join() === 'accept,decline,withdraw', 'answerHandoff takes the id and accept, decline or withdraw, and optionally a reason');
  const said = spec('handoffTask')?.description ?? '';
  check(/remind/i.test(spec('answerHandoff')?.description ?? ''), 'answerHandoff says that the office reminds once and then drops an unanswered handoff', spec('answerHandoff')?.description);
  check(/Two people must agree/.test(said) && !/needs your yes/.test(said) && /pieces/.test(said), 'it opens with who must agree, and says accepting cancels the giver\'s requests and pieces', said);
  const answering = spec('answerHandoff')?.description ?? '';
  check(/Answer before this turn ends/.test(answering) && /pieces/.test(answering) && /gets it back as a new request/.test(answering), 'answerHandoff says to answer before the turn ends, what accepting cancels, and that a decline gives the task back');
  check(/changes nothing/i.test(said) && /stop working/i.test(said) && /new request/i.test(said) && /may decline/i.test(said) && !/awaitReplies|you have to/.test(said), 'the description says that saying yes in a message changes nothing, that the giver stops working, that it comes back if it stays, and that the person asked may decline', said);

  const asked = (await call(anaTools, 'handoffTask', { to: 'Bruno', reason: WHY })).json();
  check(asked.ok === true && asked.state === 'proposed' && asked.awaits === 'Pia' && now().handoff?.id === asked.id && now().assignees.join() === ana, 'Ana proposes through the tool, as herself', JSON.stringify(asked));
  check(poFake.assigned.at(-1)?.includes(asked.id) === true, 'Pia is woken by a message that carries the id');
  const wrong = (await call(anaTools, 'answerHandoff', { id: asked.id, answer: 'accept' })).json();
  check(wrong.ok === false && wrong.reason === 'not_yours' && now().handoff?.id === asked.id, 'Ana cannot accept it herself through the tool');
  const bad = await call(pia, 'answerHandoff', { id: asked.id, answer: 'maybe' });
  check(bad.isError && now().handoff?.id === asked.id, 'an answer outside accept, decline and withdraw is refused before the office hears of it');
  const agreed = (await call(pia, 'answerHandoff', { id: asked.id, answer: 'accept', reason: 'Agreed' })).json();
  check(agreed.ok === true && agreed.state === 'accepted' && now().assignees.join() === bruno && now().runs.length === 2 && now().handoff === undefined, 'Pia accepts through the tool: Bruno has the task, with a new run', JSON.stringify(agreed));
  check(brunoFake.assigned.length === 1 && brunoFake.assigned[0]!.includes(WHY) && brunoFake.assigned[0]!.includes('Ana'), 'and Bruno\'s harness is started on it, told who handed it over and why');
  const again = (await call(anaTools, 'handoffTask', { task: TITLE, to: 'Pia', reason: 'Back again' })).json();
  check(again.ok === false && again.reason === 'not_on_task', 'Ana, no longer on the task, cannot propose it');

  const boardId = office.snapshot().boards[0]!.id;
  office.handle({ type: 'create_task', boardId, title: 'Second task', notes: 'x' });
  const second = () => office.snapshot().tasks.find((t) => t.title === 'Second task')!;
  office.handle({ type: 'assign_task', taskId: second().id, employeeId: bruno });
  const asked2 = (await call(pia, 'handoffTask', { task: 'Second task', to: 'Ana', reason: 'Ana is free' })).json();
  check(asked2.ok === true && asked2.awaits === 'Bruno' && second().handoff?.id === asked2.id, 'the PO asks Bruno through the tool to give a task to Ana', JSON.stringify(asked2));
  office.handle({ type: 'fire', employeeId: ana });
  check(second().handoff === undefined && (second().history ?? []).some((h) => h.kind === 'handoff' && h.step === 'dropped'), 'firing the receiver drops the handoff at once, without anyone touching it');

  office.handle({ type: 'hire', provider: 'claude-code', blockId, name: 'Dora' });
  const dora = idOf('Dora');
  office.handle({ type: 'create_task', boardId, title: 'Third task', notes: 'x' });
  office.handle({ type: 'assign_task', taskId: office.snapshot().tasks.find((t) => t.title === 'Third task')!.id, employeeId: bruno });
  const asked3 = (await call(pia, 'handoffTask', { task: 'Third task', to: 'Dora', reason: 'Dora is free' })).json();
  check(asked3.ok === true && asked3.awaits === 'Bruno', 'the PO asks Bruno to give a third task to Dora');
  await pia.close();
  await anaTools.close();
  office.shutdown();
  // Dora leaves while the app is closed.
  const file = join(dir, 'office', 'company.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.employees = stored.employees.filter((e: { id: string }) => e.id !== dora);
  writeFileSync(file, JSON.stringify(stored));
  const reopened = new Office(file, harnesses, { building() {}, rejected() {}, changed() {}, said() {}, log() {}, error() {} }, { mcp, memory, acker });
  const third = reopened.snapshot().tasks.find((t) => t.title === 'Third task')!;
  check(third.handoff === undefined && (third.history ?? []).some((h) => h.kind === 'handoff' && h.step === 'dropped'), 'a handoff whose receiver left while the app was closed is dropped when the office starts');
  reopened.shutdown();
  await mcp.close();
}

rmSync(dir, { recursive: true, force: true });
finish();
