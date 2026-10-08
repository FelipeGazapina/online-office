// What a build gesture means to the building, as pure functions over a story. The renderer turns pointer input into
// these arguments and sends the ops to main, which runs the same rules (`applyOps`) before anything changes.
import { footprint, ITEM_DEFS } from './catalog.ts';
import { defOf, floorItems, hasFloorAt, inLotTile, itemRect, tileIndex, wrefKey } from './geom.ts';
import { rectWalls, type TileRect } from './builders.ts';
import type { BuildOp, FloorCell, FloorItem, Item, ItemId, Lot, PaintId, Rot, Story, Vec2, WallRef, WallSeg } from './types.ts';
import { CELL } from './types.ts';

const ref = (x: number, z: number, d: 'e' | 's'): WallRef => ({ x, z, d });

/** The straight run of wall segments from vertex `a` toward vertex `b`, locked to the longer axis. */
export function wallRun(a: Vec2, b: Vec2): WallRef[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const out: WallRef[] = [];
  if (Math.abs(dx) >= Math.abs(dz)) {
    for (let x = Math.min(a.x, a.x + dx); x < Math.max(a.x, a.x + dx); x++) out.push(ref(x, a.z, 'e'));
  } else {
    for (let z = Math.min(a.z, a.z + dz); z < Math.max(a.z, a.z + dz); z++) out.push(ref(a.x, z, 's'));
  }
  return out;
}

/** The vertex a run from `a` toward `b` ends on. */
export function runEnd(a: Vec2, b: Vec2): Vec2 {
  return Math.abs(b.x - a.x) >= Math.abs(b.z - a.z) ? { x: b.x, z: a.z } : { x: a.x, z: b.z };
}

const wallMap = (s: Story): Map<number, WallSeg> => new Map(s.walls.map((w) => [wrefKey(w), w]));

/** Walls to add for `refs`. A segment that already stands is left alone, so its door or window survives. */
export function wallsToPut(s: Story, refs: readonly WallRef[], style: number): WallSeg[] {
  const have = wallMap(s);
  return refs.filter((r) => !have.has(wrefKey(r))).map((r) => ({ ...r, style }));
}

export function wallsToDelete(s: Story, refs: readonly WallRef[]): WallRef[] {
  const have = wallMap(s);
  return refs.filter((r) => have.has(wrefKey(r)));
}

export function wallOp(story: number, put: readonly WallSeg[], del: readonly WallRef[]): BuildOp | null {
  return put.length || del.length ? { t: 'walls', story, put, del } : null;
}

/** The rectangle of tiles between two vertices, or null when it has no area. */
export function roomRect(a: Vec2, b: Vec2): TileRect | null {
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.z - a.z);
  return w > 0 && h > 0 ? { x: Math.min(a.x, b.x), z: Math.min(a.z, b.z), w, h } : null;
}

const tileHasFloor = (b: { lot: Lot }, s: Story, x: number, z: number) => inLotTile(b.lot, x, z) && hasFloorAt(s, tileIndex(b.lot, x, z));

/** Walls around the rectangle, and `paint` on every tile of it that has no floor yet. */
export function roomOps(b: { lot: Lot }, s: Story, storyIndex: number, r: TileRect, style: number, paint: PaintId): BuildOp[] {
  const ops: BuildOp[] = [];
  const cells: FloorCell[] = [];
  for (let z = r.z; z < r.z + r.h; z++) for (let x = r.x; x < r.x + r.w; x++) if (!tileHasFloor(b, s, x, z)) cells.push({ x, z, half: 0, paint });
  if (cells.length) ops.push({ t: 'floor', story: storyIndex, cells });
  const walls = wallOp(storyIndex, wallsToPut(s, rectWalls(r, style), style), []);
  if (walls) ops.push(walls);
  return ops;
}

export const tileKey = (x: number, z: number) => `${x},${z}`;

/** Every tile of the lot boundary-connected to `from` without crossing a wall, or null when the area leaks out of the lot. */
export function floodRoom(b: { lot: Lot }, s: Story, from: Vec2, limit = 4096): Vec2[] | null {
  if (!inLotTile(b.lot, from.x, from.z)) return null;
  const walls = wallMap(s);
  const has = (x: number, z: number, d: 'e' | 's') => walls.has(wrefKey(ref(x, z, d)));
  const seen = new Set<string>([tileKey(from.x, from.z)]);
  const queue: Vec2[] = [from];
  const tiles: Vec2[] = [];
  while (queue.length) {
    const t = queue.pop()!;
    tiles.push(t);
    if (tiles.length > limit) return null;
    const next: [number, number, boolean][] = [
      [t.x, t.z - 1, has(t.x, t.z, 'e')],
      [t.x, t.z + 1, has(t.x, t.z + 1, 'e')],
      [t.x - 1, t.z, has(t.x, t.z, 's')],
      [t.x + 1, t.z, has(t.x + 1, t.z, 's')],
    ];
    for (const [x, z, blocked] of next) {
      if (blocked) continue;
      if (!inLotTile(b.lot, x, z)) return null;
      const k = tileKey(x, z);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ x, z });
    }
  }
  return tiles;
}

/** The standing wall segments around a set of tiles. */
export function wallsAround(s: Story, tiles: readonly Vec2[]): WallSeg[] {
  const walls = wallMap(s);
  const out = new Map<number, WallSeg>();
  for (const t of tiles) {
    for (const r of [ref(t.x, t.z, 'e'), ref(t.x, t.z + 1, 'e'), ref(t.x, t.z, 's'), ref(t.x + 1, t.z, 's')]) {
      const w = walls.get(wrefKey(r));
      if (w) out.set(wrefKey(r), w);
    }
  }
  return [...out.values()];
}

export function paintFloorOp(b: { lot: Lot }, s: Story, storyIndex: number, tiles: readonly Vec2[], paint: PaintId): BuildOp | null {
  const cells: FloorCell[] = [];
  for (const t of tiles) {
    if (!inLotTile(b.lot, t.x, t.z)) continue;
    if (s.paint[tileIndex(b.lot, t.x, t.z)] !== paint) cells.push({ x: t.x, z: t.z, half: 0, paint });
  }
  return cells.length ? { t: 'floor', story: storyIndex, cells } : null;
}

export function paintWallsOp(storyIndex: number, walls: readonly WallSeg[], style: number): BuildOp | null {
  const put = walls.filter((w) => w.style !== style).map((w) => ({ ...w, style }));
  return put.length ? { t: 'walls', story: storyIndex, put, del: [] } : null;
}

export function openingOp(s: Story, storyIndex: number, at: WallRef, open: 'door' | 'window' | 'arch'): BuildOp | null {
  const w = wallMap(s).get(wrefKey(at));
  if (!w || w.open === open) return null;
  return { t: 'walls', story: storyIndex, put: [{ ...w, open }], del: [] };
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

/** The straight wall segment nearest to a point in meters, within `reach`. */
export function nearestWall(s: Story, p: Vec2, reach = 0.4): WallSeg | null {
  let best: WallSeg | null = null;
  let bestD = reach;
  for (const w of s.walls) {
    if (w.d !== 'e' && w.d !== 's') continue;
    const a = { x: w.x, z: w.z };
    const b = w.d === 'e' ? { x: w.x + 1, z: w.z } : { x: w.x, z: w.z + 1 };
    const d = distToSegment(p, a, b);
    if (d < bestD) {
      best = w;
      bestD = d;
    }
  }
  return best;
}

/** The cell of an item that sits with its middle on the cursor. Stairs sit on whole tiles. */
export function itemOrigin(defId: string, rot: Rot, cursor: Vec2): { x: number; z: number } {
  const def = ITEM_DEFS[defId];
  const f = footprint(def, rot);
  const snap = def.stairs ? (v: number, size: number) => Math.round((v / CELL - size / 2) / 2) * 2 : (v: number, size: number) => Math.round(v / CELL - size / 2);
  return { x: snap(cursor.x, f.w), z: snap(cursor.z, f.d) };
}

/** The floor item under a point in meters. Furniture wins over a rug lying beneath it. */
export function itemAt(s: Story, p: Vec2): FloorItem | null {
  const cx = p.x / CELL;
  const cz = p.z / CELL;
  let found: FloorItem | null = null;
  for (const item of floorItems(s)) {
    const def = defOf(item);
    if (!def) continue;
    const r = itemRect(item, def);
    if (cx < r.x0 || cx >= r.x1 || cz < r.z0 || cz >= r.z1) continue;
    if (!def.walkable) return item;
    found ??= item;
  }
  return found;
}

export function putItemOp(story: number, item: Item): BuildOp {
  return { t: 'items', story, put: [item], del: [] };
}

export function removeItemOp(story: number, id: ItemId): BuildOp {
  return { t: 'items', story, put: [], del: [id] };
}
