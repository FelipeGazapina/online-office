import { scratch, assert } from './lib.mjs';
import { join } from 'node:path';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_TEST_PICK_FOLDER: repo, OFFICE_TASK_BOARD_FIXTURE: join(process.cwd(), 'verify/fixtures/task-board.json') };

export default async (s) => {
  await s.waitFor('!!window.__office && !!window.office');
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor('__office.store.getState().company.blocks.length === 1');
  // Slot 0 project computer chair: block center (-12, -5), PO station at (-8.95, -5).
  await s.eval("__office.teleport(-8.95, -5, Math.PI); __office.step(0.5)");
  await s.press('KeyF', 'f');
  await s.waitFor("__office.store.getState().portalMode === true");
  await s.waitFor("document.body.innerText.includes('Task boards')");
  assert(await s.eval("document.body.innerText.includes('Task boards')"), 'PO configuration shows task boards');
  assert(await s.eval("document.body.innerText.includes('Add Linear') && document.body.innerText.includes('Add CronoSpark')"), 'PO configuration offers both providers');
  await s.clickText('.task-config-actions button', 'Add CronoSpark');
  await s.waitFor("!!document.querySelector('.task-source-row input')");
  await s.clickOn('.task-source-row input');
  await s.type('project-1');
  assert(await s.eval("document.querySelector('.task-source-row input')?.value === 'project-1'"), 'PO can enter a provider project id');
  await s.clickText('.task-config-actions button', 'Save and refresh');
  await s.waitFor("__office.store.getState().taskBoards[__office.store.getState().company.blocks[0].id]?.kind === 'ready'");
  await s.eval(`(() => { const blockId = __office.store.getState().company.blocks[0].id; __office.store.setState({ modal: { kind: 'task_board', blockId } }); })()`);
  await s.waitFor("document.querySelector('.task-card')?.innerText.includes('CS-27')");
  assert(await s.eval("document.body.innerText.includes('Fix the board')"), 'the board renders a normalized ticket card');
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: __office.store.getState().company.blocks[0].id })`);
  await s.waitFor("__office.store.getState().company.employees.length === 1");
  await s.clickText('.task-card', 'CS-27');
  await s.clickText('.task-assign', '');
  await s.waitFor("__office.store.getState().company.employees[0].status.kind === 'working'");
  assert(await s.eval("__office.store.getState().company.employees[0].status.task.includes('CS-27')"), 'assigning a card starts the ticket with an AI employee');
};
