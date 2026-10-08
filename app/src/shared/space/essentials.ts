import { ITEM_DEFS, rotateLocal } from './catalog.ts';
import { deriveFloors } from './derive.ts';
import { route } from './nav.ts';
import { deskOf, freeDesk } from './seats.ts';
import { entryOf, locateItem, validate } from './validate.ts';
import type { BlockId, Building, BuildOp, EmployeeId, FloorCell, ItemId, SpaceContext } from './types.ts';

/** What a building still lacks before build mode may save it. */
export type Missing =
  | { kind: 'entrance' }
  | { kind: 'owner_desk' }
  | { kind: 'owner_desk_unreachable' }
  | { kind: 'desks'; blockId: BlockId; desk: 'po_desk' | 'bench_desk'; count: number }
  | { kind: 'team_item'; blockId: BlockId; def: 'whiteboard' | 'board_terminal' }
  | { kind: 'desks_unreachable'; ids: readonly ItemId[] };

const TEAM_ITEMS = ['whiteboard', 'board_terminal'] as const;
const kindFor = (orchestrator: boolean) => (orchestrator ? 'po_desk' : 'bench_desk');

/** Who would sit where: everyone keeps a desk that still fits them, and the rest take their team's free desks in order. Never adds a desk. */
export function assignSeats(b: Building, ctx: SpaceContext): Map<EmployeeId, ItemId> {
  const seats = new Map<EmployeeId, ItemId>();
  const taken = new Set<ItemId>();
  for (const [emp, who] of ctx.employees) {
    const id = ctx.seats.get(emp);
    const item = id ? locateItem(b, id)?.item : undefined;
    if (!item || taken.has(item.id) || item.blockId !== who.blockId || ITEM_DEFS[item.def]?.kind !== kindFor(who.orchestrator)) continue;
    seats.set(emp, item.id);
    taken.add(item.id);
  }
  for (const [emp, who] of ctx.employees) {
    if (seats.has(emp)) continue;
    const desk = freeDesk(b, seats, who.blockId, who.orchestrator);
    if (desk) seats.set(emp, desk.id);
  }
  return seats;
}

/** Empty when the office can run in `b`: a way in, the owner's desk, and for every team its desks, whiteboard and board terminal, all within walking reach. */
export function missingEssentials(b: Building, ctx: SpaceContext): Missing[] {
  const out: Missing[] = [];
  const entry = entryOf(b);
  if (!entry) out.push({ kind: 'entrance' });

  const owner = deskOf(b, new Map(), 'owner');
  if (!owner) out.push({ kind: 'owner_desk' });
  else if (entry) {
    const found = locateItem(b, owner.id)!;
    const seat = ITEM_DEFS[owner.def].seat!;
    const exit = rotateLocal(ITEM_DEFS[owner.def], owner.rot, seat.exit);
    if (!route(deriveFloors(b), entry, { floor: found.story, x: (owner.x + exit.x) * 0.5, z: (owner.z + exit.z) * 0.5 })) out.push({ kind: 'owner_desk_unreachable' });
  }

  const seats = assignSeats(b, ctx);
  const short = new Map<string, { blockId: BlockId; desk: 'po_desk' | 'bench_desk'; count: number }>();
  for (const [emp, who] of ctx.employees) {
    if (seats.has(emp) || !ctx.blocks.has(who.blockId)) continue;
    const desk = kindFor(who.orchestrator);
    const key = `${who.blockId}|${desk}`;
    const cur = short.get(key) ?? { blockId: who.blockId, desk, count: 0 };
    cur.count++;
    short.set(key, cur);
  }
  for (const s of short.values()) out.push({ kind: 'desks', ...s });

  const items = b.stories.flatMap((s) => s.items);
  for (const blockId of ctx.blocks) {
    for (const def of TEAM_ITEMS) if (!items.some((i) => i.def === def && i.blockId === blockId)) out.push({ kind: 'team_item', blockId, def });
  }

  const far = validate(b, { ...ctx, seats })
    .filter((v) => v.kind === 'desk_unreachable' || v.kind === 'would_strand_desks')
    .flatMap((v) => v.ids ?? []);
  if (far.length) out.push({ kind: 'desks_unreachable', ids: [...new Set(far)] });
  return out;
}

/** Takes the building down to an empty lot with one floor level: no items, no walls, no floor, no stock lobby or facilities. */
export function clearOps(b: Building): BuildOp[] {
  const ops: BuildOp[] = [];
  b.stories.forEach((s, story) => {
    if (s.items.length) ops.push({ t: 'items', story, put: [], del: s.items.map((i) => i.id) });
    if (s.walls.length) ops.push({ t: 'walls', story, put: [], del: s.walls.map(({ x, z, d }) => ({ x, z, d })) });
    const cells: FloorCell[] = [];
    s.paint.forEach((p, i) => {
      const x = b.lot.x0 + (i % b.lot.w);
      const z = b.lot.z0 + Math.floor(i / b.lot.w);
      if (p > 0) cells.push({ x, z, half: 0, paint: 0 });
      if ((s.halfB[i] ?? 0) > 0) cells.push({ x, z, half: 1, paint: 0 });
    });
    if (cells.length) ops.push({ t: 'floor', story, cells });
  });
  if (b.stories.length > 1) ops.push({ t: 'stories', count: 1 });
  if (!b.bare) ops.push({ t: 'bare', on: true });
  return ops;
}
