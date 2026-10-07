import { ITEM_DEFS, PAINT_COUNT, layerOf, placementOf, rotateLocal } from './catalog.ts';
import { deriveFloors } from './derive.ts';
import { defOf, floorItems, hasFloorAt, inLotTile, isFloor, isTop, itemRect, sameItem, stairsInfo, tileIndex, wkey, type CellRect } from './geom.ts';
import { route } from './nav.ts';
import { levelOf, MAX_LVL, supportViolation, topsClash, topViolation } from './surface.ts';
import { itemInLot, wallInLot, applyAll } from './story.ts';
import type {
  Applied,
  Building,
  BuildOp,
  FloorGeometry,
  FloorItem,
  FloorPos,
  Item,
  ItemDef,
  ItemId,
  SpaceContext,
  Story,
  TopItem,
  Violation,
  Vec2,
} from './types.ts';

const vkey = (v: Violation) => `${v.kind}|${v.story}|${v.at ? `${v.at.x},${v.at.z}` : ''}|${v.ids?.join(',') ?? ''}`;
const dedupe = (list: readonly Violation[]): Violation[] => {
  const seen = new Set<string>();
  return list.filter((v) => {
    const k = vkey(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const center = (r: CellRect): Vec2 => ({ x: (r.x0 + r.x1) / 4, z: (r.z0 + r.z1) / 4 });

export function findItem(story: Story, id: ItemId): Item | undefined {
  let lo = 0;
  let hi = story.items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cur = story.items[mid].id;
    if (cur === id) return story.items[mid];
    if (cur < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** The floor item with this id and its story. What stands on something else is placed by its host, and is not found here. */
export function locateItem(b: Building, id: ItemId): { story: number; item: FloorItem } | null {
  for (let s = 0; s < b.stories.length; s++) {
    const item = findItem(b.stories[s], id);
    if (item && isFloor(item)) return { story: s, item };
  }
  return null;
}

function segmentHitsInterior(ax: number, az: number, bx: number, bz: number, r: { x0: number; x1: number; z0: number; z1: number }): boolean {
  const e = 1e-6;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q > 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  const dx = bx - ax;
  const dz = bz - az;
  return clip(-dx, ax - (r.x0 + e)) && clip(dx, r.x1 - e - ax) && clip(-dz, az - (r.z0 + e)) && clip(dz, r.z1 - e - az) && t0 <= t1;
}

function wallCrosses(g: FloorGeometry, r: CellRect): boolean {
  const X0 = r.x0 / 2;
  const X1 = r.x1 / 2;
  const Z0 = r.z0 / 2;
  const Z1 = r.z1 / 2;
  const tx0 = Math.floor(X0);
  const tx1 = Math.ceil(X1) - 1;
  const tz0 = Math.floor(Z0);
  const tz1 = Math.ceil(Z1) - 1;
  for (let z = Math.floor(Z0) + 1; z <= Math.ceil(Z1) - 1; z++) for (let x = tx0; x <= tx1; x++) if (g.wallAt.has(wkey(x, z, 'e'))) return true;
  for (let x = Math.floor(X0) + 1; x <= Math.ceil(X1) - 1; x++) for (let z = tz0; z <= tz1; z++) if (g.wallAt.has(wkey(x, z, 's'))) return true;
  const box = { x0: X0, x1: X1, z0: Z0, z1: Z1 };
  for (let z = tz0; z <= tz1; z++) {
    for (let x = tx0; x <= tx1; x++) {
      if (g.wallAt.has(wkey(x, z, 'sd')) && segmentHitsInterior(x, z, x + 1, z + 1, box)) return true;
      if (g.wallAt.has(wkey(x, z, 'nd')) && segmentHitsInterior(x, z + 1, x + 1, z, box)) return true;
    }
  }
  return false;
}

/** Rules that need only the floor the item stands on. Overlap is separate because it needs the other items. */
function itemViolations(g: FloorGeometry, item: FloorItem, def: ItemDef): Violation[] {
  const story = g.index;
  const r = itemRect(item, def);
  const at = center(r);
  if (!itemInLot(g.lot, item)) return [{ kind: 'out_of_lot', story, at, ids: [item.id] }];
  const out: Violation[] = [];
  if (placementOf(def) === 'surface') out.push({ kind: 'needs_surface', story, at, ids: [item.id] });
  let noFloor = false;
  let onHole = false;
  for (let tz = Math.floor(r.z0 / 2); tz <= Math.ceil(r.z1 / 2) - 1; tz++) {
    for (let tx = Math.floor(r.x0 / 2); tx <= Math.ceil(r.x1 / 2) - 1; tx++) {
      const ti = tileIndex(g.lot, tx, tz);
      if (!hasFloorAt(g.story, ti)) noFloor = true;
      if (g.hole[ti]) onHole = true;
    }
  }
  if (noFloor) out.push({ kind: 'no_floor', story, at, ids: [item.id] });
  if (onHole) out.push({ kind: 'on_hole', story, at, ids: [item.id] });
  if (!def.walkable && wallCrosses(g, r)) out.push({ kind: 'wall_through_item', story, at, ids: [item.id] });
  return out;
}

function seatViolations(b: Building, ctx: SpaceContext): Violation[] {
  const out: Violation[] = [];
  const taken = new Map<ItemId, string>();
  for (const [emp, itemId] of ctx.seats) {
    const who = ctx.employees.get(emp);
    if (!who) continue;
    const found = locateItem(b, itemId);
    if (!found) continue;
    const want = who.orchestrator ? 'po_desk' : 'bench_desk';
    const kind = defOf(found.item)?.kind;
    if (kind !== want) out.push({ kind: 'desk_wrong_kind', story: found.story, ids: [itemId] });
    if (found.item.blockId !== who.blockId) out.push({ kind: 'desk_wrong_block', story: found.story, ids: [itemId] });
    if (taken.has(itemId)) out.push({ kind: 'desk_double_occupied', story: found.story, ids: [itemId] });
    taken.set(itemId, emp);
  }
  return out;
}

/** The first door in the lot's outer wall on the ground floor, and a spot just inside it. */
export function entryOf(b: Building): FloorPos | null {
  const { lot } = b;
  for (const w of b.stories[0]?.walls ?? []) {
    if (w.open !== 'door') continue;
    if (w.d === 'e' && w.z === lot.z0 + lot.h) return { floor: 0, x: w.x + 0.5, z: w.z - 1.2 };
    if (w.d === 'e' && w.z === lot.z0) return { floor: 0, x: w.x + 0.5, z: w.z + 1.2 };
    if (w.d === 's' && w.x === lot.x0) return { floor: 0, x: w.x + 1.2, z: w.z + 0.5 };
    if (w.d === 's' && w.x === lot.x0 + lot.w) return { floor: 0, x: w.x - 1.2, z: w.z + 0.5 };
  }
  return null;
}

function seatExit(item: FloorItem, def: ItemDef): Vec2 | null {
  if (!def.seat) return null;
  const o = rotateLocal(def, item.rot, def.seat.exit);
  return { x: (item.x + o.x) * 0.5, z: (item.z + o.z) * 0.5 };
}

/** Every rule, over every story. */
export function validate(b: Building, ctx: SpaceContext): readonly Violation[] {
  const floors = deriveFloors(b);
  const out: Violation[] = [];
  floors.forEach((g, s) => {
    const { lot, story } = g;
    for (const w of story.walls) {
      if (!wallInLot(lot, w)) out.push({ kind: 'out_of_lot', story: s, at: { x: w.x, z: w.z } });
      if (w.open === 'door' && (w.d === 'sd' || w.d === 'nd')) out.push({ kind: 'bad_opening', story: s, at: { x: w.x, z: w.z } });
      if (w.d === 'sd' && g.wallAt.has(wkey(w.x, w.z, 'nd'))) out.push({ kind: 'bad_diagonal_half', story: s, at: { x: w.x, z: w.z } });
    }
    for (const k of Object.keys(story.halfB)) {
      const ti = Number(k);
      const tx = lot.x0 + (ti % lot.w);
      const tz = lot.z0 + Math.floor(ti / lot.w);
      if (!g.wallAt.has(wkey(tx, tz, 'sd')) && !g.wallAt.has(wkey(tx, tz, 'nd'))) out.push({ kind: 'bad_diagonal_half', story: s, at: { x: tx, z: tz } });
    }
    for (let ti = 0; ti < story.paint.length; ti++) {
      if (story.paint[ti] >= PAINT_COUNT) out.push({ kind: 'bad_paint', story: s });
      if (s > 0 && hasFloorAt(story, ti) && !hasFloorAt(b.stories[s - 1], ti)) {
        out.push({ kind: 'floor_unsupported', story: s, at: { x: lot.x0 + (ti % lot.w), z: lot.z0 + Math.floor(ti / lot.w) } });
      }
    }
    for (const item of story.items) {
      const def = defOf(item);
      if (!def) {
        out.push({ kind: 'unknown_item', story: s, ids: [item.id] });
        continue;
      }
      if (isTop(item)) {
        const kind = topViolation(item, def, findItem(story, item.on)) ?? supportViolation(item, def, (g.tops.get(item.on) ?? []).map((n) => story.items[n]));
        if (kind) out.push({ kind, story: s, ids: [item.id] });
        continue;
      }
      out.push(...itemViolations(g, item, def));
      if (def.stairs) out.push(...stairsViolations(b, s, item, def));
    }
    for (const [a, c] of g.overlaps) out.push({ kind: 'overlap', story: s, ids: [a, c] });
  });
  out.push(...seatViolations(b, ctx));
  out.push(...reachability(b, ctx, floors));
  return dedupe(out);
}

function stairsViolations(b: Building, s: number, item: FloorItem, def: ItemDef): Violation[] {
  const info = stairsInfo(item, def);
  const at = { x: info.top.x, z: info.top.z };
  if (!info.aligned) return [{ kind: 'stairs_misaligned', story: s, ids: [item.id] }];
  const above = b.stories[s + 1];
  if (!above) return [{ kind: 'stairs_no_upper_story', story: s, ids: [item.id] }];
  const { tx, tz } = info.landing;
  if (!inLotTile(b.lot, tx, tz) || !hasFloorAt(above, tileIndex(b.lot, tx, tz))) return [{ kind: 'stairs_no_landing', story: s + 1, at, ids: [item.id] }];
  return [];
}

function reachability(b: Building, ctx: SpaceContext, floors: readonly FloorGeometry[]): Violation[] {
  const out: Violation[] = [];
  const reached = new Set<number>([0]);
  for (let s = 0; s + 1 < b.stories.length; s++) {
    if (!reached.has(s)) continue;
    const links = floorItems(b.stories[s]).some((i) => {
      const d = defOf(i);
      return d?.stairs && stairsInfo(i, d).aligned && stairsViolations(b, s, i, d).length === 0;
    });
    if (links) reached.add(s + 1);
  }
  const stranded = new Set<number>();
  for (let s = 1; s < b.stories.length; s++) {
    if (reached.has(s) || !b.stories[s].paint.some((p) => p > 0)) continue;
    out.push({ kind: 'story_unreachable', story: s });
    stranded.add(s);
  }
  const entry = entryOf(b);
  for (const [emp, itemId] of ctx.seats) {
    if (!ctx.employees.has(emp)) continue;
    const found = locateItem(b, itemId);
    if (!found) continue;
    if (stranded.has(found.story)) {
      out.push({ kind: 'would_strand_desks', story: found.story, ids: [itemId] });
      continue;
    }
    const def = defOf(found.item);
    const exit = def && seatExit(found.item, def);
    if (!entry || !exit) continue;
    if (!route(floors, entry, { floor: found.story, x: exit.x, z: exit.z })) out.push({ kind: 'desk_unreachable', story: found.story, ids: [itemId] });
  }
  return out;
}

// ---------------------------------------------------------------- incremental path for item-only edits

function fastEligible(b: Building, ops: readonly BuildOp[]): boolean {
  // An edit that moves pieces between stories can strand a desk: it takes the full rules, with reachability.
  if (new Set(ops.map((op) => (op.t === 'items' ? op.story : -1))).size > 1) return false;
  for (const op of ops) {
    if (op.t !== 'items' || !b.stories[op.story]) return false;
    for (const it of op.put) if (ITEM_DEFS[it.def]?.stairs) return false;
    for (const id of op.del) {
      const old = findItem(b.stories[op.story], id);
      if (old && ITEM_DEFS[old.def]?.stairs) return false;
    }
    for (const it of op.put) {
      const old = findItem(b.stories[op.story], it.id);
      if (old && ITEM_DEFS[old.def]?.stairs) return false;
    }
  }
  return true;
}

/** Rule check for item-only edits against the cached geometry of `b`. */
export function fastViolations(b: Building, ops: readonly BuildOp[]): Violation[] {
  const floors = deriveFloors(b);
  const finals = new Map<number, Map<ItemId, Item | null>>();
  for (const op of ops) {
    if (op.t !== 'items') continue;
    const m = finals.get(op.story) ?? finals.set(op.story, new Map()).get(op.story)!;
    for (const id of op.del) m.set(id, null);
    for (const it of op.put) m.set(it.id, it);
  }
  const out: Violation[] = [];
  for (const [s, m] of finals) {
    const g = floors[s];
    const added: { item: FloorItem; def: ItemDef; rect: CellRect }[] = [];
    const addedTops: { item: TopItem; def: ItemDef }[] = [];
    for (const [id, item] of m) {
      if (!item) continue;
      const def = ITEM_DEFS[item.def];
      if (!def) {
        out.push({ kind: 'unknown_item', story: s, ids: [id] });
        continue;
      }
      const old = findItem(b.stories[s], id);
      if (old && sameItem(old, item)) continue;
      if (isTop(item)) {
        const host = m.has(item.on) ? (m.get(item.on) ?? undefined) : findItem(b.stories[s], item.on);
        const kind = topViolation(item, def, host);
        if (kind) out.push({ kind, story: s, ids: [id] });
        for (const n of g.tops.get(item.on) ?? []) {
          const other = g.story.items[n] as TopItem;
          if (m.has(other.id)) continue;
          if (ITEM_DEFS[other.def] && topsClash(item, def, other, ITEM_DEFS[other.def])) out.push({ kind: 'overlap', story: s, ids: [other.id, id] });
        }
        addedTops.push({ item, def });
        continue;
      }
      out.push(...itemViolations(g, item, def));
      if (!itemInLot(g.lot, item)) continue;
      const rect = itemRect(item, def);
      const cw = g.lot.w * 2;
      const grid = layerOf(def) === 'floor' ? g.floorOcc : g.occ;
      const hit = new Set<ItemId>();
      for (let cz = rect.z0; cz < rect.z1; cz++) {
        for (let cx = rect.x0; cx < rect.x1; cx++) {
          const owner = grid[(cz - g.lot.z0 * 2) * cw + (cx - g.lot.x0 * 2)];
          if (!owner) continue;
          const otherId = g.story.items[owner - 1].id;
          if (m.has(otherId)) continue;
          hit.add(otherId);
        }
      }
      for (const otherId of hit) out.push({ kind: 'overlap', story: s, ids: [otherId, id] });
      added.push({ item, def, rect });
    }
    for (let i = 0; i < added.length; i++) {
      for (let j = i + 1; j < added.length; j++) {
        if (layerOf(added[i].def) !== layerOf(added[j].def)) continue;
        const a = added[i].rect;
        const c = added[j].rect;
        if (a.x0 < c.x1 && c.x0 < a.x1 && a.z0 < c.z1 && c.z0 < a.z1) out.push({ kind: 'overlap', story: s, ids: [added[i].item.id, added[j].item.id] });
      }
    }
    for (let i = 0; i < addedTops.length; i++) {
      for (let j = i + 1; j < addedTops.length; j++) {
        if (addedTops[i].item.on !== addedTops[j].item.on) continue;
        if (topsClash(addedTops[i].item, addedTops[i].def, addedTops[j].item, addedTops[j].def)) {
          out.push({ kind: 'overlap', story: s, ids: [addedTops[i].item.id, addedTops[j].item.id] });
        }
      }
    }
    // A stack stays whole: what is put or left on a host rests on something that is still there. What a deleted thing carried falls with
    // it (the story does the same), so only what stood before and has lost its support through a move counts.
    const hosts = new Set<ItemId>(addedTops.map((t) => t.item.on));
    for (const [id] of m) {
      const old = findItem(b.stories[s], id);
      if (old && isTop(old)) hosts.add(old.on);
    }
    for (const host of hosts) {
      const before = (g.tops.get(host) ?? []).map((n) => g.story.items[n]);
      let kept: Item[] = before.filter((i) => m.get(i.id) !== null);
      for (let pass = 0; pass <= MAX_LVL; pass++) {
        const falling = kept.filter((i) => isTop(i) && levelOf(i) > 0 && ITEM_DEFS[i.def] && supportViolation(i, ITEM_DEFS[i.def], kept) !== null && supportViolation(i, ITEM_DEFS[i.def], before) === null);
        if (!falling.length) break;
        kept = kept.filter((i) => !falling.includes(i));
      }
      const now: Item[] = [...kept.filter((i) => !m.has(i.id)), ...[...m.values()].filter((i): i is Item => !!i && isTop(i) && i.on === host)];
      for (const item of now) {
        const def = ITEM_DEFS[item.def];
        if (!def || !isTop(item) || levelOf(item) === 0 || supportViolation(item, def, now) === null) continue;
        if (m.has(item.id) || supportViolation(item, def, before) === null) out.push({ kind: 'unsupported', story: s, ids: [item.id] });
      }
    }
  }
  return out;
}

/** Reported by `validate` but never a reason to reject an edit: an upper floor has to be paintable before its stairs exist. */
const ADVISORY: ReadonlySet<string> = new Set(['story_unreachable']);

function evaluate(b: Building, ops: readonly BuildOp[], ctx: SpaceContext) {
  const report: Violation[] = [];
  const { b: nb, inverse } = applyAll(b, ops, report);
  if (nb === b) return { nb, inverse, violations: dedupe(report) };
  let fresh: Violation[];
  if (fastEligible(b, ops)) {
    const before = new Set(seatViolations(b, ctx).map(vkey));
    fresh = [...fastViolations(b, ops), ...seatViolations(nb, ctx).filter((v) => !before.has(vkey(v)))];
  } else {
    fresh = [...validate(nb, ctx)];
    if (fresh.length) {
      const before = new Set(validate(b, ctx).map(vkey));
      fresh = fresh.filter((v) => !before.has(vkey(v)));
    }
  }
  return { nb, inverse, violations: dedupe([...report, ...fresh.filter((v) => !ADVISORY.has(v.kind))]) };
}

/**
 * All or nothing. Only violations that are new relative to `b` reject an edit, so a building that was already broken
 * stays editable. Item-only edits are checked against the cached geometry of `b` and skip the reachability rules,
 * which need a nav rebuild; `validate` and any wall, floor, lot or stairs edit run every rule.
 */
export function applyOps(b: Building, ops: readonly BuildOp[], ctx: SpaceContext): Applied {
  const r = evaluate(b, ops, ctx);
  if (r.violations.length) return { ok: false, violations: r.violations };
  return { ok: true, building: r.nb, forward: ops, inverse: r.inverse };
}

/** The same verdict as `applyOps`, without the result. Drives the red/green ghost. */
export function checkOps(b: Building, ops: readonly BuildOp[], ctx: SpaceContext): readonly Violation[] {
  return evaluate(b, ops, ctx).violations;
}

type Entry = { forward: readonly BuildOp[]; inverse: readonly BuildOp[]; label: string };
const HISTORY_LIMIT = 100;

export class BuildHistory {
  private done: Entry[] = [];
  private undone: Entry[] = [];

  push(entry: Entry): void {
    this.done.push(entry);
    if (this.done.length > HISTORY_LIMIT) this.done.shift();
    this.undone = [];
  }

  /** Null when there is nothing to undo. A rejected undo leaves both stacks as they were. */
  undo(b: Building, ctx: SpaceContext): Applied | null {
    const entry = this.done[this.done.length - 1];
    if (!entry) return null;
    const r = applyOps(b, entry.inverse, ctx);
    if (r.ok) {
      this.done.pop();
      this.undone.push(entry);
    }
    return r;
  }

  redo(b: Building, ctx: SpaceContext): Applied | null {
    const entry = this.undone[this.undone.length - 1];
    if (!entry) return null;
    const r = applyOps(b, entry.forward, ctx);
    if (r.ok) {
      this.undone.pop();
      this.done.push(entry);
    }
    return r;
  }
}
