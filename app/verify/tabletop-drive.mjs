// What the tabletop scripts share: pointing the build camera at a spot of the office and hovering it with the real mouse, choosing a
// card of the catalog (opening it first when a small thing in hand has folded it down), reading the ghost, and taking shots.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const store = '__office.store.getState()';

export function drive(s, { shots } = {}) {
  const at = (x, y, z) => s.eval(`__office.project(${x}, ${y}, ${z})`);
  const hold = (code, key) => s.key('keyDown', code, key);
  const release = (code, key) => s.key('keyUp', code, key);
  const building = () => s.eval(`${store}.building`);
  const tool = () => s.eval(`${store}.build?.tool ?? null`);
  const level = () => s.eval(`${store}.build?.level ?? 0`);
  const verdict = () => s.eval(`${store}.buildCursor.verdict`);
  const waitBuilding = (expr, label, ms = 6000) =>
    s.waitFor(`(() => { const b = ${store}.building; return ${expr}; })()`, ms).catch(() => {
      throw new Error(label);
    });
  const park = () => s.mouse('mouseMoved', 720, 20);
  const still = async () => {
    let last = null;
    for (let i = 0; i < 40; i++) {
      const c = await s.eval('({ x: __officeCamera.x, z: __officeCamera.z, y: __officeCamera.y })');
      if (last && Math.hypot(c.x - last.x, c.z - last.z, c.y - last.y) < 0.004) return;
      last = c;
      await s.sleep(200);
    }
  };
  // Pans the build camera with the real WASD keys until the point sits where nothing of the HUD covers it.
  const bring = async (x, y, z) => {
    for (let i = 0; i < 80; i++) {
      const p = await at(x, y, z);
      const key = p.x > 1000 ? ['KeyD', 'd'] : p.x < 440 ? ['KeyA', 'a'] : p.y > 560 ? ['KeyS', 's'] : p.y < 260 ? ['KeyW', 'w'] : null;
      if (!key) {
        await still();
        return at(x, y, z);
      }
      await hold(...key);
      await s.sleep(Math.min(400, 120 + Math.abs(p.x > 1000 || p.x < 440 ? p.x - 720 : p.y - 400) / 3));
      await release(...key);
      await s.sleep(350);
    }
    throw new Error(`could not bring ${x}, ${y}, ${z} into view`);
  };
  // Pans until the point is within `tol` pixels of the middle of the screen, so a close view has the thing it is about in the middle of it.
  const centerOn = async (x, y, z, tol = 70) => {
    for (let i = 0; i < 14; i++) {
      const p = await at(x, y, z);
      const [dx, dy] = [p.x - 720, p.y - 400];
      if (Math.hypot(dx, dy) < tol) break;
      const key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ['KeyD', 'd'] : ['KeyA', 'a']) : dy > 0 ? ['KeyS', 's'] : ['KeyW', 'w'];
      await hold(...key);
      await s.sleep(Math.min(350, 70 + Math.max(Math.abs(dx), Math.abs(dy)) / 2.5));
      await release(...key);
      await s.sleep(450);
    }
    await still();
    return at(x, y, z);
  };
  const hoverPx = async (p) => {
    await s.mouse('mouseMoved', p.x - 2, p.y);
    await s.mouse('mouseMoved', p.x, p.y);
    await s.sleep(160);
  };
  const probeOf = async (name) => {
    for (let i = 0; i < 15; i++) {
      const [found] = await s.eval(`__office.probe('${name}')`);
      if (found) return found;
      await s.sleep(80);
    }
    return undefined;
  };
  const waitProbe = async (name, ok) => {
    let last;
    for (let i = 0; i < 25; i++) {
      last = await probeOf(name);
      if (last && ok(last)) return last;
      await s.sleep(80);
    }
    return last;
  };
  const enterBuild = async () => {
    await s.clickOn('[data-testid="build-enter"]');
    await s.waitFor(`!!${store}.build`, 4000);
    await s.sleep(500);
  };
  const exitBuild = async () => {
    await s.clickOn('.bh-done');
    await s.waitFor(`${store}.build === null`, 4000);
  };
  const zoom = async (delta) => {
    await s.eval(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: ${delta}, bubbles: true }))`);
    await s.sleep(700);
    await still();
  };
  const shotTo = async (name) => {
    const path = await s.shot(name);
    if (shots) {
      mkdirSync(shots, { recursive: true });
      copyFileSync(path, join(shots, `${name}.png`));
    }
    return path;
  };
  // A small thing in hand folds the catalog into a bar; the pointer over the bar opens it again, above the bar.
  const openCatalog = async () => {
    const bar = await s.center('.bh-held');
    if (bar) {
      await s.mouse('mouseMoved', bar.x - 40, bar.y);
      await s.mouse('mouseMoved', bar.x, bar.y);
      await s.waitFor(`getComputedStyle(document.querySelector('.bh-panel')).display !== 'none'`, 3000);
    }
  };
  const choose = async (entry, tab = 'tabletop') => {
    await openCatalog();
    await s.clickOn(`[data-tab="${tab}"]`);
    await s.eval(`document.querySelector('[data-entry="${entry}"]').scrollIntoView({ inline: 'center', block: 'nearest' })`);
    await s.sleep(120);
    await s.clickOn(`[data-entry="${entry}"]`);
    await s.sleep(120);
  };
  const turnTo = async (world) => {
    const now = (await tool()).rot;
    for (let n = 0; n < (((world - now) % 4) + 4) % 4; n++) await s.press('Period');
  };
  return { at, hold, release, building, tool, level, verdict, waitBuilding, park, still, bring, centerOn, hoverPx, probeOf, waitProbe, enterBuild, exitBuild, zoom, shotTo, openCatalog, choose, turnTo };
}
