// Run with `pnpm build && node verify/cdp.mjs verify/e2e-move-block-3d.mjs`.
// The owner moves and turns a block inside the 3D office with real pointer input. The block's sign opens its menu,
// Move or turn starts a preview that follows a drag on the floor, a spot over another block turns red and cannot be
// placed, R turns it, and Place saves it. The employee at the block gets up and sits down at the moved desk.
import { deskPose, placementOf, signPose } from '../src/renderer/src/layout.ts';
import { assert, claude, company, hireClaudeInBlock, scratch, stepUntil } from './lib.mjs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { dataDir, repo } = scratch();
const other = realpathSync(mkdtempSync(join(tmpdir(), 'office-other-')));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const arranging = '__office.store.getState().arranging';
const blockOf = (cwd) => `${company}.blocks.find((b) => b.cwd === ${JSON.stringify(cwd)})`;
const onScreen = (s, x, z) => s.eval(`__office.project(${x}, 0, ${z})`);

export default async function moveBlock3d(s) {
  await hireClaudeInBlock(s, repo);
  const id = await s.eval(`${claude}.id`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(other)} })`);
  await s.waitFor(`${company}.blocks.length === 2`);
  await s.eval('__office.step(1)');
  await s.sleep(500);

  const start = placementOf(await s.eval(blockOf(repo)));
  const sign = signPose(start);
  const at = await s.eval(`__office.project(${sign.x}, 1.25, ${sign.z})`);
  await s.click(at.x, at.y);
  await s.waitFor(`__office.store.getState().modal?.kind === 'block_menu'`);
  await s.clickOn('.modal .btn', 'Move or turn');
  await s.waitFor(`${arranging} !== null`);
  assert(await s.eval(`!!document.querySelector('.arrange-bar')`), 'Move or turn opens the move bar');
  await s.shot('move-block-start');

  const grab = await onScreen(s, start.x, start.z);
  const otherPlace = placementOf(await s.eval(blockOf(other)));
  const overOther = await onScreen(s, otherPlace.x, otherPlace.z);
  await s.drag(grab, overOther, 12);
  await s.sleep(200);
  await s.shot('move-block-blocked');
  assert(await s.eval(`document.querySelector('.arrange-bar').innerText.includes('overlaps') && document.querySelector('.arrange-bar .btn.primary').disabled`), 'a spot over the other block says so and cannot be placed');

  const free = { x: start.x, z: start.z - 10 };
  const freeAt = await onScreen(s, free.x, free.z);
  await s.drag(overOther, freeAt, 12);
  await s.sleep(200);
  await s.press('KeyR', 'r');
  await s.sleep(200);
  const preview = await s.eval(`${arranging}.place`);
  assert(Math.abs(preview.x - free.x) <= 0.5 && Math.abs(preview.z - free.z) <= 0.5 && preview.turns === 1, `the drag carries the block to the free spot and R turns it a quarter (${JSON.stringify(preview)})`);
  assert(await s.eval(`!document.querySelector('.arrange-bar .btn.primary').disabled`), 'the free spot can be placed');
  await s.shot('move-block-preview');

  await s.clickOn('.arrange-bar .btn', 'Place');
  await s.waitFor(`${arranging} === null && !!${blockOf(repo)}.place`);
  const saved = await s.eval(`${blockOf(repo)}.place`);
  assert(saved.x === preview.x && saved.z === preview.z && saved.turns === 1, `Place saves the spot and the turn (${JSON.stringify(saved)})`);

  const chair = deskPose(saved, await s.eval(`${claude}.desk`)).chair;
  await stepUntil(s, `(() => { const a = __office.state().avatars.find((a) => a.id === '${id}'); return a.seated && Math.hypot(a.x - ${chair.x}, a.z - ${chair.z}) < 0.05; })()`, 60000, 'the employee to sit at the moved desk');
  assert(true, 'the employee walks to the moved desk and sits down');
  await s.shot('move-block-placed');
}
