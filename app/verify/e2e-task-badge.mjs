// The task number above the heads of the people on a task, on the built app with fake employees and seeded tasks, no model.
// Run: pnpm build && node verify/cdp.mjs verify/e2e-task-badge.mjs
import { assert, scratch } from './lib.mjs';

const { dataDir } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3' };

const now = Date.now();
const piece = (n) => ({ requestId: `req-${n}`, title: `Piece ${n}` });
const person = (employeeId, state) =>
  state === 'blocked'
    ? { employeeId, state, question: { id: `q-${employeeId}`, asker: employeeId, text: 'Which database?', askedAt: now } }
    : state === 'done'
      ? { employeeId, state, piece: piece(employeeId), at: now }
      : state === 'queued'
        ? { employeeId, state, piece: piece(employeeId), since: now }
        : { employeeId, state, piece: piece(employeeId), since: now, on: [] };
const task = (number, title) => ({
  id: `task-${number}`,
  number,
  boardId: 'board-fake',
  title,
  origin: { kind: 'manual' },
  stage: 'doing',
  assignees: [],
  runs: [],
  createdAt: now - (10 - number) * 60_000,
  updatedAt: now,
});
const TASKS = [task(7, 'Ship the CSV export'), task(8, 'Pick the database'), task(9, 'Write the changelog')];
const live = (people) => ({ people, questions: [], open: people.length });

async function seed(s, live7, live8, live9) {
  await s.eval(`__office.seedTasks(${JSON.stringify(TASKS)}, ${JSON.stringify({ 'task-7': live(live7), 'task-8': live(live8), 'task-9': live(live9) })})`);
  await s.sleep(400);
}

// The pills in an employee's label, with the color each one is drawn in.
const pills = (s, id) =>
  s.eval(`[...document.querySelectorAll('[data-hud-resize-target="employee-label-${id}"] .task-no')].map((p) => ({
    text: p.innerText.trim(),
    no: p.dataset.taskNo,
    bg: getComputedStyle(p).backgroundColor,
  }))`);

const one = (list, text) => list.length === 1 && list[0].text === text && list[0].no === text.slice(1);

export default async (s) => {
  await s.waitFor('!!__office.store.getState().company');
  await s.resize(1440, 900);
  // Main never hears about fake people, so nothing it sends replaces them.
  await s.eval(`__office.tapSend(() => {})`);
  await s.eval('__office.injectFake(5)');
  for (let i = 0; i < 120; i++) {
    const { avatars } = await s.eval('__office.state()');
    if (avatars.length === 5 && avatars.every((a) => a.seated)) break;
    await s.eval('__office.step(1)');
  }
  await s.waitFor(`document.querySelectorAll('[data-hud-resize-target^="employee-label-fake-emp-"]').length === 5`, 10000);

  await seed(
    s,
    [person('fake-emp-1', 'working'), person('fake-emp-2', 'queued')],
    [person('fake-emp-3', 'blocked')],
    [person('fake-emp-4', 'done')],
  );
  const [p0, p1, p2, p3, p4] = await Promise.all([0, 1, 2, 3, 4].map((n) => pills(s, `fake-emp-${n}`)));
  assert(one(p1, '#7'), `Fake 1, working on task #7, shows one #7 pill (${JSON.stringify(p1)})`);
  assert(one(p2, '#7'), `Fake 2, queued on task #7, shows one #7 pill (${JSON.stringify(p2)})`);
  assert(p1[0].bg === p2[0].bg, `both #7 pills are drawn in the same color (${p1[0].bg})`);
  assert(one(p3, '#8'), `Fake 3, blocked on task #8, shows one #8 pill (${JSON.stringify(p3)})`);
  assert(p3[0].bg !== p1[0].bg, `the #8 pill has a different color from #7 (${p3[0].bg} vs ${p1[0].bg})`);
  assert(p4.length === 0, `Fake 4, done on task #9, shows no pill (${JSON.stringify(p4)})`);
  assert(p0.length === 0, `Fake 0, on no task, shows no pill (${JSON.stringify(p0)})`);
  await s.shot('task-badge-pair');

  await seed(
    s,
    [person('fake-emp-1', 'working'), person('fake-emp-2', 'done'), person('fake-emp-4', 'working')],
    [person('fake-emp-3', 'blocked')],
    [person('fake-emp-4', 'done')],
  );
  const [q1, q2, q4] = await Promise.all([1, 2, 4].map((n) => pills(s, `fake-emp-${n}`)));
  assert(q2.length === 0, `once Fake 2 is done on #7 its pill goes away (${JSON.stringify(q2)})`);
  assert(one(q1, '#7'), `Fake 1 still shows #7 (${JSON.stringify(q1)})`);
  assert(one(q4, '#7'), `Fake 4, now working on #7, shows #7 and nothing for the task it finished (${JSON.stringify(q4)})`);
  assert(q4[0].bg === q1[0].bg, `and its pill matches Fake 1's color (${q4[0].bg})`);
  await s.shot('task-badge-updated');
};
