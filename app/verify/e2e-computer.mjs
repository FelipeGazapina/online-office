import { scratch, assert } from './lib.mjs';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_TEST_PICK_FOLDER: repo };

export default async (s) => {
  await s.waitFor('!!window.__office && !!window.office');
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor('__office.store.getState().company.blocks.length === 1');
  await s.eval("window.__office.teleport(-15.6, 5.2, Math.PI); window.__office.step(0.5)");
  assert(await s.eval("__office.store.getState().nearComputer"), 'the owner is near the computer');
  await s.press('KeyF', 'f');
  await s.waitFor("__office.store.getState().portalMode === true");
  assert(await s.eval("__office.store.getState().computerView === 'office'"), 'F opens the office desktop without mirroring');
  assert(await s.eval("!!document.querySelector('.mac-portal') && !document.querySelector('.mac-mirror-portal')"), 'the office desktop is visible first');
  assert(await s.eval("document.querySelector('.mac-window-head b')?.innerText.includes('My Mac')"), 'the desktop shows the computer app');
  assert(await s.eval("[...document.querySelectorAll('.mac-action')].some((b) => b.innerText.includes('Configuration'))"), 'the desktop has a configuration icon');
  await s.clickText('.mac-action', 'Configuration');
  await s.waitFor("document.querySelector('#mac-configuration')?.getBoundingClientRect().top >= 0");
  assert(await s.eval("document.body.innerText.includes('Blocks') && document.body.innerText.includes('Camera')"), 'configuration contains company and settings controls');
  assert(await s.eval("[...document.querySelectorAll('.mac-office-window .co-row .btn')].some((b) => b.innerText === 'Hire' && !b.disabled)"), 'the max-level configuration can hire without a seat cap');
  await s.clickText('.mac-office-window .co-row .btn', 'Hire');
  assert(await s.eval("[...document.querySelectorAll('.modal option')].some((o) => o.innerText.includes('Block orchestrator'))"), 'hiring offers the block orchestrator role');
  await s.press('Escape', 'Escape');
  await s.clickText('.mac-office-window .blocks-head .btn', 'New block');
  await s.waitFor("__office.store.getState().modal?.kind === 'block'");
  assert(await s.eval("document.body.innerText.includes('Choose folder')"), 'configuration opens the new block form');
  await s.clickText('.modal .btn.ghost', 'Cancel');
  await s.waitFor("__office.store.getState().modal === null");
  await s.clickText('.mac-action', 'Live Mac mirror');
  await s.waitFor("__office.store.getState().computerView === 'mirror'");
  assert(await s.eval("!!document.querySelector('.mac-mirror-portal')"), 'the mirror app opens the live desktop view');
  await s.press('KeyF', 'f');
  await s.waitFor("__office.store.getState().portalMode === false");
  assert(await s.eval("__office.store.getState().computerState === 'away'"), 'F stands up from the desktop');
};
