// No model, no Electron, no sessions. The pure mailroom core and its shell, driven through fake ports.
// Run from app/: node verify/mail-check.ts   Exits 1 on any failed check.
import type { EmployeeId } from '../src/shared/protocol.ts';
import type { LedgerEntry, MessageId } from '../src/shared/mail.ts';
import { MAX_HOPS } from '../src/shared/mail.ts';
import { emptyMail, fold, Mailroom, recover, serving, type MailState } from '../src/main/office/mail.ts';
import { check, finish } from './check.ts';

import { ANA, B1, BRUNO, CLEO, PO, world, type World } from './mail-world.ts';

const owner = (to: string, text: string, as: 'request' | 'say' = 'request', extra: { key?: string } = {}) =>
  ({ from: 'owner' as const, to, blockId: B1, body: as === 'request' ? { kind: 'request' as const, text } : { kind: 'say' as const, text }, ...extra });
const ask = (from: EmployeeId, to: string, text: string, bar?: string[]) => ({ from, to, body: { kind: 'request' as const, text, ...(bar ? { bar } : {}) } });
const posted = (r: ReturnType<Mailroom['post']>) => {
  if (!r.ok) throw new Error(`post refused: ${r.reason}`);
  return r;
};
const ids = (r: ReturnType<Mailroom['post']>) => posted(r).id;
const life = (w: World, m: MessageId) => w.room.state.life.get(m)?.s;
const replyTo = (w: World, m: MessageId) => {
  const l = w.room.state.life.get(m);
  const r = l?.s === 'settled' ? w.room.state.messages.get(l.by) : undefined;
  return r?.kind === 'reply' ? r : undefined;
};
const requestIn = (prompt: string) => /\[Request (\w+) /.exec(prompt)![1]!;
// An employee answers with the reply tool, then the turn ends.
const answer = (w: World, who: EmployeeId, r: Parameters<Mailroom['reply']>[2]) => {
  w.room.reply(who, requestIn(lastPrompt(w, who)), r);
  w.room.turnEnded(who, r.text, true);
};
const lastPrompt = (w: World, who: EmployeeId) => w.prompts.get(who)?.at(-1) ?? '';

const dump = (s: MailState) =>
  JSON.stringify({
    messages: [...s.messages],
    order: s.order,
    life: [...s.life].sort(([a], [b]) => a.localeCompare(b)),
    queue: [...s.queue].filter(([, q]) => q.length).sort(([a], [b]) => a.localeCompare(b)),
    unsettled: [...s.unsettled].sort(),
    turns: [...s.turns],
    active: [...s.active].sort(),
  });

console.log('# queueing a busy target');
{
  const w = world();
  const first = posted(w.room.post(owner('ana', 'build the parser')));
  check(first.delivery === 'delivered' && first.ahead === 0, 'a request to an idle actor is delivered at once');
  check(/build the parser/.test(lastPrompt(w, ANA)), 'the prompt carries the request text');
  const second = posted(w.room.post(owner('Ana', 'and the lexer')));
  const third = posted(w.room.post(owner('ana', 'and the docs')));
  check(second.delivery === 'queued' && second.ahead === 0, 'a request to a busy actor queues, never errors', JSON.stringify(second));
  check(third.delivery === 'queued' && third.ahead === 1, 'the next one is one ahead', JSON.stringify(third));
  check((w.prompts.get(ANA)?.length ?? 0) === 1, 'nothing is delivered while the actor is busy');
  w.room.turnEnded(ANA, 'parser done', true);
  check(replyTo(w, first.id)?.outcome === 'done' && replyTo(w, first.id)?.auto === true && replyTo(w, first.id)?.text === 'parser done', 'a turn that ends without reply settles done, auto, with the final text');
  check((w.prompts.get(ANA)?.length ?? 0) === 2, 'the queue drains when the actor goes idle');
  check(/and the lexer/.test(lastPrompt(w, ANA)) && /and the docs/.test(lastPrompt(w, ANA)), 'the waiting messages arrive together as one batch');
  const firstReply = w.room.reply(ANA, first.id, { outcome: 'done', text: 'late' });
  check(firstReply.ok && w.room.state.messages.size === [...w.room.state.messages].length && replyTo(w, first.id)?.text === 'parser done', 'a second reply to a settled request changes nothing');
  check(w.room.reply(BRUNO, second.id, { outcome: 'done', text: 'x' }).ok === false, 'only the addressee can reply');
  const dup = posted(w.room.post(owner('ana', 'again', 'request', { key: 'c1' })));
  const dup2 = posted(w.room.post(owner('ana', 'again', 'request', { key: 'c1' })));
  check(dup.id === dup2.id, 'the same key posts once');
  const cross = w.room.post(ask(ANA, 'zed', 'hi'));
  check(!cross.ok && cross.reason === 'cross_block', 'a peer in another block is refused');
  const nobody = w.room.post(ask(ANA, 'nobody', 'hi'));
  check(!nobody.ok && nobody.reason === 'unknown_target', 'an unknown name is refused');
  for (let i = 0; i < 21; i++) w.room.post(owner('cleo', `m${i}`, 'say'));
  const full = w.room.post(owner('cleo', 'one too many', 'say'));
  check(!full.ok && full.reason === 'queue_full', 'the per-actor queue is capped');
}

console.log('\n# a say steers a running turn');
{
  const w = world();
  w.room.post(owner('ana', 'work'));
  const s = posted(w.room.post({ from: 'owner', to: 'ana', blockId: B1, body: { kind: 'say', text: 'use pg', urgency: 'next' } }));
  check(s.delivery === 'delivered' && w.steers.length === 1 && w.steers[0]!.style === 'next' && /use pg/.test(w.steers[0]!.text), 'a say with urgency next reaches the running turn');
  const q = posted(w.room.post({ from: 'owner', to: 'ana', blockId: B1, body: { kind: 'say', text: 'later' } }));
  check(q.delivery === 'queued', 'a say with urgency queue waits');
}

console.log('\n# delegation and settling');
{
  const w = world();
  const root = ids(w.room.post(owner('po', 'ship csv export')));
  check(/ship csv export/.test(lastPrompt(w, PO)), 'to: po resolves to the block orchestrator');
  const c1 = ids(w.room.post(ask(PO, 'Ana', 'backend', ['route returns csv'])));
  const c2 = ids(w.room.post(ask(PO, 'Bruno', 'ui')));
  const child = w.room.state.messages.get(c1)!;
  check(child.parentId === root && child.rootId === root && child.hops === 1, 'a request posted mid-turn is a child of the request being served');
  check(/Acceptance bar:\n- route returns csv/.test(lastPrompt(w, ANA)), 'the bar reaches the assignee');
  w.room.turnEnded(PO, 'Split into two pieces.', true);
  check(life(w, root) === 'delivered' && !replyTo(w, root), 'a parent with open children is not auto-settled');
  w.room.turnEnded(ANA, 'backend done', true);
  check(replyTo(w, c1)?.text === 'backend done', 'the child settles to the delegator');
  check(/Reply from Ana to your request/.test(lastPrompt(w, PO)) && /backend done/.test(lastPrompt(w, PO)), 'a child reply wakes the parent with the result');
  w.room.turnEnded(PO, 'waiting on the ui', true);
  check(!replyTo(w, root), 'one child still open: the parent stays unsettled');
  w.room.turnEnded(BRUNO, 'ui done', true);
  check(/ui done/.test(lastPrompt(w, PO)), 'the last child reply wakes the parent again');
  w.room.turnEnded(PO, 'CSV export shipped', true);
  const final = replyTo(w, root);
  check(final?.outcome === 'done' && final.auto === true && final.text === 'CSV export shipped' && final.to === 'owner', 'the parent auto-settles to the owner only after all children settled');
  check(serving(w.room.state, PO).length === 0, 'nothing is left being served');

  const early = world();
  const earlyRoot = ids(early.room.post(owner('po', 'ship it')));
  ids(early.room.post(ask(PO, 'Ana', 'backend')));
  const refused = early.room.reply(PO, earlyRoot, { outcome: 'done', text: 'all shipped' });
  check(!refused.ok && refused.reason === 'open_children' && !replyTo(early, earlyRoot), 'a done reply is refused while a request the replier made is still open');
  const blockedEarly = early.room.reply(PO, earlyRoot, { outcome: 'blocked', text: 'stuck' });
  check(!blockedEarly.ok && blockedEarly.reason === 'open_children' && !replyTo(early, earlyRoot), 'a blocked reply is refused while a request the replier made is still open (G2: PO replied blocked over an open piece)');
  const earlyChild = [...early.room.state.unsettled].find((i) => early.room.state.messages.get(i)?.parentId === earlyRoot)!;
  early.room.cancel(PO, earlyChild);
  check(early.room.reply(PO, earlyRoot, { outcome: 'blocked', text: 'stuck' }).ok && replyTo(early, earlyRoot)?.outcome === 'blocked', 'a blocked reply goes through once the open request is cancelled explicitly');
  const late = world();
  const lateRoot = ids(late.room.post(owner('po', 'ship it')));
  ids(late.room.post(ask(PO, 'Ana', 'backend')));
  late.room.turnEnded(ANA, 'backend done', true);
  check(late.room.reply(PO, lateRoot, { outcome: 'done', text: 'all shipped' }).ok && replyTo(late, lateRoot)?.outcome === 'done', 'a done reply goes through once every request it made is settled');

  const rv = world();
  const g1 = posted(rv.room.requestGauntlet(PO, { piece: 'build it', bar: ['it works'], builder: 'Ana', critic: 'Bruno' })).id;
  rv.room.turnEnded(ANA, 'built', true);
  const reviewId = requestIn(lastPrompt(rv, BRUNO));
  const bare = rv.room.reply(BRUNO, reviewId, { outcome: 'done', text: 'Artifact passes.' });
  check(!bare.ok && bare.reason === 'verdict_required' && life(rv, g1) === 'running', 'a review reply without a verdict is refused and the gauntlet keeps running');
  check(rv.room.reply(BRUNO, reviewId, { outcome: 'done', text: 'ok', verdict: { pass: true, findings: [] } }).ok && replyTo(rv, g1)?.outcome === 'done', 'the same review with a verdict passes the gauntlet');

  const auto = world();
  const ag = posted(auto.room.requestGauntlet(PO, { piece: 'build it', bar: ['it works'], builder: 'Ana', critic: 'Bruno' })).id;
  auto.room.turnEnded(ANA, 'built', true);
  auto.room.turnEnded(BRUNO, '**Verdict: PASS**', true);
  check(replyTo(auto, ag)?.outcome === 'done', 'a critic whose turn ends with a bare PASS passes the gauntlet');
  const af = posted(auto.room.requestGauntlet(PO, { piece: 'again', bar: ['it works'], builder: 'Ana', critic: 'Bruno' })).id;
  auto.room.turnEnded(ANA, 'built', true);
  auto.room.turnEnded(BRUNO, 'FAIL: the button does not download. Not a pass.', true);
  check(!replyTo(auto, af) && /Round 2/.test(lastPrompt(auto, ANA)), 'a critic text with FAIL in it sends the builder round again');

  const e = world();
  const r = ids(e.room.post(owner('ana', 'crash')));
  e.room.turnEnded(ANA, 'boom', false);
  const failed = replyTo(e, r);
  check(failed?.outcome === 'failed' && /boom/.test(failed.text), 'a turn ending in error settles failed with the error text');

  const f = world();
  f.failDeliver(ANA);
  const fr = ids(f.room.post(owner('ana', 'no folder')));
  check(replyTo(f, fr)?.outcome === 'failed' && /folder is gone/.test(replyTo(f, fr)!.text), 'a delivery that throws settles failed instead of erroring the sender');

  const h = world();
  ids(h.room.post(owner('ana', 'root')));
  ids(h.room.post(ask(ANA, 'bruno', 'level 1')));
  h.room.turnEnded(ANA, 'ok', true);
  ids(h.room.post(ask(BRUNO, 'cleo', 'level 2')));
  h.room.turnEnded(BRUNO, 'ok', true);
  ids(h.room.post(ask(CLEO, 'ana', 'level 3')));
  h.room.turnEnded(CLEO, 'ok', true);
  const deep = h.room.post(ask(ANA, 'bruno', 'level 4'));
  check(!deep.ok && deep.reason === 'hop_limit' && MAX_HOPS === 3, 'delegation depth is capped');
}

console.log('\n# asking a peer and waiting');
{
  const w = world();
  w.room.post(owner('ana', 'task'));
  w.room.post(owner('bruno', 'task'));
  const q = ids(w.room.post({ from: BRUNO, to: 'ana', body: { kind: 'request', intent: 'help', text: 'does the route take ?from=?' } }));
  check(life(w, q) === 'queued', 'the question to a busy peer queues');
  const wait = w.room.await(BRUNO, { ids: [q], timeoutSec: 5 });
  const other = w.room.await(ANA, { ids: [], timeoutSec: 5 });
  const got = await other;
  check(got.some((m) => m.id === q), 'a waiting peer returns early with the incoming question, so mutual waits do not deadlock');
  w.room.reply(ANA, q, { outcome: 'done', text: 'yes' });
  const answer = await wait;
  check(answer.length === 1 && answer[0]!.kind === 'reply' && answer[0]!.text === 'yes', 'awaitReplies returns the reply as a result');
  const none = await w.room.await(BRUNO, { ids: [], timeoutSec: 0.05 });
  check(none.length === 0, 'awaitReplies times out with nothing');
}

console.log('\n# gauntlet');
{
  const w = world();
  for (const f of ['src/Button.tsx', 'git diff main', 'x']) w.fresh.add(f);
  const root = ids(w.room.post(owner('po', 'make the button')));
  const same = w.room.requestGauntlet(PO, { piece: 'ui', bar: ['visible'], builder: 'Ana', critic: 'ana' });
  check(!same.ok && same.reason === 'critic_is_builder', 'critic === builder is refused');
  const g = posted(w.room.requestGauntlet(PO, { piece: 'Build the export button', bar: ['button visible', 'click downloads'], builder: 'Ana', critic: 'Bruno' }));
  check(w.room.state.messages.get(g.id)?.parentId === root, 'the gauntlet hangs off the request the PO is serving');
  check(/Build the export button/.test(lastPrompt(w, ANA)) && /button visible/.test(lastPrompt(w, ANA)), 'round 1 asks the builder with the bar');
  const prose = 'I am very proud of this CSS trick with gradients';
  answer(w, ANA, { outcome: 'done', text: prose, artifact: ['src/Button.tsx', 'git diff main'] });
  const critic1 = lastPrompt(w, BRUNO);
  check(/src\/Button\.tsx/.test(critic1) && /button visible/.test(critic1) && /click downloads/.test(critic1), 'the critic gets the artifact and the bar');
  check(!critic1.includes('proud') && !critic1.includes(prose) && !critic1.includes('Build the export button'), 'the builder prose is absent from the critic prompt');
  answer(w, BRUNO, { outcome: 'done', text: 'fails', verdict: { pass: false, findings: ['click does nothing'] } });
  check(/click does nothing/.test(lastPrompt(w, ANA)) && w.prompts.get(ANA)!.length === 2, 'fail findings go back to the builder as a new work request');
  check(life(w, g.id) === 'running', 'the gauntlet stays open between rounds');
  answer(w, ANA, { outcome: 'done', text: 'fixed', artifact: ['src/Button.tsx'] });
  answer(w, BRUNO, { outcome: 'done', text: 'good', verdict: { pass: true, findings: [] } });
  const settled = replyTo(w, g.id);
  check(settled?.outcome === 'done' && settled.artifact?.[0] === 'src/Button.tsx' && settled.to === PO, 'a pass settles the gauntlet done to the requester with the last artifact');
  check(/Reply from the office to your request/.test(lastPrompt(w, PO)) || w.prompts.get(PO)!.length >= 1, 'the requester hears about it');

  const b = world();
  b.fresh.add('x');
  ids(b.room.post(owner('po', 'loop forever')));
  const lg = posted(b.room.requestGauntlet(PO, { piece: 'hard piece', bar: ['perfect'], builder: 'Ana', critic: 'Bruno', maxRounds: 2 }));
  for (let round = 1; round <= 2; round++) {
    answer(b, ANA, { outcome: 'done', text: 'try', artifact: ['x'] });
    answer(b, BRUNO, { outcome: 'done', text: 'no', verdict: { pass: false, findings: [`gap ${round}`] } });
  }
  const blocked = replyTo(b, lg.id);
  check(blocked?.outcome === 'blocked' && /gap 2/.test(blocked.text), 'maxRounds reached settles blocked with the last findings');
  check(b.prompts.get(ANA)!.length === 2, 'no third round starts');

  const c = world();
  ids(c.room.post(owner('po', 'x')));
  const cg = posted(c.room.requestGauntlet(PO, { piece: 'p', bar: ['b'], builder: 'Ana', critic: 'Bruno' }));
  c.room.turnEnded(ANA, 'crashed', false);
  check(replyTo(c, cg.id)?.outcome === 'failed', 'a builder that fails settles the gauntlet failed');
}

console.log('\n# done means done');
{
  const w = world();
  w.setDirty([]);
  const r = ids(w.room.post(owner('ana', 'build the parser')));
  const rid = requestIn(lastPrompt(w, ANA));
  const bare = w.room.reply(ANA, rid, { outcome: 'done', text: 'parser built' });
  check(!bare.ok && bare.reason === 'no_artifacts' && life(w, r) === 'delivered', 'a done reply to a work request with no artifacts is refused and the request stays open');
  w.stale.add('docs/old.md');
  const old = w.room.reply(ANA, rid, { outcome: 'done', text: 'parser built', artifact: ['docs/old.md'] });
  check(!old.ok && old.reason === 'artifact_unchanged' && life(w, r) === 'delivered', 'an artifact that did not change since the request is refused');
  const ghost = w.room.reply(ANA, rid, { outcome: 'done', text: 'parser built', artifact: ['src/ghost.ts'] });
  check(!ghost.ok && ghost.reason === 'artifact_missing', 'an artifact that does not exist is refused');
  const mixed = w.room.reply(ANA, rid, { outcome: 'done', text: 'parser built', artifact: ['src/parser.ts', 'docs/old.md'] });
  check(!mixed.ok, 'one bad ref among good ones refuses the reply');
  w.fresh.add('src/parser.ts');
  check(w.room.reply(ANA, rid, { outcome: 'done', text: 'parser built', artifact: ['src/parser.ts'] }).ok && replyTo(w, r)?.outcome === 'done' && replyTo(w, r)?.artifact?.[0] === 'src/parser.ts', 'a done reply with a changed file is accepted and carries it');

  const blk = world();
  const b1 = ids(blk.room.post(owner('ana', 'try it')));
  check(blk.room.reply(ANA, requestIn(lastPrompt(blk, ANA)), { outcome: 'blocked', text: 'no access' }).ok && replyTo(blk, b1)?.outcome === 'blocked', 'blocked and failed replies need no artifacts');

  const why = world();
  const wb = ids(why.room.post(ask(PO, 'ana', 'write the README')));
  const blocker = { why: 'Two layouts fit.', question: 'Short or long README?', next: 'I write the one you pick.' };
  check(why.room.reply(ANA, requestIn(lastPrompt(why, ANA)), { outcome: 'blocked', text: 'stuck on the layout', blocker }).ok && JSON.stringify(replyTo(why, wb)?.blocker) === JSON.stringify(blocker), 'a blocked reply keeps its why, question and next step');
  const toPo = lastPrompt(why, PO);
  check(/Why it stopped: Two layouts fit\.\nQuestion: Short or long README\?\nProposed next step: I write the one you pick\./.test(toPo), 'and whoever asked reads all three under the reply', toPo);
  const plain = world();
  const p1 = ids(plain.room.post(owner('ana', 'try it')));
  plain.setDirty(['notes.md']);
  plain.fresh.add('notes.md');
  plain.room.reply(ANA, requestIn(lastPrompt(plain, ANA)), { outcome: 'done', text: 'done', artifact: ['notes.md'], blocker });
  check(replyTo(plain, p1)?.outcome === 'done' && replyTo(plain, p1)?.blocker === undefined, 'a done reply drops a breakdown it should not have');

  const help = world();
  const h1 = ids(help.room.post({ from: 'owner', to: 'ana', blockId: B1, body: { kind: 'request', intent: 'help', text: 'where is the router?' } }));
  check(help.room.reply(ANA, requestIn(lastPrompt(help, ANA)), { outcome: 'done', text: 'src/router.ts' }).ok && replyTo(help, h1)?.outcome === 'done', 'a help request is answered without artifacts');

  const asked = world();
  asked.setDirty([]);
  const ownerAsk = (text: string) => ({ from: 'owner' as const, to: 'ana', blockId: B1, body: { kind: 'request' as const, intent: 'help' as const, text } });
  const k1 = ids(asked.room.post(ownerAsk('which file handles login?')));
  check(!/must name the files/.test(lastPrompt(asked, ANA)) && /, help\]/.test(lastPrompt(asked, ANA)), 'an owner question reaches the employee as help, with no demand for files');
  asked.room.turnEnded(ANA, 'src/login.ts handles it.', true);
  check(replyTo(asked, k1)?.outcome === 'done' && replyTo(asked, k1)?.text === 'src/login.ts handles it.' && replyTo(asked, k1)?.auto === true && !replyTo(asked, k1)?.artifact, 'an owner question that changed no file settles done with the answer when the turn ends');
  const k2 = ids(asked.room.post(ownerAsk('and the logout?')));
  check(asked.room.reply(ANA, requestIn(lastPrompt(asked, ANA)), { outcome: 'done', text: 'src/logout.ts' }).ok && replyTo(asked, k2)?.outcome === 'done' && replyTo(asked, k2)?.text === 'src/logout.ts', 'and the employee can answer it with a done reply that names no file');
  const orderNoFiles = world();
  orderNoFiles.setDirty([]);
  const k3 = ids(orderNoFiles.room.post(owner('ana', 'add a logout button')));
  check(/must name the files/.test(lastPrompt(orderNoFiles, ANA)), 'an owner work order still tells the employee that a done reply must name files');
  orderNoFiles.room.turnEnded(ANA, 'You can add it in src/ui.ts.', true);
  check(replyTo(orderNoFiles, k3)?.outcome === 'blocked', 'and an owner work order whose turn changed no file still settles blocked');

  const wait = world();
  wait.fresh.add('a.txt');
  const w1 = ids(wait.room.post(owner('ana', 'write it')));
  const waiting = wait.room.reply(ANA, requestIn(lastPrompt(wait, ANA)), { outcome: 'done', text: "Waiting for Eli's gauntlet, I'll check back", artifact: ['a.txt'] });
  check(wait.room.reply(ANA, requestIn(lastPrompt(wait, ANA)), { outcome: 'done', text: "I'm standing by until Eli ships it.", artifact: ['a.txt'] }).ok === false, 'standing by is waiting too');
  check(!waiting.ok && waiting.reason === 'still_waiting' && life(wait, w1) === 'delivered', 'a done reply whose text says it is waiting is refused even with artifacts');

  const auto = world();
  auto.setDirty([]);
  const a1 = ids(auto.room.post(owner('po', 'root')));
  const child = ids(auto.room.post(ask(PO, 'Ana', 'write the lexer')));
  auto.room.turnEnded(PO, 'split', true);
  auto.room.turnEnded(ANA, 'Lexer is written.', true);
  const blocked = replyTo(auto, child);
  check(blocked?.outcome === 'blocked' && blocked.auto === true && blocked.text === 'Lexer is written.' && !blocked.artifact, 'a turn that ends on a work request with nothing on disk settles blocked with the final text');
  check(/Reply from Ana to your request/.test(lastPrompt(auto, PO)) && /blocked/.test(lastPrompt(auto, PO)), 'the requester is woken with the blocked reply');
  check(life(auto, a1) === 'delivered', 'the parent is not settled by a blocked child');

  const real = world();
  real.setDirty(['src/lexer.ts', 'src/lexer.test.ts']);
  const c = ids(real.room.post(owner('ana', 'write the lexer')));
  real.room.turnEnded(ANA, 'Lexer is written.', true);
  check(replyTo(real, c)?.outcome === 'done' && replyTo(real, c)?.artifact?.join() === 'src/lexer.ts,src/lexer.test.ts', 'a turn that ends after real changes settles done with those files as artifacts');

  const talk = world();
  talk.setDirty(['x']);
  const t = ids(talk.room.post(owner('ana', 'write it')));
  talk.room.turnEnded(ANA, "Waiting for Morgan to finish, will check back.", true);
  check(replyTo(talk, t)?.outcome === 'blocked', 'an auto reply whose text says it is waiting settles blocked even with changes');

  const rev = world();
  rev.setDirty([]);
  const g = posted(rev.room.requestGauntlet(PO, { piece: 'p', bar: ['b'], builder: 'Ana', critic: 'Bruno' })).id;
  rev.fresh.add('p.txt');
  answer(rev, ANA, { outcome: 'done', text: 'built', artifact: ['p.txt'] });
  rev.room.turnEnded(BRUNO, '**Verdict: PASS**', true);
  check(replyTo(rev, g)?.outcome === 'done' && replyTo(rev, g)?.artifact?.[0] === 'p.txt', 'review requests still settle with verdicts and need no artifacts of their own');

  const po = world();
  po.fresh.add('api.ts');
  po.fresh.add('ui.tsx');
  const root = ids(po.room.post(owner('po', 'ship csv export')));
  ids(po.room.post(ask(PO, 'Ana', 'backend')));
  ids(po.room.post(ask(PO, 'Bruno', 'ui')));
  po.room.turnEnded(PO, 'split', true);
  po.room.reply(ANA, requestIn(lastPrompt(po, ANA)), { outcome: 'done', text: 'api done', artifact: ['api.ts'] });
  po.room.turnEnded(ANA, 'api done', true);
  po.room.reply(BRUNO, requestIn(lastPrompt(po, BRUNO)), { outcome: 'done', text: 'ui done', artifact: ['ui.tsx'] });
  po.room.turnEnded(BRUNO, 'ui done', true);
  po.setDirty([]);
  po.room.turnEnded(PO, 'CSV export shipped', true);
  const final = replyTo(po, root);
  check(final?.outcome === 'done' && final.artifact?.join() === 'api.ts,ui.tsx', 'the PO final reply carries the union of its children artifacts, no files of its own needed');
}

console.log('\n# a piece that came back blocked (G2)');
{
  // A README piece sent while the code it documents did not exist yet: the writer says blocked. Replying blocked to the owner
  // over it ended three real runs with the README undone.
  const w = world();
  const root = ids(w.room.post(owner('po', 'ship slugify and document it')));
  const code = ids(w.room.post(ask(PO, 'Ana', 'code')));
  const docs = ids(w.room.post(ask(PO, 'Bruno', 'readme')));
  w.room.turnEnded(PO, 'split', true);
  w.room.turnEnded(ANA, 'code done', true);
  w.room.reply(BRUNO, docs, { outcome: 'blocked', text: 'slug.js does not exist yet' });
  w.room.turnEnded(BRUNO, 'slug.js does not exist yet', true);
  check(replyTo(w, code)?.outcome === 'done' && replyTo(w, docs)?.outcome === 'blocked', 'setup: code done, readme blocked');
  const done = w.room.reply(PO, root, { outcome: 'done', text: 'all shipped', artifact: ['out.txt'] });
  check(!done.ok && done.reason === 'piece_blocked' && /Bruno/.test(done.detail ?? ''), 'a done reply is refused over a piece that came back blocked, naming who');
  const giveUp = w.room.reply(PO, root, { outcome: 'blocked', text: 'readme blocked' });
  check(!giveUp.ok && giveUp.reason === 'piece_blocked' && /new request to the same person/.test(giveUp.detail ?? ''), 'a blocked reply is refused until the piece was sent again once');
  const again = w.room.post(ask(PO, 'Bruno', 'readme again, slug.js exists now'));
  check(again.ok, 'sending the blocked piece to the same person again is allowed even though they hold a piece');
  const midway = w.room.reply(PO, root, { outcome: 'done', text: 'all shipped' });
  check(!midway.ok && midway.reason === 'open_children', 'the retry is an open request like any other');
  w.room.turnEnded(BRUNO, 'readme done', true);
  const finished = w.room.reply(PO, root, { outcome: 'done', text: 'all shipped' });
  check(finished.ok && replyTo(w, root)?.outcome === 'done' && (replyTo(w, root)?.artifact?.length ?? 0) > 0, 'once the retry is done the PO settles done and its reply carries its children artifacts');

  const stuck = world();
  const sroot = ids(stuck.room.post(owner('po', 'ship it')));
  ids(stuck.room.post(ask(PO, 'Ana', 'code')));
  stuck.room.turnEnded(PO, 'split', true);
  stuck.room.reply(ANA, requestIn(lastPrompt(stuck, ANA)), { outcome: 'blocked', text: 'cannot' });
  stuck.room.turnEnded(ANA, 'cannot', true);
  ids(stuck.room.post(ask(PO, 'Ana', 'code again')));
  stuck.room.reply(ANA, requestIn(lastPrompt(stuck, ANA)), { outcome: 'blocked', text: 'still cannot' });
  check(stuck.room.reply(PO, sroot, { outcome: 'blocked', text: 'Ana could not do it twice' }).ok, 'after the piece was sent again once and came back blocked, the PO may reply blocked');
  const autoW = world();
  const aroot = ids(autoW.room.post(owner('po', 'ship it')));
  ids(autoW.room.post(ask(PO, 'Ana', 'code')));
  autoW.room.turnEnded(PO, 'split', true);
  autoW.room.reply(ANA, requestIn(lastPrompt(autoW, ANA)), { outcome: 'blocked', text: 'cannot' });
  autoW.room.turnEnded(PO, 'all good', true);
  check(replyTo(autoW, aroot)?.outcome === 'blocked', 'a turn that ends with a blocked piece unretried settles blocked, never done');
}

console.log('\n# stale waiting text (G2)');
{
  const w = world();
  const root = ids(w.room.post(owner('po', 'ship it')));
  ids(w.room.post(ask(PO, 'Ana', 'code')));
  w.room.turnEnded(PO, 'split', true);
  w.room.turnEnded(ANA, 'code done', true);
  const stale = w.room.reply(PO, root, { outcome: 'blocked', text: 'Waiting for Ana to finish the code.' });
  check(!stale.ok && stale.reason === 'still_waiting', 'a blocked reply that says it is waiting is refused when every request it made is settled');
  w.fresh.add('out.txt');
  const stillDone = w.room.reply(PO, root, { outcome: 'done', text: 'Ana is done, standing by for nothing else.', artifact: ['out.txt'] });
  check(!stillDone.ok && stillDone.reason === 'still_waiting', 'a done reply that says it is waiting is refused even when every request it made is settled (G2: PO closed with "Waiting for Alex")');
  check(w.room.reply(PO, root, { outcome: 'done', text: 'Ana is done and checked.', artifact: ['out.txt'] }).ok && replyTo(w, root)?.outcome === 'done', 'the same reply without waiting words settles done');
  const lone = world();
  const lroot = ids(lone.room.post(owner('ana', 'task')));
  lone.room.turnEnded(ANA, 'Waiting for the build to finish.', true);
  check(replyTo(lone, lroot)?.outcome === 'blocked', 'a worker with no children whose final text says waiting still settles blocked');
}

console.log('\n# pieces go to different people (G2)');
{
  const w = world();
  ids(w.room.post(owner('po', 'ship it')));
  ids(w.room.post(ask(PO, 'Ana', 'code')));
  const second = w.room.post(ask(PO, 'Ana', 'docs'));
  check(!second.ok && second.reason === 'bad_request' && /Bruno and Cleo have none/.test(second.detail) && /Send this one to Bruno/.test(second.detail), 'a second piece for the same person is refused while teammates have none, naming them');
  check(w.room.post(ask(PO, 'Bruno', 'docs')).ok, 'the same piece to a teammate with none goes through');
  const help = world();
  ids(help.room.post(owner('po', 'ship it')));
  ids(help.room.post(ask(PO, 'Ana', 'code')));
  check(help.room.post({ from: PO, to: 'Ana', body: { kind: 'request', text: 'quick question', intent: 'help' } }).ok, 'a help question is not a piece');
  const all = world();
  ids(all.room.post(owner('po', 'ship it')));
  ids(all.room.post(ask(PO, 'Ana', 'code')));
  ids(all.room.post(ask(PO, 'Bruno', 'docs')));
  ids(all.room.post(ask(PO, 'Cleo', 'tests')));
  check(all.room.post(ask(PO, 'Ana', 'more')).ok, 'when everyone holds a piece a second one queues on a teammate as before');
  const busy = world();
  ids(busy.room.post(owner('po', 'ship it')));
  ids(busy.room.post(ask(PO, 'Ana', 'code')));
  busy.room.post(owner('bruno', 'something else'));
  busy.room.post(owner('cleo', 'something else too'));
  check(busy.room.post(ask(PO, 'Ana', 'docs')).ok, 'teammates already busy with other work do not count as free');
}

console.log('\n# hiring');
{
  const w = world();
  ids(w.room.post(owner('po', 'need more hands')));
  const first = w.room.hire(PO, { key: 'k1', name: 'Dora' });
  const again = w.room.hire(PO, { key: 'k1', name: 'Dora' });
  check(first.ok && again.ok && first.id === again.id && w.hires.length === 1, 'hireTeammate is idempotent on its key');
  const clash = w.room.hire(PO, { key: 'k2', name: 'ana' });
  check(!clash.ok, 'a name already in the block is refused');
  check(!w.room.hire(ANA, { key: 'k3' }).ok, 'only the orchestrator hires');
  const hired = [...w.room.state.messages.values()].find((m) => m.kind === 'event' && m.event === 'hired');
  check(hired?.kind === 'event' && hired.rootId === w.room.state.order[0], 'the hire shows up in the thread of the request that caused it');
}

console.log('\n# ledger: replay and restart');
{
  const w = world();
  const root = ids(w.room.post(owner('po', 'ship')));
  const c1 = ids(w.room.post(ask(PO, 'ana', 'a')));
  w.room.post(owner('ana', 'queued behind', 'say'));
  w.room.turnEnded(PO, 'split', true);
  w.room.turnEnded(ANA, 'a done', true);
  w.room.requestGauntlet(PO, { piece: 'g', bar: ['b'], builder: 'Bruno', critic: 'Cleo' });
  const entries = [...w.persisted];

  const once = entries.reduce(fold, emptyMail());
  const twice = entries.reduce(fold, entries.reduce(fold, emptyMail()));
  check(dump(once) === dump(twice), 'folding the same ledger twice gives the same state as once');
  check(dump(once) === dump(w.room.state), 'a fold of the persisted entries equals the live state');
  check(dump(recover(recover(structuredClone(once) as MailState))) === dump(recover(structuredClone(once) as MailState)), 'recover is idempotent');

  const recoverOnce = [...entries, { t: 'recover', at: 0 } as LedgerEntry];
  const a = recoverOnce.reduce(fold, emptyMail());
  const b = [...recoverOnce, ...recoverOnce].reduce(fold, emptyMail());
  const c = recoverOnce.reduce(fold, recoverOnce.reduce(fold, emptyMail()));
  check(dump(a) === dump(c) && dump(a) === dump(b), 'replaying a ledger with a recover entry twice is stable');
  check(c1 !== root, 'ids are distinct');

  const crash = world();
  const r = ids(crash.room.post(owner('ana', 'long job')));
  check(crash.prompts.get(ANA)!.length === 1, 'delivered once before the crash');
  const survived = [...crash.persisted];
  const reborn = world(survived);
  reborn.room.recoverOnStart();
  check(reborn.prompts.get(ANA)!.length === 1 && /before a restart/.test(lastPrompt(reborn, ANA)) && /long job/.test(lastPrompt(reborn, ANA)), 'restart mid-delivery redelivers once, flagged as a possible repeat');
  reborn.room.turnEnded(ANA, 'finished after restart', true);
  check(replyTo(reborn, r)?.text === 'finished after restart', 'the redelivered request settles exactly once');
  const third = world([...reborn.persisted]);
  third.room.recoverOnStart();
  check((third.prompts.get(ANA)?.length ?? 0) === 0, 'a settled request is never redelivered');
  const crashedTwice = world([...crash.persisted, ...reborn.persisted.slice(crash.persisted.length, crash.persisted.length + 2)].filter((e) => e.t !== 'turn_end'));
  crashedTwice.room.recoverOnStart();
  check((crashedTwice.prompts.get(ANA)?.length ?? 0) === 1, 'a second crash before settling redelivers once more, still one open request');
}

{
  console.log('\n# acknowledgement');
  const calls: string[] = [];
  let finishAck!: (text: string | undefined) => void;
  let emit!: (delta: string) => void;
  const ack = (to: string, request: { id: string }, onDelta: (d: string) => void) => {
    calls.push(`${to}:${request.id}`);
    emit = onDelta;
    return new Promise<string | undefined>((resolve) => (finishAck = resolve));
  };
  const w = world([], ack);
  const r = ids(w.room.post(owner('ana', 'write the slugify function')));
  check(calls.length === 1 && calls[0] === `ana:${r}`, 'an owner request to an employee is acknowledged once');
  check(/already being said to the boss/.test(lastPrompt(w, ANA)) && /write the slugify function/.test(lastPrompt(w, ANA)), 'the real turn is told the boss already heard from them');
  emit('On it, ');
  w.room.streamed(ANA, 'the real turn writes', false);
  emit('starting now.');
  check(w.streams.filter((s) => !s.done).map((s) => s.delta).join('') === 'On it, starting now.', 'the acknowledgement streams alone while it is being written');
  finishAck('On it, starting now.');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const said = [...w.room.state.messages.values()].filter((m) => m.kind === 'say' && m.from === ANA);
  check(said.length === 1 && said[0]!.kind === 'say' && said[0]!.text === 'On it, starting now.' && said[0]!.parentId === r, 'it lands as one message from them to the owner, under the request');
  check(w.streams.at(-1)?.done === true, 'and its stream is closed');
  w.room.streamed(ANA, 'later bubble', false);
  check(w.streams.at(-1)?.delta === 'later bubble', 'once it is over the turn streams again');

  const again = world([...w.persisted], ack);
  again.room.recoverOnStart();
  check(calls.length === 1 && /already being said/.test(lastPrompt(again, ANA)), 'a redelivery does not acknowledge twice and still carries the note');
  const sayCount = [...again.room.state.messages.values()].filter((m) => m.kind === 'say' && m.from === ANA).length;
  check(sayCount === 1, 'and no second acknowledgement lands');

  const quiet = world([], ack);
  quiet.room.post({ from: 'owner', to: 'bruno', blockId: B1, body: { kind: 'say', text: 'hello' } });
  quiet.room.post(ask(PO, 'cleo', 'build the thing'));
  check(calls.length === 1, 'a plain message and a request from a teammate are not acknowledged');
  check(!/already being said/.test(lastPrompt(quiet, ANA)), 'and their turns carry no note');

  const failed = world([], () => Promise.resolve(undefined));
  const f = ids(failed.room.post(owner('ana', 'try')));
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(![...failed.room.state.messages.values()].some((m) => m.kind === 'say') && failed.streams.at(-1)?.done === true && life(failed, f) === 'delivered', 'a failed acknowledgement says nothing, closes its stream and leaves the turn alone');

  const off = world([], () => undefined);
  ids(off.room.post(owner('ana', 'try')));
  check(!/already being said/.test(lastPrompt(off, ANA)), 'when acknowledging is off the turn is not told to skip replying first');

  const stale = world();
  stale.room.closeStream(ANA);
  check(stale.streams.at(-1)?.who === ANA && stale.streams.at(-1)?.done === true, 'closing a stream emits the closing event the owner screen waits for');
}

finish();
