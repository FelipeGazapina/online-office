// Tab switches between the isometric camera and first person. Real key and mouse events on the built app.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-camera.mjs
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert } from './lib.mjs';

export const env = { OFFICE_DATA_DIR: mkdtempSync(join(tmpdir(), 'online-office-camera-')), OFFICE_START_LEVEL: '3' };

const SHOTS = '/Users/feliperico/.claude/orchestrate/online-office-game/shots';
const cam = (s) => s.eval('window.__officeCamera && ({ ...window.__officeCamera, ownerVisible: window.__officeCamera.ownerVisible() })');
const settled = (s, blend) => s.waitFor(`window.__officeCamera && Math.abs(window.__officeCamera.blend - ${blend}) < 0.001`, 10000);
// Logs the camera on every rendered frame, so the flight check never depends on how often the test polls.
const RECORD = `window.__camLog = []; (function tick() { if (window.__officeCamera) window.__camLog.push({ ...window.__officeCamera }); if (window.__camLog.length < 600) requestAnimationFrame(tick); })()`;
async function save(s, name) {
  const path = await s.shot(name);
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(path, join(SHOTS, `${name}.png`));
}

export default async (s) => {
  await s.waitFor('__office.store.getState().company !== null');
  await s.waitFor('window.__officeCamera !== undefined');
  await s.eval('__office.teleport(-10, 4, Math.PI)');
  await settled(s, 0);
  await s.sleep(1200);

  const iso = await cam(s);
  assert(iso.y > 10 && iso.ownerVisible, `the isometric camera floats high (y ${iso.y.toFixed(1)}) and shows the owner`);
  assert(await s.eval('!!document.querySelector(".camera-toggle")'), 'the HUD has a camera toggle');
  await save(s, 'c1-iso');

  // The wheel zooms the overview between a nearest and a farthest distance. The nearest keeps the camera above the top of a wall (3.2 m), and the way
  // there is eased: the camera glides through in-between positions instead of jumping.
  const wheel = (deltaY) => s.eval(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY}, bubbles: true }))`);
  const wallTop = 3.2;
  const far = await cam(s);
  await s.eval(RECORD);
  await wheel(-4000);
  await s.sleep(1500);
  const near = await cam(s);
  const glide = (await s.eval('window.__camLog')).map((c) => c.y).filter((y) => y < far.y - 0.05 && y > near.y + 0.05);
  assert(near.dist === near.near && near.near < 8, `the wheel stops at the nearest distance, ${near.near} (it used to stop at 8)`);
  assert(near.y - (await s.eval('__office.state().owner.y')) >= wallTop, `at the nearest the camera is ${near.y.toFixed(2)} m up, above a wall's top (${wallTop} m)`);
  assert(glide.length >= 3 && glide.every((y, i) => i === 0 || y <= glide[i - 1] + 1e-6), `the way in is eased through ${glide.length} in-between heights`);
  await save(s, 'c1-near');
  await wheel(4000);
  await s.sleep(1500);
  assert((await cam(s)).dist === 48, 'the wheel stops at 48 when not building');
  await wheel(-((48 - far.dist) / 0.03));
  await s.sleep(1500);
  assert(Math.abs((await cam(s)).dist - far.dist) < 0.01, 'and comes back to where it was');

  // Tab flies to the owner's eyes.
  await s.eval(RECORD);
  await s.press('Tab');
  await settled(s, 1);
  const samples = await s.eval('window.__camLog');
  assert((await s.eval('__office.state().camera')) === 'first', 'Tab switches the camera to first person');
  const mid = samples.filter((c) => c.blend > 0.05 && c.blend < 0.95);
  assert(mid.length >= 3 && mid.every((c) => c.y < iso.y && c.y > 1.5) && mid.every((c, i) => i === 0 || c.y <= mid[i - 1].y), `the flight is eased through ${mid.length} in-between positions (y ${mid.map((c) => c.y.toFixed(1)).join(', ')})`);
  await settled(s, 1);
  await s.sleep(300);
  const owner = await s.eval('__office.state().owner');
  const fp = await cam(s);
  assert(Math.abs(fp.y - 1.6) < 0.08, `first person stands at eye height (${fp.y.toFixed(2)} m)`);
  assert(Math.hypot(fp.x - owner.x, fp.z - owner.z) < 0.2, 'the first-person camera sits on the owner');
  assert(Math.abs(fp.fov - 65) < 0.5, `the field of view is 65 (${fp.fov.toFixed(1)})`);
  assert(!fp.ownerVisible, 'the owner mesh is hidden in first person');
  // Look into the open floor for the picture.
  await s.eval('__office.teleport(2, 2, Math.PI / 4)');
  await s.sleep(500);
  await save(s, 'c1-first');

  // Mouse look. The hidden test window cannot hold a pointer lock, so a drag turns the view the same way.
  const before = (await cam(s)).yaw;
  await s.drag({ x: 640, y: 500 }, { x: 760, y: 470 });
  await s.sleep(200);
  const after = await cam(s);
  assert(Math.abs(after.yaw - before) > 0.1, `mouse look turns the view (yaw ${before.toFixed(2)} to ${after.yaw.toFixed(2)})`);
  assert(Math.abs(after.pitch) > 0.02, `mouse look tilts the view (pitch ${after.pitch.toFixed(2)})`);

  // W walks along the view, whatever way it faces.
  await s.eval('__office.teleport(-10, 4, 0.7)');
  await s.eval('window.dispatchEvent(new Event("blur"))');
  await s.sleep(300);
  const yaw = (await cam(s)).yaw;
  const start = await s.eval('__office.state().owner');
  await s.eval('__office.hold("KeyW"); __office.step(1); __office.hold("KeyW", false)');
  const end = await s.eval('__office.state().owner');
  const moved = Math.hypot(end.x - start.x, end.z - start.z);
  const along = (end.x - start.x) * Math.sin(yaw) + (end.z - start.z) * Math.cos(yaw);
  assert(moved > 1 && along / moved > 0.95, `W walks forward along the view (${moved.toFixed(2)} m, ${(along / moved).toFixed(2)} of it along yaw ${yaw.toFixed(2)})`);

  // Tab flies back.
  await s.eval(RECORD);
  await s.press('Tab');
  await settled(s, 0);
  const back = await s.eval('window.__camLog');
  assert((await s.eval('__office.state().camera')) === 'iso', 'Tab switches back to the isometric camera');
  assert(back.filter((c) => c.blend > 0.05 && c.blend < 0.95).length >= 3, 'the flight back is eased through in-between positions');
  await settled(s, 0);
  await s.sleep(1200);
  const home = await cam(s);
  assert(home.y > 10 && home.ownerVisible, `the isometric camera is back up (y ${home.y.toFixed(1)}) and shows the owner`);

  // The HUD button does the same as Tab.
  await s.clickOn('.camera-toggle');
  await settled(s, 1);
  assert((await s.eval('__office.state().camera')) === 'first', 'the HUD button switches to first person');
  await s.clickOn('.camera-toggle');
  await settled(s, 0);
  assert((await s.eval('__office.state().camera')) === 'iso', 'the HUD button switches back');
};
