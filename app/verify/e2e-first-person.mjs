// The office settings on the Mac offer first person beside top down, and the choice survives a restart.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/e2e-first-person.mjs
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_TEST_PICK_FOLDER: repo };

const cameraLabels = (s) => s.eval('[...document.querySelectorAll(".mac-settings-window .panel.settings button")].map((b) => b.innerText)');
const mode = (s) => s.eval('__office.store.getState().camera');
// Where the owner's head lands on screen; in first person the lens sits in it, so the projection is behind or far off.
const eyeLine = (s) => s.eval('(() => { const { x, z } = __office.state().owner; return __office.project(x + Math.sin(__office.state().view.yaw) * 4, 1.62, z + Math.cos(__office.state().view.yaw) * 4); })()');

export default async (s, { launch }) => {
  await s.waitFor('!!window.__office && !!window.office');
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor('__office.store.getState().company.blocks.length === 1');
  assert((await mode(s)) === 'iso', 'a fresh office starts in the top-down camera');
  await s.shot('fp-top-down');

  await s.eval('window.__office.teleport(-15.6, 5.2, Math.PI); window.__office.step(0.5)');
  await s.press('KeyF', 'f');
  await s.waitFor('__office.store.getState().portalMode === true');
  const labels = await cameraLabels(s);
  assert(labels.includes('2 Top down') && labels.includes('3 First person'), `the camera setting offers both views (${labels.join(', ')})`);
  await s.clickOn('.mac-settings-window .panel.settings button', '3 First person');
  await s.waitFor('__office.store.getState().camera === "first"');
  await s.press('KeyF', 'f');
  await s.waitFor('__office.store.getState().portalMode === false');
  await s.sleep(1500);
  const eye = await eyeLine(s);
  const vh = await s.eval('innerHeight');
  assert(Math.abs(eye.y - vh / 2) < vh * 0.08, `a point at eye height ahead sits on the horizon in first person (${eye.y.toFixed(0)} of ${vh})`);
  await s.shot('fp-first-person');

  await s.press('Digit2', '2');
  await s.waitFor('__office.store.getState().camera === "iso"');
  await s.press('Digit3', '3');
  await s.waitFor('__office.store.getState().camera === "first"');

  await s.close();
  const again = await launch({ env });
  await again.waitFor('__office.store.getState().company !== null');
  assert((await mode(again)) === 'first', 'first person is still selected after a restart');
};
