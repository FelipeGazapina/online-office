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

export default async (s, { launch }) => {
  await s.waitFor('__office.store.getState().company !== null');
  await s.waitFor('document.querySelector("[data-hud-resize-target=clock]") !== null');
  await s.waitFor(`document.querySelector('[aria-label="Resize World clock"]') !== null`);
  await s.waitFor(`document.querySelector('[aria-label="Resize Your name tag"]') !== null`);

  const initial = await rect(s, '.clock-toggle');
  const before = await s.eval('({ owner: __office.state().owner, camera: __office.state().camera })');
  const start = await handle(s, 'World clock');
  assert(initial && start, 'the clock exposes a visible resize handle');
  assert((await s.eval('document.querySelectorAll(".hud-resize-handle").length')) >= 5, 'visible HUD items expose resize handles');
  await s.drag(start, { x: start.x + 90, y: start.y + 90 });
  await s.sleep(300);

  const grown = await rect(s, '.clock-toggle');
  const afterGrow = await s.eval('({ owner: __office.state().owner, camera: __office.state().camera, saved: JSON.parse(localStorage.getItem("online-office.hud-scales") || "{}") })');
  assert(grown.width > initial.width * 1.25, `dragging the clock corner grows the clock (${initial.width.toFixed(0)}px to ${grown.width.toFixed(0)}px)`);
  assert(afterGrow.saved.clock > 1, 'the resized clock scale is persisted on pointerup');
  assert(afterGrow.camera === before.camera, 'resizing does not change the camera mode');
  assert(Math.hypot(afterGrow.owner.x - before.owner.x, afterGrow.owner.z - before.owner.z) < 0.01, 'resizing does not move the player');

  const labelInitial = await rect(s, '[data-hud-resize-target="owner-label"]');
  const labelStart = await handle(s, 'Your name tag');
  await s.drag(labelStart, { x: labelStart.x + 55, y: labelStart.y + 55 });
  await s.sleep(300);
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

  const restoredHandle = await handle(reopened, 'World clock');
  await reopened.drag(restoredHandle, { x: restoredHandle.x - 100, y: restoredHandle.y - 100 });
  await reopened.sleep(300);
  const shrunk = await rect(reopened, '.clock-toggle');
  assert(shrunk.width < restored.width * 0.9, `dragging back shrinks the clock (${restored.width.toFixed(0)}px to ${shrunk.width.toFixed(0)}px)`);
  await reopened.shot('hud-resize');
};
