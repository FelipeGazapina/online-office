// Pure office geometry. Units are meters. +x east, +z south (toward the entrance), -z north.
// A yaw of 0 faces +z; forward = (sin yaw, cos yaw); right = (-cos yaw, sin yaw).
import type { ProjectBlock } from '../../shared/protocol.ts';

export const BLOCK_W = 10;
export const BLOCK_D = 8;
export const AISLE = 2;
export const COLS = 3;
export const X0 = -18;
export const LOBBY_Z0 = -1;
export const Z1 = 9;
export const WALL_H = 3.2;

export type Vec2 = { x: number; z: number };
export type Box = { cx: number; cz: number; hw: number; hd: number };

export type Bounds = { x0: number; x1: number; z0: number; z1: number; cols: number; rows: number };

export function blockCenter(slot: number): Vec2 {
  const col = slot % COLS;
  const row = Math.floor(slot / COLS);
  return {
    x: X0 + AISLE / 2 + BLOCK_W / 2 + col * (BLOCK_W + AISLE),
    z: -(BLOCK_D / 2 + 1) - row * (BLOCK_D + AISLE),
  };
}

export type DeskPose = { desk: Vec2; chair: Vec2; exit: Vec2 };

export function deskPose(slot: number, desk: number): DeskPose {
  const c = blockCenter(slot);
  const i = Math.max(0, Math.min(4, desk));
  const front = i < 3;
  const x = c.x + (front ? (i - 1) * 3.2 : (i - 3.5) * 3.2);
  const z = c.z + (front ? 1.4 : -1.3);
  // The chair is south of the desk; the employee faces north at the monitor.
  return { desk: { x, z }, chair: { x, z: z + 0.9 }, exit: { x, z: z + 2.0 } };
}

export function whiteboardPose(slot: number): Vec2 {
  const c = blockCenter(slot);
  return { x: c.x, z: c.z - BLOCK_D / 2 + 0.7 };
}

export function signPose(slot: number): Vec2 {
  const c = blockCenter(slot);
  return { x: c.x - BLOCK_W / 2 + 1.6, z: c.z + BLOCK_D / 2 - 0.4 };
}

export const DOOR: Vec2 = { x: X0 + 8, z: Z1 };
export const OWNER_START: Vec2 = { x: X0 + 8, z: Z1 - 4.8 };
export const OWNER_DESK: Vec2 = { x: X0 + 1.5, z: 5.2 };

export type Layout = {
  bounds: Bounds;
  ghostSlot: number | null;
  obstacles: Box[];
  plants: Vec2[];
};

let cacheKey = '';
let cache: Layout | null = null;

export function getLayout(blocks: readonly ProjectBlock[]): Layout {
  const key = blocks.map((b) => `${b.id}:${b.slot}`).join(',');
  if (cache && key === cacheKey) return cache;
  cacheKey = key;
  cache = computeLayout(blocks);
  return cache;
}

function computeLayout(blocks: readonly ProjectBlock[]): Layout {
  const maxSlot = blocks.reduce((m, b) => Math.max(m, b.slot), -1);
  const ghostSlot = maxSlot + 1 < 6 ? maxSlot + 1 : null;
  const shown = ghostSlot === null ? maxSlot + 1 : ghostSlot + 1;
  const cols = Math.max(2, Math.min(COLS, shown));
  const rows = Math.max(1, Math.ceil(shown / COLS));
  const bounds: Bounds = {
    x0: X0,
    x1: X0 + cols * (BLOCK_W + AISLE),
    z0: -rows * (BLOCK_D + AISLE),
    z1: Z1,
    cols,
    rows,
  };

  const obstacles: Box[] = [{ cx: OWNER_DESK.x, cz: OWNER_DESK.z, hw: 0.45, hd: 1.0 }];
  for (const b of blocks) {
    for (let d = 0; d < 5; d++) {
      const p = deskPose(b.slot, d).desk;
      obstacles.push({ cx: p.x, cz: p.z, hw: 0.8, hd: 0.4 });
    }
    const wb = whiteboardPose(b.slot);
    obstacles.push({ cx: wb.x, cz: wb.z, hw: 2.3, hd: 0.15 });
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

export function clampToBounds(p: { x: number; z: number }, bounds: Bounds, margin = 0.6) {
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
