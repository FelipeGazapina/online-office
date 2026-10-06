import { HAIKU, scratch, assert } from './lib.mjs';
import { join } from 'node:path';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_CLAUDE_MODEL: HAIKU, OFFICE_TEST_PICK_FOLDER: repo, OFFICE_TASK_BOARD_FIXTURE: join(process.cwd(), 'verify/fixtures/task-board.json') };

const synced = "__office.store.getState().boards.find((b) => b.kind !== 'quick')";

export default async (s) => {
  await s.waitFor('!!window.__office && !!window.office');
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor('__office.store.getState().company.blocks.length === 1');
  // The pod arrives with the building. Standing in it before then, the owner is moved out when it lands.
  await s.waitFor("__office.store.getState().building?.stories.some((st) => st.items.some((i) => i.def === 'board_terminal'))");
  await s.sleep(300);
  // Slot 0 board terminal: block center (-12, -5), the terminal stands at (-8.5, -8.25) and is used from just south of it.
  await s.eval("__office.teleport(-8.5, -7.4, Math.PI); __office.step(0.5)");
  await s.press('KeyF', 'f');
  await s.waitFor("__office.store.getState().portalMode === true");
  await s.waitFor("!!document.querySelector('.task-config')");
  assert(await s.eval("document.body.innerText.includes('task boards')"), 'PO configuration shows task boards');
  assert(await s.eval("document.body.innerText.includes('Add Linear') && document.body.innerText.includes('Add CronoSpark')"), 'PO configuration offers both providers');
  assert(await s.eval("document.body.innerText.includes('CronoSpark credentials') && document.body.innerText.includes('MCP user ID')"), 'PO configuration exposes CronoSpark credentials');
  const cronoCredentials = '.task-credentials:not(.linear-board-config)';
  await s.clickOn(`${cronoCredentials} input[type="password"]`);
  await s.type('board-test-key');
  await s.clickOn(`${cronoCredentials} input:not([type="password"])`);
  await s.type('board-test-user');
  await s.clickText(`${cronoCredentials} button`, 'Save CronoSpark');
  await s.waitFor("__office.store.getState().taskConnections.cronospark.kind === 'ready'");
  assert(await s.eval("__office.store.getState().taskConnections.cronospark.userId === 'board-test-user'"), 'CronoSpark credentials are saved through the owner computer');
  await s.clickText('.task-config-actions button', 'Add CronoSpark');
  await s.waitFor("!!document.querySelector('.task-source-row input')");
  await s.clickOn('.task-source-row input');
  await s.type('project-1');
  assert(await s.eval("document.querySelector('.task-source-row input')?.value === 'project-1'"), 'PO can enter a provider project id');
  await s.clickText('.task-config-actions button', 'Save and refresh');
  await s.waitFor(`(() => { const st = __office.store.getState(); return st.boardSync[${synced}?.id]?.kind === 'ready'; })()`);
  assert(await s.eval(`${synced}?.name === 'Tasks' && ${synced}?.sources[0]?.projectId === 'project-1' && __office.store.getState().tasks.length === 6`), 'the saved sources became a Tasks board that pulled the six cards as tasks');
  await s.eval('document.activeElement?.blur()');
  await s.press('KeyF', 'f');
  await s.waitFor("__office.store.getState().portalMode === false");
  await s.eval("__office.teleport(-12, -7.4, Math.PI); __office.step(0.5)");
  assert(await s.eval("document.body.innerText.includes('open the task board')"), 'the nearby board advertises the F shortcut');
  await s.press('KeyF', 'f');
  await s.waitFor("__office.store.getState().modal?.kind === 'task_board'");
  await s.waitFor("document.querySelector('.task-card')?.innerText.includes('CS-27')");
  assert(await s.eval("document.body.innerText.includes('Fix the board')"), 'the board renders a normalized ticket card');
  assert(await s.eval("document.querySelectorAll('[data-testid=task-board-kanban] .task-board-column').length === 6"), 'the board renders the Linear-style workflow columns');
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: __office.store.getState().company.blocks[0].id })`);
  await s.waitFor("__office.store.getState().company.employees.length === 1");
  await s.clickText('.task-card', 'CS-27');
  assert(await s.eval("document.querySelector('[data-testid=task-card-details]')?.innerText.includes('Assign to an AI employee')"), 'selecting a card opens its assignment details');
  await s.shot('task-board-kanban');
  await s.clickText('.task-assign', '');
  await s.waitFor("__office.store.getState().company.employees[0].status.kind === 'working'");
  assert(await s.eval("__office.store.getState().company.employees[0].status.task.includes('Fix the board')"), 'assigning a card starts the ticket with an AI employee');
  assert(await s.eval(`(() => { const st = __office.store.getState(); const t = st.tasks.find((x) => x.origin.identifier === 'CS-27'); return t.stage === 'doing' && t.runs.length === 1 && t.assignees[0] === st.company.employees[0].id; })()`), 'the card is a task in doing, assigned to that employee through assign_task');
  await s.eval(`window.office.send({ type: 'update_board', boardId: ${synced}.id, sources: [{ provider: 'linear', projectId: 'bloomnetwork' }] })`);
  await s.waitFor(`__office.store.getState().boardSync[${synced}.id]?.kind === 'error'`);
  await s.eval(`(() => { const blockId = __office.store.getState().company.blocks[0].id; __office.store.setState({ modal: { kind: 'task_board', blockId } }); })()`);
  await s.waitFor("document.body.innerText.includes('Connect Linear')");
  assert(await s.eval("document.body.innerText.includes('Connect Linear') && document.body.innerText.includes('No tickets matched') === false"), 'the board explains a missing Linear connection instead of showing a blank result');
};
