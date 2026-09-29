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

let failed = false;
const check = (ok, message) => {
  console.log(`${ok ? 'ok' : 'FAIL'}: ${message}`);
  failed ||= !ok;
};

const person = (id, name) => ({ id, name, provider: 'claude-code', blockId: 'b1', desk: 0, status: { kind: 'idle' }, activity: '', hiredAt: 0 });
set({ company: { name: 'Test', level: 3, xp: 0, blocks: [], employees: [person('ann', 'Ann'), person('bob', 'Bob')] } });

const lines = (id) => get().chat[id] ?? [];
const texts = (id) => lines(id).map((l) => l.text).join(' | ');

const owned = [
  [{ type: 'interject', employeeId: 'ann', text: 'stop and rebase', style: 'now' }, 'stop and rebase'],
  [{ type: 'answer', employeeId: 'ann', questionId: 'q1', text: 'use sqlite' }, 'use sqlite'],
  [{ type: 'assign', employeeId: 'ann', task: 'write the docs' }, 'write the docs'],
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
send({ type: 'assign', employeeId: 'ann', task: 'a1' });
send({ type: 'assign', employeeId: 'bob', task: 'b1' });
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

process.exit(failed ? 1 : 0);
