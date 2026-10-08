// What the sim needs to know about the building: per-floor walkable grids, stairs, seats, the owner's room and its door.
// All of it derives from the Building the renderer holds, and is built once per Building and door state.
import type { BlockId, Employee, MeetingDoor } from '../../shared/protocol.ts';
import {
  ITEM_DEFS,
  NAV_CELL,
  STORY_H,
  closeDoor,
  deskOf,
  deriveFloors,
  entryOf,
  navOf,
  openDoor,
  rotateLocal,
  route,
  seatPose,
  snapToOpen,
  stairLinks,
  wallName,
  YAW,
  floorItems,
  type Building,
  type FloorGeometry,
  type FloorItem,
  type FloorNav,
  type FloorPos,
  type Leg,
  type Lot,
  type SeatPose,
  type StairLink,
  type Vec2,
  type WallRef,
} from '../../shared/space/index.ts';

export type { FloorPos, Leg, SeatPose, StairLink, Vec2 };

export type OwnerRoom = { floor: number; bbox: Lot; doors: readonly WallRef[]; doorAt: Vec2 | null; area: number };

export type World = {
  building: Building;
  floors: readonly FloorGeometry[];
  navs: readonly FloorNav[];
  links: readonly StairLink[];
  // Bumps whenever a walk planned earlier may have gone stale: a door moved.
  version: number;
  door: MeetingDoor;
  ownerRoom: OwnerRoom | null;
  entry: FloorPos;
  seats: Map<string, SeatPose | null>;
};

const doorCenter = (w: WallRef): Vec2 => (w.d === 'e' ? { x: w.x + 0.5, z: w.z } : { x: w.x, z: w.z + 0.5 });

function ownerRoomOf(b: Building, floors: readonly FloorGeometry[]): OwnerRoom | null {
  for (const g of floors) {
    const desk = g.story.items.find((i) => ITEM_DEFS[i.def]?.kind === 'owner_desk');
    if (!desk) continue;
    const room = g.rooms.find((r) => r.items.includes(desk.id));
    if (!room) return null;
    const { lot } = g;
    const outer = (w: WallRef) =>
      w.d === 'e' ? w.z === lot.z0 || w.z === lot.z0 + lot.h : w.d === 's' ? w.x === lot.x0 || w.x === lot.x0 + lot.w : false;
    const doors = room.doors.filter((w) => !outer(w));
    const centers = g.story.walls.filter((w) => w.open === 'door' && doors.some((d) => d.x === w.x && d.z === w.z && d.d === w.d)).map(doorCenter);
    const doorAt = centers.length ? { x: centers.reduce((s, c) => s + c.x, 0) / centers.length, z: centers.reduce((s, c) => s + c.z, 0) / centers.length } : null;
    return { floor: g.index, bbox: room.bbox, doors, doorAt, area: room.area };
  }
  return null;
}

function setDoor(w: World, door: MeetingDoor) {
  const room = w.ownerRoom;
  if (!room) return;
  const nav = w.navs[room.floor];
  for (const ref of room.doors) (door === 'closed' ? closeDoor : openDoor)(nav, wallName(ref));
}

const worlds = new WeakMap<Building, World>();

export function worldFor(b: Building | null, door: MeetingDoor): World | null {
  if (!b) return null;
  let w = worlds.get(b);
  if (!w) {
    const floors = deriveFloors(b);
    const entry = entryOf(b) ?? { floor: 0, x: b.lot.x0 + b.lot.w / 2, z: b.lot.z0 + b.lot.h - 1.5 };
    w = {
      building: b,
      floors,
      navs: floors.map((g) => navOf(g)),
      links: stairLinks(floors),
      version: 0,
      door,
      ownerRoom: ownerRoomOf(b, floors),
      entry,
      seats: new Map(),
    };
    setDoor(w, door);
    worlds.set(b, w);
  } else if (w.door !== door) {
    w.door = door;
    w.version++;
    setDoor(w, door);
  }
  return w;
}

const cellIndex = (nav: FloorNav, x: number, z: number): number => {
  const col = Math.floor((x - nav.x0) / NAV_CELL);
  const row = Math.floor((z - nav.z0) / NAV_CELL);
  return col >= 0 && col < nav.cols && row >= 0 && row < nav.rows ? row * nav.cols + col : -1;
};

export function openAt(w: World, floor: number, x: number, z: number): boolean {
  const nav = w.navs[floor];
  if (!nav) return false;
  const i = cellIndex(nav, x, z);
  return i >= 0 && nav.open[i] === 1;
}

/** The nearest standable spot to p on a floor, or null when the floor has none. */
export function standable(w: World, floor: number, p: Vec2): Vec2 | null {
  const nav = w.navs[floor];
  if (!nav) return null;
  const cell = snapToOpen(nav, p);
  if (cell < 0) return null;
  const col = cell % nav.cols;
  return { x: nav.x0 + (col + 0.5) * NAV_CELL, z: nav.z0 + ((cell - col) / nav.cols + 0.5) * NAV_CELL };
}

export function seatOf(w: World, e: Employee): SeatPose | null {
  if (!e.seat) return null;
  let pose = w.seats.get(e.seat);
  if (pose === undefined) {
    try {
      pose = seatPose(w.building, e.seat);
    } catch {
      pose = null;
    }
    w.seats.set(e.seat, pose);
  }
  return pose;
}

export function ownerSeat(w: World): SeatPose | null {
  const desk = deskOf(w.building, new Map(), 'owner');
  if (!desk) return null;
  try {
    return seatPose(w.building, desk.id);
  } catch {
    return null;
  }
}

export function itemsOf(w: World, def: string, blockId?: BlockId): { floor: number; item: FloorItem }[] {
  return w.building.stories.flatMap((s, floor) => floorItems(s).filter((i) => i.def === def && (blockId === undefined || i.blockId === blockId)).map((item) => ({ floor, item })));
}

const centerOf = (item: FloorItem): Vec2 => {
  const def = ITEM_DEFS[item.def];
  const f = item.rot % 2 === 0 ? { w: def.w, d: def.d } : { w: def.d, d: def.w };
  return { x: (item.x + f.w / 2) / 2, z: (item.z + f.d / 2) / 2 };
};
export { centerOf as itemCenter };

/** The spot in front of a block's board terminal where the owner stands to use it. */
export function terminalStand(w: World, blockId: BlockId): { floor: number; at: Vec2 } | null {
  const found = itemsOf(w, 'board_terminal', blockId)[0];
  if (!found) return null;
  const c = centerOf(found.item);
  const yaw = YAW[found.item.rot];
  return { floor: found.floor, at: { x: c.x + Math.sin(yaw) * 0.9, z: c.z + Math.cos(yaw) * 0.9 } };
}

export function whiteboardAt(w: World, blockId: BlockId): { floor: number; at: Vec2 } | null {
  const found = itemsOf(w, 'whiteboard', blockId)[0];
  return found ? { floor: found.floor, at: centerOf(found.item) } : null;
}

export function chairOf(item: FloorItem): Vec2 | null {
  const def = ITEM_DEFS[item.def];
  if (!def.seat) return null;
  const o = rotateLocal(def, item.rot, def.seat.chair);
  return { x: (item.x + o.x) / 2, z: (item.z + o.z) / 2 };
}

// ---------------------------------------------------------------- trips

export type Trip = { legs: Leg[]; to: FloorPos; version: number };

export function tripTo(w: World, from: FloorPos, to: FloorPos): Trip | null {
  const legs = route(w.floors, from, to);
  if (!legs) return null;
  // Legs are consumed as the walker goes, so the trip gets its own arrays.
  return { legs: legs.map((l) => ({ ...l, path: l.path.map((p) => ({ x: p.x, z: p.z })) })), to, version: w.version };
}

const SPOTS = 24;
const ALONE = 0.3;
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/** Where to stand to talk to someone at `target`, and the way there. The last point is the spot. */
export function approachTo(w: World, from: FloorPos, target: FloorPos, opts: { dist: number; others: readonly Vec2[] }): Trip | null {
  const spots: { p: Vec2; alone: boolean; d: number }[] = [];
  for (let k = 0; k < SPOTS; k++) {
    const angle = (2 * Math.PI * k) / SPOTS;
    const p = { x: target.x + opts.dist * Math.cos(angle), z: target.z + opts.dist * Math.sin(angle) };
    if (!openAt(w, target.floor, p.x, p.z)) continue;
    const alone = opts.others.every((o) => dist(p, o) - dist(p, target) >= ALONE);
    spots.push({ p, alone, d: dist(p, from) });
  }
  spots.sort((a, b) => (a.alone === b.alone ? a.d - b.d : a.alone ? -1 : 1));
  for (const { p } of spots) {
    const trip = tripTo(w, from, { floor: target.floor, x: p.x, z: p.z });
    if (trip) return trip;
  }
  return null;
}

export const floorBase = (floor: number) => floor * STORY_H;

export function climbHeight(link: StairLink, p: Vec2): number {
  return Math.min(link.from.floor, link.to.floor) * STORY_H + link.heightAt(p);
}
