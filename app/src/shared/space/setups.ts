// The computer a desk carries is one of a few setups (one monitor, two, a laptop on a stand, a screen on an arm...). Which one a
// desk wears is derived from the story, never stored: a hash of the desk's id says which it would like, and desks that stand next to
// each other never take the same. Nothing in the file changes, so older buildings get their setups too.
import { ITEM_DEFS } from './catalog.ts';
import { itemRect, floorItems } from './geom.ts';
import type { FloorItem, ItemId, Story } from './types.ts';

/** How many setups a desk model draws. A desk def with `setups` set takes one of 0 .. count - 1. */
export const SETUP_COUNT = 8;
// ITEM_DEFS holds the same number (catalog.ts cannot import this file); the space check compares them.
/** Two desks closer than this (in cells, edge to edge) are neighbours: they never share a setup. A meter covers a back to back pair, the next column, the diagonal and a desk one cell away. */
export const NEIGHBOUR_GAP = 2;

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const gap = (a: FloorItem, b: FloorItem): number => {
  const [p, q] = [itemRect(a, ITEM_DEFS[a.def]), itemRect(b, ITEM_DEFS[b.def])];
  return Math.max(q.x0 - p.x1, p.x0 - q.x1, q.z0 - p.z1, p.z0 - q.z1, 0);
};

const cache = new WeakMap<Story, ReadonlyMap<ItemId, number>>();

/**
 * The setup of every desk of a story. Desks are settled in the order of their ids, each taking the setup its hash prefers or the next
 * one no neighbour settled before it has, so one desk's setup moves only when a neighbour with an earlier id appears next to it.
 */
export function setupsOf(story: Story): ReadonlyMap<ItemId, number> {
  const hit = cache.get(story);
  if (hit) return hit;
  const desks = floorItems(story).filter((i) => ITEM_DEFS[i.def]?.setups).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map<ItemId, number>();
  for (const desk of desks) {
    const near = desks.filter((o) => out.has(o.id) && gap(desk, o) < NEIGHBOUR_GAP);
    const taken = new Map<number, number>();
    for (const o of near) taken.set(out.get(o.id)!, (taken.get(out.get(o.id)!) ?? 0) + 1);
    const want = hash(desk.id) % SETUP_COUNT;
    // The preferred setup when no neighbour has it, else the first unused one after it; a crowd that uses them all gets the least used.
    let best = want;
    for (let k = 1; k < SETUP_COUNT; k++) {
      const s = (want + k) % SETUP_COUNT;
      if ((taken.get(s) ?? 0) < (taken.get(best) ?? 0)) best = s;
    }
    out.set(desk.id, best);
  }
  cache.set(story, out);
  return out;
}
