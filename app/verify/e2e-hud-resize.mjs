import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert } from './lib.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'online-office-hud-resize-'));

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
};

const rect = (s, selector) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const handle = (s, label) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(`[aria-label="Resize ${label}"]`)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const affordance = (s, label) => s.eval(`(() => { const e = document.querySelector(${JSON.stringify(`[aria-label="Resize ${label}"]`)}); if (!e) return null; const style = getComputedStyle(e); return { state: e.dataset.resizeState, opacity: style.opacity, color: style.color, cursor: style.cursor, pointerEvents: style.pointerEvents, boxShadow: style.boxShadow, badge: e.querySelector('.hud-resize-badge')?.textContent ?? null, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height }; })()`);
const waitAffordance = (s, label, state, opacity, ms = 15000) => {
  const selector = `[aria-label="Resize ${label}"]`;
  return s.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e?.dataset.resizeState === ${JSON.stringify(state)} && getComputedStyle(e).opacity === ${JSON.stringify(opacity)}; })()`, ms);
};
const moveToHandle = async (s, label) => {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const point = await handle(s, label);
    assert(point, `${label} has a resize hit area`);
    await s.mouse('mouseMoved', point.x, point.y);
    try {
      await waitAffordance(s, label, 'hover', '1', 1000);
      return point;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${label} did not reveal its resize grip: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};

export default async (s, { launch }) => {
  await s.waitFor('__office.store.getState().company !== null');
  await s.waitFor('document.querySelector("[data-hud-resize-target=clock]") !== null');
  await s.waitFor(`document.querySelector('[aria-label="Resize World clock"]') !== null`);
  await s.waitFor(`document.querySelector('[aria-label="Resize Your name tag"]') !== null`);

  const initial = await rect(s, '.clock-toggle');
  const before = await s.eval('({ owner: __office.state().owner, camera: __office.state().camera })');
  const start = await handle(s, 'World clock');
  const idle = await affordance(s, 'World clock');
  assert(initial && start, 'the clock exposes a resize hit area without changing layout');
  assert(idle?.state === 'idle' && idle.opacity === '0' && idle.badge === null && idle.boxShadow === 'none', 'released resize has no visible handle, badge, or halo');
  assert(idle.cursor === 'default' && idle.pointerEvents === 'auto' && idle.width === 24 && idle.height === 24, 'the idle hit area is limited to the corner');
  assert((await s.eval('document.querySelectorAll(".hud-resize-handle").length')) >= 5, 'visible HUD items expose resize hit areas');

  await moveToHandle(s, 'World clock');
  await waitAffordance(s, 'World clock', 'hover', '1');
  const hover = await affordance(s, 'World clock');
  assert(hover?.state === 'hover' && hover.opacity === '1', 'hover reveals the resize grip');
  assert(hover.cursor === 'nwse-resize' && hover.boxShadow !== 'none' && hover.color === 'rgb(85, 223, 255)', 'hover uses a cyan grip, halo, and resize cursor');
  await s.shot('hud-resize-hover');

  const activeStart = await handle(s, 'World clock');
  await s.mouse('mousePressed', activeStart.x, activeStart.y, 1);
  await s.mouse('mouseMoved', activeStart.x + 90, activeStart.y + 90, 1);
  await waitAffordance(s, 'World clock', 'active-drag', '1');
  const active = await affordance(s, 'World clock');
  assert(active?.state === 'active-drag' && active.badge?.endsWith('%'), 'active drag exposes its current percentage badge');
  assert(active.opacity === '1' && active.cursor === 'nwse-resize' && active.boxShadow !== 'none' && active.color === 'rgb(255, 189, 86)', 'active drag keeps the amber grip and halo');
  const grownDuringDrag = await rect(s, '.clock-toggle');
  assert(grownDuringDrag.width > initial.width * 1.25, `dragging the clock corner grows the clock (${initial.width.toFixed(0)}px to ${grownDuringDrag.width.toFixed(0)}px)`);
  await s.shot('hud-resize-active');
  await s.mouse('mouseReleased', activeStart.x + 90, activeStart.y + 90);
  await waitAffordance(s, 'World clock', 'idle', '0');

  const grown = await rect(s, '.clock-toggle');
  const afterGrow = await s.eval('({ owner: __office.state().owner, camera: __office.state().camera, saved: JSON.parse(localStorage.getItem("online-office.hud-scales") || "{}") })');
  const released = await affordance(s, 'World clock');
  assert(released?.state === 'idle' && released.opacity === '0' && released.badge === null && released.boxShadow === 'none', 'pointerup persists the value and clears every highlight');
  assert(grown.width > initial.width * 1.25, `the released clock remains grown (${initial.width.toFixed(0)}px to ${grown.width.toFixed(0)}px)`);
  assert(afterGrow.saved.clock > 1, 'the resized clock scale is persisted on pointerup');
  assert(afterGrow.camera === before.camera, 'resizing does not change the camera mode');
  assert(Math.hypot(afterGrow.owner.x - before.owner.x, afterGrow.owner.z - before.owner.z) < 0.01, 'resizing does not move the player');

  const savedScale = afterGrow.saved.clock;
  await moveToHandle(s, 'World clock');
  await waitAffordance(s, 'World clock', 'hover', '1');
  const escapeStart = await handle(s, 'World clock');
  await s.mouse('mousePressed', escapeStart.x, escapeStart.y, 1);
  await s.mouse('mouseMoved', escapeStart.x - 70, escapeStart.y - 70, 1);
  await waitAffordance(s, 'World clock', 'active-drag', '1');
  const beforeEscape = await rect(s, '.clock-toggle');
  await s.press('Escape');
  await waitAffordance(s, 'World clock', 'idle', '0');
  const afterEscape = await rect(s, '.clock-toggle');
  const escapeState = await affordance(s, 'World clock');
  assert(escapeState?.state === 'idle' && escapeState.opacity === '0' && escapeState.badge === null, 'Escape cancels the drag and clears the affordance');
  assert(afterEscape.width > beforeEscape.width * 1.05 && Math.abs(afterEscape.width - grown.width) < 2, 'Escape restores the scale that was committed before the drag');
  assert((await s.eval('JSON.parse(localStorage.getItem("online-office.hud-scales") || "{}").clock')) === savedScale, 'Escape leaves the persisted scale unchanged');

  await moveToHandle(s, 'World clock');
  await waitAffordance(s, 'World clock', 'hover', '1');
  const pointerCancelStart = await handle(s, 'World clock');
  await s.mouse('mousePressed', pointerCancelStart.x, pointerCancelStart.y, 1);
  await s.mouse('mouseMoved', pointerCancelStart.x - 60, pointerCancelStart.y - 60, 1);
  await waitAffordance(s, 'World clock', 'active-drag', '1');
  await s.eval('window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }))');
  await waitAffordance(s, 'World clock', 'idle', '0');
  const pointerCancelState = await affordance(s, 'World clock');
  assert(pointerCancelState?.state === 'idle' && pointerCancelState.opacity === '0' && pointerCancelState.badge === null, 'pointercancel restores the committed scale and clears the affordance');

  const labelInitial = await rect(s, '[data-hud-resize-target="owner-label"]');
  await moveToHandle(s, 'Your name tag');
  await waitAffordance(s, 'Your name tag', 'hover', '1');
  const labelDragStart = await handle(s, 'Your name tag');
  await s.mouse('mousePressed', labelDragStart.x, labelDragStart.y, 1);
  await s.mouse('mouseMoved', labelDragStart.x + 55, labelDragStart.y + 55, 1);
  await waitAffordance(s, 'Your name tag', 'active-drag', '1');
  await s.mouse('mouseReleased', labelDragStart.x + 55, labelDragStart.y + 55);
  await waitAffordance(s, 'Your name tag', 'idle', '0');
  const labelGrown = await rect(s, '[data-hud-resize-target="owner-label"]');
  const afterLabel = await s.eval('({ owner: __office.state().owner, camera: __office.state().camera })');
  assert(labelGrown.width > labelInitial.width * 1.15, `a projected player label also resizes (${labelInitial.width.toFixed(0)}px to ${labelGrown.width.toFixed(0)}px)`);
  assert(afterLabel.camera === before.camera && Math.hypot(afterLabel.owner.x - before.owner.x, afterLabel.owner.z - before.owner.z) < 0.01, 'resizing a projected label leaves the player and camera unchanged');

  await s.close();
  const reopened = await launch({ env });
  await reopened.waitFor('__office.store.getState().company !== null');
  await reopened.waitFor('document.querySelector(".clock-toggle") !== null');
  const restored = await rect(reopened, '.clock-toggle');
  assert(restored.width > initial.width * 1.25, `the clock scale survives an app restart (${restored.width.toFixed(0)}px)`);

  await moveToHandle(reopened, 'World clock');
  await waitAffordance(reopened, 'World clock', 'hover', '1');
  const restoredDragStart = await handle(reopened, 'World clock');
  await reopened.drag(restoredDragStart, { x: restoredDragStart.x - 100, y: restoredDragStart.y - 100 });
  await waitAffordance(reopened, 'World clock', 'idle', '0');
  const shrunk = await rect(reopened, '.clock-toggle');
  const restoredState = await affordance(reopened, 'World clock');
  assert(restoredState?.state === 'idle' && restoredState.opacity === '0' && restoredState.badge === null, 'a real drag release clears the restored affordance');
  assert(shrunk.width < restored.width * 0.9, `dragging back shrinks the clock (${restored.width.toFixed(0)}px to ${shrunk.width.toFixed(0)}px)`);
  await reopened.shot('hud-resize');
};
