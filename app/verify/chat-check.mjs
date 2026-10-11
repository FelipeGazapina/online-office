// No model, no Electron. What the owner and an employee say lands in that employee's thread, in order: the owner's words show
// at once, the mail view takes over when it carries them back, each person's thread holds only their conversation with the
// owner, history pages merge without duplicates, and what an employee says out loud is logged, capped at 200 lines.
// Run: node --no-warnings verify/chat-check.mjs
const sent = [];
globalThis.window = {
  office: {
    send(m) {
      sent.push(m);
    },
  },
};
const { get, send, set } = await import('../src/renderer/src/store.ts');
const { applyServerMessage } = await import('../src/renderer/src/office.ts');
const { mergeMessages, personThread } = await import('../src/renderer/src/hud/chat/model.ts');
const { check, finish } = await import('./check.ts');

const person = (id, name) => ({ id, name, provider: 'claude-code', blockId: 'b1', seat: null, status: { kind: 'idle' }, activity: '', model: 'fake', permissions: { mode: 'inherit', alwaysAllow: [] }, subagents: [], hiredAt: 0 });
// The office's quiet room: an employee's words are logged without being read aloud, which needs no speech engine.
set({ meetingDoor: 'closed', company: { name: 'Test', level: 3, xp: 0, blocks: [], employees: [person('ann', 'Ann'), person('bob', 'Bob')] } });

let seq = 0;
const say = (from, to, text, at, key) => ({ id: `m${++seq}`, rootId: `m${seq}`, parentId: null, from, to, at, hops: 0, kind: 'say', text, wake: true, urgency: 'queue', ...(key ? { key } : {}) });
const view = (tail) => ({ seq: ++seq, actors: {}, open: [], tail });
const thread = (who) => personThread(mergeMessages(get().mail.tail, ...Object.values(get().history).map((h) => h.messages)), who).map((i) => i.m.text);

console.log('# the owner\'s words show at once');
const owned = [
  { type: 'post', to: 'ann', clientId: 'c1', as: 'say', text: 'stop and rebase', urgency: 'now' },
  { type: 'post', to: 'ann', clientId: 'c2', as: 'request', text: 'write the docs' },
];
for (const message of owned) {
  send(message);
  const line = get().pending.at(-1);
  check(line?.clientId === message.clientId && line.to === 'ann' && line.text === message.text && line.as === message.as, `a ${message.as} post shows in Ann's thread before main answers`);
  check(sent.at(-1) === message, `a ${message.as} post is forwarded unchanged`);
}
const answer = { type: 'answer', employeeId: 'ann', questionId: 'q1', text: 'use sqlite' };
send(answer);
check(get().pending.length === 2 && sent.at(-1) === answer, 'an answer settles a card: it is forwarded unchanged and adds no chat line');
const hire = { type: 'hire', provider: 'claude-code', blockId: 'b1' };
send(hire);
check(get().pending.length === 2 && sent.at(-1) === hire, 'hire adds nothing to any thread and is forwarded unchanged');

console.log('\n# the mail view takes over');
const t0 = Date.now() - 60_000;
applyServerMessage({ type: 'mail', view: view([say('owner', 'ann', 'stop and rebase', t0, 'c1')]) });
check(get().pending.map((p) => p.clientId).join() === 'c2', 'a post the mail view carries back under its client id stops being pending, and the other stays');
check(thread('ann').join(' | ') === 'stop and rebase', 'and it is in Ann\'s thread once, from the mailroom');

console.log('\n# one thread per person, in order');
set({ pending: [], history: {} });
const tail = [
  say('owner', 'ann', 'a1', t0 + 1), say('owner', 'bob', 'b1', t0 + 2), say('ann', 'owner', 'a2', t0 + 3),
  say('bob', 'owner', 'b2', t0 + 4), say('ann', 'bob', 'peer', t0 + 5), say('owner', 'ann', 'a3', t0 + 6),
];
applyServerMessage({ type: 'mail', view: view(tail) });
check(thread('ann').join(' | ') === 'a1 | a2 | a3', 'Ann\'s thread keeps arrival order, newest last');
check(thread('bob').join(' | ') === 'b1 | b2', 'Bob keeps a separate thread');
check(!thread('ann').includes('peer') && !thread('bob').includes('peer'), 'what two teammates say to each other is not in their thread with the owner');
const ats = personThread(get().mail.tail, 'ann').map((i) => i.m.at);
check(ats.every((at, i) => i === 0 || ats[i - 1] <= at), 'timestamps never go backwards');

console.log('\n# history pages');
const older = [say('owner', 'ann', 'a0', t0 - 10), say('ann', 'owner', 'a0 reply', t0 - 5)];
applyServerMessage({ type: 'history', convo: 'dm:ann', messages: older, hasMore: true });
applyServerMessage({ type: 'history', convo: 'dm:ann', messages: older, hasMore: false });
check(get().history['dm:ann'].messages.length === 2 && get().history['dm:ann'].hasMore === false, 'the same page twice is kept once, and the last answer says whether more remain');
check(thread('ann').join(' | ') === 'a0 | a0 reply | a1 | a2 | a3', 'an older page goes before the live tail');
applyServerMessage({ type: 'history', convo: 'dm:ann', messages: [tail[0]], hasMore: false });
check(thread('ann').filter((t) => t === 'a1').length === 1, 'a message in both the tail and a page shows once');

console.log('\n# what an employee says out loud');
applyServerMessage({ type: 'said', employeeId: 'bob', text: 'the build is green' });
check(get().logs.bob?.at(-1)?.line === 'says: the build is green', 'a said message lands in that employee\'s log');
check(!get().logs.ann, 'and in nobody else\'s');
for (let i = 1; i <= 250; i++) applyServerMessage({ type: 'said', employeeId: 'ann', text: `line ${i}` });
const ann = get().logs.ann;
check(ann.length === 200, 'after 250 lines only 200 remain');
check(ann[0].line === 'says: line 51' && ann.at(-1).line === 'says: line 250', 'the oldest kept line is line 51 and the newest is line 250');

finish();
