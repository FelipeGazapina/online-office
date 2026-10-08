// Run with `pnpm build && node verify/cdp.mjs verify/e2e-remove-block.mjs`.
// The owner removes a block from the configuration window. The first click arms the button and says who will be fired,
// the second removes the block and its people, and the folder stays on disk.
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, claude, company, hireClaudeInBlock, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
const other = realpathSync(mkdtempSync(join(tmpdir(), 'office-other-')));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const removeIn = (cwd) => `[...document.querySelectorAll('.mac-office-window .blocks li')].find((li) => li.querySelector('.b-cwd').title === ${JSON.stringify(cwd)})?.querySelector('.remove')`;

export default async function removeBlock(s) {
  await hireClaudeInBlock(s, repo);
  const id = await s.eval(`${claude}.id`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(other)} })`);
  await s.waitFor(`${company}.blocks.length === 2`);

  await s.eval("window.__office.teleport(-15.6, 5.2, Math.PI); window.__office.step(0.5)");
  await s.press('KeyF', 'f');
  await s.waitFor('__office.store.getState().portalMode === true');
  await s.clickText('.mac-action', 'Configuration');
  await s.waitFor("document.querySelector('#mac-configuration')?.getBoundingClientRect().top >= 0");

  const at = await s.eval(`(() => { const r = ${removeIn(repo)}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await s.click(at.x, at.y);
  await s.waitFor(`${removeIn(repo)}.innerText.includes('Fire 1')`);
  await s.shot('remove-block-armed');
  assert(await s.eval(`${company}.blocks.length === 2`), 'the first click only arms the button and names how many will be fired');

  await s.click(at.x, at.y);
  await s.waitFor(`${company}.blocks.length === 1`);
  await s.shot('remove-block-done');
  assert(await s.eval(`${company}.blocks[0].cwd === ${JSON.stringify(other)} && !${company}.employees.some((e) => e.id === '${id}')`), 'the second click removes the block and fires its employee, the other block stays');
  assert(await s.eval(`![...document.querySelectorAll('.mac-office-window .b-cwd')].some((el) => el.title === ${JSON.stringify(repo)})`), 'the configuration list no longer shows it');
  assert(existsSync(repo), 'the project folder is still on disk');
}
