// The surface layer. A desk, table, counter or shelf declares a top (`ItemDef.surface`); a small item stands on it as a
// `TopItem` that names its host and its place on the host's frame. Everything here is pure: where a top item is in the
// world, and the rules that decide whether it may stand there.
import { ITEM_DEFS, YAW, placementOf, rotateLocal } from './catalog.ts';
import { floorItems, isTop } from './geom.ts';
import { CELL, TOP_UNIT, type FloorItem, type Item, type ItemDef, type Rot, type Story, type TopItem, type UnitRect, type Vec2, type ViolationKind } from './types.ts';

const PER_CELL = CELL / TOP_UNIT;
export const unitsOverlap = (a: UnitRect, b: UnitRect): boolean => a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1;

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

/** Where a top item stands in the world, from where its host stands. */
export function topPose(host: FloorItem, hostDef: ItemDef, item: TopItem, def: ItemDef): TopPose {
  const r = topRect(item, def);
  const a = hostToWorld(host, hostDef, r.u0, r.v0);
  const b = hostToWorld(host, hostDef, r.u1, r.v1);
  const rot = ((host.rot + item.rot) % 4) as Rot;
  return {
    x: (a.x + b.x) / 2,
    y: hostDef.surface?.height ?? 0,
    z: (a.z + b.z) / 2,
    yaw: YAW[rot],
    rot,
    box: { x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z) },
  };
}

/** The pose of a top item in a story's item list, or null when its host or def is missing. */
export function poseIn(items: ReadonlyMap<string, Item>, item: TopItem): TopPose | null {
  const host = items.get(item.on);
  const def = ITEM_DEFS[item.def];
  const hostDef = host && !isTop(host) ? ITEM_DEFS[host.def] : undefined;
  return host && !isTop(host) && hostDef?.surface && def ? topPose(host, hostDef, item, def) : null;
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
/** The top item a ray reaches first, by the box it fills above its host. */
export function topItemAt(story: Story, ray: PickRay): TopItem | null {
  const hosts = new Map<string, FloorItem>(floorItems(story).map((h) => [h.id, h]));
  let best: { item: TopItem; t: number } | null = null;
  for (const item of story.items) {
    if (!isTop(item)) continue;
    const host = hosts.get(item.on);
    const def = ITEM_DEFS[item.def];
    const hostDef = host && ITEM_DEFS[host.def];
    if (!host || !def || !hostDef?.surface) continue;
    const pose = topPose(host, hostDef, item, def);
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
