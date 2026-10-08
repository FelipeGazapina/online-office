// A Linear board driven through the board UI on its own, with a fake Linear and no agent runs: assignee, cycle, limit, hiding
// and showing Done, and a restart. The same flow closes e2e-board-ui.mjs.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-board-linear.mjs
// OFFICE_SHOTS_DIR copies the shots (filters.png, collapsed.png) from /tmp/office-shots to that folder.
import { rmSync } from 'node:fs';
import { assert, scratch } from './lib.mjs';
import { linearBoardFlow } from './board-linear-flow.mjs';
import { linearWorld, startFakeLinear, TOKEN } from './fake-linear.ts';

const { dataDir, repo } = scratch();
const world = linearWorld();
const fake = await startFakeLinear(world);

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_TEST_PICK_FOLDER: repo, LINEAR_MCP_TOKEN: TOKEN, LINEAR_MCP_URL: fake.url, OFFICE_TASK_BOARD_FIXTURE: '' };

export default async (s, { launch }) => {
  try {
    await s.resize(1440, 900);
    await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)}, name: 'Checkout' })`);
    await s.waitFor('__office.store.getState().company.blocks.length === 1');
    await s.clickOn('[data-testid=tasks-chip]');
    await s.waitFor("!!document.querySelector('[data-testid=task-board]')");
    await linearBoardFlow(s, { fake, world, launch, env });
    assert(fake.auth.every((a) => a === `Bearer ${TOKEN}`), 'every call to Linear carried the token');
  } finally {
    await fake.close();
  }
};

process.on('exit', () => {
  for (const dir of [dataDir, repo]) rmSync(dir, { recursive: true, force: true });
});
