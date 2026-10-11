// The laptop the owner always carries. It sits in the inventory slot; Esc with nothing open takes it out. The owner brings it up in
// both hands, the lid opens and the camera goes into its screen, where the desktop of the owner's Mac is, with the same apps. While it
// is out the owner stays put, Esc closes what is open over it before it goes away, and Live Mac mirror sits the owner at the Mac from
// there. Real key presses and clicks only, no model. Screenshots land in /tmp/office-shots.
import { assert, sceneReady, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_TEST_PICK_FOLDER: repo };

const S = '__officeLaptop.anim.s';
const laptop = (k) => `__officeLaptop.store.getState().${k}`;
const store = (k) => `__office.store.getState().${k}`;
// The software renderer of a CI box can draw a frame a second, and the sequence is 1.5 s of frames.
const LONG = 120000;

// Titles of the windows and names of the apps on whichever desktop `root` holds.
const apps = (root) => `[...document.querySelectorAll('${root} .mac-window-head b, ${root} .mac-action b')].map((b) => b.innerText.trim())`;

export default async (s) => {
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${store('company')}.blocks.length === 1`);
  await sceneReady(s);

  // The slot shows the laptop and the key that takes it out.
  assert(await s.eval(`document.querySelector('.inv-slot .inv-name')?.textContent === 'Laptop' && document.querySelector('.inv-slot kbd')?.textContent === 'Esc'`), 'the inventory holds the laptop, with Esc on its slot');
  await s.shot('laptop-1-inventory');

  // Esc closes what is open first: the key help goes, and the laptop stays in the inventory.
  await s.press('KeyH', 'h');
  await s.waitFor(store('helpOpen'));
  await s.press('Escape');
  await s.waitFor(`!${store('helpOpen')}`);
  await s.sleep(300);
  assert(await s.eval(`!${laptop('open')} && ${S} === 0`), 'Esc closes the key help and leaves the laptop away');

  // Esc with nothing open: the owner stops, takes the laptop out, opens it, and the camera goes into its screen.
  const before = await s.eval('__office.state().owner');
  await s.press('Escape');
  await s.waitFor(laptop('open'));
  assert(await s.eval(`document.body.dataset.laptop === 'open' && getComputedStyle(document.querySelector('.hud')).visibility === 'hidden'`), 'the HUD steps back while the laptop is out');
  await s.waitFor(`${S} >= 0.9`, LONG);
  assert(await s.eval('__officeCamera.ownerVisible()'), 'the owner is in the shot while bringing the laptop up');
  const view = await s.eval('__officeLaptopProbe.blocked()');
  assert(view === null, `nothing stands between the camera and the laptop (${view ?? 'clear'})`);
  assert(!(await s.eval(`!!document.querySelector('.tag.you')`)), 'the name tag is out of the shot');
  await s.shot('laptop-2-open-lid');
  await s.waitFor(`${S} >= 1.2`, LONG);
  await s.shot('laptop-3-zoom');
  await s.waitFor(laptop('ready'), LONG);
  await s.sleep(400);
  await s.shot('laptop-4-desktop');

  assert((await s.eval('__officeLaptopProbe.blocked()')) === null, 'nothing stands between the camera and the screen once zoomed');
  const grip = await s.eval('__officeLaptopProbe.grip()');
  assert(grip && grip.left < 0.03 && grip.right < 0.03, `both hands hold the laptop (${grip && `${grip.left.toFixed(3)} m, ${grip.right.toFixed(3)} m`} off their grips)`);

  // The desktop lies on the 3D screen the camera frames, to the pixel.
  const fit = await s.eval(`(() => {
    const corners = __officeLaptopProbe.corners().map(([x, y, z]) => __office.project(x, y, z));
    const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
    const r = document.querySelector('.laptop-frame').getBoundingClientRect();
    return { screen: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], panel: [r.left, r.top, r.right, r.bottom] };
  })()`);
  const off = Math.max(...fit.screen.map((v, i) => Math.abs(v - fit.panel[i])));
  assert(off < 2, `the desktop lies on the laptop's screen (${off.toFixed(2)} px off; screen ${fit.screen.map(Math.round)}, panel ${fit.panel.map(Math.round)})`);
  assert(await s.eval(`document.querySelector('.laptop-frame .mac-live')?.innerText === 'LAPTOP'`), 'the laptop says it is the laptop');
  assert(await s.eval(`document.elementFromPoint(8, innerHeight / 2)?.classList.contains('laptop-sheet')`), 'nothing in the office takes a click while the laptop is out');

  // The owner stays put: W is the page's, not the legs'.
  await s.key('keyDown', 'KeyW', 'w');
  await s.sleep(800);
  await s.key('keyUp', 'KeyW', 'w');
  const after = await s.eval('__office.state().owner');
  assert(Math.hypot(after.x - before.x, after.z - before.z) < 0.01 && after.yaw === before.yaw, 'the owner does not walk or turn while holding the laptop');

  // Its apps work: Hire opens the hire dialog over the laptop. Esc closes the dialog first, then the laptop.
  const onLaptop = await s.eval(apps('.laptop-frame'));
  await s.clickOn('.laptop-frame .co-row .btn', 'Hire');
  await s.waitFor(`${store('modal')}?.kind === 'hire'`);
  assert(await s.eval(`[...document.querySelectorAll('.modal option')].some((o) => o.innerText.includes('Block orchestrator'))`), 'Hire on the laptop opens the hire dialog');
  await s.shot('laptop-5-hire');
  await s.press('Escape');
  await s.waitFor(`${store('modal')} === null`);
  await s.sleep(300);
  assert(await s.eval(`${laptop('open')} && ${laptop('ready')}`), 'Esc closes the dialog and the laptop stays open');
  await s.press('Escape');
  await s.waitFor(`!${laptop('open')}`);
  assert(await s.eval(`!document.querySelector('.laptop-frame')`), 'Esc again puts the desktop away at once');
  await s.waitFor(`${S} === 0`, LONG);
  await s.waitFor(`!document.body.dataset.laptop && !!document.querySelector('.tag.you')`);
  assert(await s.eval(`__officeCamera.blend === 0 && __officeCamera.ownerVisible()`), 'the laptop goes away and the camera is back over the office');

  // With their back to a wall the camera still sees the laptop from the shoulder. Looking north, the owner walks west (A) into the
  // meeting room until its outer wall stops them, then turns their back to it. One call, so no frame turns the view in between.
  await s.eval(`__office.teleport(${before.x}, ${before.z}, Math.PI); __office.hold('KeyA'); __office.step(6); __office.hold('KeyA', false); __office.step(1)`);
  const wall = await s.eval('__office.state().owner');
  await s.eval(`__office.teleport(${wall.x}, ${wall.z}, ${wall.yaw + Math.PI}); __office.step(0.2)`);
  await s.press('Escape');
  await s.waitFor(`${S} >= 0.9`, LONG);
  const backed = await s.eval('__officeLaptopProbe.blocked()');
  assert(backed === null, `with a wall at their back the camera still sees the laptop (${backed ?? 'clear'})`);
  await s.waitFor(laptop('ready'), LONG);
  await s.press('Escape');
  await s.waitFor(`${S} === 0`, LONG);

  // The same apps as the Mac at the owner's desk.
  await s.eval(`__office.set({ computerState: 'seated', computerView: 'office', portalMode: true })`);
  await s.waitFor(`!!document.querySelector('.mac-portal')`);
  const onDesk = await s.eval(apps('.mac-portal'));
  await s.eval(`__office.set({ computerState: 'away', portalMode: false })`);
  assert(onDesk.length > 3 && JSON.stringify(onLaptop) === JSON.stringify(onDesk), `the laptop has every app of the desk computer (${onLaptop.join(', ')})`);

  // First person: the camera steps out of the owner's eyes to watch them take the laptop out, and back in after.
  await s.press('Tab');
  await s.waitFor(`__officeCamera.blend === 1 && !__officeCamera.ownerVisible()`, LONG);
  await s.press('Escape');
  await s.waitFor(`${S} >= 0.9`, LONG);
  assert(await s.eval('__officeCamera.ownerVisible()'), 'in first person the owner shows while taking the laptop out');
  const firstView = await s.eval('__officeLaptopProbe.blocked()');
  assert(firstView === null, `and the camera sees the laptop from the shoulder (${firstView ?? 'clear'})`);
  await s.shot('laptop-6-first-person');
  await s.waitFor(laptop('ready'), LONG);
  await s.press('Escape');
  await s.waitFor(`${S} === 0`, LONG);
  await s.sleep(300);
  assert(await s.eval(`__officeCamera.blend === 1 && !__officeCamera.ownerVisible()`), 'the camera is back at the eyes when the laptop is away');
  await s.press('Tab');
  await s.waitFor('__officeCamera.blend === 0', LONG);

  // The slot takes it out too, and Live Mac mirror sits the owner at the Mac from wherever they are.
  await s.clickOn('.inv-slot');
  await s.waitFor(laptop('ready'), LONG);
  await s.clickOn('.laptop-frame .mac-action', 'Live Mac mirror');
  await s.waitFor(`${store('computerView')} === 'mirror' && ${store('portalMode')}`);
  assert(await s.eval(`!${laptop('open')} && ${S} === 0 && !!document.querySelector('.mac-mirror-portal')`), 'Live Mac mirror on the laptop opens the mirror and puts the laptop away');
  await s.press('KeyF', 'f');
  await s.waitFor(`!${store('portalMode')}`);
  assert(await s.eval(`${store('computerState')} === 'away'`), 'F leaves the mirror for the office');
};
