import { PAINT } from './catalog.ts';
import { hasFloorAt, inLotTile, tileIndex } from './geom.ts';
import type { Building, BuildOp, FloorCell, Item, ItemId, Lot, Rot, Vec2, WallRef, WallSeg } from './types.ts';
import { MAX_LOT } from './types.ts';

export const BLOCK_W = 10;
export const BLOCK_D = 8;
export const AISLE = 2;
export const COLS = 3;
export const X0 = -18;
export const BENCH_COUNT = 6;
export const SLOTS = 6;
export const Z1 = 9;
export const LOBBY_Z0 = -1;
export const DOOR_X = X0 + 8;

/** The lot the office needs for teams up to `maxSlot`: room for them and for the next free slot. */
export function lotForSlot(maxSlot: number): Lot {
  const ghost = maxSlot + 1 < SLOTS ? maxSlot + 1 : null;
  const shown = ghost === null ? maxSlot + 1 : ghost + 1;
  const cols = Math.max(2, Math.min(COLS, shown));
  const rows = Math.max(1, Math.ceil(shown / COLS));
  return { x0: X0, z0: -rows * 10, w: cols * 12, h: Z1 + rows * 10 };
}

/** The outer wall of a lot: the south wall has the front door, the north and west walls have windows. */
export function perimeter(lot: Lot): WallSeg[] {
  const right = lot.x0 + lot.w;
  const bottom = lot.z0 + lot.h;
  const walls = new Map<string, WallSeg>();
  const put = (w: WallSeg) => walls.set(`${w.d}:${w.x},${w.z}`, w);
  for (let x = lot.x0; x < right; x++) {
    put({ x, z: lot.z0, d: 'e', style: 0 });
    put({ x, z: bottom, d: 'e', style: 0 });
  }
  for (let z = lot.z0; z < bottom; z++) {
    put({ x: lot.x0, z, d: 's', style: 0 });
    put({ x: right, z, d: 's', style: 0 });
  }
  if (DOOR_X - 1 >= lot.x0 && DOOR_X < right) for (const x of [DOOR_X - 1, DOOR_X]) put({ x, z: bottom, d: 'e', style: 0, open: 'door' });
  for (let i = 0; i < Math.floor(lot.w / 6); i++) put({ x: Math.floor(lot.x0 + 3.5 + i * 6), z: lot.z0, d: 'e', style: 0, open: 'window' });
  for (const z of [lot.z0 + 4.5, lot.z0 + 14]) if (z < -1.5 && z > lot.z0 + 2) put({ x: lot.x0, z: Math.floor(z), d: 's', style: 0, open: 'window' });
  return [...walls.values()];
}

/** The seven plants in the corners and by the door, as the static office placed them. */
export function plantItems(lot: Lot): Item[] {
  const right = lot.x0 + lot.w;
  const bottom = lot.z0 + lot.h;
  const spots = [
    [lot.x0 + 1, bottom - 1],
    [right - 1, bottom - 1],
    [lot.x0 + 1, LOBBY_Z0 + 1],
    [right - 1, LOBBY_Z0 + 1],
    [DOOR_X + 2.6, bottom - 0.9],
    [right - 1, lot.z0 + 1],
    [lot.x0 + 1, lot.z0 + 1],
  ];
  return spots.map(([x, z], n) => ({ id: globalId('plant', n), def: 'plant', x: Math.floor(x * 2), z: Math.floor(z * 2), rot: 0 as Rot }));
}

export const itemId = (blockId: string, kind: string, n: number): ItemId => `${blockId}:${kind}:${String(n).padStart(2, '0')}` as ItemId;
export const globalId = (kind: string, n: number): ItemId => `${kind}:${String(n).padStart(2, '0')}` as ItemId;

/** The center of a team slot, in meters, as the static office laid it out. */
export function blockCenter(slot: number): Vec2 {
  const col = slot % COLS;
  const row = Math.floor(slot / COLS);
  return { x: X0 + AISLE / 2 + BLOCK_W / 2 + col * (BLOCK_W + AISLE), z: -(BLOCK_D / 2 + 1) - row * (BLOCK_D + AISLE) };
}

/** The shared meeting table and its eight chairs, at the middle of the lot just north of the lobby. */
export function meetingItems(lot: Lot): Item[] {
  const cx = Math.round(lot.x0 + lot.w / 2) * 2;
  const items: Item[] = [{ id: globalId('meeting_table', 0), def: 'meeting_table', x: cx - 3, z: -2, rot: 0 }];
  [-3, -1, 1, 2].forEach((dx, n) => {
    items.push({ id: globalId('chair', n), def: 'chair', x: cx + dx, z: -3, rot: 0 }, { id: globalId('chair', n + 4), def: 'chair', x: cx + dx, z: 1, rot: 2 });
  });
  return items;
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
 * When the lot grows, the outer walls and corner plants move to the new edge and the new ground is floored. Ids derive
 * from (blockId, kind, index), so a repeated kit is a no-op.
 */
export function teamKit(b: Building, blockId: string, slot: number): BuildOp[] {
  const c = blockCenter(slot);
  const area: Lot = { x0: c.x - BLOCK_W / 2, z0: c.z - BLOCK_D / 2, w: BLOCK_W, h: BLOCK_D };
  const ops: BuildOp[] = [];
  const lot = union(union(b.lot, area), lotForSlot(slot));
  const grew = lot.w !== b.lot.w || lot.h !== b.lot.h || lot.x0 !== b.lot.x0 || lot.z0 !== b.lot.z0;
  const made = grew && lot.w <= MAX_LOT && lot.h <= MAX_LOT ? lot : null;
  if (grew) ops.push({ t: 'lot', lot: made ?? { ...b.lot } });
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
  const items = teamItems(blockId, slot);
  if (made) {
    const seen = new Set(cells.map((c) => `${c.x},${c.z}`));
    for (let z = made.z0; z < made.z0 + made.h; z++) {
      for (let x = made.x0; x < made.x0 + made.w; x++) {
        if (!seen.has(`${x},${z}`) && !(inLotTile(b.lot, x, z) && hasFloorAt(b.stories[0], tileIndex(b.lot, x, z)))) cells.push({ x, z, half: 0, paint: PAINT.woodLight });
      }
    }
    const next = new Map(perimeter(made).map((w) => [`${w.d}:${w.x},${w.z}`, w]));
    const del: WallRef[] = perimeter(b.lot).filter((w) => !next.has(`${w.d}:${w.x},${w.z}`)).map(({ x, z, d }) => ({ x, z, d }));
    ops.push({ t: 'walls', story: 0, put: [...next.values()], del });
    items.push(...plantItems(made), ...meetingItems(made));
  }
  ops.push({ t: 'floor', story: 0, cells });
  ops.push({ t: 'items', story: 0, put: items, del: [] });
  return ops;
}
