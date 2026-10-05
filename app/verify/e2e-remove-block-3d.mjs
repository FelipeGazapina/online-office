// Run with `pnpm build && node verify/cdp.mjs verify/e2e-remove-block-3d.mjs`.
// The owner removes a block from inside the 3D office. A real click on the block's sign opens a confirm dialog that
// names who will be fired. Cancel keeps the block, and the confirm button removes it while the folder stays on disk.
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signPose } from '../src/renderer/src/layout.ts';
import { assert, claude, company, hireClaudeInBlock, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
const other = realpathSync(mkdtempSync(join(tmpdir(), 'office-other-')));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const modal = '__office.store.getState().modal';

async function clickSign(s, cwd) {
  const slot = await s.eval(`${company}.blocks.find((b) => b.cwd === ${JSON.stringify(cwd)}).slot`);
  const { x, z } = signPose(slot);
  const at = await s.eval(`__office.project(${x}, 1.25, ${z})`);
  const top = await s.eval(`document.elementFromPoint(${at.x}, ${at.y})?.tagName`);
  assert(top === 'CANVAS', `the sign at ${at.x.toFixed(0)},${at.y.toFixed(0)} is on screen and not under the HUD (${top})`);
  await s.click(at.x, at.y);
}

export default async function removeBlock3d(s) {
  await hireClaudeInBlock(s, repo);
  const id = await s.eval(`${claude}.id`);
  const name = await s.eval(`${claude}.name`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(other)} })`);
  await s.waitFor(`${company}.blocks.length === 2`);
  await s.eval('__office.step(1)');
  await s.sleep(500);

  await clickSign(s, other);
  await s.waitFor(`${modal}?.kind === 'remove_block'`);
  assert(await s.eval(`document.querySelector('.modal').innerText.includes('Nobody works here yet')`), 'an empty block says nobody will be fired');
  await s.clickOn('.modal .btn', 'Cancel');
  await s.waitFor(`${modal} === null`);
  assert(await s.eval(`${company}.blocks.length === 2`), 'Cancel keeps the block');

  await clickSign(s, repo);
  await s.waitFor(`${modal}?.kind === 'remove_block'`);
  assert(await s.eval(`document.querySelector('.modal').innerText.includes(${JSON.stringify(name)})`), `the dialog names ${name}, who will be fired`);
  await s.shot('remove-block-3d-confirm');
  await s.clickOn('.modal .btn', 'Fire and remove');
  await s.waitFor(`${company}.blocks.length === 1`);
  await s.eval('__office.step(1)');
  await s.sleep(500);
  await s.shot('remove-block-3d-done');
  assert(await s.eval(`${company}.blocks[0].cwd === ${JSON.stringify(other)} && !${company}.employees.some((e) => e.id === '${id}')`), 'confirming removes the block and fires its employee, the other block stays');
  assert(await s.eval(`${modal} === null`), 'the dialog closes');
  assert(existsSync(repo), 'the project folder is still on disk');
}
