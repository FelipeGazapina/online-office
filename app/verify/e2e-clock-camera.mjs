import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert } from './lib.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'online-office-clock-'));

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
};

const clockCards = (s) => s.eval('[...document.querySelectorAll(".clock-card")].map((card) => ({ zone: card.querySelector(".clock-zone")?.innerText, remove: card.querySelector(".clock-remove")?.getAttribute("aria-label") ?? null }))');
const rects = (s) => s.eval('(() => { const read = (element) => { if (!element) return null; const { top, right, bottom, left, width, height } = element.getBoundingClientRect(); return { top, right, bottom, left, width, height }; }; return { clock: read(document.querySelector(".clock-bar")), waiting: read(document.querySelector(".waiting")), viewport: { width: innerWidth, height: innerHeight } }; })()');

export default async (s, { launch }) => {
  await s.waitFor('__office.store.getState().company !== null');
  await s.waitFor('document.querySelector(".clock-bar") !== null');

  const baseline = await rects(s);
  assert(baseline.clock && baseline.waiting, 'the clock and waiting meter render together');
  const overlap = baseline.clock.left < baseline.waiting.right && baseline.clock.right > baseline.waiting.left && baseline.clock.top < baseline.waiting.bottom && baseline.clock.bottom > baseline.waiting.top;
  assert(!overlap, 'the clock tray leaves the waiting meter readable');

  const openClock = async (driver) => {
    await driver.clickOn('button.clock-toggle');
    await driver.waitFor('document.querySelector(".clock-popover") !== null');
  };
  await openClock(s);

  const add = async (zone) => {
    await s.waitFor('document.querySelector(".clock-add-select select") !== null');
    await s.eval(`(() => { const select = document.querySelector('.clock-add-select select'); select.value = ${JSON.stringify(zone)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await s.waitFor(`document.querySelector('.clock-zone')?.innerText.includes(${JSON.stringify(zone.split('/').at(-1).replaceAll('_', ' '))})`);
  };

  await add('America/New_York');
  await add('Europe/London');
  assert((await clockCards(s)).length === 3, 'the HUD shows the local clock plus two added timezones');
  assert((await s.eval('[...document.querySelectorAll(".clock-card .clock-remove")].length')) === 2, 'each added timezone has its own remove action');

  await s.clickOn('button.clock-remove[aria-label^="Remove "]');
  assert((await clockCards(s)).length === 2, 'removing one timezone leaves the other saved clock visible');

  await s.close();
  const reopened = await launch({ env });
  await reopened.waitFor('__office.store.getState().company !== null');
  await reopened.waitFor('document.querySelector(".clock-bar") !== null');
  await openClock(reopened);
  assert((await clockCards(reopened)).length === 2, 'the remaining timezone persists after restarting the app');

  await reopened.eval('__office.setCamera("iso")');
  await reopened.eval('__office.teleport(-10, 4)');
  await reopened.sleep(1200);
  const center = await reopened.eval('(() => { const p = __office.project(__office.state().owner.x, 1, __office.state().owner.z); return { p, width: innerWidth, height: innerHeight }; })()');
  assert(Math.abs(center.p.x - center.width / 2) < center.width * 0.12, `the owner stays horizontally centered in Overview (${center.p.x.toFixed(0)} vs ${(center.width / 2).toFixed(0)})`);
  assert(Math.abs(center.p.y - center.height / 2) < center.height * 0.18, `the owner stays vertically centered in Overview (${center.p.y.toFixed(0)} vs ${(center.height / 2).toFixed(0)})`);
  await reopened.shot('clock-camera');
};
