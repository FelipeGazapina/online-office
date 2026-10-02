import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assert } from './lib.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'online-office-hud-'));

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
};

const rects = (s) => s.eval(`(() => {
  const read = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const { width, height, bottom } = element.getBoundingClientRect();
    return { width, height, bottom };
  };
  return {
    clock: read('.clock-toggle'),
    popover: read('.clock-popover'),
    ticket: read('.ticket'),
    chat: read('.chat'),
    tag: read('.tag.you'),
    viewport: { height: innerHeight },
  };
})()`);

export default async (s) => {
  await s.waitFor('document.querySelector(".clock-bar") !== null');
  await s.waitFor('document.querySelector(".tag.you") !== null');

  const closed = await rects(s);
  assert(closed.clock.width <= 148, `the collapsed clock stays compact (${closed.clock.width.toFixed(0)}px wide)`);
  assert(closed.ticket.width <= 210 && closed.ticket.height <= 54, `the waiting meter stays compact (${closed.ticket.width.toFixed(0)}x${closed.ticket.height.toFixed(0)})`);
  assert(closed.chat.width <= 540, `the idle chat bar stays within the compact width (${closed.chat.width.toFixed(0)}px)`);
  assert(closed.chat.bottom <= closed.viewport.height - 16, `the idle chat bar keeps a 16px bottom margin (${(closed.viewport.height - closed.chat.bottom).toFixed(0)}px)`);
  assert(closed.tag.width <= 76 && closed.tag.height <= 22, `the owner tag stays compact (${closed.tag.width.toFixed(0)}x${closed.tag.height.toFixed(0)})`);

  await s.clickOn('button.clock-toggle');
  await s.waitFor('document.querySelector(".clock-popover") !== null');
  const open = await rects(s);
  assert(open.popover.width <= 280, `the expanded clock panel stays within the compact width (${open.popover.width.toFixed(0)}px)`);
  assert(open.popover.height <= 215, `the expanded clock panel stays within the compact height (${open.popover.height.toFixed(0)}px)`);
  await s.shot('hud-compact');
};
