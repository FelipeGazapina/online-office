// Overview navigation and the employee menu with real pointer events and a real Claude employee.
// Run: pnpm build && OFFICE_CDP_PORT=9335 node verify/screen-watch.mjs node verify/cdp.mjs verify/e2e-nav.mjs
import { HAIKU, assert, claude, diagnoseClaude, hireClaudeInBlock, logLines, scratch, stepUntil } from './lib.mjs';

const { dataDir, repo } = scratch();

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
  OFFICE_CLAUDE_MODEL: HAIKU,
};

const state = (s) => s.eval('__office.state()');
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const project = (s, x, y, z) => s.eval(`__office.project(${x}, ${y}, ${z})`);
const menuOpen = `!!document.querySelector('.emp-menu')`;
const thread = (s, who) => s.eval(`[...document.querySelectorAll('.thread .msg.${who}')].map((m) => m.innerText)`);

async function overCanvas(s, at, what) {
  const top = await s.eval(`document.elementFromPoint(${at.x}, ${at.y})?.tagName`);
  assert(top === 'CANVAS', `${what} at ${at.x.toFixed(0)},${at.y.toFixed(0)} is not covered by the HUD (${top})`);
}

async function floorClick(s, x, z) {
  const at = await project(s, x, 0, z);
  await overCanvas(s, at, `the floor point (${x}, ${z})`);
  await s.click(at.x, at.y);
  return at;
}

async function settle(s) {
  let prev = null;
  for (let i = 0; i < 40; i++) {
    const { owner } = await state(s);
    const p = await project(s, owner.x, 0, owner.z);
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.5) return;
    prev = p;
    await s.sleep(250);
  }
  throw new Error('the Overview camera never settled');
}

async function chestOf(s) {
  const a = (await state(s)).avatars[0];
  const at = await project(s, a.x, 0.95, a.z);
  await overCanvas(s, at, `${await s.eval(`${claude}.name`)}'s chest`);
  return at;
}

async function menuAt(s, at, what) {
  await s.click(at.x, at.y);
  await s.waitFor(menuOpen);
  await s.sleep(300);
  const menu = await s.eval(`(() => { const r = document.querySelector('.emp-menu').getBoundingClientRect(); return { x: r.left, y: r.top, items: [...document.querySelectorAll('.emp-menu button')].map((b) => b.innerText) }; })()`);
  assert(Math.abs(menu.x - at.x) <= 3 && Math.abs(menu.y - at.y) <= 3, `a click on ${what} opens the menu at the cursor (click ${at.x.toFixed(0)},${at.y.toFixed(0)}, menu ${menu.x.toFixed(0)},${menu.y.toFixed(0)})`);
  return menu;
}

export default async (s) => {
  await hireClaudeInBlock(s, repo);
  const id = await s.eval(`${claude}.id`);
  const name = await s.eval(`${claude}.name`);
  await stepUntil(s, '__office.state().avatars[0].seated', 90000, 'the new hire to walk in and sit at its desk');
  assert((await state(s)).avatars[0].seated, `${name} walked in past the meeting room and sat down at its desk`);

  await s.press('Digit2', '2');
  await s.waitFor(`__office.store.getState().camera === 'iso'`);
  assert((await state(s)).camera === 'iso', 'key 2 switched to the Overview camera');
  await settle(s);

  const target = { x: -12, z: -4.95 };
  await floorClick(s, target.x, target.z);
  await s.waitFor(`__office.state().intent.kind === 'walk'`);
  const walk = (await state(s)).intent;
  assert(walk.goal.kind === 'point' && gap(walk.dest, target) < 0.5, `an Overview floor click starts a walk to that point (ends at ${walk.dest.x.toFixed(2)}, ${walk.dest.z.toFixed(2)})`);
  assert(walk.left >= 2, `with a desk between the owner and the target the route bends (${walk.left} waypoints left)`);
  await s.shot('n1-marker');
  await stepUntil(s, `__office.state().intent.kind === 'keys'`, 60000, 'the walk to the target to end');
  await s.sleep(600);
  const arrived = (await state(s)).owner;
  assert(gap(arrived, target) < 0.5, `the owner ended within 0.5 m of the target (${gap(arrived, target).toFixed(2)} m)`);
  await settle(s);

  const before = await state(s);
  const from = { x: 420, y: 520 };
  await overCanvas(s, from, 'the start of the drag');
  await s.drag(from, { x: 520, y: 520 });
  await s.sleep(400);
  const after = await state(s);
  const turned = Math.abs(after.view.isoYawTarget - before.view.isoYawTarget);
  assert(turned > 0.4 && turned < 0.8, `a 100 px drag turned the Overview by ${turned.toFixed(2)} rad`);
  assert(after.intent.kind === 'keys' && gap(after.owner, before.owner) < 0.02, 'the drag did not walk the owner');
  await settle(s);

  const far = { x: -4, z: 1 };
  await floorClick(s, far.x, far.z);
  await s.waitFor(`__office.state().intent.kind === 'walk'`);
  await s.press('KeyW', 'w');
  assert((await state(s)).intent.kind === 'keys', 'a W key press cancels the walk at once');
  await s.sleep(2500);
  const stopped = (await state(s)).owner;
  assert(gap(stopped, far) > 3, `and the owner does not carry on to the target (${gap(stopped, far).toFixed(1)} m short)`);
  await settle(s);

  const chest = await chestOf(s);
  const opened = await menuAt(s, chest, `${name}'s avatar`);
  assert(opened.items.join('|') === `Open chat|Go to ${name}`, `the menu offers "Open chat" and "Go to ${name}" (${opened.items.join(' | ')})`);
  await s.shot('n1-menu');
  await s.press('Escape');
  await s.waitFor(`!${menuOpen}`);
  assert((await s.eval('__office.store.getState().selectedId')) === null, 'Esc closed the menu and nothing else');

  await menuAt(s, chest, `${name}'s avatar again`);
  await floorClick(s, -6, 3);
  await s.waitFor(`!${menuOpen}`);
  assert((await state(s)).intent.kind === 'keys', 'a click anywhere else closes the menu and does not start a walk');

  const tag = await s.center('button.tag', name);
  await menuAt(s, tag, `${name}'s name tag`);
  await s.press('Escape');
  await s.waitFor(`!${menuOpen}`);

  await menuAt(s, chest, `${name}'s avatar for the walk`);
  await s.clickOn('.emp-menu button', 'Go to');
  await s.waitFor(`__office.state().intent.kind === 'walk'`);
  await stepUntil(s, `__office.state().intent.kind === 'keys'`, 60000, `the walk to ${name} to end`);
  await stepUntil(s, `__office.state().talkingTo === '${id}'`, 8000, `the owner to be talking to ${name}`);
  assert((await state(s)).talkingTo === id, `"Go to ${name}" ends with the owner talking to ${name}`);
  await s.sleep(1200);
  const now = await state(s);
  const there = now.avatars[0];
  const facing = Math.atan2(there.x - now.owner.x, there.z - now.owner.z);
  const off = Math.abs(((now.owner.yaw - facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  assert(off < 0.6, `and the owner faces ${name} (${off.toFixed(2)} rad off)`);
  await settle(s);

  const chest2 = await chestOf(s);
  await menuAt(s, chest2, `${name}'s avatar for the chat`);
  await s.clickOn('.emp-menu button', 'Open chat');
  await s.waitFor(`document.activeElement?.id === 'drawer-input'`);
  assert(await s.eval(`!!document.querySelector('.drawer') && !${menuOpen}`), '"Open chat" opens the drawer and closes the menu');
  assert((await s.eval(`document.activeElement?.id`)) === 'drawer-input', 'and the message input has focus');

  const message = 'Reply with exactly one word, pineapple. Do not use any tools.';
  await s.type(message);
  await s.press('Enter');
  await s.waitFor(`document.querySelectorAll('.thread .msg.owner').length > 0`);
  assert((await thread(s, 'owner')).at(-1) === message, 'the message sent from the chat is the newest line of the transcript');
  assert((await s.eval(`document.getElementById('drawer-input').value`)) === '', 'and the input is empty again');
  await s.waitFor(`[...document.querySelectorAll('.thread .msg.employee')].some((m) => /pineapple/i.test(m.innerText))`, 120000);
  assert((await thread(s, 'employee')).some((t) => /pineapple/i.test(t)), `${name}'s reply shows in the transcript`);
  assert((await logLines(s)).some((l) => l.startsWith('Boss said:') && l.includes('pineapple')), 'the message reached the real employee as something the boss said');
  await s.shot('n1-chat');
};

export const diagnose = (s) => diagnoseClaude(s, 'n1-failure');
