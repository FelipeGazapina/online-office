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
  check(early.room.reply(PO, earlyRoot, { outcome: 'blocked', text: 'stuck' }).ok && replyTo(early, earlyRoot)?.outcome === 'blocked', 'a blocked reply is still allowed with open children');
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
  const q = ids(w.room.post(ask(BRUNO, 'ana', 'does the route take ?from=?')));
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

finish();
