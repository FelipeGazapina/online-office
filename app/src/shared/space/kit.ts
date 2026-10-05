import { PAINT } from './catalog.ts';
import { hasFloorAt, inLotTile, tileIndex } from './geom.ts';
import type { Building, BuildOp, FloorCell, Item, ItemId, Lot, Rot, Vec2 } from './types.ts';
import { MAX_LOT } from './types.ts';

export const BLOCK_W = 10;
export const BLOCK_D = 8;
export const AISLE = 2;
export const COLS = 3;
export const X0 = -18;
export const BENCH_COUNT = 6;

export const itemId = (blockId: string, kind: string, n: number): ItemId => `${blockId}:${kind}:${String(n).padStart(2, '0')}` as ItemId;
export const globalId = (kind: string, n: number): ItemId => `${kind}:${String(n).padStart(2, '0')}` as ItemId;

/** The center of a team slot, in meters, as the static office laid it out. */
export function blockCenter(slot: number): Vec2 {
  const col = slot % COLS;
  const row = Math.floor(slot / COLS);
  return { x: X0 + AISLE / 2 + BLOCK_W / 2 + col * (BLOCK_W + AISLE), z: -(BLOCK_D / 2 + 1) - row * (BLOCK_D + AISLE) };
}

/** Bench desk n of a team: three columns of two desks back to back, south seat first, east column first. */
export function benchItem(blockId: string, slot: number, n: number): Item {
  const c = blockCenter(slot);
  const column = [0, -3, -6][n >> 1];
  const south = n % 2 === 0;
  return { id: itemId(blockId, 'bench_desk', n), def: 'bench_desk', x: c.x * 2 + column, z: c.z * 2 - (south ? 0 : 2), rot: (south ? 2 : 0) as Rot, blockId };
}

export function teamItems(blockId: string, slot: number): Item[] {
  const c = blockCenter(slot);
  const [cx, cz] = [c.x * 2, c.z * 2];
  const items: Item[] = Array.from({ length: BENCH_COUNT }, (_, n) => benchItem(blockId, slot, n));
  items.push(
    { id: itemId(blockId, 'po_desk', 0), def: 'po_desk', x: cx + 3, z: cz - 2, rot: 1, blockId },
    { id: itemId(blockId, 'whiteboard', 0), def: 'whiteboard', x: cx - 4, z: cz - 7, rot: 0, blockId },
    { id: itemId(blockId, 'board_terminal', 0), def: 'board_terminal', x: cx + 6, z: cz - 7, rot: 0, blockId },
    { id: itemId(blockId, 'team_sign', 0), def: 'team_sign', x: cx - 8, z: cz + 7, rot: 0, blockId },
  );
  return items;
}

/** Carpet tiles of a team's rug, as the static office drew it (9 by 7 tiles). */
export function rugTiles(slot: number): { x0: number; z0: number; x1: number; z1: number } {
  const c = blockCenter(slot);
  return { x0: c.x - 5, x1: c.x + 4, z0: c.z - 3, z1: c.z + 4 };
}

const union = (a: Lot, b: Lot): Lot => {
  const x0 = Math.min(a.x0, b.x0);
  const z0 = Math.min(a.z0, b.z0);
  return { x0, z0, w: Math.max(a.x0 + a.w, b.x0 + b.w) - x0, h: Math.max(a.z0 + a.h, b.z0 + b.h) - z0 };
};

/**
 * Everything a new team needs in its 10 by 8 slot: floor where there is none, a carpet rug, a PO desk, six bench desks,
 * a whiteboard with the board terminal beside it, and the team sign. Grows the lot when the slot sticks out of it.
 * Ids derive from (blockId, kind, index), so a repeated kit is a no-op. Outer walls are not extended.
 */
export function teamKit(b: Building, blockId: string, slot: number): BuildOp[] {
  const c = blockCenter(slot);
  const area: Lot = { x0: c.x - BLOCK_W / 2, z0: c.z - BLOCK_D / 2, w: BLOCK_W, h: BLOCK_D };
  const ops: BuildOp[] = [];
  const lot = union(b.lot, area);
  const grew = lot.w !== b.lot.w || lot.h !== b.lot.h || lot.x0 !== b.lot.x0 || lot.z0 !== b.lot.z0;
  if (grew) ops.push({ t: 'lot', lot: lot.w > MAX_LOT || lot.h > MAX_LOT ? { ...b.lot } : lot });
  const rug = rugTiles(slot);
  const cells: FloorCell[] = [];
  for (let z = area.z0; z < area.z0 + area.h; z++) {
    for (let x = area.x0; x < area.x0 + area.w; x++) {
      const bare = !grew && inLotTile(b.lot, x, z) ? !hasFloorAt(b.stories[0], tileIndex(b.lot, x, z)) : true;
      const onRug = x >= rug.x0 && x < rug.x1 && z >= rug.z0 && z < rug.z1;
      if (onRug) cells.push({ x, z, half: 0, paint: PAINT.carpetBlue });
      else if (bare) cells.push({ x, z, half: 0, paint: PAINT.woodLight });
    }
  }
  ops.push({ t: 'floor', story: 0, cells });
  ops.push({ t: 'items', story: 0, put: teamItems(blockId, slot), del: [] });
  return ops;
}
