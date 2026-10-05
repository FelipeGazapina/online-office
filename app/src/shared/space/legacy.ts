// Today's static office as a Building. Mirrors renderer/src/layout.ts and scene/Office.tsx; S2 deletes those.
import { PAINT } from './catalog.ts';
import { blockCenter, COLS, BENCH_COUNT, globalId, itemId, rugTiles, teamItems, X0 } from './kit.ts';
import { freeDesk, placeDesk } from './seats.ts';
import { applyAll, emptyBuilding } from './story.ts';
import { wrefKey } from './geom.ts';
import type { Building, BuildOp, BlockId, EmployeeId, FloorCell, Item, ItemId, Lot, SpaceContext, WallSeg } from './types.ts';

const Z1 = 9;
const LOBBY_Z0 = -1;
const DOOR_X = X0 + 8;
const MEETING = { x0: -18, x1: -11, z0: 2, z1: 8, doorZ: [4, 5] } as const;

export type LegacyBlock = { id: BlockId; slot: number };
export type LegacyEmployee = { id: EmployeeId; blockId: BlockId; desk: number; orchestrator: boolean };

export function legacyLot(blocks: readonly LegacyBlock[]): Lot {
  const maxSlot = blocks.reduce((m, b) => Math.max(m, b.slot), -1);
  const ghost = maxSlot + 1 < 6 ? maxSlot + 1 : null;
  const shown = ghost === null ? maxSlot + 1 : ghost + 1;
  const cols = Math.max(2, Math.min(COLS, shown));
  const rows = Math.max(1, Math.ceil(shown / COLS));
  return { x0: X0, z0: -rows * 10, w: cols * 12, h: Z1 + rows * 10 };
}

/**
 * company.json without `building`. Deterministic: ids derive from (blockId, kind, index). Employee.desk index d becomes
 * bench desk d of the block; orchestrators move to the block's PO desk; a desk that is missing or already taken falls
 * back to the team's next free desk, then to a new one.
 */
export function legacyBuilding(
  blocks: readonly LegacyBlock[],
  employees: readonly LegacyEmployee[],
): { building: Building; seats: Map<EmployeeId, ItemId> } {
  const lot = legacyLot(blocks);
  const right = lot.x0 + lot.w;
  const walls = new Map<number, WallSeg>();
  const wall = (w: WallSeg) => walls.set(wrefKey(w), w);
  for (let x = lot.x0; x < right; x++) {
    wall({ x, z: lot.z0, d: 'e', style: 0 });
    wall({ x, z: Z1, d: 'e', style: 0 });
  }
  for (let z = lot.z0; z < Z1; z++) {
    wall({ x: lot.x0, z, d: 's', style: 0 });
    wall({ x: right, z, d: 's', style: 0 });
  }
  for (const x of [DOOR_X - 1, DOOR_X]) wall({ x, z: Z1, d: 'e', style: 0, open: 'door' });
  for (let i = 0; i < Math.floor(lot.w / 6); i++) wall({ x: Math.floor(lot.x0 + 3.5 + i * 6), z: lot.z0, d: 'e', style: 0, open: 'window' });
  for (const z of [lot.z0 + 4.5, lot.z0 + 14]) if (z < -1.5 && z > lot.z0 + 2) wall({ x: lot.x0, z: Math.floor(z), d: 's', style: 0, open: 'window' });
  const m = MEETING;
  for (let x = m.x0; x < m.x1; x++) {
    wall({ x, z: m.z0, d: 'e', style: 0 });
    wall({ x, z: m.z1, d: 'e', style: 0 });
  }
  for (let z = m.z0; z < m.z1; z++) wall({ x: m.x1, z, d: 's', style: 0, ...((m.doorZ as readonly number[]).includes(z) ? { open: 'door' as const } : {}) });

  const cells: FloorCell[] = [];
  for (let z = lot.z0; z < lot.z0 + lot.h; z++) for (let x = lot.x0; x < right; x++) cells.push({ x, z, half: 0, paint: PAINT.woodLight });
  for (const b of blocks) {
    const r = rugTiles(b.slot);
    for (let z = r.z0; z < r.z1; z++) for (let x = r.x0; x < r.x1; x++) cells.push({ x, z, half: 0, paint: PAINT.carpetBlue });
  }

  const items: Item[] = [{ id: globalId('owner_desk', 0), def: 'owner_desk', x: -34, z: 9, rot: 1 }];
  const plants = [
    [lot.x0 + 1, Z1 - 1],
    [right - 1, Z1 - 1],
    [lot.x0 + 1, LOBBY_Z0 + 1],
    [right - 1, LOBBY_Z0 + 1],
    [DOOR_X + 2.6, Z1 - 0.9],
    [right - 1, lot.z0 + 1],
    [lot.x0 + 1, lot.z0 + 1],
  ];
  plants.forEach(([x, z], n) => items.push({ id: globalId('plant', n), def: 'plant', x: Math.floor(x * 2), z: Math.floor(z * 2), rot: 0 }));
  for (const b of blocks) items.push(...teamItems(b.id, b.slot));

  const ops: BuildOp[] = [
    { t: 'floor', story: 0, cells },
    { t: 'walls', story: 0, put: [...walls.values()], del: [] },
    { t: 'items', story: 0, put: items, del: [] },
  ];
  let building = applyAll(emptyBuilding(lot), ops, []).b;

  const known = new Set(blocks.map((b) => b.id));
  const seated = employees.filter((e) => known.has(e.blockId));
  const ctx: SpaceContext = {
    blocks: known,
    employees: new Map(seated.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.orchestrator }])),
    seats: new Map(),
  };
  const seats = new Map<EmployeeId, ItemId>();
  const taken = new Set<ItemId>();
  const claim = (emp: EmployeeId, id: ItemId) => {
    seats.set(emp, id);
    taken.add(id);
  };
  for (const e of seated) {
    const want = e.orchestrator ? itemId(e.blockId, 'po_desk', 0) : e.desk >= 0 && e.desk < BENCH_COUNT ? itemId(e.blockId, 'bench_desk', e.desk) : null;
    if (want && !taken.has(want)) claim(e.id, want);
  }
  for (const e of seated) {
    if (seats.has(e.id)) continue;
    let desk = freeDesk(building, seats, e.blockId, e.orchestrator);
    if (!desk) {
      const put = placeDesk(building, e.blockId, e.orchestrator, { ...ctx, seats });
      if (put) {
        building = applyAll(building, put, []).b;
        desk = freeDesk(building, seats, e.blockId, e.orchestrator);
      }
    }
    if (desk) claim(e.id, desk.id);
  }
  return { building, seats };
}
