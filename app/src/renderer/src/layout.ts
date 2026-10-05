// Pure office geometry. Units are meters. +x east, +z south (toward the entrance), -z north.
// A yaw of 0 faces +z; forward = (sin yaw, cos yaw); right = (-cos yaw, sin yaw).
import type { BlockPlace, ProjectBlock } from '../../shared/protocol.ts';
import { AISLE, BLOCK_D, BLOCK_W, COLS, footprint, LOBBY_Z0, nextSlot, placementOf, slotPlace, X0 } from '../../shared/placement.ts';

export { AISLE, BLOCK_D, BLOCK_W, COLS, LOBBY_Z0, placementOf, slotPlace, X0 };
export const RUG_W = BLOCK_W - 1;
export const RUG_D = BLOCK_D - 1;
export const Z1 = 9;
export const WALL_H = 3.2;
// The owner's body. Collision pushes out by this radius and walking paths keep this far from furniture.
export const OWNER_RADIUS = 0.35;
// How close anyone may come to the outer walls.
export const WALL_MARGIN = 0.6;

export type Vec2 = { x: number; z: number };
export type Box = { cx: number; cz: number; hw: number; hd: number };

export type Bounds = { x0: number; x1: number; z0: number; z1: number; cols: number; rows: number };

// The turn as a yaw. Turns are clockwise seen from above, and a positive yaw turns south toward east, which is the other way.
export const turnYaw = (place: BlockPlace) => (-place.turns * Math.PI) / 2;

// A point given in meters from the block center, as the block stands now.
export function onBlock(place: BlockPlace, x: number, z: number): Vec2 {
  const a = turnYaw(place);
  return { x: place.x + x * Math.cos(a) + z * Math.sin(a), z: place.z + z * Math.cos(a) - x * Math.sin(a) };
}

// A seat is a desk center and the way the person sitting at it faces, in meters from the block center.
export type Seat = { x: number; z: number; yaw: number };
export type DeskPose = { desk: Vec2; chair: Vec2; exit: Vec2; yaw: number };

const DESK_W = 1.6;
const DESK_D = 0.8;
const CHAIR_BACK = 0.9;
const EXIT_BACK = 2.0;

const FACE_SOUTH = 0;
const FACE_NORTH = Math.PI;
const FACE_WEST = -Math.PI / 2;

// Two facing rows of three desks, flush like one long bench that runs east to west. The head desk closes its east end
// to make a T. The bench runs along x because three desks, the head desk and its chair need more room along z than
// the whiteboard leaves. Shifting the bench 0.65 m west puts the whole T, chair included, about on the block center.
const BENCH_X = -0.65;

// Indexed by Employee.desk, from the head outward. Each pair sits across from each other, the south seat first.
export const BENCH: readonly Seat[] = [1, 0, -1].flatMap((column) => [
  { x: BENCH_X + column * DESK_W, z: DESK_D / 2, yaw: FACE_NORTH },
  { x: BENCH_X + column * DESK_W, z: -DESK_D / 2, yaw: FACE_SOUTH },
]);

// Reserved for the block's orchestrator. It is not a desk index, so nobody is hired into it.
export const HEAD: Seat = { x: BENCH_X + DESK_W + (DESK_W + DESK_D) / 2, z: 0, yaw: FACE_WEST };

// The person sits in a chair behind the desk they face and steps out to the exit farther back.
function poseOf(place: BlockPlace, seat: Seat): DeskPose {
  const fx = Math.sin(seat.yaw);
  const fz = Math.cos(seat.yaw);
  const back = (d: number) => onBlock(place, seat.x - fx * d, seat.z - fz * d);
  return { desk: back(0), chair: back(CHAIR_BACK), exit: back(EXIT_BACK), yaw: seat.yaw + turnYaw(place) };
}

export function deskPose(place: BlockPlace, desk: number): DeskPose {
  const seat = BENCH[desk];
  if (seat) return poseOf(place, seat);
  const overflow = Math.max(0, desk - BENCH.length);
  const row = Math.floor(overflow / 3);
  const column = overflow % 3;
  return poseOf(place, {
    x: BENCH_X + (column - 1) * DESK_W,
    z: -1.8 - row * 1.25,
    yaw: FACE_NORTH,
  });
}

export function headPose(place: BlockPlace): DeskPose {
  return poseOf(place, HEAD);
}

// The PO workstation is the block's project computer. It is reserved for board configuration.
export function projectComputerPose(place: BlockPlace): DeskPose {
  return headPose(place);
}

// A desk is wide across the person's line of sight, so one that faces east or west is turned on the floor plan.
function deskBox(pose: DeskPose): Box {
  const sideways = Math.abs(Math.sin(pose.yaw)) > 0.5;
  return { cx: pose.desk.x, cz: pose.desk.z, hw: (sideways ? DESK_D : DESK_W) / 2, hd: (sideways ? DESK_W : DESK_D) / 2 };
}

// In meters from the block center. The scene places them inside the block's turned group, the layout through onBlock.
export const WHITEBOARD_AT: Vec2 = { x: 0, z: -BLOCK_D / 2 + 0.7 };
export const SIGN_AT: Vec2 = { x: -BLOCK_W / 2 + 1.6, z: BLOCK_D / 2 - 0.4 };
export const HUDDLE_AT: Vec2 = { x: 2.65, z: -2.15 };

export const whiteboardPose = (place: BlockPlace): Vec2 => onBlock(place, WHITEBOARD_AT.x, WHITEBOARD_AT.z);
export const signPose = (place: BlockPlace): Vec2 => onBlock(place, SIGN_AT.x, SIGN_AT.z);

export const DOOR: Vec2 = { x: X0 + 8, z: Z1 };
export const OWNER_START: Vec2 = { x: X0 + 8, z: Z1 - 4.8 };
export const OWNER_DESK: Vec2 = { x: X0 + 1.5, z: 5.2 };
export const OWNER_CHAIR: Vec2 = { x: OWNER_DESK.x + 0.9, z: OWNER_DESK.z };

// A small room around the owner's desk. The east wall has one opening so the owner can walk in and close it.
// The same dimensions are used by the renderer and the simulation collision boxes.
export const MEETING_ROOM = {
  x0: -17.8,
  x1: -11.4,
  z0: 1.9,
  z1: 8.3,
  doorZ: 5.2,
  doorHalf: 0.9,
} as const;

export function meetingRoomObstacles(closed: boolean): Box[] {
  const r = MEETING_ROOM;
  const wall = 0.16;
  const span = r.x1 - r.x0;
  const boxes: Box[] = [
    { cx: (r.x0 + r.x1) / 2, cz: r.z0, hw: span / 2, hd: wall },
    { cx: (r.x0 + r.x1) / 2, cz: r.z1, hw: span / 2, hd: wall },
  ];
  const top = (r.doorZ - r.doorHalf) - r.z0;
  const bottom = r.z1 - (r.doorZ + r.doorHalf);
  if (top > 0) boxes.push({ cx: r.x1, cz: (r.z0 + r.doorZ - r.doorHalf) / 2, hw: wall, hd: top / 2 });
  if (bottom > 0) boxes.push({ cx: r.x1, cz: (r.doorZ + r.doorHalf + r.z1) / 2, hw: wall, hd: bottom / 2 });
  if (closed) boxes.push({ cx: r.x1, cz: r.doorZ, hw: wall, hd: r.doorHalf });
  return boxes;
}

export type Layout = {
  bounds: Bounds;
  ghostSlot: number | null;
  obstacles: Box[];
  plants: Vec2[];
};

const withRooms = new WeakMap<Layout, Record<'open' | 'closed', Layout>>();

// The layout with the meeting room in it, whose door is an opening or a wall. There is one object per layout and door
// state, so whatever is keyed on the layout, like the nav grid, is built once and not every frame.
export function withMeetingRoom(layout: Layout, door: 'open' | 'closed'): Layout {
  let byDoor = withRooms.get(layout);
  if (!byDoor) {
    byDoor = {
      open: { ...layout, obstacles: [...layout.obstacles, ...meetingRoomObstacles(false)] },
      closed: { ...layout, obstacles: [...layout.obstacles, ...meetingRoomObstacles(true)] },
    };
    withRooms.set(layout, byDoor);
  }
  return byDoor[door];
}

let cacheKey = '';
let cache: Layout | null = null;

export function getLayout(blocks: readonly ProjectBlock[]): Layout {
  const key = blocks.map((b) => { const p = placementOf(b); return `${b.id}:${p.x}:${p.z}:${p.turns}`; }).join(',');
  if (cache && key === cacheKey) return cache;
  cacheKey = key;
  cache = computeLayout(blocks);
  return cache;
}

// The room as it would be with one block standing somewhere else. Built fresh, so the walking layout's cache keeps its own.
export function previewLayout(blocks: readonly ProjectBlock[], id: ProjectBlock['id'], place: BlockPlace): Layout {
  return computeLayout(blocks.map((b) => (b.id === id ? { ...b, place } : b)));
}

function computeLayout(blocks: readonly ProjectBlock[]): Layout {
  const next = nextSlot(blocks);
  const ghostSlot = next < 6 ? next : null;
  const shown = Math.max(blocks.length, ghostSlot === null ? 0 : ghostSlot + 1);
  const cols = Math.max(2, Math.min(COLS, shown));
  const rows = Math.max(1, Math.ceil(shown / COLS));
  // The room holds every block where it stands, the ghost spot, and at least the grid it started as.
  const spots = [...blocks.map((b) => footprint(placementOf(b))), ...(ghostSlot === null ? [] : [footprint(slotPlace(ghostSlot))])];
  const bounds: Bounds = {
    x0: X0,
    x1: Math.max(X0 + cols * (BLOCK_W + AISLE), ...spots.map((f) => f.x1 + AISLE / 2)),
    z0: Math.min(-rows * (BLOCK_D + AISLE), ...spots.map((f) => f.z0 - AISLE / 2)),
    z1: Z1,
    cols,
    rows,
  };

  const obstacles: Box[] = [{ cx: OWNER_DESK.x, cz: OWNER_DESK.z, hw: 0.45, hd: 1.0 }];
  for (const b of blocks) {
    const place = placementOf(b);
    for (const pose of [...BENCH.map((_, d) => deskPose(place, d)), headPose(place)]) obstacles.push(deskBox(pose));
    const wb = whiteboardPose(place);
    const turned = place.turns % 2 === 1;
    obstacles.push({ cx: wb.x, cz: wb.z, hw: turned ? 0.15 : 2.3, hd: turned ? 2.3 : 0.15 });
  }

  const plants: Vec2[] = [
    { x: bounds.x0 + 1, z: bounds.z1 - 1 },
    { x: bounds.x1 - 1, z: bounds.z1 - 1 },
    { x: bounds.x0 + 1, z: LOBBY_Z0 + 1 },
    { x: bounds.x1 - 1, z: LOBBY_Z0 + 1 },
    { x: DOOR.x + 2.6, z: bounds.z1 - 0.9 },
    { x: bounds.x1 - 1, z: bounds.z0 + 1 },
    { x: bounds.x0 + 1, z: bounds.z0 + 1 },
  ];
  for (const p of plants) obstacles.push({ cx: p.x, cz: p.z, hw: 0.35, hd: 0.35 });

  return { bounds, ghostSlot, obstacles, plants };
}

// Slides a circle out of any box it overlaps. Mutates and returns p.
export function pushOut(p: { x: number; z: number }, radius: number, boxes: readonly Box[]) {
  for (const b of boxes) {
    const dx = p.x - b.cx;
    const dz = p.z - b.cz;
    const px = b.hw + radius - Math.abs(dx);
    const pz = b.hd + radius - Math.abs(dz);
    if (px <= 0 || pz <= 0) continue;
    if (px < pz) p.x += Math.sign(dx || 1) * px;
    else p.z += Math.sign(dz || 1) * pz;
  }
  return p;
}

export function clampToBounds(p: { x: number; z: number }, bounds: Bounds, margin = WALL_MARGIN) {
  p.x = Math.max(bounds.x0 + margin, Math.min(bounds.x1 - margin, p.x));
  p.z = Math.max(bounds.z0 + margin, Math.min(bounds.z1 - margin, p.z));
  return p;
}

export function angleDiff(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function hash(s: string, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
