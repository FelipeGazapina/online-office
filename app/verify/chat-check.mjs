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
const { check, finish } = await import('./check.ts');

const person = (id, name) => ({ id, name, provider: 'claude-code', blockId: 'b1', seat: null, status: { kind: 'idle' }, activity: '', hiredAt: 0 });
set({ company: { name: 'Test', level: 3, xp: 0, blocks: [], employees: [person('ann', 'Ann'), person('bob', 'Bob')] } });

const lines = (id) => get().chat[id] ?? [];
const texts = (id) => lines(id).map((l) => l.text).join(' | ');

const owned = [
  [{ type: 'post', to: 'ann', clientId: 'c1', as: 'say', text: 'stop and rebase', urgency: 'now' }, 'stop and rebase'],
  [{ type: 'answer', employeeId: 'ann', questionId: 'q1', text: 'use sqlite' }, 'use sqlite'],
  [{ type: 'post', to: 'ann', clientId: 'c2', as: 'request', text: 'write the docs' }, 'write the docs'],
];
for (const [message, words] of owned) {
  send(message);
  const line = lines('ann').at(-1);
  check(line?.from === 'owner' && line.text === words, `${message.type} adds the owner's words to that employee's transcript`);
  check(sent.at(-1) === message, `${message.type} is forwarded unchanged`);
}

const before = get().chat;
const hire = { type: 'hire', provider: 'claude-code', blockId: 'b1' };
send(hire);
check(get().chat === before, 'hire adds nothing to any transcript');
check(sent.at(-1) === hire, 'hire is forwarded unchanged');

applyServerMessage({ type: 'said', employeeId: 'bob', text: 'the build is green' });
check(lines('bob').at(-1)?.from === 'employee' && lines('bob').at(-1).text === 'the build is green', 'a said message adds an employee line');

set({ chat: {} });
send({ type: 'post', to: 'ann', clientId: 'c3', as: 'request', text: 'a1' });
send({ type: 'post', to: 'bob', clientId: 'c4', as: 'request', text: 'b1' });
applyServerMessage({ type: 'said', employeeId: 'ann', text: 'a2' });
applyServerMessage({ type: 'said', employeeId: 'bob', text: 'b2' });
send({ type: 'answer', employeeId: 'ann', questionId: 'q2', text: 'a3' });
check(texts('ann') === 'a1 | a2 | a3', 'lines keep arrival order, newest last');
check(texts('bob') === 'b1 | b2', 'a second employee keeps a separate transcript');
check(lines('ann').every((l, i, all) => i === 0 || all[i - 1].at <= l.at), 'timestamps never go backwards');

set({ chat: {} });
for (let i = 1; i <= 250; i++) applyServerMessage({ type: 'said', employeeId: 'ann', text: `line ${i}` });
check(lines('ann').length === 200, 'after 250 lines only 200 remain');
check(lines('ann')[0].text === 'line 51', 'the oldest kept line is line 51');
check(lines('ann').at(-1).text === 'line 250', 'the newest line is line 250');

finish();
