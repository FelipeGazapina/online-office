// Run with `pnpm build:verify && OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-hire-several.mjs`.
// The hire dialog seats several people in one go, up to one block's worth of desks per batch.
import { assert, company, scratch } from './lib.mjs';
import { DESKS_PER_BLOCK } from '../src/shared/protocol.ts';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const setCount = (n) => `(() => {
  const input = [...document.querySelectorAll('.modal .field')].find((f) => f.innerText.startsWith('How many')).querySelector('input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${n}');
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`;
const hireButton = `document.querySelector('.modal .btn.primary')`;

export default async function hireSeveral(s) {
  await s.waitFor(`!!${company}`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${company}.blocks.length === 1`);

  await s.eval("window.__office.teleport(-15.6, 5.2, Math.PI); window.__office.step(0.5)");
  await s.press('KeyF', 'f');
  await s.waitFor('__office.store.getState().portalMode === true');
  await s.clickText('.mac-action', 'Configuration');
  await s.waitFor("document.querySelector('#mac-configuration')?.getBoundingClientRect().top >= 0");
  assert(await s.clickText('.mac-office-window .co-row .btn', 'Hire'), 'clicked Hire in Configuration');
  await s.waitFor(`!!${hireButton}`);

  await s.eval(setCount(9));
  await s.sleep(200);
  assert((await s.eval(`${hireButton}.innerText`)) === `Hire ${DESKS_PER_BLOCK}`, `asking for 9 offers one block's worth, ${DESKS_PER_BLOCK}`);
  await s.eval(setCount(3));
  await s.sleep(200);
  assert((await s.eval(`${hireButton}.innerText`)) === 'Hire 3', 'asking for 3 offers 3');
  assert(await s.eval(`document.querySelector('.modal input[placeholder^="Each new hire"]').disabled`), 'and the name field steps aside for a batch');
  await s.shot('hire-several-modal');

  await s.eval(`${hireButton}.click()`);
  await s.waitFor(`${company}.employees.length === 3`);
  const hires = await s.eval(`${company}.employees.map((e) => e.name + '@' + e.seat)`);
  assert(new Set(hires.map((h) => h.split('@')[0])).size === 3 && new Set(hires.map((h) => h.split('@')[1])).size === 3, `one click hires three people at three desks (${hires.join(', ')})`);
  await s.sleep(300);
  assert(!(await s.eval(`__office.store.getState().toasts.length`)), 'with no error toast');

  await s.press('KeyF', 'f');
  await s.eval('__office.step(25)');
  await s.shot('hire-several-office');
}
