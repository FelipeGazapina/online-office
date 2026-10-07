// The surface layer. A desk, table, counter or shelf declares a top (`ItemDef.surface`); a small item stands on it as a
// `TopItem` that names its host and its place on the host's frame. Everything here is pure: where a top item is in the
// world, and the rules that decide whether it may stand there.
import { ITEM_DEFS, YAW, placementOf, rotateLocal } from './catalog.ts';
import { floorItems, isTop } from './geom.ts';
import { CELL, TOP_UNIT, type FloorItem, type Item, type ItemDef, type ItemId, type Rot, type Story, type TopItem, type UnitRect, type Vec2, type ViolationKind } from './types.ts';

const PER_CELL = CELL / TOP_UNIT;
export const unitsOverlap = (a: UnitRect, b: UnitRect): boolean => a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1;

/** Things stack this high: a mug on a notebook on a folder is level 2. */
export const MAX_LVL = 3;
export const levelOf = (i: Item): number => i.lvl ?? 0;
/** Which of the def's looks an item shows: a look the def does not have wraps around, so a stale file still draws something. */
export const lookOf = (i: Item, def: ItemDef): number => {
  const n = def.looks ?? 1;
  return (((i.look ?? 0) % n) + n) % n;
};
/** The key a look is drawn under: the def alone for its first look, `def#n` for the others. */
export const drawKey = (i: Item, def: ItemDef): string => (lookOf(i, def) ? `${i.def}#${lookOf(i, def)}` : i.def);
const RAD = Math.PI / 180;

/** Footprint of a small item on a surface after its turn relative to the host, in TOP_UNITs. */
export function topSize(def: ItemDef, rot: Rot): { w: number; d: number } {
  const t = def.top ?? { w: 1, d: 1 };
  return rot % 2 === 0 ? t : { w: t.d, d: t.w };
}

/** The rect a top item covers in its host's unturned frame. */
export function topRect(item: TopItem, def: ItemDef): UnitRect {
  const s = topSize(def, item.rot);
  return { u0: item.u, v0: item.v, u1: item.u + s.w, v1: item.v + s.d };
}

// The inverse of `rotateLocal`: a point of the turned footprint back to the unturned one.
function unrotateLocal(def: ItemDef, rot: Rot, p: Vec2): Vec2 {
  switch (rot) {
    case 0:
      return p;
    case 1:
      return { x: p.z, z: def.d - p.x };
    case 2:
      return { x: def.w - p.x, z: def.d - p.z };
    case 3:
      return { x: def.w - p.z, z: p.x };
  }
}

/** A point of the host's top, in TOP_UNITs of its unturned frame, to the world in meters. */
export function hostToWorld(host: FloorItem, def: ItemDef, u: number, v: number): Vec2 {
  const c = rotateLocal(def, host.rot, { x: u / PER_CELL, z: v / PER_CELL });
  return { x: (host.x + c.x) * CELL, z: (host.z + c.z) * CELL };
}

/** A point in the world in meters to the host's unturned frame, in TOP_UNITs. */
export function worldToHost(host: FloorItem, def: ItemDef, p: Vec2): Vec2 {
  const c = unrotateLocal(def, host.rot, { x: p.x / CELL - host.x, z: p.z / CELL - host.z });
  return { x: c.x * PER_CELL, z: c.z * PER_CELL };
}

const grow = (r: UnitRect, n: number): UnitRect => ({ u0: r.u0 - n, v0: r.v0 - n, u1: r.u1 + n, v1: r.v1 + n });
const within = (a: UnitRect, b: UnitRect): boolean => a.u0 >= b.u0 && a.v0 >= b.v0 && a.u1 <= b.u1 && a.v1 <= b.v1;

/** Whether `up` stands on `low`: same host, one level down, a def things may rest on, its middle over `low` and no more than one unit of it hanging over the edge. */
export function restsOn(up: TopItem, upDef: ItemDef, low: TopItem, lowDef: ItemDef): boolean {
  if (low.on !== up.on || low.id === up.id || !lowDef.stackable || levelOf(low) !== levelOf(up) - 1) return false;
  const r = topRect(up, upDef);
  const under = topRect(low, lowDef);
  const [mu, mv] = [(r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2];
  const area = (q: UnitRect) => (q.u1 - q.u0) * (q.v1 - q.v0);
  return area(r) <= area(under) && within(r, grow(under, 1)) && mu >= under.u0 && mu <= under.u1 && mv >= under.v0 && mv <= under.v1;
}

/** Two things on one host that cannot both be there: they fill the same level of the same patch. Different levels are the stack's business. */
export const topsClash = (a: TopItem, aDef: ItemDef, b: TopItem, bDef: ItemDef): boolean => levelOf(a) === levelOf(b) && unitsOverlap(topRect(a, aDef), topRect(b, bDef));

/** How far above the host's top an item stands, in meters: the height of what it rests on, which has its own lift. */
export function liftOf(item: TopItem, def: ItemDef, siblings: readonly Item[]): number {
  if (levelOf(item) === 0) return 0;
  let best = 0;
  for (const s of siblings) {
    const sd = isTop(s) ? ITEM_DEFS[s.def] : undefined;
    if (s !== item && isTop(s) && sd && restsOn(item, def, s, sd)) best = Math.max(best, liftOf(s, sd, siblings) + sd.height);
  }
  return best;
}

/** Why a stacked item has nothing to stand on, or null. `siblings` are the other items of its host. */
export function supportViolation(item: TopItem, def: ItemDef, siblings: readonly Item[]): ViolationKind | null {
  if (levelOf(item) === 0) return null;
  if (levelOf(item) > MAX_LVL) return 'unsupported';
  return siblings.some((s) => isTop(s) && ITEM_DEFS[s.def] && restsOn(item, def, s, ITEM_DEFS[s.def])) ? null : 'unsupported';
}

/** What rests directly on `item`, on its story. */
export function restingOn(story: Story, item: TopItem): TopItem[] {
  const def = ITEM_DEFS[item.def];
  return story.items.filter((i): i is TopItem => isTop(i) && !!def && !!ITEM_DEFS[i.def] && restsOn(i, ITEM_DEFS[i.def], item, def));
}

/** The item a hand reaches for at `item`: whatever is stacked highest above it, since the thing on top has to come off first. */
export function topOfStack(story: Story, item: TopItem): TopItem {
  let cur = item;
  for (let n = 0; n <= MAX_LVL; n++) {
    const next = restingOn(story, cur)[0];
    if (!next) break;
    cur = next;
  }
  return cur;
}

export type TopPose = {
  /** Middle of the footprint and the height of the surface, in meters. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  rot: Rot;
  /** The footprint in the world, in meters. */
  box: { x0: number; z0: number; x1: number; z1: number };
};

/** Where a top item stands in the world, from where its host stands. `lift` is the height of what it rests on. */
export function topPose(host: FloorItem, hostDef: ItemDef, item: TopItem, def: ItemDef, lift = 0): TopPose {
  const r = topRect(item, def);
  const a = hostToWorld(host, hostDef, r.u0, r.v0);
  const b = hostToWorld(host, hostDef, r.u1, r.v1);
  const rot = ((host.rot + item.rot) % 4) as Rot;
  return {
    x: (a.x + b.x) / 2,
    y: (hostDef.surface?.height ?? 0) + lift,
    z: (a.z + b.z) / 2,
    yaw: YAW[rot] + (item.ang ?? 0) * RAD,
    rot,
    box: { x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z) },
  };
}

/** The pose of a top item in a story's item list, or null when its host or def is missing. */
export function poseIn(items: ReadonlyMap<string, Item>, item: TopItem): TopPose | null {
  const host = items.get(item.on);
  const def = ITEM_DEFS[item.def];
  const hostDef = host && !isTop(host) ? ITEM_DEFS[host.def] : undefined;
  if (!host || isTop(host) || !hostDef?.surface || !def) return null;
  return topPose(host, hostDef, item, def, levelOf(item) ? liftOf(item, def, [...items.values()]) : 0);
}

/** Why a top item cannot stand where it is, by the rules of a surface alone. The overlap with other top items is `derive`'s. */
export function topViolation(item: TopItem, def: ItemDef, host: Item | undefined): ViolationKind | null {
  if (!host || isTop(host)) return 'no_host';
  const surface = ITEM_DEFS[host.def]?.surface;
  if (!surface) return 'not_surface';
  if (placementOf(def) === 'floor' || !def.top) return 'floor_only';
  const r = topRect(item, def);
  const s = surface.rect;
  if (r.u0 < s.u0 || r.v0 < s.v0 || r.u1 > s.u1 || r.v1 > s.v1) return 'off_surface';
  if (surface.blocked?.some((b) => unitsOverlap(r, b))) return 'overlap';
  return null;
}

/** The usable part of a host's top in the world, in meters, and how high it is. */
export function surfaceBox(host: FloorItem, def: ItemDef): { x0: number; z0: number; x1: number; z1: number; y: number } | null {
  const s = def.surface;
  if (!s) return null;
  const a = hostToWorld(host, def, s.rect.u0, s.rect.v0);
  const b = hostToWorld(host, def, s.rect.u1, s.rect.v1);
  return { x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z), y: s.height };
}

/** A turn in the world as the turn relative to a host. */
export const relativeRot = (world: Rot, host: FloorItem): Rot => ((((world - host.rot) % 4) + 4) % 4) as Rot;

/** Where a small item of `def` facing `world` stands on `host` with the middle of its footprint under a point in meters. */
export function topSpot(host: FloorItem, hostDef: ItemDef, def: ItemDef, world: Rot, point: Vec2): { rot: Rot; u: number; v: number } {
  const local = worldToHost(host, hostDef, point);
  const rot = relativeRot(world, host);
  const s = topSize(def, rot);
  return { rot, u: Math.round(local.x - s.w / 2), v: Math.round(local.z - s.d / 2) };
}

/** A pick ray in meters, with y measured from the floor of the story it is cast into. */
export type PickRay = { o: { x: number; y: number; z: number }; d: { x: number; y: number; z: number } };

/** The surface a ray reaches first on a story: the host, and the point of its top the ray lands on. */
export function surfaceAt(story: Story, ray: PickRay): { host: FloorItem; point: Vec2 } | null {
  if (ray.d.y >= 0) return null;
  let best: { host: FloorItem; point: Vec2; t: number } | null = null;
  for (const host of floorItems(story)) {
    const def = ITEM_DEFS[host.def];
    if (!def?.surface) continue;
    const t = (def.surface.height - ray.o.y) / ray.d.y;
    if (t <= 0 || (best && t >= best.t)) continue;
    const point = { x: ray.o.x + ray.d.x * t, z: ray.o.z + ray.d.z * t };
    const local = worldToHost(host, def, point);
    if (local.x < 0 || local.z < 0 || local.x >= def.w * PER_CELL || local.z >= def.d * PER_CELL) continue;
    best = { host, point, t };
  }
  return best && { host: best.host, point: best.point };
}

const PICK_MARGIN = 0.03;
/** The top item a ray reaches first, by the box it fills above its host. `skip` is an item in hand, which does not stand in its own way. */
export function topItemAt(story: Story, ray: PickRay, skip?: ItemId): TopItem | null {
  const hosts = new Map<string, FloorItem>(floorItems(story).map((h) => [h.id, h]));
  let best: { item: TopItem; t: number } | null = null;
  for (const item of story.items) {
    if (!isTop(item) || item.id === skip) continue;
    const host = hosts.get(item.on);
    const def = ITEM_DEFS[item.def];
    const hostDef = host && ITEM_DEFS[host.def];
    if (!host || !def || !hostDef?.surface) continue;
    const pose = topPose(host, hostDef, item, def, levelOf(item) ? liftOf(item, def, story.items) : 0);
    const lo = [pose.box.x0 - PICK_MARGIN, pose.y, pose.box.z0 - PICK_MARGIN];
    const hi = [pose.box.x1 + PICK_MARGIN, pose.y + def.height + PICK_MARGIN, pose.box.z1 + PICK_MARGIN];
    const o = [ray.o.x, ray.o.y, ray.o.z];
    const d = [ray.d.x, ray.d.y, ray.d.z];
    let t0 = 0;
    let t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      if (d[k] === 0) {
        if (o[k] < lo[k] || o[k] > hi[k]) t1 = -1;
        continue;
      }
      const a = (lo[k] - o[k]) / d[k];
      const b = (hi[k] - o[k]) / d[k];
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (t0 <= t1 && (!best || t0 < best.t)) best = { item, t: t0 };
  }
  return best?.item ?? null;
}

/** The way an item faces in the world: its own turn on the floor, the host's and its own on a top. */
export function worldRotOf(story: Story, item: Item): Rot {
  if (!isTop(item)) return item.rot;
  const host = story.items.find((i) => i.id === item.on);
  return host ? (((host.rot + item.rot) % 4) as Rot) : item.rot;
}

/** Where a point of the ray's plane at height `y` is, for a ray that comes down onto it. */
export function pointAtHeight(ray: PickRay, y: number): Vec2 | null {
  if (ray.d.y >= 0) return null;
  const t = (y - ray.o.y) / ray.d.y;
  return t > 0 ? { x: ray.o.x + ray.d.x * t, z: ray.o.z + ray.d.z * t } : null;
}

/**
 * Where a small item of `def` facing `world` rests on `base`, with the middle of its footprint under `point`: the spot on the host,
 * pulled in so it stays within what the base carries, and one level above it. Null when the base is too small for it or the stack is high enough.
 */
export function stackSpot(host: FloorItem, hostDef: ItemDef, base: TopItem, baseDef: ItemDef, def: ItemDef, world: Rot, point: Vec2): { rot: Rot; u: number; v: number; lvl: number } | null {
  const lvl = levelOf(base) + 1;
  if (!baseDef.stackable || lvl > MAX_LVL) return null;
  const local = worldToHost(host, hostDef, point);
  const rot = relativeRot(world, host);
  const s = topSize(def, rot);
  const under = topRect(base, baseDef);
  const room = grow(under, 1);
  if (s.w > room.u1 - room.u0 || s.d > room.v1 - room.v0 || s.w * s.d > (under.u1 - under.u0) * (under.v1 - under.v0)) return null;
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  // Inside what the base carries, or one unit over its edge for a thing as big as the base, with the middle always over it.
  const u = clamp(Math.round(local.x - s.w / 2), Math.max(room.u0, Math.ceil(under.u0 - s.w / 2)), Math.min(room.u1 - s.w, Math.floor(under.u1 - s.w / 2)));
  const v = clamp(Math.round(local.z - s.d / 2), Math.max(room.v0, Math.ceil(under.v0 - s.d / 2)), Math.min(room.v1 - s.d, Math.floor(under.v1 - s.d / 2)));
  return { rot, lvl, u, v };
}
