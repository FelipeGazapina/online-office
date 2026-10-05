import { ITEM_DEFS, PAINT_COUNT } from './catalog.ts';
import { hashStory, itemRect, sameLot, tileIndex, wrefKey } from './geom.ts';
import {
  MAX_LOT,
  MAX_STORIES,
  type Building,
  type BuildOp,
  type FloorCell,
  type Item,
  type ItemId,
  type Lot,
  type Story,
  type Violation,
  type WallRef,
  type WallSeg,
} from './types.ts';

export function makeStory(paint: Uint8Array, halfB: Readonly<Record<number, number>>, walls: readonly WallSeg[], items: readonly Item[]): Story {
  return { rev: hashStory(paint, halfB, walls, items), paint, halfB, walls, items };
}

export function emptyStory(lot: Lot): Story {
  return makeStory(new Uint8Array(lot.w * lot.h), {}, [], []);
}

export function emptyBuilding(lot: Lot, stories = 1): Building {
  return { v: 1, lot: { ...lot }, stories: Array.from({ length: stories }, () => emptyStory(lot)) };
}

export function isEmptyStory(s: Story): boolean {
  return s.items.length === 0 && s.walls.length === 0 && Object.keys(s.halfB).length === 0 && s.paint.every((p) => p === 0);
}

export const wallInLot = (lot: Lot, s: WallRef): boolean => {
  const { x, z } = s;
  const right = lot.x0 + lot.w;
  const bottom = lot.z0 + lot.h;
  if (s.d === 'e') return x >= lot.x0 && x < right && z >= lot.z0 && z <= bottom;
  if (s.d === 's') return x >= lot.x0 && x <= right && z >= lot.z0 && z < bottom;
  return x >= lot.x0 && x < right && z >= lot.z0 && z < bottom;
};

export const itemInLot = (lot: Lot, item: Item): boolean => {
  const def = ITEM_DEFS[item.def];
  if (!def) return false;
  const r = itemRect(item, def);
  return r.x0 >= lot.x0 * 2 && r.z0 >= lot.z0 * 2 && r.x1 <= (lot.x0 + lot.w) * 2 && r.z1 <= (lot.z0 + lot.h) * 2;
};

const normWall = (w: WallSeg): WallSeg => (w.open ? { x: w.x, z: w.z, d: w.d, style: w.style, open: w.open } : { x: w.x, z: w.z, d: w.d, style: w.style });
const normItem = (i: Item): Item => {
  const o: Item = { id: i.id, def: i.def, x: i.x, z: i.z, rot: i.rot };
  if (i.blockId !== undefined) o.blockId = i.blockId;
  if (i.tint !== undefined) o.tint = i.tint;
  return o;
};
const sameWall = (a: WallSeg | undefined, b: WallSeg | undefined) => (!a || !b ? a === b : a.style === b.style && a.open === b.open);
const sameItem = (a: Item | undefined, b: Item | undefined) =>
  !a || !b ? a === b : a.def === b.def && a.x === b.x && a.z === b.z && a.rot === b.rot && a.blockId === b.blockId && a.tint === b.tint;

const byId = (a: Item, b: Item) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function withStory(b: Building, index: number, s: Story): Building {
  const stories = b.stories.slice();
  stories[index] = s;
  return { ...b, stories };
}

function reframe(story: Story, from: Lot, to: Lot): Story {
  const paint = new Uint8Array(to.w * to.h);
  const halfB: Record<number, number> = {};
  for (let z = from.z0; z < from.z0 + from.h; z++) {
    for (let x = from.x0; x < from.x0 + from.w; x++) {
      if (x < to.x0 || x >= to.x0 + to.w || z < to.z0 || z >= to.z0 + to.h) continue;
      const src = tileIndex(from, x, z);
      const dst = tileIndex(to, x, z);
      paint[dst] = story.paint[src];
      const hb = story.halfB[src];
      if (hb) halfB[dst] = hb;
    }
  }
  return makeStory(paint, halfB, story.walls, story.items);
}

function droppedContent(story: Story, to: Lot, from: Lot, index: number, out: Violation[]) {
  for (let z = from.z0; z < from.z0 + from.h; z++) {
    for (let x = from.x0; x < from.x0 + from.w; x++) {
      if (x >= to.x0 && x < to.x0 + to.w && z >= to.z0 && z < to.z0 + to.h) continue;
      const i = tileIndex(from, x, z);
      if (story.paint[i] > 0 || (story.halfB[i] ?? 0) > 0) {
        out.push({ kind: 'out_of_lot', story: index, at: { x, z } });
        return;
      }
    }
  }
  if (story.walls.some((w) => !wallInLot(to, w)) || story.items.some((i) => !itemInLot(to, i))) out.push({ kind: 'out_of_lot', story: index });
}

/** Applies one op. Problems the op itself causes (bad indices, dropped content) go to `report`. Returns the same building when nothing changes. */
export function applyOp(b: Building, op: BuildOp, report: Violation[]): { b: Building; inverse: BuildOp } {
  switch (op.t) {
    case 'lot': {
      const to = op.lot;
      const ok = Number.isInteger(to.x0) && Number.isInteger(to.z0) && Number.isInteger(to.w) && Number.isInteger(to.h) && to.w >= 1 && to.h >= 1 && to.w <= MAX_LOT && to.h <= MAX_LOT;
      if (!ok) {
        report.push({ kind: 'out_of_lot', story: 0 });
        return { b, inverse: op };
      }
      if (sameLot(b.lot, to)) return { b, inverse: op };
      b.stories.forEach((s, i) => droppedContent(s, to, b.lot, i, report));
      const lot = { x0: to.x0, z0: to.z0, w: to.w, h: to.h };
      return { b: { ...b, lot, stories: b.stories.map((s) => reframe(s, b.lot, lot)) }, inverse: { t: 'lot', lot: { ...b.lot } } };
    }
    case 'stories': {
      const n = op.count;
      if (!Number.isInteger(n) || n < 1 || n > MAX_STORIES) {
        report.push({ kind: 'story_not_empty', story: 0 });
        return { b, inverse: op };
      }
      const cur = b.stories.length;
      if (n === cur) return { b, inverse: op };
      if (n > cur) return { b: { ...b, stories: [...b.stories, ...Array.from({ length: n - cur }, () => emptyStory(b.lot))] }, inverse: { t: 'stories', count: cur } };
      for (let i = n; i < cur; i++) if (!isEmptyStory(b.stories[i])) report.push({ kind: 'story_not_empty', story: i });
      return { b: { ...b, stories: b.stories.slice(0, n) }, inverse: { t: 'stories', count: cur } };
    }
    case 'walls': {
      const story = b.stories[op.story];
      if (!story) {
        report.push({ kind: 'out_of_lot', story: op.story });
        return { b, inverse: op };
      }
      const map = new Map<number, WallSeg>(story.walls.map((w) => [wrefKey(w), w]));
      const touched = new Map<number, { ref: WallRef; prev: WallSeg | undefined }>();
      const touch = (r: WallRef) => {
        const k = wrefKey(r);
        if (!touched.has(k)) touched.set(k, { ref: { x: r.x, z: r.z, d: r.d }, prev: map.get(k) });
        return k;
      };
      for (const r of op.del) map.delete(touch(r));
      for (const w of op.put) map.set(touch(w), normWall(w));
      let changed = false;
      const put: WallSeg[] = [];
      const del: WallRef[] = [];
      for (const [k, t] of touched) {
        if (!sameWall(t.prev, map.get(k))) changed = true;
        if (t.prev) put.push(t.prev);
        else del.push(t.ref);
      }
      const inverse: BuildOp = { t: 'walls', story: op.story, put, del };
      if (!changed) return { b, inverse };
      const walls = [...map.entries()].sort((a, c) => a[0] - c[0]).map((e) => e[1]);
      return { b: withStory(b, op.story, makeStory(story.paint, story.halfB, walls, story.items)), inverse };
    }
    case 'floor': {
      const story = b.stories[op.story];
      if (!story) {
        report.push({ kind: 'out_of_lot', story: op.story });
        return { b, inverse: op };
      }
      let paint = story.paint;
      let halfB: Record<number, number> | null = null;
      const prev = new Map<number, FloorCell>();
      for (const c of op.cells) {
        const inside = c.x >= b.lot.x0 && c.x < b.lot.x0 + b.lot.w && c.z >= b.lot.z0 && c.z < b.lot.z0 + b.lot.h;
        if (!inside) {
          report.push({ kind: 'out_of_lot', story: op.story, at: { x: c.x, z: c.z } });
          continue;
        }
        if (!Number.isInteger(c.paint) || c.paint < 0 || c.paint >= PAINT_COUNT) {
          report.push({ kind: 'bad_paint', story: op.story, at: { x: c.x, z: c.z } });
          continue;
        }
        const i = tileIndex(b.lot, c.x, c.z);
        const key = i * 2 + c.half;
        const before = c.half === 0 ? paint[i] : (halfB ?? story.halfB)[i] ?? 0;
        if (!prev.has(key)) prev.set(key, { x: c.x, z: c.z, half: c.half, paint: before });
        if (c.half === 0) {
          if (paint[i] === c.paint) continue;
          if (paint === story.paint) paint = paint.slice();
          paint[i] = c.paint;
        } else {
          if (before === c.paint) continue;
          halfB ??= { ...story.halfB };
          if (c.paint === 0) delete halfB[i];
          else halfB[i] = c.paint;
        }
      }
      const inverse: BuildOp = { t: 'floor', story: op.story, cells: [...prev.values()] };
      if (paint === story.paint && !halfB) return { b, inverse };
      return { b: withStory(b, op.story, makeStory(paint, halfB ?? story.halfB, story.walls, story.items)), inverse };
    }
    case 'items': {
      const story = b.stories[op.story];
      if (!story) {
        report.push({ kind: 'out_of_lot', story: op.story });
        return { b, inverse: op };
      }
      const map = new Map<ItemId, Item>(story.items.map((i) => [i.id, i]));
      const touched = new Map<ItemId, Item | undefined>();
      const touch = (id: ItemId) => {
        if (!touched.has(id)) touched.set(id, map.get(id));
      };
      for (const id of op.del) {
        touch(id);
        map.delete(id);
      }
      for (const it of op.put) {
        if (!ITEM_DEFS[it.def]) {
          report.push({ kind: 'unknown_item', story: op.story, ids: [it.id] });
          continue;
        }
        touch(it.id);
        map.set(it.id, normItem(it));
      }
      let changed = false;
      const put: Item[] = [];
      const del: ItemId[] = [];
      for (const [id, prev] of touched) {
        if (!sameItem(prev, map.get(id))) changed = true;
        if (prev) put.push(prev);
        else del.push(id);
      }
      const inverse: BuildOp = { t: 'items', story: op.story, put, del };
      if (!changed) return { b, inverse };
      const items = [...map.values()].sort(byId);
      return { b: withStory(b, op.story, makeStory(story.paint, story.halfB, story.walls, items)), inverse };
    }
  }
}

export function applyAll(b: Building, ops: readonly BuildOp[], report: Violation[]): { b: Building; inverse: BuildOp[] } {
  let cur = b;
  const inverse: BuildOp[] = [];
  for (const op of ops) {
    const r = applyOp(cur, op, report);
    cur = r.b;
    inverse.unshift(r.inverse);
  }
  return { b: cur, inverse };
}
