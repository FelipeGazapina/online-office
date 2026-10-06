// Screenshots of the task board at 1440x900 with a populated, seeded snapshot: a block with four boards, ten tasks from
// Linear, CronoSpark and by hand, and people at work. Nothing here reaches a provider: the tasks, times and people are put
// into the renderer's store, which is all the board draws from. The flows themselves are proved in e2e-board-ui.mjs.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/shot-board-ui.mjs
// OFFICE_SHOTS_DIR is where the PNGs are copied (default: the game program's shots/t2 folder). `create` is the inline composer
// with a title, a priority and an assignee set and the assignee list open.
import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };
const OUT = process.env.OFFICE_SHOTS_DIR ?? join(homedir(), '.claude/orchestrate/online-office-game/shots/t2');

// Runs in the page. Ids are made up and main never hears of them.
const seed = (blockId, now) => {
  const min = 60_000;
  const person = (id, name, role, status, hired) => ({ id, name, provider: 'claude-code', role, blockId, seat: null, status, activity: '', model: 'claude-sonnet', permissions: { mode: 'ask', alwaysAllow: [] }, subagents: [], hiredAt: hired });
  const working = (task) => ({ kind: 'working', task, startedAt: now - 5 * min });
  const employees = [
    person('e-pia', 'Pia', 'orchestrator', { kind: 'idle' }, 1),
    person('e-ana', 'Ana', 'employee', working('Migrate session storage to Redis'), 2),
    person('e-bruno', 'Bruno', 'employee', working('Fix timezone offset in the scheduler'), 3),
    person('e-cleo', 'Cleo', 'employee', { kind: 'idle' }, 4),
  ];
  const lin = (n, priority, status) => ({ kind: 'linear', externalId: `lin-${n}`, identifier: `ENG-${n}`, url: `https://linear.app/acme/issue/ENG-${n}`, priority, providerStatus: status, sourceLabel: 'Linear' });
  const cs = (n, priority, status) => ({ kind: 'cronospark', externalId: `cs-${n}`, identifier: `CS-${n}`, url: `https://app.cronospark.io/tasks/${n}`, priority, providerStatus: status, sourceLabel: 'CronoSpark' });
  let k = 0;
  const task = (boardId, title, origin, stage, extra = {}) => ({ id: `t-${++k}`, boardId, title, origin, stage, assignees: [], runs: [], createdAt: now - (60 - k) * min, updatedAt: now - (60 - k) * min, ...extra });
  const outcome = (text, ago) => ({ outcome: 'done', text, at: now - ago * min, reply: `reply-${k}` });
  const S = 'b-sprint';
  const B = 'b-bugs';
  const Q = 'b-quick';
  const tasks = [
    task(S, 'Add retry with backoff to the webhook sender', lin(412, 'High', 'Todo'), 'todo'),
    task(S, 'Export invoices as CSV from the billing page', cs(118, 'P2', 'pending'), 'todo'),
    task(S, 'Write the release notes for 2.4', { kind: 'manual' }, 'todo'),
    task(S, 'Add pagination to the order history API', cs(124, 'P3', 'pending'), 'todo'),
    task(S, 'Audit the unused feature flags', { kind: 'manual' }, 'todo'),
    task(S, 'Migrate session storage to Redis', lin(409, 'Urgent', 'In Progress'), 'doing', { assignees: ['e-ana'], runs: ['r1'] }),
    task(S, 'Fix timezone offset in the scheduler', cs(121, 'P1', 'in-progress'), 'doing', { assignees: ['e-bruno', 'e-pia'], runs: ['r2', 'r3'] }),
    task(S, 'Draft the migration plan for the new auth flow', { kind: 'manual' }, 'doing', { assignees: ['e-pia'], runs: ['r4'] }),
    task(S, 'Fix the flaky checkout test on CI', lin(417, 'High', 'In Progress'), 'doing', { assignees: ['e-cleo'], runs: ['r10'] }),
    task(S, 'Rate limit the public search endpoint', lin(405, 'High', 'In Review'), 'review', { assignees: ['e-ana', 'e-pia'], runs: ['r5'], lastOutcome: outcome('Added a token bucket in front of /search, 60 requests a minute per key, with a test for the 429 path.', 9) }),
    task(S, 'Cache the pricing lookup per region', lin(401, 'Medium', 'In Review'), 'review', { assignees: ['e-bruno'], runs: ['r11'], lastOutcome: outcome('Added a 5 minute cache keyed by region and a test that proves it expires.', 14) }),
    task(S, 'Dark mode contrast on the settings screen', cs(115, 'P3', 'review'), 'review', { assignees: ['e-cleo'], runs: ['r6'], lastOutcome: outcome('Raised the muted text to AA contrast and checked all three settings tabs.', 22) }),
    task(S, 'Upgrade Electron to 44', lin(398, 'Medium', 'Done'), 'done', { assignees: ['e-ana', 'e-bruno'], runs: ['r7'], lastOutcome: outcome('Upgraded and ran the smoke suite, all green.', 120) }),
    task(S, 'Remove the legacy export endpoint', cs(109, 'P4', 'done'), 'done', { assignees: ['e-bruno'], runs: ['r8'], lastOutcome: outcome('Deleted /v1/export and its docs page.', 300) }),
    task(S, 'Rotate the staging API keys', { kind: 'manual' }, 'done', { assignees: ['e-pia'], runs: ['r12'], lastOutcome: outcome('Rotated both keys and updated the deploy secrets.', 600) }),
    task(B, 'Card number field loses focus after a paste', lin(431, 'High', 'In Progress'), 'doing', { assignees: ['e-cleo'], runs: ['r9'] }),
    task(B, 'Totals are off by a cent on refunds over 3 items', lin(428, 'Urgent', 'Todo'), 'todo'),
    task(B, 'Receipt email shows the wrong currency symbol', cs(122, 'P2', 'pending'), 'todo'),
    task(Q, 'Ask finance about the Q4 invoice export format', { kind: 'manual' }, 'todo'),
    task(Q, 'Rename the staging bucket', { kind: 'manual' }, 'todo'),
  ];
  const board = (id, name, kind, sources) => (kind === 'quick' ? { id, blockId, name, kind } : { id, blockId, name, kind, sources, logHours: true });
  const boards = [
    board(S, 'Sprint 42', 'feature', [{ provider: 'linear', projectId: 'team:ENG' }, { provider: 'cronospark', projectId: 'checkout-web' }]),
    board(B, 'Bugs', 'bug', [{ provider: 'linear', projectId: 'project:Checkout bugs' }]),
    board(Q, 'Quick tasks', 'quick'),
    board('b-ideas', 'Ideas', 'quick'),
  ];
  const time = (byEmployee, running = []) => ({ at: now, totalMs: Object.values(byEmployee).reduce((a, b) => a + b, 0), byEmployee, running: running.map((employeeId) => ({ employeeId, share: 1 })) });
  const idOf = (title) => tasks.find((t) => t.title === title).id;
  const taskTime = {
    [idOf('Migrate session storage to Redis')]: time({ 'e-ana': 12 * min + 4000 }, ['e-ana']),
    [idOf('Fix timezone offset in the scheduler')]: time({ 'e-bruno': 3 * min + 41_000, 'e-pia': 95_000 }, ['e-bruno']),
    [idOf('Draft the migration plan for the new auth flow')]: time({ 'e-pia': 4 * min + 20_000 }),
    [idOf('Rate limit the public search endpoint')]: time({ 'e-ana': 31 * min + 12_000, 'e-pia': 61_000 }),
    [idOf('Dark mode contrast on the settings screen')]: time({ 'e-cleo': 18 * min + 40_000 }),
    [idOf('Upgrade Electron to 44')]: time({ 'e-ana': 59 * min, 'e-bruno': 20 * min + 7000 }),
    [idOf('Remove the legacy export endpoint')]: time({ 'e-bruno': 15 * min + 5000 }),
    [idOf('Fix the flaky checkout test on CI')]: time({ 'e-cleo': 2 * min + 10_000 }),
    [idOf('Cache the pricing lookup per region')]: time({ 'e-bruno': 24 * min + 31_000 }),
    [idOf('Rotate the staging API keys')]: time({ 'e-pia': 3 * min + 2000 }),
    [idOf('Card number field loses focus after a paste')]: time({ 'e-cleo': 6 * min + 12_000 }, ['e-cleo']),
  };
  const boardSync = { [S]: { kind: 'ready', lastFetchedAt: now - 2 * min }, [B]: { kind: 'ready', lastFetchedAt: now - 9 * min } };
  return { employees, boards, tasks, taskTime, boardSync };
};

export default async (s) => {
  mkdirSync(OUT, { recursive: true });
  const save = async (name) => {
    await s.mouse('mouseMoved', 4, 890);
    await s.sleep(250);
    copyFileSync(await s.shot(name), join(OUT, `${name}.png`));
  };
  await s.resize(1440, 900);
  await s.waitFor('!!window.__office && !!window.office');
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)}, name: 'Checkout web' })`);
  await s.waitFor('__office.store.getState().company.blocks.length === 1');
  await s.eval(`(() => { const st = __office.store.getState(); const d = (${seed.toString()})(st.company.blocks[0].id, Date.now()); __office.set({ company: { ...st.company, employees: d.employees }, boards: d.boards, tasks: d.tasks, taskTime: d.taskTime, boardSync: d.boardSync, boardPick: { [st.company.blocks[0].id]: 'b-sprint' } }); })()`);
  await s.eval("document.querySelector('.test-banner')?.remove()");
  await s.clickOn('[data-testid=tasks-chip]');
  await s.waitFor("!!document.querySelector('[data-testid=task-board]')");
  await s.sleep(900);
  await s.eval('document.activeElement?.blur()');
  await save('board');

  // Three cards, enlarged: the same markup and styles with the chrome hidden and the page zoomed.
  await s.eval(`(() => {
    const css = document.createElement('style');
    css.id = 'close-up';
    css.textContent = '.tb-head, .tb-tabs, .tb-banner, .tb-dock { display: none !important } .tb-cols { grid-template-columns: 1fr !important; padding-top: 18px !important; justify-items: center } .tb-col { display: none !important } .tb-col[data-stage=doing] { display: flex !important; width: 420px } .tb-col-head { display: none } .tb-main { zoom: 1.9; justify-content: center } .tb-card:nth-child(n+4) { display: none } .modal.tb { height: 760px; width: 900px }';
    document.head.append(css);
  })()`);
  await s.sleep(400);
  await save('card');
  await s.eval("document.getElementById('close-up').remove()");

  await s.clickOn('.tb-card', 'Rate limit the public search endpoint');
  await s.waitFor("!!document.querySelector('[data-testid=task-detail]')");
  await s.eval('document.activeElement?.blur()');
  await s.sleep(300);
  await s.clickOn('.tb-card', 'Migrate session storage to Redis');
  await s.waitFor("document.querySelector('[data-testid=task-detail]')?.innerText.includes('Redis')");
  await s.eval('document.activeElement?.blur()');
  await s.sleep(300);
  await s.clickOn('.tb-card', 'Fix timezone offset in the scheduler');
  await s.waitFor("document.querySelector('[data-testid=task-detail]')?.innerText.includes('Pia')");
  await s.eval('document.activeElement?.blur()');
  await s.sleep(600);
  await save('detail');

  await s.eval("document.querySelector('[aria-label=\"Close details\"]').click()");
  await s.clickOn('[aria-label="Add a task to Todo"]');
  await s.waitFor("!!document.querySelector('[data-testid=composer-title]')");
  await s.type('Add a health check to the worker');
  await s.clickOn('[data-testid=pill-priority]');
  await s.clickOn('[role=option]', 'High');
  await s.clickOn('[data-testid=pill-assignee]');
  await s.clickOn('[role=option]', 'Ana');
  await s.clickOn('[data-testid=pill-assignee]');
  await s.waitFor("!!document.querySelector('[role=listbox][aria-label=Assignee]')");
  await s.sleep(300);
  await save('create');
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[role=listbox]')");
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=composer]')");

  await s.clickOn('.tb-tab', 'Bugs');
  await s.sleep(300);
  await s.mouse('mouseMoved', 4, 890);
  await save('tabs');

  // Not part of the panel's set: the board settings and the new-board picker, for a look.
  await s.clickOn('[aria-label="New board"]');
  await s.waitFor("!!document.querySelector('.tb-newboard')");
  await s.sleep(300);
  await s.shot('extra-newboard');
  await s.press('Escape');
  await s.clickOn('[aria-label="Board settings"]');
  await s.waitFor("!!document.querySelector('[data-testid=board-settings]')");
  await s.sleep(300);
  await s.shot('extra-settings');
  await s.press('Escape');
  await s.press('Escape');
  await s.waitFor("!document.querySelector('[data-testid=task-board]')");
  await s.eval('__office.teleport(-12, -7.4, Math.PI); __office.step(1)');
  await s.sleep(1200);
  await s.eval('__office.step(0.5)');
  await s.shot('extra-wall');
  console.log('shots in', OUT);
};
