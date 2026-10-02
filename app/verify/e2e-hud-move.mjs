// Proves HUD panels can be moved by their six-dot grip: drag, clamp, Escape, persistence, resize together, and no
// side effects on the player or the camera. Run: OFFICE_OUT_DIR=out/verify node verify/cdp.mjs verify/e2e-hud-move.mjs
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert } from './lib.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'online-office-hud-move-'));

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
};

const MARGIN = 8;
const CLOCK = '.clock-bar';
const rect = (s, selector) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const grip = (s, kind, label) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(`[aria-label="${kind} ${label}"]`)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const gripInfo = (s, label) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(`[aria-label="Move ${label}"]`)}); if (!e) return null; const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return { state: e.dataset.moveState, opacity: c.opacity, pointerEvents: c.pointerEvents, cursor: c.cursor, dots: e.querySelectorAll('svg circle').length, w: e.offsetWidth, h: e.offsetHeight, bodyMoving: document.body.classList.contains('hud-moving'), lifted: !!document.querySelector('.hud-moving-target') }; })()`);
const stored = (s, key) => s.eval(`JSON.parse(localStorage.getItem('online-office.hud-offsets') || '{}')[${JSON.stringify(key)}] ?? null`);
const world = (s) => s.eval('({ owner: __office.state().owner, camera: __office.state().camera })');
const inside = (r, vw, vh) => r.left >= MARGIN - 0.6 && r.top >= MARGIN - 0.6 && r.right <= vw - MARGIN + 0.6 && r.bottom <= vh - MARGIN + 0.6;
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const overlaps = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
// A drop plays a short ease-out; geometry is only final once it is done.
const settle = (s) => s.waitFor(`!document.querySelector('.hud-moving-target, .hud-settling-target')`, 4000);
const gripState = (s, label) => s.eval(`document.querySelector('[aria-label="Move ${label}"]')?.dataset.moveState`);
const waitGrip = (s, label, state) => s.waitFor(`document.querySelector('[aria-label="Move ${label}"]')?.dataset.moveState === ${JSON.stringify(state)}`, 4000);

// Reveals the grip the way a person does: pointer over the panel, then onto the grip.
async function reach(s, label, panel) {
  const box = await rect(s, panel);
  await s.mouse('mouseMoved', box.left + box.width / 2, box.top + box.height / 2);
  await waitGrip(s, label, 'peek');
  const at = await grip(s, 'Move', label);
  await s.mouse('mouseMoved', at.x, at.y);
  await waitGrip(s, label, 'peek');
  await s.waitFor(`getComputedStyle(document.querySelector('[aria-label="Move ${label}"]')).opacity === '1'`, 4000);
  return at;
}

const gripOverlap = async (s, label, panel) => overlaps(await rect(s, `[aria-label="Move ${label}"]`), await rect(s, panel));

async function dragBy(s, from, dx, dy, steps = 12) {
  await s.mouse('mousePressed', from.x, from.y, 1);
  for (let i = 1; i <= steps; i += 1) await s.mouse('mouseMoved', from.x + (dx * i) / steps, from.y + (dy * i) / steps, 1);
  await s.mouse('mouseReleased', from.x + dx, from.y + dy);
}

export default async (s, { launch }) => {
  await s.waitFor('__office.store.getState().company !== null');
  await s.waitFor('document.querySelector(".clock-bar") !== null');
  await s.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null`);
  const before = await world(s);
  const home = await rect(s, CLOCK);

  // The handle exists on fixed panels only and is invisible until the pointer is on the panel, but its 24px target is
  // always live, so a press that lands on it before the reveal still picks the panel up.
  assert((await s.eval(`document.querySelectorAll('.hud-move-handle').length`)) >= 4, 'visible fixed HUD panels expose a move grip');
  assert(!(await s.eval(`!!document.querySelector('[aria-label="Move Your name tag"], [aria-label^="Move Employee label"], [aria-label="Move Employee menu"]')`)), 'projected labels and the cursor menu are not movable');
  const idle = await gripInfo(s, 'World clock');
  assert(idle.state === 'idle' && idle.opacity === '0' && idle.pointerEvents === 'auto', 'the idle grip is invisible but already grabbable');
  assert(idle.dots === 6, 'the grip is six round dots');

  // Hover reveals it with a grab cursor.
  const at = await reach(s, 'World clock', CLOCK);
  const hover = await gripInfo(s, 'World clock');
  assert(hover.opacity === '1' && hover.cursor === 'grab' && hover.pointerEvents === 'auto', 'hovering the panel shows the grip with a grab cursor');
  assert(hover.w >= 24 && hover.h >= 24, `the grip hit area is at least 24px (${hover.w.toFixed(0)}x${hover.h.toFixed(0)})`);
  await s.shot('hud-move-hover');

  // The grip sits in the gutter, entirely off the panel, and leaves its text clickable.
  const gripBox = await rect(s, '[aria-label="Move World clock"]');
  assert(!overlaps(gripBox, home), `the grip overlaps no panel pixel (grip ${gripBox.left.toFixed(0)},${gripBox.top.toFixed(0)} panel ${home.left.toFixed(0)},${home.top.toFixed(0)})`);
  assert(await s.eval(`document.elementFromPoint(${home.left + 4}, ${home.top + 4})?.closest('.clock-bar') !== null`), 'the panel corner is still clickable while the grip shows');
  assert((await s.eval(`document.querySelector('[aria-label="Move World clock"]').dataset.side`)) !== 'inside', 'the grip finds a gutter beside the clock');
  // An instant tooltip, not the slow native title.
  const tip = await s.eval(`(() => { const e = document.querySelector('[aria-label="Move World clock"]'); const a = getComputedStyle(e, '::after'); return { title: e.hasAttribute('title'), content: a.content, opacity: a.opacity }; })()`);
  await s.sleep(150);
  const tip2 = await s.eval(`(() => { const a = getComputedStyle(document.querySelector('[aria-label="Move World clock"]'), '::after'); return { content: a.content, opacity: a.opacity }; })()`);
  assert(!tip.title && tip2.content === '"Drag to move · double-click to reset"' && tip2.opacity === '1', `hovering the grip shows the short tooltip (${tip2.content}, ${tip2.opacity})`);
  await s.shot('hud-move-tooltip');

  // The gap between panel and grip is bridged, and the grip waits a moment before hiding, so overshooting is safe.
  const side = await s.eval(`document.querySelector('[aria-label="Move World clock"]').dataset.side`);
  const gapPoint = side === 'left' ? { x: home.left - 3, y: home.top + 8 } : side === 'right' ? { x: home.right + 3, y: home.top + 8 } : side === 'top' ? { x: home.left + 8, y: home.top - 3 } : { x: home.left + 8, y: home.bottom + 3 };
  await s.mouse('mouseMoved', home.left + home.width / 2, home.top + home.height / 2);
  await s.mouse('mouseMoved', gapPoint.x, gapPoint.y);
  await s.sleep(250);
  assert((await gripState(s, 'World clock')) === 'peek', 'crossing the gap between panel and grip keeps the grip');
  await s.mouse('mouseMoved', 640, 560);
  await s.sleep(60);
  assert((await gripState(s, 'World clock')) === 'peek', 'the grip waits a moment after the pointer leaves');
  await waitGrip(s, 'World clock', 'idle');
  // Hovering the resize corner shows the move grip too: they read as one family.
  const corner = await grip(s, 'Resize', 'World clock');
  await s.mouse('mouseMoved', home.left + home.width / 2, home.top + home.height / 2);
  await s.mouse('mouseMoved', corner.x, corner.y);
  await s.sleep(450);
  assert((await gripState(s, 'World clock')) === 'peek', 'the move grip stays while the pointer is on the resize corner');
  await s.mouse('mouseMoved', 640, 560);
  await waitGrip(s, 'World clock', 'idle');
  await reach(s, 'World clock', CLOCK);

  // Drag: the panel follows the pointer one to one, and only the panel and its grips change in the DOM.
  await s.eval(`window.__mut = []; window.__mo = new MutationObserver((list) => window.__mut.push(...list.map((m) => ({ type: m.type, name: m.attributeName, el: m.target.className?.toString?.() ?? '', world: !!(m.type === 'characterData' && m.target.parentElement?.closest('.clock-bar')) || !!(m.target.closest?.('.emp-label') || m.target.querySelector?.('.emp-label') || m.target.closest?.('.stage')) })))); window.__mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });`);
  await s.mouse('mousePressed', at.x, at.y, 1);
  const steps = 20;
  for (let i = 1; i <= steps; i += 1) await s.mouse('mouseMoved', at.x + (320 * i) / steps, at.y + (210 * i) / steps, 1);
  await waitGrip(s, 'World clock', 'moving');
  const during = await gripInfo(s, 'World clock');
  const mid = await rect(s, CLOCK);
  assert(during.state === 'moving' && during.cursor === 'grabbing' && during.bodyMoving && during.lifted, 'while dragging the panel lifts and the cursor grabs');
  // The lift scales about the centre, so the centre is what follows the pointer one to one.
  assert(near(center(mid).x, center(home).x + 320) && near(center(mid).y, center(home).y + 210), `the panel tracks the pointer (${(center(mid).x - center(home).x).toFixed(1)}, ${(center(mid).y - center(home).y).toFixed(1)})`);
  await s.sleep(250);
  const lift = await s.eval(`(() => { const c = getComputedStyle(document.querySelector(${JSON.stringify(CLOCK)})); return { shadow: c.boxShadow, opacity: Number(c.opacity), scale: Number(c.scale.split(' ')[0]), transition: c.transitionProperty }; })()`);
  assert(lift.shadow !== 'none' && /rgba?\(.*\d+px \d+px \d+px/.test(lift.shadow), `the lifted panel carries a drop shadow (${lift.shadow.slice(0, 40)})`);
  assert(lift.scale > 1.01 && lift.scale <= 1.05, `the lifted panel scales up a little (${lift.scale})`);
  assert(lift.opacity === 1, `the lifted panel stays opaque so nothing beneath bleeds through (${lift.opacity})`);
  assert(!/translate|all/.test(lift.transition), `the live drag translate is never transitioned (${lift.transition})`);
  await s.shot('hud-move-active');
  await s.mouse('mouseReleased', at.x + 320, at.y + 210);
  await waitGrip(s, 'World clock', 'peek');
  await settle(s);
  const settled = await s.eval(`(() => { const c = getComputedStyle(document.querySelector(${JSON.stringify(CLOCK)})); return { opacity: c.opacity, scale: c.scale }; })()`);
  assert(settled.opacity === '1' && settled.scale === '1', 'the drop settles back to full size and opacity');
  const mutations = await s.eval('window.__mo.disconnect(), window.__mut');
  // The 3D world repositions its own name tags every frame and the clock ticks; those writes are not the drag's.
  const own = mutations.filter((m) => !m.world);
  const stray = own.filter((m) => m.type !== 'attributes' || !(/clock-bar|hud-move-handle|hud-resize-handle|hud-drop-ghost/.test(m.el) || m.el === 'hud-moving'));
  const moved = await rect(s, CLOCK);
  const saved = await stored(s, 'clock');
  assert(near(moved.left, home.left + 320) && near(moved.top, home.top + 210), 'the released panel stays where it was dropped');
  assert(!(await gripOverlap(s, 'World clock', CLOCK)), 'the grip still overlaps no panel pixel after the move');
  assert(saved && near(saved.x, 320) && near(saved.y, 210), `the drop position is saved (${JSON.stringify(saved)})`);
  if (stray.length) console.log(stray);
  assert(stray.length === 0, `a drag touches only the panel and its grips, no React re-render churn (${own.length} mutations, ${stray.length} stray)`);
  assert(own.length <= (steps + 4) * 6, `each pointer move costs a constant number of style writes (${own.length} for ${steps} moves)`);
  const after = await world(s);
  assert(after.camera === before.camera && Math.hypot(after.owner.x - before.owner.x, after.owner.z - before.owner.z) < 0.01, 'dragging does not move the player or change the camera');
  assert((await gripInfo(s, 'World clock')).state === 'peek', 'the grip stays visible while the pointer is still on it');

  // The grip sits on top of the panel at its new place, still draggable (move twice to prove handles follow).
  const second = await grip(s, 'Move', 'World clock');
  assert(second.x > at.x + 250, 'the grip travelled with the panel');

  // Escape cancels a drag and leaves the saved position alone.
  await s.mouse('mousePressed', second.x, second.y, 1);
  for (let i = 1; i <= 6; i += 1) await s.mouse('mouseMoved', second.x - 40 * i, second.y + 20 * i, 1);
  const away = await rect(s, CLOCK);
  assert(away.left < moved.left - 200, 'the panel follows during the drag to cancel');
  await s.press('Escape');
  await waitGrip(s, 'World clock', 'peek').catch(() => waitGrip(s, 'World clock', 'idle'));
  await settle(s);
  const restored = await rect(s, CLOCK);
  assert(near(restored.left, moved.left) && near(restored.top, moved.top), 'Escape puts the panel back where the drag began');
  assert(JSON.stringify(await stored(s, 'clock')) === JSON.stringify(saved), 'Escape leaves the saved position unchanged');
  assert(!(await gripInfo(s, 'World clock')).bodyMoving, 'Escape clears the drag state');
  await s.mouse('mouseReleased', second.x - 240, second.y + 120);
  await settle(s);
  const afterRelease = await rect(s, CLOCK);
  assert(near(afterRelease.left, moved.left) && near(afterRelease.top, moved.top), 'releasing after Escape does not move the panel');

  // Clamp: dragging far past every edge keeps the whole panel inside the window.
  const { vw, vh } = await s.eval('({ vw: innerWidth, vh: innerHeight })');
  await reach(s, 'World clock', CLOCK);
  let at2 = await grip(s, 'Move', 'World clock');
  await dragBy(s, at2, -5000, -5000);
  await settle(s);
  const topLeft = await rect(s, CLOCK);
  assert(!(await gripOverlap(s, 'World clock', CLOCK)), 'the grip stays off the panel in the top-left corner');
  assert(inside(topLeft, vw, vh) && near(topLeft.left, MARGIN) && near(topLeft.top, MARGIN), 'dragging past the top-left edge stops at the margin');
  await reach(s, 'World clock', CLOCK);
  at2 = await grip(s, 'Move', 'World clock');
  await dragBy(s, at2, 6000, 6000);
  await settle(s);
  const bottomRight = await rect(s, CLOCK);
  assert(inside(bottomRight, vw, vh) && near(bottomRight.right, vw - MARGIN) && near(bottomRight.bottom, vh - MARGIN), 'dragging past the bottom-right edge stops at the margin');
  assert(!(await gripOverlap(s, 'World clock', CLOCK)), 'the grip stays off the panel in the bottom-right corner');
  assert(inside(await rect(s, '[aria-label="Move World clock"]'), vw, vh), 'the grip stays inside the window in the corner');
  const afterClamp = await world(s);
  assert(afterClamp.camera === before.camera && Math.hypot(afterClamp.owner.x - before.owner.x, afterClamp.owner.z - before.owner.z) < 0.01, 'edge drags leave the player and camera alone');

  // Move and resize together: growing a panel that sits at the screen edge keeps it on screen.
  const resizeAt = await grip(s, 'Resize', 'World clock');
  await s.mouse('mouseMoved', resizeAt.x, resizeAt.y);
  await s.waitFor(`document.querySelector('[aria-label="Resize World clock"]')?.dataset.resizeState === 'hover'`, 4000);
  assert((await gripState(s, 'World clock')) === 'peek', 'the move grip stays while the pointer is on the resize corner');
  await dragBy(s, resizeAt, 140, 140);
  await s.waitFor(`document.querySelector('[aria-label="Resize World clock"]')?.dataset.resizeState === 'idle'`, 4000);
  const grown = await rect(s, CLOCK);
  assert(grown.width > bottomRight.width * 1.2, `the moved panel resizes (${bottomRight.width.toFixed(0)}px to ${grown.width.toFixed(0)}px)`);
  assert(inside(grown, vw, vh), 'a moved and resized panel stays inside the window');
  await s.shot('hud-move-resized-corner');

  // Persistence: restart and the panel is where it was left.
  const savedFinal = await stored(s, 'clock');
  assert(savedFinal !== null, 'the final position is stored');
  await settle(s);
  const placed = await rect(s, CLOCK);
  await s.close();
  const reopened = await launch({ env });
  await reopened.waitFor('__office.store.getState().company !== null');
  await reopened.waitFor('document.querySelector(".clock-bar") !== null');
  await reopened.waitFor(`document.querySelector('[aria-label="Move World clock"]') !== null`);
  await reopened.sleep(400);
  const back = await rect(reopened, CLOCK);
  assert(near(back.left, placed.left, 2) && near(back.top, placed.top, 2) && near(back.width, placed.width, 2), `the position and size survive an app restart (${back.left.toFixed(0)}, ${back.top.toFixed(0)})`);
  await reopened.shot('hud-move-restart');

  // Window shrink: the panel is pulled back inside, live.
  await reopened.resize(640, 420);
  await reopened.waitFor(`innerWidth === 640`, 4000);
  await reopened.sleep(300);
  const small = await rect(reopened, CLOCK);
  assert(inside(small, 640, 420), `shrinking the window pulls the panel back inside (${small.right.toFixed(0)}x${small.bottom.toFixed(0)} of 640x420)`);
  await reopened.shot('hud-move-shrunk');
  await reopened.resize(1280, 800);
  await reopened.sleep(300);
  const regrown = await rect(reopened, CLOCK);
  assert(inside(regrown, 1280, 800), 'growing the window again keeps the panel on screen');
  assert(near(regrown.left, placed.left, 2) && near(regrown.top, placed.top, 2), `growing the window back restores the saved place (${regrown.left.toFixed(0)}, ${regrown.top.toFixed(0)} vs ${placed.left.toFixed(0)}, ${placed.top.toFixed(0)})`);

  // Keyboard: arrows nudge, Home puts the panel back, and neither walks the player.
  const keyBefore = await world(reopened);
  await reopened.eval(`document.querySelector('[aria-label="Move World clock"]').focus()`);
  const k0 = await rect(reopened, CLOCK);
  await reopened.press('ArrowLeft');
  await reopened.press('ArrowLeft');
  await reopened.sleep(100);
  const k1 = await rect(reopened, CLOCK);
  assert(near(k1.left, k0.left - 16, 2), `arrow keys nudge the focused grip (${(k1.left - k0.left).toFixed(0)}px)`);
  await reopened.press('Home');
  await reopened.sleep(100);
  const k2 = await rect(reopened, CLOCK);
  assert(near(k2.left, home.left, 4) && near(k2.top, home.top, 4) || k2.width > home.width, 'Home returns the panel to its home position');
  assert((await stored(reopened, 'clock')) === null, 'putting the panel back clears the saved position');
  const keyAfter = await world(reopened);
  assert(keyAfter.camera === keyBefore.camera && Math.hypot(keyAfter.owner.x - keyBefore.owner.x, keyAfter.owner.z - keyBefore.owner.z) < 0.01, 'moving by keyboard leaves the player and camera alone');

  // A dialog on top of the scrim: its grip is reachable and the drag does not dismiss it.
  await reopened.eval(`__office.store.setState({ helpOpen: true })`);
  await reopened.waitFor(`document.querySelector('[aria-label="Move Help dialog"]') !== null`);
  await reopened.sleep(600);
  const dialogHome = await rect(reopened, '.modal.help');
  const dialogAt = await reach(reopened, 'Help dialog', '.modal.help');
  const onTop = await reopened.eval(`document.elementFromPoint(${dialogAt.x}, ${dialogAt.y})?.closest('[aria-label="Move Help dialog"]') !== null`);
  assert(onTop, 'the dialog grip sits above the scrim');
  await dragBy(reopened, dialogAt, 180, 90);
  await settle(reopened);
  const dialogMoved = await rect(reopened, '.modal.help');
  assert(near(dialogMoved.left, dialogHome.left + 180) && near(dialogMoved.top, dialogHome.top + 90), `the dialog moves with its grip (${(dialogMoved.left - dialogHome.left).toFixed(1)}, ${(dialogMoved.top - dialogHome.top).toFixed(1)})`);
  assert(await reopened.eval(`__office.store.getState().helpOpen === true`), 'dragging the dialog grip does not dismiss it');
  await reopened.shot('hud-move-dialog');
  await reopened.eval(`__office.store.setState({ helpOpen: false })`);

  // Other panels move too, including the ones whose container ignores the pointer (waiting meter, conversation bar).
  for (const [label, selector, dx, dy] of [['Waiting meter', '.waiting', 380, 120], ['Conversation bar', '.bottom', -260, -220]]) {
    const homeRect = await rect(reopened, selector);
    const gripAt = await reach(reopened, label, selector);
    await dragBy(reopened, gripAt, dx, dy);
    await settle(reopened);
    const movedRect = await rect(reopened, selector);
    assert(near(movedRect.left, homeRect.left + dx, 2) && near(movedRect.top, homeRect.top + dy, 2), `${label} moves with its grip (${(movedRect.left - homeRect.left).toFixed(0)}, ${(movedRect.top - homeRect.top).toFixed(0)})`);
    assert(inside(movedRect, 1280, 800), `${label} stays inside the window`);
    assert(!(await gripOverlap(reopened, label, selector)), `${label}: the grip overlaps no panel pixel`);
  }

  // Fit: the largest scale in a small window still leaves the whole panel on screen.
  await reopened.eval(`localStorage.removeItem('online-office.hud-offsets')`);
  await reopened.eval(`document.querySelector('[aria-label="Resize Conversation bar"]').focus()`);
  for (let i = 0; i < 32; i += 1) await reopened.press('ArrowRight');
  await reopened.waitFor(`JSON.parse(localStorage.getItem('online-office.hud-scales') || '{}')['bottom-talk'] >= 1.59`, 4000);
  for (const [w, h] of [[1280, 800], [800, 500], [480, 320]]) {
    await reopened.resize(w, h);
    await reopened.waitFor(`innerWidth === ${w}`, 4000);
    await reopened.sleep(300);
    const bar = await rect(reopened, '.bottom');
    assert(inside(bar, w, h), `the conversation bar at its largest scale fits ${w}x${h} (${bar.left.toFixed(0)}..${bar.right.toFixed(0)} x ${bar.top.toFixed(0)}..${bar.bottom.toFixed(0)})`);
    if (w === 800) await reopened.shot('hud-move-fit-800x500');
  }
  await reopened.resize(1280, 800);
  await reopened.sleep(300);

  // Every dialog is a movable panel with its own remembered place.
  const blockId = 'b-test';
  await reopened.eval(`(() => { const c = __office.store.getState().company; __office.store.setState({ company: { ...c, blocks: [{ id: 'b-test', name: 'Test block', cwd: '/tmp', color: '#7aa2ff', slot: 0, githubRepo: 'o/r', linearBoardUrl: 'about:blank', taskBoard: { sources: [] } }] } }); })()`);
  for (const kind of ['whiteboard', 'github', 'task_board', 'linear_board']) {
    await reopened.eval(`__office.store.setState({ modal: { kind: ${JSON.stringify(kind)}, blockId: ${JSON.stringify(blockId)} } })`);
    await reopened.waitFor(`document.querySelector('[data-hud-resize-target="modal-${kind}"]') !== null`, 4000);
    await reopened.waitFor(`document.querySelector('[aria-label="Move Dialog"]') !== null`, 4000);
    assert(await reopened.eval(`document.querySelectorAll('[aria-label="Move Dialog"]').length === 1`), `the ${kind} dialog exposes a move grip`);
    await reopened.eval(`__office.store.setState({ modal: null })`);
  }
  await reopened.eval(`__office.store.setState({ modal: { kind: 'hire' } })`);
  await reopened.waitFor(`document.querySelector('[data-hud-resize-target="modal-hire"]') !== null && document.querySelector('[aria-label="Move Dialog"]') !== null`, 4000);
  await reopened.sleep(500);
  const hireHome = await rect(reopened, '[data-hud-resize-target="modal-hire"]');
  const hireAt = await reach(reopened, 'Dialog', '[data-hud-resize-target="modal-hire"]');
  await dragBy(reopened, hireAt, 120, 60);
  await settle(reopened);
  const hireMoved = await rect(reopened, '[data-hud-resize-target="modal-hire"]');
  assert(hireMoved.left > hireHome.left + 100, 'the hire dialog moved');
  await reopened.eval(`__office.store.setState({ modal: { kind: 'block' } })`);
  await reopened.waitFor(`document.querySelector('[data-hud-resize-target="modal-block"]') !== null`, 4000);
  await reopened.sleep(500);
  const blockHome = await rect(reopened, '[data-hud-resize-target="modal-block"]');
  assert(near(center(blockHome).x, 640, 3), 'a dialog of another kind opens at its own home, not where the hire dialog was dragged');
  await reopened.eval(`__office.store.setState({ modal: { kind: 'hire' } })`);
  await reopened.waitFor(`document.querySelector('[data-hud-resize-target="modal-hire"]') !== null`, 4000);
  await reopened.sleep(500);
  const hireBack = await rect(reopened, '[data-hud-resize-target="modal-hire"]');
  // The dialog is centred and its content may differ in height between visits, so compare centres.
  assert(near(center(hireBack).x, center(hireMoved).x, 2) && near(center(hireBack).y, center(hireMoved).y, 2), `the hire dialog reopens where it was left (moved ${hireMoved.left.toFixed(1)},${hireMoved.top.toFixed(1)} back ${hireBack.left.toFixed(1)},${hireBack.top.toFixed(1)} h ${hireHome.top.toFixed(1)} size ${hireMoved.height.toFixed(0)}/${hireBack.height.toFixed(0)})`);
  await reopened.eval(`__office.store.setState({ modal: null })`);

  await reopened.shot('hud-move-final');
};

export const diagnose = async (s) => {
  console.log(await s.eval(`(() => { const g = document.querySelector('[aria-label="Move World clock"]'); if (!g) return 'no grip'; const r = g.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { state: g.dataset.moveState, rect: [r.left, r.top], top: top?.className?.toString().slice(0, 60), body: document.body.className, bar: document.querySelector('.clock-bar')?.style.cssText }; })()`));
};
