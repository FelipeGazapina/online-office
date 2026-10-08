// No model, no Electron. The task numbers above people's heads: which tasks count for a person, and their colours.
// Run: node --no-warnings verify/badge-check.mjs
const { taskHue, taskNumbersOf } = await import('../src/renderer/src/taskBadge.ts');
const { check, finish } = await import('./check.ts');

const task = (id, number) => ({ id, number, boardId: 'q1', title: id, origin: { kind: 'manual' }, stage: 'doing', assignees: [], runs: [], createdAt: number, updatedAt: number });
const piece = { root: 'r1', id: 'p1', title: 'a piece' };
const person = (employeeId, state) => {
  if (state === 'blocked') return { employeeId, state, question: { id: 'q', asker: employeeId, text: 'which db?', how: 'ask' } };
  if (state === 'done') return { employeeId, state, piece, at: 1 };
  if (state === 'stopped') return { employeeId, state, outcome: 'failed', piece, at: 1 };
  if (state === 'idle') return { employeeId, state };
  return { employeeId, state, piece, since: 1, on: [] };
};
const live = (...people) => ({ people, questions: [], open: people.length });

for (const state of ['working', 'waiting', 'queued', 'blocked']) {
  check(taskNumbersOf('ann', [task('t7', 7)], { t7: live(person('ann', state)) }).join() === '7', `a person ${state} on a task shows its number`);
}
for (const state of ['done', 'stopped', 'idle']) {
  check(taskNumbersOf('ann', [task('t7', 7)], { t7: live(person('ann', state)) }).length === 0, `a person ${state} on a task shows nothing`);
}

// Cal got a piece of #7 through the PO and is not an assignee. The live people of the task carry them all the same.
const assigned = { ...task('t7', 7), assignees: ['ann'] };
check(taskNumbersOf('cal', [assigned], { t7: live(person('ann', 'working'), person('cal', 'working')) }).join() === '7', 'a teammate working on a piece of the task shows its number without being an assignee');

const team = { t7: live(person('ann', 'working'), person('bob', 'waiting')) };
const tasks = [task('t7', 7)];
check(taskNumbersOf('ann', tasks, team).join() === '7' && taskNumbersOf('bob', tasks, team).join() === '7', 'two people on one task show the same number');

const many = [task('t9', 9), task('t2', 2), task('t5', 5)];
const busy = { t9: live(person('ann', 'queued')), t2: live(person('ann', 'working')), t5: live(person('ann', 'blocked'), person('ann', 'working')) };
const numbers = taskNumbersOf('ann', many, busy);
check(numbers.join() === '2,5,9', 'several tasks come in ascending order, each once', numbers.join());

check(taskNumbersOf('ann', [], {}).length === 0, 'no tasks gives []');
check(taskNumbersOf('ann', [task('t1', 1)], {}).length === 0, 'a task nobody has worked on gives []');
check(taskNumbersOf('zed', tasks, team).length === 0, 'someone not on any task gives []');

const hues = Array.from({ length: 8 }, (_, i) => taskHue(i + 1));
const closest = Math.min(...hues.flatMap((a, i) => hues.slice(i + 1).map((b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)))));
check(new Set(hues.map((h) => h.toFixed(3))).size === 8 && hues.every((h) => h >= 0 && h < 360), 'taskHue gives a different hue in [0, 360) to each of #1 to #8', hues.map((h) => h.toFixed(0)).join(', '));
check(closest > 20, `and no two of them are within 20 degrees (closest ${closest.toFixed(1)})`);

finish();
