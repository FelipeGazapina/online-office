import { ITEM_DEFS, YAW, footprint, layerOf } from './catalog.ts';
import { defOf, floorItems, hasFloorAt, inLotTile, isTop, itemRect, sameLot, stairsInfo, tileIndex, wkey } from './geom.ts';
import { poseIn, topRect, unitsOverlap } from './surface.ts';
import type { Building, FloorGeometry, FloorRender, Item, ItemId, Lot, Room, Story, TopItem, WallDir, WallRef, WallSeg } from './types.ts';


/** Tiles that open on this story because the story below carries stairs. */
export function holesOf(lot: Lot, below: Story | undefined): Uint8Array {
  const hole = new Uint8Array(lot.w * lot.h);
  if (!below) return hole;
  for (const item of floorItems(below)) {
    const def = defOf(item);
    if (!def?.stairs) continue;
    const info = stairsInfo(item, def);
    for (const t of info.holeTiles) if (inLotTile(lot, t.tx, t.tz)) hole[tileIndex(lot, t.tx, t.tz)] = 1;
  }
  return hole;
}

const cache = new WeakMap<Story, FloorGeometry>();
const byBuilding = new WeakMap<Building, readonly FloorGeometry[]>();

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Memoized per Story identity. A story's geometry also depends on the holes the story below opens, so it is reused
 * only while those holes are unchanged. Editing one story leaves every other story's geometry object untouched.
 */
export function deriveFloors(b: Building): readonly FloorGeometry[] {
  const hit = byBuilding.get(b);
  if (hit) return hit;
  const out = b.stories.map((story, i) => {
    const hole = holesOf(b.lot, b.stories[i - 1]);
    const cached = cache.get(story);
    if (cached && cached.index === i && sameLot(cached.lot, b.lot) && sameBytes(cached.hole, hole)) return cached;
    const g = buildFloor(b, i, hole);
    cache.set(story, g);
    return g;
  });
  byBuilding.set(b, out);
  return out;
}

type Side = 'N' | 'E' | 'S' | 'W';
const SIDE_STEP: Record<Side, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const OPPOSITE: Record<Side, Side> = { N: 'S', E: 'W', S: 'N', W: 'E' };
const HALF_SIDES = {
  sd: [['N', 'E'], ['S', 'W']],
  nd: [['N', 'W'], ['S', 'E']],
} as const;

function buildFloor(b: Building, index: number, hole: Uint8Array): FloorGeometry {
  const { lot } = b;
  const story = b.stories[index];
  const wallAt = new Map<number, WallSeg>();
  for (const w of story.walls) wallAt.set(wkey(w.x, w.z, w.d), w);

  const diagOf = (tx: number, tz: number): 'sd' | 'nd' | null => (wallAt.has(wkey(tx, tz, 'sd')) ? 'sd' : wallAt.has(wkey(tx, tz, 'nd')) ? 'nd' : null);
  const sideHalf = (diag: 'sd' | 'nd' | null, side: Side): 0 | 1 => (diag ? ((HALF_SIDES[diag][0] as readonly string[]).includes(side) ? 0 : 1) : 0);
  const nodeFloor = (ti: number, half: 0 | 1, diag: 'sd' | 'nd' | null) => (diag && half === 1 ? (story.halfB[ti] ?? 0) > 0 : story.paint[ti] > 0);
  const edgeKey = (tx: number, tz: number, side: Side) =>
    side === 'N' ? wkey(tx, tz, 'e') : side === 'S' ? wkey(tx, tz + 1, 'e') : side === 'W' ? wkey(tx, tz, 's') : wkey(tx + 1, tz, 's');

  const cw = lot.w * 2;
  // Objects take cells in `occ`, floor items in `floorOcc`: an object may stand on a floor item, two of the same layer may not share a cell.
  const occ = new Uint16Array(cw * lot.h * 2);
  const floorOcc = new Uint16Array(cw * lot.h * 2);
  const overlaps: [ItemId, ItemId][] = [];
  const seenPair = new Set<string>();
  story.items.forEach((item, n) => {
    const def = defOf(item);
    if (!def || isTop(item)) return;
    const grid = layerOf(def) === 'floor' ? floorOcc : occ;
    const r = itemRect(item, def);
    for (let cz = Math.max(r.z0, lot.z0 * 2); cz < Math.min(r.z1, (lot.z0 + lot.h) * 2); cz++) {
      for (let cx = Math.max(r.x0, lot.x0 * 2); cx < Math.min(r.x1, (lot.x0 + lot.w) * 2); cx++) {
        const at = (cz - lot.z0 * 2) * cw + (cx - lot.x0 * 2);
        const other = grid[at];
        if (!other) {
          grid[at] = n + 1;
          continue;
        }
        const a = story.items[other - 1].id;
        const k = `${a}|${item.id}`;
        if (!seenPair.has(k)) {
          seenPair.add(k);
          overlaps.push([a, item.id]);
        }
      }
    }
  });

  // Items that stand on a host are checked against each other on the host's own top, never against the floor.
  const tops = new Map<ItemId, number[]>();
  story.items.forEach((item, n) => {
    if (isTop(item)) (tops.get(item.on) ?? tops.set(item.on, []).get(item.on)!).push(n);
  });
  for (const list of tops.values()) {
    const rects = list.map((n) => {
      const item = story.items[n] as TopItem;
      const def = defOf(item);
      return def && topRect(item, def);
    });
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = rects[i];
        const c = rects[j];
        if (a && c && unitsOverlap(a, c)) overlaps.push([story.items[list[i]].id, story.items[list[j]].id]);
      }
    }
  }

  const roomOf = new Uint16Array(lot.w * lot.h * 2);
  const rooms: Room[] = [];
  const stack: number[] = [];
  for (let start = 0; start < roomOf.length; start++) {
    if (roomOf[start]) continue;
    const sti = start >> 1;
    const stx = lot.x0 + (sti % lot.w);
    const stz = lot.z0 + Math.floor(sti / lot.w);
    const sdiag = diagOf(stx, stz);
    if (!nodeFloor(sti, (start & 1) as 0 | 1, sdiag)) continue;
    if ((start & 1) === 1 && !sdiag) continue;
    const id = rooms.length + 1;
    let area = 0;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    roomOf[start] = id;
    stack.push(start);
    while (stack.length) {
      const node = stack.pop()!;
      const ti = node >> 1;
      const half = (node & 1) as 0 | 1;
      const tx = lot.x0 + (ti % lot.w);
      const tz = lot.z0 + Math.floor(ti / lot.w);
      const diag = diagOf(tx, tz);
      area += diag ? 0.5 : 1;
      minX = Math.min(minX, tx);
      minZ = Math.min(minZ, tz);
      maxX = Math.max(maxX, tx);
      maxZ = Math.max(maxZ, tz);
      const sides: readonly Side[] = diag ? HALF_SIDES[diag][half] : ['N', 'E', 'S', 'W'];
      for (const side of sides) {
        if (wallAt.has(edgeKey(tx, tz, side))) continue;
        const nx = tx + SIDE_STEP[side][0];
        const nz = tz + SIDE_STEP[side][1];
        if (!inLotTile(lot, nx, nz)) continue;
        const nti = tileIndex(lot, nx, nz);
        const ndiag = diagOf(nx, nz);
        const nhalf = sideHalf(ndiag, OPPOSITE[side]);
        if (!nodeFloor(nti, nhalf, ndiag)) continue;
        const nnode = nti * 2 + nhalf;
        if (roomOf[nnode]) continue;
        roomOf[nnode] = id;
        stack.push(nnode);
      }
    }
    rooms.push({ id, story: index, area, bbox: { x0: minX, z0: minZ, w: maxX - minX + 1, h: maxZ - minZ + 1 }, doors: [], items: [] });
  }

  const nodeAtPoint = (px: number, pz: number): number => {
    const tx = Math.floor(px);
    const tz = Math.floor(pz);
    if (!inLotTile(lot, tx, tz)) return -1;
    const ti = tileIndex(lot, tx, tz);
    const diag = diagOf(tx, tz);
    const fx = px - tx;
    const fz = pz - tz;
    const half = diag === 'sd' ? (fx > fz ? 0 : 1) : diag === 'nd' ? (fx + fz < 1 ? 0 : 1) : 0;
    return ti * 2 + half;
  };
  const roomItems = new Map<number, ItemId[]>();
  for (const item of story.items) {
    const def = defOf(item);
    if (!def || isTop(item)) continue;
    const r = itemRect(item, def);
    const node = nodeAtPoint((r.x0 + r.x1) / 4, (r.z0 + r.z1) / 4);
    const room = node < 0 ? 0 : roomOf[node];
    if (room) (roomItems.get(room) ?? roomItems.set(room, []).get(room)!).push(item.id);
  }
  const roomDoors = new Map<number, WallRef[]>();
  for (const w of story.walls) {
    if (w.open !== 'door') continue;
    const pairs: [number, number][] = w.d === 'e' ? [[w.x + 0.5, w.z - 0.5], [w.x + 0.5, w.z + 0.5]] : [[w.x - 0.5, w.z + 0.5], [w.x + 0.5, w.z + 0.5]];
    for (const [px, pz] of pairs) {
      const node = nodeAtPoint(px, pz);
      const room = node < 0 ? 0 : roomOf[node];
      if (!room) continue;
      const list = roomDoors.get(room) ?? roomDoors.set(room, []).get(room)!;
      if (!list.some((d) => d.x === w.x && d.z === w.z && d.d === w.d)) list.push({ x: w.x, z: w.z, d: w.d });
    }
  }
  const finalRooms = rooms.map((r) => ({ ...r, doors: roomDoors.get(r.id) ?? [], items: roomItems.get(r.id) ?? [] }));

  return {
    index,
    lot: { ...lot },
    story,
    hole,
    occ,
    floorOcc,
    tops,
    overlaps,
    wallAt,
    roomOf,
    rooms: finalRooms,
    render: buildRender(b, index, hole, wallAt, diagOf),
  };
}

const WALL_ANGLE: Record<WallDir, number> = { e: 0, s: -Math.PI / 2, sd: -Math.PI / 4, nd: Math.PI / 4 };
const R2 = Math.SQRT1_2;

function buildRender(b: Building, index: number, hole: Uint8Array, wallAt: ReadonlyMap<number, WallSeg>, diagOf: (tx: number, tz: number) => 'sd' | 'nd' | null): FloorRender {
  const { lot } = b;
  const story = b.stories[index];
  const pos: number[] = [];
  const idx: number[] = [];
  const paintAttr: number[] = [];
  const vert = (x: number, z: number, p: number) => {
    pos.push(x, 0, z);
    paintAttr.push(p);
    return paintAttr.length - 1;
  };
  const floored = (tx: number, tz: number) => inLotTile(lot, tx, tz) && hasFloorAt(story, tileIndex(lot, tx, tz)) && !hole[tileIndex(lot, tx, tz)];
  for (let tz = lot.z0; tz < lot.z0 + lot.h; tz++) {
    for (let tx = lot.x0; tx < lot.x0 + lot.w; tx++) {
      const ti = tileIndex(lot, tx, tz);
      if (hole[ti] || !hasFloorAt(story, ti)) continue;
      const diag = diagOf(tx, tz);
      const p0 = story.paint[ti];
      if (!diag) {
        if (!p0) continue;
        const a = vert(tx, tz, p0);
        const bb = vert(tx + 1, tz, p0);
        const c = vert(tx + 1, tz + 1, p0);
        const d = vert(tx, tz + 1, p0);
        idx.push(a, d, bb, bb, d, c);
        continue;
      }
      const p1 = story.halfB[ti] ?? 0;
      const tri = (pts: [number, number][], p: number, order: [number, number, number]) => {
        if (!p) return;
        const v = pts.map(([x, z]) => vert(x, z, p));
        idx.push(v[order[0]], v[order[1]], v[order[2]]);
      };
      if (diag === 'sd') {
        tri([[tx, tz], [tx + 1, tz], [tx + 1, tz + 1]], p0, [0, 2, 1]);
        tri([[tx, tz], [tx, tz + 1], [tx + 1, tz + 1]], p1, [0, 1, 2]);
      } else {
        tri([[tx, tz], [tx + 1, tz], [tx, tz + 1]], p0, [0, 2, 1]);
        tri([[tx + 1, tz], [tx + 1, tz + 1], [tx, tz + 1]], p1, [0, 2, 1]);
      }
    }
  }

  const wallBuf: Record<'solid' | 'door' | 'window' | 'arch', number[]> = { solid: [], door: [], window: [], arch: [] };
  const normals: Record<'solid' | 'door' | 'window' | 'arch', number[]> = { solid: [], door: [], window: [], arch: [] };
  for (const w of story.walls) {
    const len = w.d === 'sd' || w.d === 'nd' ? Math.SQRT2 : 1;
    const mx = w.d === 'e' ? w.x + 0.5 : w.d === 's' ? w.x : w.x + 0.5;
    const mz = w.d === 'e' ? w.z : w.d === 's' ? w.z + 0.5 : w.z + 0.5;
    const variant = w.open ?? 'solid';
    wallBuf[variant].push(mx, mz, WALL_ANGLE[w.d], len, w.style);
    let nx: number;
    let nz: number;
    let sideA: boolean;
    let sideB: boolean;
    if (w.d === 'e') {
      [nx, nz] = [0, -1];
      sideA = floored(w.x, w.z - 1);
      sideB = floored(w.x, w.z);
    } else if (w.d === 's') {
      [nx, nz] = [-1, 0];
      sideA = floored(w.x - 1, w.z);
      sideB = floored(w.x, w.z);
    } else if (w.d === 'sd') {
      [nx, nz] = [R2, -R2];
      sideA = (story.paint[tileIndex(lot, w.x, w.z)] ?? 0) > 0;
      sideB = (story.halfB[tileIndex(lot, w.x, w.z)] ?? 0) > 0;
    } else {
      [nx, nz] = [-R2, -R2];
      sideA = (story.paint[tileIndex(lot, w.x, w.z)] ?? 0) > 0;
      sideB = (story.halfB[tileIndex(lot, w.x, w.z)] ?? 0) > 0;
    }
    if (sideA && !sideB) {
      nx = -nx;
      nz = -nz;
    } else if (sideA === sideB) {
      nx = 0;
      nz = 0;
    }
    normals[variant].push(nx, nz);
  }

  const groups = new Map<string, { m: number[]; ids: ItemId[] }>();
  const byId = new Map<string, Item>(story.items.map((i) => [i.id, i]));
  for (const item of story.items) {
    const def = ITEM_DEFS[item.def];
    if (!def) continue;
    const g = groups.get(item.def) ?? groups.set(item.def, { m: [], ids: [] }).get(item.def)!;
    if (isTop(item)) {
      const pose = poseIn(byId, item);
      if (!pose) continue;
      g.m.push(pose.x, pose.y, pose.z, pose.yaw, item.tint ?? -1);
    } else {
      const f = footprint(def, item.rot);
      g.m.push((item.x + f.w / 2) * 0.5, 0, (item.z + f.d / 2) * 0.5, YAW[item.rot], item.tint ?? -1);
    }
    g.ids.push(item.id);
  }
  const items = new Map<string, { matrices: Float32Array; ids: readonly ItemId[] }>();
  for (const [def, g] of groups) items.set(def, { matrices: Float32Array.from(g.m), ids: g.ids });

  const rails: number[] = [];
  const below = b.stories[index - 1];
  if (below) {
    for (const item of floorItems(below)) {
      const def = defOf(item);
      if (!def?.stairs) continue;
      const info = stairsInfo(item, def);
      const inHole = (tx: number, tz: number) => info.holeTiles.some((t) => t.tx === tx && t.tz === tz);
      for (const t of info.holeTiles) {
        for (const side of ['N', 'E', 'S', 'W'] as const) {
          const [dx, dz] = SIDE_STEP[side];
          const nx = t.tx + dx;
          const nz = t.tz + dz;
          if (inHole(nx, nz) || (nx === info.landing.tx && nz === info.landing.tz)) continue;
          if (side === 'N' || side === 'S') rails.push(t.tx + 0.5, t.tz + (side === 'N' ? 0 : 1), 0, 1, 0);
          else rails.push(t.tx + (side === 'W' ? 0 : 1), t.tz + 0.5, -Math.PI / 2, 1, 0);
        }
      }
    }
  }

  return {
    floor: { position: Float32Array.from(pos), index: Uint32Array.from(idx), paint: Uint8Array.from(paintAttr) },
    walls: {
      solid: Float32Array.from(wallBuf.solid),
      door: Float32Array.from(wallBuf.door),
      window: Float32Array.from(wallBuf.window),
      arch: Float32Array.from(wallBuf.arch),
    },
    wallNormals: {
      solid: Float32Array.from(normals.solid),
      door: Float32Array.from(normals.door),
      window: Float32Array.from(normals.window),
      arch: Float32Array.from(normals.arch),
    },
    items,
    rails: Float32Array.from(rails),
  };
}
