// Keeps the card in hand off the name tags. Every frame while a card is out in the office it reads where the tags are, asks
// `hangCard` where the card and its line can hang, and moves them there with two custom properties of the ghost.
import { hangCard, type Box, type Point } from '../../carry.ts';

// What the card must not cover: every name tag with its bubble, the label on the desk it is over, and the bar.
const AVOID = '.emp-label, .desk-aim, [data-carry-avoid]';
// The card is drawn at this scale once it is out of the board (tasks.css, `.tb-ghost.away`), and its line hangs under it.
export const AWAY_SCALE = 0.58;
const LINE_GAP = 6;

const shown = (el: Element, r: DOMRect) => {
  if (r.width === 0 || r.height === 0) return false;
  const css = getComputedStyle(el);
  return css.visibility !== 'hidden' && css.display !== 'none' && Number(css.opacity) > 0.03;
};

const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

export function tagsOnScreen(): Box[] {
  const out: Box[] = [];
  for (const el of document.querySelectorAll(AVOID)) {
    const r = el.getBoundingClientRect();
    if (shown(el, r) && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight) out.push(boxOf(r));
  }
  return out;
}

// One step. Returns where the card now hangs, to be passed back in on the next frame.
export function hang(ghost: HTMLElement, pointer: Point, prev: Point | null): Point {
  const card = ghost.querySelector<HTMLElement>('.tb-ghost-in');
  const line = ghost.querySelector<HTMLElement>('.tb-ghost-aim');
  if (!card) return prev ?? { x: 12, y: 12 };
  const cw = card.offsetWidth * AWAY_SCALE;
  const ch = card.offsetHeight * AWAY_SCALE;
  const size = { w: Math.max(cw, line?.offsetWidth ?? 0), h: ch + (line ? LINE_GAP + line.offsetHeight : 0) };
  const at = hangCard(pointer, size, tagsOnScreen(), { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, prev);
  if (!prev || at.x !== prev.x || at.y !== prev.y) {
    ghost.style.setProperty('--ox', `${at.x}px`);
    ghost.style.setProperty('--oy', `${at.y}px`);
  }
  ghost.style.setProperty('--ch', `${ch}px`);
  return at;
}
