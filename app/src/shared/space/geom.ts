import { footprint, ITEM_DEFS } from './catalog.ts';
import { CELL, STORY_H, type FloorItem, type Item, type ItemDef, type Lot, type Story, type TopItem, type Vec2, type WallDir, type WallRef } from './types.ts';

const DIR_INDEX: Record<WallDir, number> = { e: 0, s: 1, sd: 2, nd: 3 };
const OFF = 4096;

/** Numeric identity of a wall segment, valid for coordinates within +-4096. */
export const wkey = (x: number, z: number, d: WallDir): number => ((z + OFF) * 8192 + (x + OFF)) * 4 + DIR_INDEX[d];
export const wrefKey = (r: WallRef): number => wkey(r.x, r.z, r.d);
/** Stable string for a wall segment, used as the `doors` key of a FloorNav. */
export const wallName = (r: WallRef): string => `${r.d}:${r.x},${r.z}`;

export const tileIndex = (lot: Lot, tx: number, tz: number): number => (tz - lot.z0) * lot.w + (tx - lot.x0);
export const inLotTile = (lot: Lot, tx: number, tz: number): boolean =>
  tx >= lot.x0 && tx < lot.x0 + lot.w && tz >= lot.z0 && tz < lot.z0 + lot.h;
export const sameLot = (a: Lot, b: Lot): boolean => a.x0 === b.x0 && a.z0 === b.z0 && a.w === b.w && a.h === b.h;
export const hasFloorAt = (s: Story, i: number): boolean => s.paint[i] > 0 || (s.halfB[i] ?? 0) > 0;

export type CellRect = { x0: number; z0: number; x1: number; z1: number };

export const isTop = (i: Item): i is TopItem => i.on !== undefined;
export const isFloor = (i: Item): i is FloorItem => i.on === undefined;

const floorOf = new WeakMap<Story, readonly FloorItem[]>();
/** The items that stand on the floor. A story is never edited in place, so the list is made once per story. */
export function floorItems(s: Story): readonly FloorItem[] {
  let list = floorOf.get(s);
  if (!list) floorOf.set(s, (list = s.items.filter(isFloor)));
  return list;
}

export const sameItem = (a: Item | undefined, b: Item | undefined): boolean =>
  !a || !b ? a === b : a.def === b.def && a.x === b.x && a.z === b.z && a.rot === b.rot && a.blockId === b.blockId && a.tint === b.tint && a.on === b.on && a.u === b.u && a.v === b.v && a.look === b.look && a.ang === b.ang && a.lvl === b.lvl;

export function itemRect(item: FloorItem, def: ItemDef): CellRect {
  const f = footprint(def, item.rot);
  return { x0: item.x, z0: item.z, x1: item.x + f.w, z1: item.z + f.d };
}

export const defOf = (item: Item): ItemDef | undefined => ITEM_DEFS[item.def];
export const tileOfCell = (c: number): number => Math.floor(c / 2);

// rot -> unit direction of the climb. Rot 0 climbs toward +z, like a seat faces +z at rot 0.
const CLIMB: readonly Vec2[] = [
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
  { x: 1, z: 0 },
];

export type StairsInfo = {
  aligned: boolean;
  dir: Vec2;
  /** The tiles of the run, base first. */
  tiles: { tx: number; tz: number }[];
  holeTiles: { tx: number; tz: number }[];
  landing: { tx: number; tz: number };
  approach: Vec2;
  top: Vec2;
  heightAt(p: Vec2): number;
};

export function stairsInfo(item: FloorItem, def: ItemDef): StairsInfo {
  const rot = item.rot;
  const dir = CLIMB[rot];
  const f = footprint(def, rot);
  const tx0 = Math.floor(item.x / 2);
  const tz0 = Math.floor(item.z / 2);
  const run = Math.max(f.w, f.d) / 2;
  const start = { tx: rot === 1 ? tx0 + run - 1 : tx0, tz: rot === 2 ? tz0 + run - 1 : tz0 };
  const tiles = Array.from({ length: run }, (_, i) => ({ tx: start.tx + dir.x * i, tz: start.tz + dir.z * i }));
  const holeLen = def.stairs?.holeLen ?? 0;
  const center = (t: { tx: number; tz: number }): Vec2 => ({ x: t.tx + 0.5, z: t.tz + 0.5 });
  const base = center(tiles[0]);
  const landing = tiles[holeLen];
  const top = center(landing);
  return {
    aligned: item.x % 2 === 0 && item.z % 2 === 0,
    dir,
    tiles,
    holeTiles: tiles.slice(0, holeLen),
    landing,
    approach: { x: base.x - dir.x * 1.1, z: base.z - dir.z * 1.1 },
    top,
    heightAt(p) {
      const s = (p.x - base.x) * dir.x + (p.z - base.z) * dir.z;
      return STORY_H * Math.min(1, Math.max(0, (s + 0.5) / 3.5));
    },
  };
}

// FNV-1a over the story's content. rev is a content hash, so an undo restores it exactly and equal rev means equal content.
export function hashStory(paint: Uint8Array, halfB: Readonly<Record<number, number>>, walls: readonly { x: number; z: number; d: string; style: number; open?: string }[], items: readonly Item[]): number {
  let h = 2166136261;
  const mix = (n: number) => {
    h = Math.imul(h ^ (n & 0xff), 16777619);
    h = Math.imul(h ^ ((n >>> 8) & 0xff), 16777619);
    h = Math.imul(h ^ ((n >>> 16) & 0xff), 16777619);
    h = Math.imul(h ^ ((n >>> 24) & 0xff), 16777619);
  };
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    mix(s.length);
  };
  for (let i = 0; i < paint.length; i++) h = Math.imul(h ^ paint[i], 16777619);
  mix(1);
  for (const k of Object.keys(halfB)) {
    mix(Number(k));
    mix(halfB[Number(k)]);
  }
  mix(2);
  for (const w of walls) {
    mix(w.x);
    mix(w.z);
    str(w.d);
    mix(w.style);
    str(w.open ?? '');
  }
  mix(3);
  for (const it of items) {
    str(it.id);
    str(it.def);
    if (it.on === undefined) {
      mix(it.x);
      mix(it.z);
    } else {
      str(it.on);
      mix(it.u);
      mix(it.v);
    }
    mix(it.rot);
    mix(it.look ?? 0);
    mix(it.ang ?? 0);
    mix(it.lvl ?? 0);
    str(it.blockId ?? '');
    mix(it.tint ?? -1);
  }
  return h >>> 0;
}

export const cellCenter = (c: number): number => c * CELL;
