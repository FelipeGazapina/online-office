// What a task card in hand needs besides the desk it is over: where it hangs so it never sits on a name tag, and what the
// bar at the bottom says about letting go. Pure, so verify/desk-drop-check.ts runs it in Node. The board folds away while a
// card is carried, so the office is all there is to read, and the card must not hide the people it is about to go to.
import { STAGE_LABEL } from './boardView.ts';
import type { TaskStage } from '../../shared/tasks.ts';
import type { Aim } from './deskDrop.ts';

export type Box = { left: number; top: number; right: number; bottom: number };
export type Point = { x: number; y: number };
export type Size = { w: number; h: number };

// How far the card keeps from a tag, and from the edge of the window. The card is tilted a little, which moves its corners.
const PAD = 12;
const EDGE = 8;

// Rings of increasing distance from the pointer. Within a ring the first free slot in this order wins: where the card
// hangs by default (below and to the right, like something held in a hand), then the other corners, then the sides.
const GAPS = [14, 40, 80, 130, 200, 300] as const;
const SLOTS: readonly ((g: number, s: Size) => Point)[] = [
  (g) => ({ x: g, y: g }),
  (g, s) => ({ x: -s.w - g, y: g }),
  (g, s) => ({ x: g, y: -s.h - g }),
  (g, s) => ({ x: -s.w - g, y: -s.h - g }),
  (g, s) => ({ x: g, y: -s.h / 2 }),
  (g, s) => ({ x: -s.w - g, y: -s.h / 2 }),
  (g, s) => ({ x: -s.w / 2, y: g }),
  (g, s) => ({ x: -s.w / 2, y: -s.h - g }),
];

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

const boxAt = (pointer: Point, at: Point, size: Size): Box => ({ left: pointer.x + at.x, top: pointer.y + at.y, right: pointer.x + at.x + size.w, bottom: pointer.y + at.y + size.h });

const inside = (b: Box, bounds: Box) => b.left >= bounds.left + EDGE && b.top >= bounds.top + EDGE && b.right <= bounds.right - EDGE && b.bottom <= bounds.bottom - EDGE;

// Where the top-left corner of the card (and the line under it) hangs, relative to the pointer, so that it stays clear of
// every box in `avoid` and inside `bounds`. `size` is the card and its line together. `prev` is where it hung a moment ago:
// it stays there while that is still as near as anything free, so the card does not hop between corners as tags move a
// pixel. When nothing is free anywhere the least covered slot wins.
export function hangCard(pointer: Point, size: Size, avoid: readonly Box[], bounds: Box, prev: Point | null): Point {
  const padded = avoid.map((b) => ({ left: b.left - PAD, top: b.top - PAD, right: b.right + PAD, bottom: b.bottom + PAD }));
  const covered = (at: Point) => {
    const box = boxAt(pointer, at, size);
    return padded.reduce((sum, b) => sum + overlap(box, b), 0);
  };
  let fallback: { at: Point; area: number } | null = null;
  for (const g of GAPS) {
    const ring = SLOTS.map((slot) => slot(g, size)).filter((at) => inside(boxAt(pointer, at, size), bounds));
    const free = ring.find((at) => covered(at) === 0);
    if (free) {
      // `prev` counts as part of this ring when it is no farther out than the ring.
      const keep = prev && covered(prev) === 0 && inside(boxAt(pointer, prev, size), bounds) && ringOf(prev, size) >= GAPS[0] - 2 && ringOf(prev, size) <= g;
      return keep ? prev : free;
    }
    for (const at of ring) {
      const area = covered(at);
      if (!fallback || area < fallback.area) fallback = { at, area };
    }
  }
  return fallback?.at ?? { x: GAPS[0], y: GAPS[0] };
}

// The ring a slot belongs to: how far its nearest edge or corner is from the pointer, along the axis it hangs on. A card
// that holds the pointer has no ring (0 or less), which a size that grew since it was placed can cause.
function ringOf(at: Point, size: Size): number {
  const dx = at.x >= 0 ? at.x : -(at.x + size.w);
  const dy = at.y >= 0 ? at.y : -(at.y + size.h);
  return Math.max(dx, dy, 0);
}

export type BarTone = 'idle' | 'go' | 'same' | 'stop';
// `chip` is the short line under the card in hand, `text` the sentence on the bar at the bottom.
export type Bar = { chip: string; text: string; tone: BarTone };

// What the card in hand and the bar say while it is carried: what letting go does right now. A desk answers first, then a
// stage chip under the pointer, else how to start. The wording follows `Aim.verdict`, so the bar, the desk and the drop agree.
export function barOf(aim: Aim | null, over: TaskStage | null, from: TaskStage): Bar {
  if (aim) {
    const v = aim.verdict;
    switch (v.kind) {
      case 'assign':
        return v.already
          ? { chip: 'Already on it', text: `${v.to.name} is already on it. Letting go changes nothing.`, tone: 'same' }
          : { chip: `Give it to ${v.to.name}`, text: `Let go to give it to ${v.to.name}${v.to.po ? ', the PO' : ''}. ${v.to.name} starts at once.`, tone: 'go' };
      case 'hire':
        return { chip: 'Hire for this desk', text: `Empty ${v.role === 'orchestrator' ? 'PO ' : ''}desk. Let go to hire someone for it, who starts this task.`, tone: 'go' };
      case 'refuse':
        return { chip: 'Not there', text: v.message, tone: 'stop' };
    }
  }
  if (over)
    return over === from
      ? { chip: `Already in ${STAGE_LABEL[over]}`, text: `It is already in ${STAGE_LABEL[over]}. Letting go changes nothing.`, tone: 'same' }
      : { chip: `Move to ${STAGE_LABEL[over]}`, text: `Let go to move it to ${STAGE_LABEL[over]}.`, tone: 'go' };
  return { chip: 'Hold it over a desk', text: 'Hold it over a desk to give it to the person there, or over a stage to move it.', tone: 'idle' };
}
