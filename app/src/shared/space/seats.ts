import { ITEM_DEFS, YAW, footprint, rotateLocal } from './catalog.ts';
import { deriveFloors } from './derive.ts';
import { defOf, itemRect, tileOfCell } from './geom.ts';
import { itemId } from './kit.ts';
import { fastViolations, locateItem } from './validate.ts';
import type { Building, BlockId, BuildOp, EmployeeId, Item, ItemId, Rot, SeatPose, SpaceContext, Vec2 } from './types.ts';

const toMeters = (item: Item, p: Vec2): Vec2 => ({ x: (item.x + p.x) * 0.5, z: (item.z + p.z) * 0.5 });

/** Where a seat's desk, chair and standing spot are, in meters, and the way the sitter faces. Throws for an item that is not a desk. */
export function seatPose(b: Building, id: ItemId): SeatPose {
  const found = locateItem(b, id);
  const def = found && defOf(found.item);
  if (!found || !def?.seat) throw new Error(`${id} is not a desk`);
  const { item } = found;
  const at = (p: Vec2) => toMeters(item, rotateLocal(def, item.rot, p));
  return {
    floor: found.story,
    desk: at({ x: def.w / 2, z: def.d / 2 }),
    chair: at(def.seat.chair),
    exit: at(def.seat.exit),
    yaw: YAW[item.rot] + def.seat.yaw,
  };
}

/** The owner's desk, or the desk `seats` gives an employee. */
export function deskOf(b: Building, seats: ReadonlyMap<EmployeeId, ItemId>, who: EmployeeId | 'owner'): Item | null {
  if (who === 'owner') {
    for (const s of b.stories) for (const i of s.items) if (ITEM_DEFS[i.def]?.kind === 'owner_desk') return i;
    return null;
  }
  const id = seats.get(who);
  return (id && locateItem(b, id)?.item) || null;
}

const kindFor = (orchestrator: boolean) => (orchestrator ? 'po_desk' : 'bench_desk');

/** The team's first unclaimed desk of the right kind: its PO desk for an orchestrator, a bench desk for anyone else. Null when none is free. */
export function freeDesk(b: Building, seats: ReadonlyMap<EmployeeId, ItemId>, blockId: BlockId, orchestrator: boolean): Item | null {
  const taken = new Set(seats.values());
  for (const s of b.stories) {
    for (const i of s.items) {
      if (i.blockId === blockId && ITEM_DEFS[i.def]?.kind === kindFor(orchestrator) && !taken.has(i.id)) return i;
    }
  }
  return null;
}

/** A new desk as close to the team's existing items as the rules allow, or null when the search radius is full. */
export function placeDesk(b: Building, blockId: BlockId, orchestrator: boolean, _ctx: SpaceContext): BuildOp[] | null {
  const kind = kindFor(orchestrator);
  const def = ITEM_DEFS[kind];
  let story = -1;
  let sx = 0;
  let sz = 0;
  let n = 0;
  b.stories.forEach((st, s) => {
    for (const i of st.items) {
      if (i.blockId !== blockId) continue;
      const d = defOf(i);
      if (!d) continue;
      if (story < 0) story = s;
      if (s !== story) continue;
      const r = itemRect(i, d);
      sx += (r.x0 + r.x1) / 2;
      sz += (r.z0 + r.z1) / 2;
      n++;
    }
  });
  if (story < 0) return null;
  const g = deriveFloors(b)[story];
  const used = b.stories.flatMap((s) => s.items).filter((i) => i.def === kind && i.blockId === blockId).map((i) => Number(i.id.slice(i.id.lastIndexOf(':') + 1)));
  const id = itemId(blockId, kind, used.length ? Math.max(...used) + 1 : 0);
  const ax = Math.round(sx / n);
  const az = Math.round(sz / n);
  const free = (cx: number, cz: number) => {
    const tx = tileOfCell(cx);
    const tz = tileOfCell(cz);
    if (tx < g.lot.x0 || tx >= g.lot.x0 + g.lot.w || tz < g.lot.z0 || tz >= g.lot.z0 + g.lot.h) return false;
    return g.occ[(cz - g.lot.z0 * 2) * g.lot.w * 2 + (cx - g.lot.x0 * 2)] === 0;
  };
  const RADIUS = 24;
  for (let r = 0; r <= RADIUS; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const rot of [0, 2, 1, 3] as Rot[]) {
          const f = footprint(def, rot);
          const item: Item = { id, def: kind, x: ax + dx - Math.floor(f.w / 2), z: az + dz - Math.floor(f.d / 2), rot, blockId };
          const op: BuildOp = { t: 'items', story, put: [item], del: [] };
          if (fastViolations(b, [op]).length) continue;
          const chair = rotateLocal(def, rot, def.seat!.chair);
          if (!free(Math.floor(item.x + chair.x), Math.floor(item.z + chair.z))) continue;
          return [op];
        }
      }
    }
  }
  return null;
}
