// No model, no Electron. The activity of a task is a fold of the mailroom's ledger and the task's own history: ledgers are made
// by the real mailroom (verify/mail-world.ts) and read back through shared/activity.ts. The fold is held to the mailroom's own
// on every ledger it reads, so what it says a person is doing is what the mailroom thinks.
// Run from app/: node verify/activity-check.ts   Exits 1 on any failed check.
import type { EmployeeId } from '../src/shared/protocol.ts';
import type { LedgerEntry, MessageId } from '../src/shared/mail.ts';
import { activityIndexOf, activityOf, answerKey, answeredBy, noteKey, type ActivityEntry, type LiveInputs, type PersonLive, type TaskLive } from '../src/shared/activity.ts';
import { newTask, restage, withEvent, type BoardId, type Task, type TaskId } from '../src/shared/tasks.ts';
import { emptyMail, fold } from '../src/main/office/mail.ts';
import { check, finish } from './check.ts';
import { ANA, BRUNO, CLEO, PO, world, type World } from './mail-world.ts';

const tid = 'task-1' as TaskId;
const m = (s: string) => s as MessageId;

let clock = 1_000_000;
const tick = () => (clock += 1000);
const fresh = (n = 0) => world([], undefined, () => (clock += 10 + n));

const taskOf = (runs: string[], extra: Partial<Task> = {}): Task => ({ ...newTask({ id: tid, boardId: 'b' as BoardId, title: 'A task', origin: { kind: 'manual' }, stage: 'doing', now: 1_000_000 }), runs: runs.map(m), ...extra });
const ownerPost = (w: World, to: string, text: string, extra: { parentId?: MessageId; key?: string; kind?: 'request' | 'say'; title?: string } = {}) => {
  const body = extra.kind === 'say' ? ({ kind: 'say', text } as const) : ({ kind: 'request', intent: 'work', text, title: extra.title ?? text } as const);
  const r = w.room.post({ from: 'owner', to, body, ...(extra.parentId ? { parentId: extra.parentId } : {}), ...(extra.key ? { key: extra.key } : {}) });
  if (!r.ok) throw new Error(`post refused: ${r.detail}`);
  return r.id;
};
const ask = (w: World, from: EmployeeId, to: string, text: string, intent: 'work' | 'help' = 'work') => {
  const r = w.room.post({ from, to, body: { kind: 'request', intent, text, title: text } });
  if (!r.ok) throw new Error(`post refused: ${r.detail}`);
  return r.id;
};
const reply = (w: World, who: EmployeeId, id: MessageId, r: Parameters<World['room']['reply']>[2]) => {
  const out = w.room.reply(who, id, r);
  if (!out.ok) throw new Error(`reply refused: ${out.reason} ${out.detail ?? ''}`);
};
const idle: LiveInputs = { awaiting: new Set(), asks: [] };
const live = (t: Task, w: World, inputs: LiveInputs = idle) => activityOf(t, w.persisted, inputs).live;
const who = (l: TaskLive, id: EmployeeId): PersonLive => l.people.find((p) => p.employeeId === id)!;
const kinds = (entries: ActivityEntry[]) => entries.map((e) => e.kind);

// The mailroom's own fold of the same ledger, and a comparison of what the two say about every message.
function agrees(ledger: readonly LedgerEntry[]): { ok: boolean; detail: string } {
  const mail = ledger.reduce(fold, emptyMail());
  const ix = activityIndexOf(ledger);
  for (const id of mail.order) {
    const a = JSON.stringify(mail.life.get(id) ?? null);
    const b = JSON.stringify(ix.life.get(id) ?? null);
    if (a !== b) return { ok: false, detail: `${id}: mailroom ${a}, activity ${b}` };
  }
  const left = [...mail.unsettled].sort().join();
  const right = [...ix.unsettled].sort().join();
  return left === right ? { ok: true, detail: '' } : { ok: false, detail: `unsettled: mailroom ${left}, activity ${right}` };
}

const ledgers: { name: string; ledger: readonly LedgerEntry[] }[] = [];

console.log('# a delegation tree with a gauntlet');
{
  const w = fresh();
  w.fresh.add('app/a.ts');
  w.fresh.add('app/b.ts');
  const root = ownerPost(w, 'po', 'Build the meeting room');
  const piece = ask(w, PO, 'ana', 'Write the README');
  const g = w.room.requestGauntlet(PO, { piece: 'Build the office side', bar: ['it works'], builder: 'Bruno', critic: 'Cleo' });
  if (!g.ok) throw new Error(g.detail);
  w.room.turnEnded(PO, 'Delegated to Ana and Bruno.', true);
  const t = taskOf([root]);

  let l = live(t, w);
  check(who(l, PO).state === 'waiting', 'the PO whose turn ended with open pieces is waiting, not idle', JSON.stringify(who(l, PO)));
  const po = who(l, PO) as Extract<PersonLive, { state: 'waiting' }>;
  check(po.on.map((x) => x.who).sort().join() === [ANA, BRUNO].sort().join(), 'the PO waits on Ana and Bruno, the one holding the gauntlet round', JSON.stringify(po.on.map((x) => [x.who, x.state])));
  check(po.on.find((x) => x.who === BRUNO)?.state === 'building' && po.on.find((x) => x.who === BRUNO)?.round === 1, 'the gauntlet piece is waited on through its open round: Bruno building round 1');
  check(po.on.find((x) => x.who === BRUNO)?.piece.title === 'Build the office side', 'the wait names the piece the PO handed out, not the round');
  check(who(l, ANA).state === 'working' && (who(l, ANA) as { piece: { title: string } }).piece.title === 'Write the README', 'Ana is working on her piece');
  check(who(l, BRUNO).state === 'working', 'Bruno is working');
  check(l.people.length === 3 && !l.people.some((p) => p.employeeId === CLEO), 'someone who has not been asked yet is not on the task', JSON.stringify(l.people.map((p) => p.employeeId)));
  check(l.open === 3, 'three requests are open: the root, the README and the build round (a gauntlet is counted through its round)', `open ${l.open}`);

  const parked = live(t, w, { awaiting: new Set([PO]), asks: [] });
  check(who(parked, PO).state === 'waiting', 'the PO parked in awaitReplies, even with the turn open, is waiting');

  reply(w, ANA, piece, { outcome: 'done', text: 'README written.', artifact: ['app/a.ts'] });
  w.room.turnEnded(ANA, 'done', true);
  w.room.turnEnded(PO, 'noted', true);
  reply(w, BRUNO, w.room.state.children.get(g.id)![0]!, { outcome: 'done', text: 'Built.', artifact: ['app/b.ts'] });
  w.room.turnEnded(BRUNO, 'done', true);
  l = live(t, w);
  const reviewing = (who(l, PO) as Extract<PersonLive, { state: 'waiting' | 'working' }>).on.find((x) => x.piece.title === 'Build the office side');
  check(reviewing?.state === 'reviewing' && reviewing.who === CLEO && reviewing.round === 1, 'once the builder is done the PO waits on the critic: Cleo reviewing round 1', JSON.stringify(reviewing));
  check(who(l, ANA).state === 'done' && JSON.stringify((who(l, ANA) as { artifact?: string[] }).artifact) === '["app/a.ts"]', 'Ana is done with her files', JSON.stringify(who(l, ANA)));

  const review1 = w.room.state.children.get(g.id)!.at(-1)!;
  reply(w, CLEO, review1, { outcome: 'done', text: 'Not yet.', verdict: { pass: false, findings: ['click does nothing'] } });
  w.room.turnEnded(CLEO, 'reviewed', true);
  const round2 = w.room.state.children.get(g.id)!.at(-1)!;
  reply(w, BRUNO, round2, { outcome: 'done', text: 'Fixed.', artifact: ['app/b.ts'] });
  w.room.turnEnded(BRUNO, 'done', true);
  const review2 = w.room.state.children.get(g.id)!.at(-1)!;
  reply(w, CLEO, review2, { outcome: 'done', text: 'Good.', verdict: { pass: true, findings: [] } });
  w.room.turnEnded(CLEO, 'reviewed', true);
  reply(w, PO, root, { outcome: 'done', text: 'All pieces landed.' });
  while (w.room.state.active.has(PO)) w.room.turnEnded(PO, 'done', true);

  const { entries, live: end } = activityOf(t, w.persisted, idle);
  const reqs = entries.filter((e): e is Extract<ActivityEntry, { kind: 'request' }> => e.kind === 'request');
  check(reqs.length === 7, 'every request is in the log: root, README, gauntlet, 2 build rounds, 2 reviews', `${reqs.length}: ${reqs.map((r) => r.title).join(' | ')}`);
  check(reqs[0]!.from === 'owner' && reqs[0]!.to === PO && reqs[0]!.parent === null, 'the first entry after the task is the owner asking the PO');
  const rounds = reqs.filter((r) => r.round).map((r) => `${r.round!.role}${r.round!.n}`);
  check(rounds.join() === 'build1,review1,build2,review2', 'gauntlet rounds are numbered and a review belongs to the round it judges', rounds.join());
  const verdicts = entries.filter((e): e is Extract<ActivityEntry, { kind: 'reply' }> => e.kind === 'reply' && !!e.verdict);
  check(verdicts.length === 2 && !verdicts[0]!.verdict!.pass && verdicts[0]!.verdict!.findings[0] === 'click does nothing' && verdicts[1]!.verdict!.pass, 'both verdicts are in the log with their findings, fail then pass');
  check(verdicts.every((v) => v.round?.role === 'review'), 'a verdict knows its round');
  const files = entries.filter((e): e is Extract<ActivityEntry, { kind: 'reply' }> => e.kind === 'reply' && !!e.artifact?.length).map((e) => `${e.from}:${e.artifact!.join('+')}`);
  check(files.includes(`${ANA}:app/a.ts`) && files.includes(`${BRUNO}:app/b.ts`), 'the file lists of the replies are in the log', files.join(' | '));
  const started = entries.filter((e) => e.kind === 'started').length;
  check(started >= 5, 'each pickup of a request is in the log', `${started}`);
  check(entries.every((e, i) => i === 0 || entries[i - 1]!.at <= e.at), 'the log is in time order');
  check(new Set(entries.map((e) => e.id)).size === entries.length, 'every entry has its own id');
  const finalReply = entries.filter((e) => e.kind === 'reply').at(-1)!;
  check(finalReply.kind === 'reply' && finalReply.from === PO && finalReply.to === 'owner' && finalReply.outcome === 'done', 'the log ends with the PO settling the owner\'s request');
  check(who(end, PO).state === 'done' && end.questions.length === 0 && end.open === 0, 'at the end the PO is done and nothing is open', JSON.stringify(who(end, PO)));
  check(!entries.some((e) => e.kind === 'request' && e.title === 'Review the artifact against the bar' && e.round?.role !== 'review'), 'review requests are labelled as reviews');
  ledgers.push({ name: 'delegation tree', ledger: w.persisted });
}

console.log('\n# a blocked reply with its breakdown');
{
  const w = fresh();
  const root = ownerPost(w, 'ana', 'Add the export');
  const blocker = { why: 'The format was never chosen.', question: 'CSV or JSON?', next: 'I build the one you pick.' };
  reply(w, ANA, root, { outcome: 'blocked', text: 'stopped before writing anything', blocker });
  w.room.turnEnded(ANA, 'blocked', true);
  const l = live(taskOf([root]), w);
  const q = l.questions[0]!;
  check(q?.how === 'blocked' && JSON.stringify(q.blocker) === JSON.stringify(blocker) && q.text === 'stopped before writing anything', 'the open question carries the why, the question and the next step, beside the reply text', JSON.stringify(l.questions));
  const said = activityOf(taskOf([root]), w.persisted, idle).entries.find((e) => e.kind === 'reply');
  check(said?.kind === 'reply' && said.blocker?.question === 'CSV or JSON?', 'and the log entry of the reply carries them too');
}

console.log('\n# a blocked reply is a question the owner answers');
{
  const w = fresh();
  w.fresh.add('app/api.ts');
  const root = ownerPost(w, 'ana', 'Add the export');
  reply(w, ANA, root, { outcome: 'blocked', text: 'Which format do you want, CSV or JSON?' });
  w.room.turnEnded(ANA, 'blocked', true);
  const t = taskOf([root]);
  let l = live(t, w);
  const q = l.questions[0]!;
  check(l.questions.length === 1 && q.how === 'blocked' && q.asker === ANA && q.to === 'owner' && q.text === 'Which format do you want, CSV or JSON?', 'a blocked reply to the owner is an open question with its asker and text', JSON.stringify(l.questions));
  check(q.how === 'blocked' && q.piece.title === 'Add the export', 'the question names the request it blocked');
  check(q.how === 'blocked' && q.blocker === undefined, 'a blocked reply without a breakdown carries none');
  check(who(l, ANA).state === 'blocked' && (who(l, ANA) as { question: { text: string } }).question.text === q.text, 'the asker is shown blocked on the question, not idle');

  const answer = ownerPost(w, 'ana', 'CSV.', { parentId: root, key: answerKey(tid, ANA, q.ref.kind === 'mail' ? q.ref.id : m('')) });
  const t2 = taskOf([root, answer]);
  l = live(t2, w);
  check(l.questions.length === 0, 'the question closes once the owner\'s answer is posted');
  check(who(l, ANA).state === 'working' && (who(l, ANA) as { piece: { title: string } }).piece.title === 'CSV.', 'the asker resumes on the answer', JSON.stringify(who(l, ANA)));
  const answers = activityOf(t2, w.persisted, idle).entries.find((e) => e.kind === 'request' && e.msg === answer);
  check(answers?.kind === 'request' && answers.answers === (q.ref.kind === 'mail' ? q.ref.id : ''), 'the log says which question the request answers');
  check(w.room.state.messages.get(answer)?.rootId === root && w.room.state.messages.get(answer)?.parentId === root, 'the answer sits in the question\'s own chain');
  reply(w, ANA, answer, { outcome: 'done', text: 'Exported CSV.', artifact: ['app/api.ts'] });
  w.room.turnEnded(ANA, 'done', true);
  l = live(t2, w);
  check(who(l, ANA).state === 'done', 'the asker settles and shows done');

  const again = w.room.post({ from: 'owner', to: 'ana', key: answerKey(tid, ANA, q.ref.kind === 'mail' ? q.ref.id : m('')), parentId: root, body: { kind: 'request', intent: 'work', text: 'CSV.', title: 'CSV.' } });
  check(again.ok && again.id === answer, 'answering twice posts once: the key finds the first answer');
  check(answeredBy(answerKey(tid, ANA, m('abc'))) === 'abc' && answeredBy(noteKey(tid, m('abc'))) === 'abc' && answeredBy('task:x:y:1') === undefined && answeredBy(undefined) === undefined, 'a key says which question it answers');
  ledgers.push({ name: 'blocked answered', ledger: w.persisted });

  const chat = fresh();
  const r2 = ownerPost(chat, 'ana', 'Add the import');
  reply(chat, ANA, r2, { outcome: 'blocked', text: 'Which file?' });
  chat.room.turnEnded(ANA, 'blocked', true);
  check(live(taskOf([r2]), chat).questions.length === 1, 'a second blocked run is a question too');
  chat.room.post({ from: 'owner', to: 'ana', body: { kind: 'say', text: 'Use import.ts' } });
  check(live(taskOf([r2]), chat).questions.length === 0, 'the owner telling the asker something in chat closes it');
  ledgers.push({ name: 'blocked answered in chat', ledger: chat.persisted });

  const again2 = fresh();
  const r3 = ownerPost(again2, 'ana', 'Add the cache');
  reply(again2, ANA, r3, { outcome: 'blocked', text: 'Cannot find the module.' });
  again2.room.turnEnded(ANA, 'blocked', true);
  const run2 = ownerPost(again2, 'ana', 'Add the cache, again');
  check(live(taskOf([r3, run2]), again2).questions.length === 0, 'giving the asker a new run closes the question');
  ledgers.push({ name: 'assign again', ledger: again2.persisted });

  check(live(taskOf([r2], { stage: 'done' }), chat).questions.length === 0 && live(taskOf([root], { stage: 'done' }), w).questions.length === 0, 'a done task shows no questions');

  const moved = fresh();
  const r4 = ownerPost(moved, 'ana', 'Add the report');
  reply(moved, ANA, r4, { outcome: 'blocked', text: 'Which quarter?' });
  moved.room.turnEnded(ANA, 'blocked', true);
  const parked = taskOf([r4], { stage: 'todo' });
  check(live(parked, moved).questions.length === 1, 'a card left in todo keeps the question');
  check(live(restage(parked, 'review', 'owner', clock + 1e9), moved).questions.length === 0, 'the owner moving the card to another column closes it: they read it and decided');
  check(live(restage(parked, 'doing', 'mailroom', clock + 1e9), moved).questions.length === 1, 'the office moving it does not');
  ledgers.push({ name: 'moved', ledger: moved.persisted });
}

console.log('\n# a question put to a teammate');
{
  const w = fresh();
  w.fresh.add('app/x.ts');
  const root = ownerPost(w, 'po', 'Ship the export');
  const piece = ask(w, PO, 'ana', 'Write the exporter');
  w.room.turnEnded(PO, 'delegated', true);
  reply(w, ANA, piece, { outcome: 'blocked', text: 'I need the schema from Bruno.' });
  w.room.turnEnded(ANA, 'blocked', true);
  const t = taskOf([root]);
  let l = live(t, w);
  const q = l.questions.find((x) => x.how === 'blocked');
  check(q?.asker === ANA && q.to === PO, 'a blocked piece is a question from the teammate to the PO', JSON.stringify(l.questions));
  check(who(l, PO).state === 'working' || who(l, PO).state === 'waiting', 'the PO is not shown blocked: the question is Ana\'s');
  check(who(l, ANA).state === 'blocked', 'Ana is blocked');
  ask(w, PO, 'ana', 'Write the exporter, schema is in schema.ts');
  l = live(t, w);
  check(!l.questions.some((x) => x.how === 'blocked'), 'the PO sending the piece again closes the question', JSON.stringify(l.questions));
  check(who(l, ANA).state === 'working', 'Ana is working again');

  const w2 = fresh();
  const root2 = ownerPost(w2, 'po', 'Ship the import');
  const piece2 = ask(w2, PO, 'ana', 'Write the importer');
  w2.room.turnEnded(PO, 'delegated', true);
  reply(w2, ANA, piece2, { outcome: 'blocked', text: 'Blocked.' });
  w2.room.turnEnded(ANA, 'blocked', true);
  check(live(taskOf([root2]), w2).questions.length === 1, 'while the PO\'s request is open Ana\'s block is a question');
  w2.room.cancel('owner', root2);
  const l2 = live(taskOf([root2]), w2);
  check(l2.questions.length === 0, 'once the request she was asked under is settled, her block is moot', JSON.stringify(l2.questions.map((x) => [x.asker, x.to])));
  ledgers.push({ name: 'nested blocked', ledger: w2.persisted });

  const h = fresh();
  const hr = ownerPost(h, 'po', 'Ship the thing');
  ask(h, PO, 'ana', 'Build it');
  const help = ask(h, ANA, 'bruno', 'Which port does the dev server use?', 'help');
  let hl = live(taskOf([hr]), h);
  const hq = hl.questions.find((x) => x.how === 'help');
  check(hq?.asker === ANA && hq.to === BRUNO && hq.ref.kind === 'mail' && hq.ref.id === help && hq.text === 'Which port does the dev server use?', 'a help request to a teammate inside the chain is an open question', JSON.stringify(hl.questions));
  const note = h.room.post({ from: 'owner', to: 'ana', parentId: help, key: noteKey(tid, help), body: { kind: 'say', text: 'Port 5173.', urgency: 'next' } });
  hl = live(taskOf([hr]), h);
  check(note.ok && hl.questions.length === 0, 'the owner answering the asker closes the help question', JSON.stringify(hl.questions));
  const hn = activityOf(taskOf([hr]), h.persisted, idle).entries.find((e) => e.kind === 'say' && e.answers === help);
  check(!!hn, 'the log says which question a word answers');
  ledgers.push({ name: 'help', ledger: h.persisted });

  const h2 = fresh();
  const r5 = ownerPost(h2, 'po', 'Ship the thing');
  const help2 = ask(h2, ANA, 'bruno', 'Which port?', 'help');
  reply(h2, BRUNO, help2, { outcome: 'done', text: '5173' });
  check(live(taskOf([r5]), h2).questions.length === 0, 'a help request the teammate replied to is not a question any more');
  ledgers.push({ name: 'help replied', ledger: h2.persisted });
}

console.log('\n# an employee asking the owner in person');
{
  const w = fresh();
  const root = ownerPost(w, 'ana', 'Pick a name');
  const asks: LiveInputs = { awaiting: new Set(), asks: [{ employeeId: ANA, question: { id: 'q1' as never, askedAt: 5, kind: 'ask', text: 'Name it Atlas or Orion?', options: ['Atlas', 'Orion'] } }] };
  const l = live(taskOf([root]), w, asks);
  check(l.questions.length === 1 && l.questions[0]!.how === 'ask' && l.questions[0]!.ref.kind === 'ask' && (l.questions[0] as { options?: string[] }).options?.join() === 'Atlas,Orion', 'what an employee on the task asked the owner in person is a question with its options', JSON.stringify(l.questions));
  check(who(l, ANA).state === 'blocked', 'and the employee is shown blocked on it');
  const other: LiveInputs = { awaiting: new Set(), asks: [{ employeeId: BRUNO, question: { id: 'q2' as never, askedAt: 5, kind: 'ask', text: 'Elsewhere?' } }] };
  check(live(taskOf([root]), w, other).questions.length === 0, 'an employee who is not on the task does not put a question on it');
  const perm: LiveInputs = { awaiting: new Set(), asks: [{ employeeId: ANA, question: { id: 'q3' as never, askedAt: 6, kind: 'permission', text: 'Run it?', tool: 'Bash', detail: 'rm -rf build' } }] };
  const lp = live(taskOf([root]), w, perm).questions[0]!;
  check(lp.how === 'permission' && lp.tool === 'Bash' && lp.detail === 'rm -rf build', 'a permission card of an employee on the task is a question too');
  ledgers.push({ name: 'ask', ledger: w.persisted });
}

console.log('\n# queued behind other work, and a crash');
{
  const w = fresh();
  ownerPost(w, 'ana', 'Another task entirely');
  const root = ownerPost(w, 'po', 'The task');
  const piece = ask(w, PO, 'ana', 'Piece for Ana');
  w.room.turnEnded(PO, 'delegated', true);
  const t = taskOf([root]);
  let l = live(t, w);
  const a = who(l, ANA) as Extract<PersonLive, { state: 'queued' }>;
  check(a.state === 'queued' && a.piece.title === 'Piece for Ana' && a.behind === 'Another task entirely', 'a piece waiting behind the person\'s other work is queued and says behind what', JSON.stringify(a));
  const po = who(l, PO) as Extract<PersonLive, { state: 'waiting' }>;
  check(po.state === 'waiting' && po.on[0]?.who === ANA && po.on[0].state === 'queued', 'the PO waits on Ana, whose piece has not started');
  check(!activityOf(t, w.persisted, idle).entries.some((e) => e.kind === 'started' && e.msg === piece), 'a queued piece has no pickup entry yet');

  const before = w.persisted.length;
  w.room.recoverOnStart();
  check(w.persisted.length > before, 'the crash left a recover entry');
  const crash = fresh();
  const cr = ownerPost(crash, 'ana', 'Long job');
  crash.room.recoverOnStart();
  const { entries, live: lc } = activityOf(taskOf([cr]), crash.persisted, idle);
  const rec = entries.find((e) => e.kind === 'recovered');
  check(rec?.kind === 'recovered' && rec.requeued.length === 1 && rec.requeued[0]!.who === ANA && rec.requeued[0]!.title === 'Long job', 'a crash puts what was in hand back in the log as requeued');
  const starts = entries.filter((e) => e.kind === 'started');
  check(starts.length === 2 && starts[0]!.kind === 'started' && !starts[0].again && starts[1]!.kind === 'started' && starts[1].again, 'the pickup after a crash is a second go', JSON.stringify(starts));
  check(kinds(entries).join() === 'created,request,started,recovered,started', 'the crash shows between the two pickups', kinds(entries).join());
  check(who(lc, ANA).state === 'working', 'after the restart the person is working again');
  ledgers.push({ name: 'crash', ledger: crash.persisted });
  ledgers.push({ name: 'queued', ledger: w.persisted });

  const solo = fresh();
  const sr = ownerPost(solo, 'ana', 'Piece');
  const dead = [...solo.persisted];
  const cut = dead.filter((e) => !(e.t === 'turn_end'));
  const lq = activityOf(taskOf([sr]), [...cut, { t: 'recover', at: 9 }], idle).live;
  check(who(lq, ANA).state === 'queued', 'a turn with no end that a restart repaired is queued, not working', JSON.stringify(who(lq, ANA)));
  const mid = activityOf(taskOf([sr]), cut, idle).live;
  check(who(mid, ANA).state === 'working', 'the same ledger before the restart is working');
}

console.log('\n# stage changes and hours are in the log');
{
  const w = fresh();
  const root = ownerPost(w, 'ana', 'Do it');
  let t = taskOf([root], { stage: 'todo' });
  t = restage(t, 'doing', 'owner', 1_000_500);
  t = restage(t, 'review', 'mailroom', 1_050_000, m('r1'));
  t = restage(t, 'review', 'owner', 1_060_000);
  t = withEvent(t, { kind: 'hours', at: 1_070_000, employeeId: ANA, date: '2026-10-06', hours: 0.25 });
  t = withEvent(t, { kind: 'hours', at: 1_080_000, employeeId: ANA, date: '2026-10-06', hours: 0.5, error: 'offline' });
  const { entries } = activityOf(t, w.persisted, idle);
  const stages = entries.filter((e): e is Extract<ActivityEntry, { kind: 'stage' }> => e.kind === 'stage');
  check(stages.length === 2 && stages[0]!.by === 'owner' && stages[0]!.from === 'todo' && stages[0]!.to === 'doing' && stages[1]!.by === 'mailroom' && stages[1]!.cause === 'r1', 'stage changes say who moved the task and why', JSON.stringify(stages));
  check(t.history!.length === 4, 'moving a task to where it already is leaves no entry');
  const hours = entries.filter((e): e is Extract<ActivityEntry, { kind: 'hours' }> => e.kind === 'hours');
  check(hours.length === 2 && hours[0]!.hours === 0.25 && !hours[0]!.error && hours[1]!.error === 'offline', 'hours sends are in the log, and a failed one says why');
  check(entries[0]!.kind === 'created' && entries[0]!.by === 'owner', 'the log opens with the task being made');
  const pos = (k: string) => entries.findIndex((e) => e.kind === k);
  check(pos('stage') > pos('request') || entries.find((e) => e.kind === 'stage')!.at < entries.find((e) => e.kind === 'request')!.at, 'history entries are placed by time among the mail');
  const provider = activityOf(newTask({ id: tid, boardId: 'b' as BoardId, title: 't', origin: { kind: 'linear', externalId: '1', identifier: 'ABC-1', providerStatus: 'Todo', sourceLabel: 'Linear' }, stage: 'todo', now: 5 }), [], idle).entries;
  check(provider[0]!.kind === 'created' && provider[0].by === 'provider', 'a provider task was created by the provider');
}

console.log('\n# the fold keeps the mailroom\'s lifecycle on every ledger');
for (const { name, ledger } of ledgers) {
  const r = agrees(ledger);
  check(r.ok, `${name}: every message is where the mailroom says it is`, r.detail);
}
const replay = ledgers[0]!.ledger;
{
  const twice = [...replay, ...replay];
  const a = activityOf(taskOf(['m0001']), replay, idle);
  const b = activityOf(taskOf(['m0001']), twice, idle);
  check(JSON.stringify(a.entries.map((e) => e.kind)) === JSON.stringify(b.entries.map((e) => e.kind)), 'folding the same ledger twice gives the same log');
}

finish();
