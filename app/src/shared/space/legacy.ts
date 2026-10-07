// The static office the app shipped with, as a Building. A company.json without a building migrates through this.
import { PAINT } from './catalog.ts';
import { BENCH_COUNT, DOOR_X, LOBBY_Z0, globalId, itemId, lotForSlot, meetingItems, perimeter, plantItems, teamItems } from './kit.ts';
import { freeDesk, placeDesk } from './seats.ts';
import { applyAll, emptyBuilding } from './story.ts';
import { wrefKey } from './geom.ts';
import type { Building, BuildOp, BlockId, EmployeeId, FloorCell, Item, ItemId, Lot, SpaceContext, WallSeg } from './types.ts';

const OWNER_WALLS = 6;
const MEETING = { x0: -18, x1: -11, z0: 2, z1: 8, doorZ: [4, 5] } as const;

/**
 * The lobby's default dressing: the bookshelf by the first archway and a lounge in the middle of the hall, two leather sofas
 * and two armchairs around a coffee table with a lamp and plants, so the first look down the hall ends in a furnished room.
 */
function lobbyItems(lot: Lot): Item[] {
  if (lot.x0 > -18 || lot.w < 24) return [];
  const put = (def: string, n: number, x: number, z: number, rot: 0 | 1 | 2 | 3 = 0): Item => ({ id: globalId(def, 50 + n), def, x, z, rot });
  return [
    put('bookshelf', 0, -21, 4),
    put('sofa', 0, 1, 6),
    put('sofa', 1, 1, 10, 2),
    put('armchair', 0, -2, 8, 3),
    put('armchair', 1, 6, 8, 1),
    put('coffee_table', 0, 2, 8),
    put('lamp_floor', 0, -1, 5),
    put('plant_large', 0, 7, 5),
    put('plant_large', 1, -3, 12),
    put('side_table', 0, 7, 12),
    put('armchair', 2, -21, 5),
    put('armchair', 3, -18, 5),
    put('side_table', 1, -19, 5),
  ];
}

export type LegacyBlock = { id: BlockId; slot: number };
export type LegacyEmployee = { id: EmployeeId; blockId: BlockId; desk: number; orchestrator: boolean };

export function legacyLot(blocks: readonly LegacyBlock[]): Lot {
  return lotForSlot(blocks.reduce((m, b) => Math.max(m, b.slot), -1));
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
  for (const w of perimeter(lot)) wall(w);
  // Four-tile window bands along the outer walls, so the facade reads as glazing between piers, not slits in plaster.
  const band = (i: number) => i % 6 >= 1 && i % 6 <= 4;
  for (const w of [...walls.values()]) {
    if (w.open) continue;
    if (w.d === 'e' && band(w.x - lot.x0) && (w.z === lot.z0 || Math.abs(w.x - DOOR_X) > 3)) wall({ ...w, open: 'window' });
    if (w.d === 's' && band(w.z - lot.z0) && w.z < LOBBY_Z0 - 1) wall({ ...w, open: 'window' });
  }
  // Each zone gets its own wall paint: a white street front, a brick lobby on the east side.
  for (const w of [...walls.values()]) {
    if (w.d === 'e' && w.z === lot.z0 + lot.h) wall({ ...w, style: 2 });
    if (w.d === 's' && w.x === right && w.z >= LOBBY_Z0) wall({ ...w, style: 5 });
  }
  const m = MEETING;
  for (let x = m.x0; x < m.x1; x++) {
    wall({ x, z: m.z0, d: 'e', style: OWNER_WALLS });
    wall({ x, z: m.z1, d: 'e', style: OWNER_WALLS });
  }
  for (let z = m.z0; z < m.z1; z++) wall({ x: m.x1, z, d: 's', style: OWNER_WALLS, ...((m.doorZ as readonly number[]).includes(z) ? { open: 'door' as const } : {}) });

  // A glass partition between the lobby and the workspace, with a three-tile archway: it names the zones and frames the view.
  const PART_Z = LOBBY_Z0 + 3;
  for (let x = m.x1; x < Math.min(right, 5); x++) {
    const arch = x >= -6 && x <= -4;
    wall({ x, z: PART_Z, d: 'e', style: 2, open: arch ? 'arch' : (x - m.x1) % 4 === 3 ? undefined : 'window' });
  }

  const cells: FloorCell[] = [];
  const bottom = lot.z0 + lot.h;
  const inBox = (x: number, z: number, x0: number, x1: number, z0: number, z1: number) => x >= x0 && x < x1 && z >= z0 && z < z1;
  // Floor by zone: the owner suite in dark wood, a tiled kitchen, a gray lounge, a stone entry, a tiled reception.
  const zonePaint = (x: number, z: number) => {
    if (inBox(x, z, m.x0, m.x1, m.z0, m.z1)) return PAINT.woodDark;
    if (inBox(x, z, -3, 6, 3, 7)) return PAINT.carpetBlue;
    if (inBox(x, z, right - 8, right, bottom - 6, bottom - 3)) return PAINT.tileWhite;
    if (inBox(x, z, right - 8, right, bottom - 3, bottom)) return PAINT.carpetGray;
    if (inBox(x, z, DOOR_X - 3, DOOR_X + 3, bottom - 3, bottom)) return PAINT.concrete;
    if (inBox(x, z, -4, 4, bottom - 3, bottom)) return PAINT.tileDark;
    return PAINT.woodLight;
  };
  for (let z = lot.z0; z < bottom; z++) for (let x = lot.x0; x < right; x++) cells.push({ x, z, half: 0, paint: zonePaint(x, z) });

  const items: Item[] = [{ id: globalId('owner_desk', 0), def: 'owner_desk', x: -34, z: 9, rot: 1 }, ...plantItems(lot), ...meetingItems(lot), ...lobbyItems(lot)];
  for (const b of blocks) items.push(...teamItems(b.id, b.slot));

  const ops: BuildOp[] = [
    { t: 'floor', story: 0, cells },
    { t: 'walls', story: 0, put: [...walls.values()], del: [] },
    { t: 'items', story: 0, put: items, del: [] },
  ];
  let building: Building = { ...applyAll(emptyBuilding(lot), ops, []).b, shelled: true };

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
