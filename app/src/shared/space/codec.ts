// The only place untrusted JSON becomes a Building, and the inverse.
import { ITEM_DEFS, PAINT_COUNT } from './catalog.ts';
import { wrefKey } from './geom.ts';
import { MAX_LVL } from './surface.ts';
import { makeStory } from './story.ts';
import { MAX_LOT, MAX_STORIES, type Building, type Item, type ItemId, type Rot, type Story, type WallDir, type WallSeg } from './types.ts';

const fail = (path: string, msg: string): never => {
  throw new Error(`Invalid building: ${path} ${msg}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown, path: string): number => (Number.isInteger(v) ? (v as number) : fail(path, 'must be an integer'));
const DIRS: readonly string[] = ['e', 's', 'sd', 'nd'];
const OPENINGS: readonly string[] = ['door', 'window', 'arch'];

function decodePaint(rle: unknown, size: number, path: string): Uint8Array {
  if (typeof rle !== 'string') return fail(path, 'must be a run-length string');
  const out = new Uint8Array(size);
  let at = 0;
  for (const token of rle === '' ? [] : rle.split(',')) {
    const m = /^(\d+)x(\d+)$/.exec(token);
    if (!m) return fail(path, `has a bad run "${token}"`);
    const value = Number(m[1]);
    const count = Number(m[2]);
    if (value >= PAINT_COUNT) return fail(path, `uses unknown paint ${value}`);
    if (at + count > size) return fail(path, 'is longer than the lot');
    out.fill(value, at, at + count);
    at += count;
  }
  if (at !== size) return fail(path, `covers ${at} tiles, the lot has ${size}`);
  return out;
}

function encodePaint(paint: Uint8Array): string {
  const runs: string[] = [];
  for (let i = 0; i < paint.length; ) {
    let j = i;
    while (j < paint.length && paint[j] === paint[i]) j++;
    runs.push(`${paint[i]}x${j - i}`);
    i = j;
  }
  return runs.join(',');
}

export function parseBuilding(raw: unknown, warn: (msg: string) => void = (m) => console.warn(m)): Building {
  if (!isObj(raw)) return fail('building', 'must be an object');
  if (raw.v !== 1) return fail('v', 'must be 1');
  if (!isObj(raw.lot)) return fail('lot', 'must be an object');
  const rawW = int(raw.lot.w, 'lot.w');
  const rawH = int(raw.lot.h, 'lot.h');
  if (rawW < 1 || rawH < 1) return fail('lot', 'must have a positive size');
  const lot = { x0: int(raw.lot.x0, 'lot.x0'), z0: int(raw.lot.z0, 'lot.z0'), w: Math.min(rawW, MAX_LOT), h: Math.min(rawH, MAX_LOT) };
  if (!Array.isArray(raw.stories) || raw.stories.length === 0) return fail('stories', 'must be a non-empty array');
  const stories = raw.stories.slice(0, MAX_STORIES).map((rs: unknown, s): Story => {
    const p = `stories[${s}]`;
    if (!isObj(rs)) return fail(p, 'must be an object');
    const full = decodePaint(rs.paint, rawW * rawH, `${p}.paint`);
    const paint = new Uint8Array(lot.w * lot.h);
    for (let z = 0; z < lot.h; z++) paint.set(full.subarray(z * rawW, z * rawW + lot.w), z * lot.w);

    const halfB: Record<number, number> = {};
    if (rs.halfB !== undefined) {
      if (!isObj(rs.halfB)) return fail(`${p}.halfB`, 'must be an object');
      for (const [k, v] of Object.entries(rs.halfB)) {
        const tile = Number(k);
        const col = tile % rawW;
        if (!Number.isInteger(tile) || tile < 0 || tile >= rawW * rawH) return fail(`${p}.halfB`, `has a bad tile ${k}`);
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) >= PAINT_COUNT) return fail(`${p}.halfB.${k}`, 'must be a paint id');
        if (col < lot.w && Math.floor(tile / rawW) < lot.h) halfB[Math.floor(tile / rawW) * lot.w + col] = v as number;
      }
    }

    if (!Array.isArray(rs.walls)) return fail(`${p}.walls`, 'must be an array');
    const walls = new Map<number, WallSeg>();
    rs.walls.forEach((w: unknown, i: number) => {
      const wp = `${p}.walls[${i}]`;
      if (!isObj(w)) return fail(wp, 'must be an object');
      if (typeof w.d !== 'string' || !DIRS.includes(w.d)) return fail(`${wp}.d`, 'must be one of e, s, sd, nd');
      if (w.open !== undefined && (typeof w.open !== 'string' || !OPENINGS.includes(w.open))) return fail(`${wp}.open`, 'must be door, window or arch');
      const seg: WallSeg = { x: int(w.x, `${wp}.x`), z: int(w.z, `${wp}.z`), d: w.d as WallDir, style: int(w.style, `${wp}.style`) };
      if (w.open) seg.open = w.open as 'door' | 'window' | 'arch';
      walls.set(wrefKey(seg), seg);
    });

    if (!Array.isArray(rs.items)) return fail(`${p}.items`, 'must be an array');
    const items = new Map<string, Item>();
    rs.items.forEach((it: unknown, i: number) => {
      const ip = `${p}.items[${i}]`;
      if (!isObj(it)) return fail(ip, 'must be an object');
      if (typeof it.id !== 'string' || it.id === '') return fail(`${ip}.id`, 'must be a non-empty string');
      if (typeof it.def !== 'string') return fail(`${ip}.def`, 'must be a string');
      if (!ITEM_DEFS[it.def]) {
        warn(`building: dropped ${it.id}, unknown item "${it.def}"`);
        return;
      }
      const rot = int(it.rot, `${ip}.rot`);
      if (rot < 0 || rot > 3) return fail(`${ip}.rot`, 'must be 0 to 3');
      const item: Item =
        it.on === undefined
          ? { id: it.id as ItemId, def: it.def, x: int(it.x, `${ip}.x`), z: int(it.z, `${ip}.z`), rot: rot as Rot }
          : { id: it.id as ItemId, def: it.def, on: typeof it.on === 'string' ? (it.on as ItemId) : fail(`${ip}.on`, 'must be an item id'), u: int(it.u, `${ip}.u`), v: int(it.v, `${ip}.v`), rot: rot as Rot };
      if (item.on !== undefined) {
        // How a thing looks and how it stands: all optional, none needed for the rules but the stack level.
        for (const key of ['look', 'ang', 'lvl'] as const) {
          if (it[key] === undefined) continue;
          const n = int(it[key], `${ip}.${key}`);
          if (key === 'lvl' && (n < 0 || n > MAX_LVL)) fail(`${ip}.lvl`, `must be 0 to ${MAX_LVL}`);
          if (key === 'look' && n < 0) fail(`${ip}.look`, 'must not be negative');
          if (n !== 0) item[key] = n;
        }
      }
      if (it.blockId !== undefined) item.blockId = typeof it.blockId === 'string' ? it.blockId : fail(`${ip}.blockId`, 'must be a string');
      if (it.tint !== undefined) item.tint = typeof it.tint === 'number' ? it.tint : fail(`${ip}.tint`, 'must be a number');
      items.set(item.id, item);
    });
    // A top item whose host is gone (a file edited by hand) has nowhere to stand: it is dropped, like an unknown def.
    for (const item of [...items.values()]) {
      if (item.on === undefined) continue;
      const host = items.get(item.on);
      if (!host || host.on !== undefined) {
        warn(`building: dropped ${item.id}, nothing to stand on`);
        items.delete(item.id);
      }
    }
    return makeStory(
      paint,
      halfB,
      [...walls.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]),
      [...items.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
  });
  // A file from the build that made the pods items says `true`: that is level 1.
  const shelled = raw.shelled === 2 ? 2 : raw.shelled === 1 || raw.shelled === true ? 1 : undefined;
  return { v: 1, lot, stories, ...(shelled && { shelled }) };
}

/** Plain JSON: paint as a run-length string, everything else as it is. */
export function encodeBuilding(b: Building): unknown {
  return {
    v: 1,
    lot: { ...b.lot },
    ...(b.shelled && { shelled: b.shelled }),
    stories: b.stories.map((s) => ({ paint: encodePaint(s.paint), halfB: { ...s.halfB }, walls: s.walls.map((w) => ({ ...w })), items: s.items.map((i) => ({ ...i })) })),
  };
}
