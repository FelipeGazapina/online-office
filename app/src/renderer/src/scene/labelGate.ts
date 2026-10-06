import { useFrame } from '@react-three/fiber';
import { useRef, type RefObject } from 'react';
import type { Vector3 } from 'three';
import { STORY_H, type FloorGeometry } from '../../../shared/space/index.ts';
import { runtime } from '../runtime.ts';
import { get } from '../store.ts';
import { worldFor } from '../world.ts';
import { wallRecords, VARIANTS, type Variant } from './building/walls.ts';

// In first person a tag belongs to what the owner can see: a wall between the eye and the person hides it, and it
// fades out with distance. The overview shows every tag, since the cutaway walls there never stand in the way.
const FADE_FROM = 12;
const FADE_TO = 16;
const EVERY_MS = 100;

// A wall blocks the sight line unless it passes through the opening: [lo, hi] is the clear height range in meters above the floor.
type Seg = { ax: number; az: number; bx: number; bz: number; lo: number; hi: number };
// The glass is drawn opaque, so a window hides what is behind it like a wall does.
const OPENING: Record<Variant, [number, number]> = { solid: [0, 0], window: [0, 0], door: [0, 2.2], arch: [0, 2.6] };
const segCache = new WeakMap<FloorGeometry, Seg[]>();

function solidWalls(g: FloorGeometry): Seg[] {
  let segs = segCache.get(g);
  if (!segs) {
    const all = wallRecords(g);
    segs = VARIANTS.flatMap((v) =>
      all[v].map((r) => {
        const dx = (Math.cos(r.angle) * r.len) / 2;
        const dz = (-Math.sin(r.angle) * r.len) / 2;
        return { ax: r.x - dx, az: r.z - dz, bx: r.x + dx, bz: r.z + dz, lo: OPENING[v][0], hi: OPENING[v][1] };
      }),
    );
    segCache.set(g, segs);
  }
  return segs;
}

const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;

/** Whether the sight line from p to q is stopped by the wall segment: it crosses the wall outside the wall's opening. */
function blocks(s: Seg, px: number, py: number, pz: number, qx: number, qy: number, qz: number): boolean {
  const rx = qx - px, rz = qz - pz;
  const ex = s.bx - s.ax, ez = s.bz - s.az;
  const d = cross(rx, rz, ex, ez);
  if (Math.abs(d) < 1e-9) return false;
  const t = cross(s.ax - px, s.az - pz, ex, ez) / d;
  const u = cross(s.ax - px, s.az - pz, rx, rz) / d;
  if (!(t > 0 && t < 1 && u >= 0 && u <= 1)) return false;
  const y = py + (qy - py) * t;
  return y < s.lo || y > s.hi;
}

/** 0 when hidden, 1 when fully shown, in between while it fades with distance. `at` is the head the tag floats over. */
export function tagAlpha(eye: Vector3, at: Vector3, floor: number): number {
  const world = worldFor(get().building, get().meetingDoor);
  if (!world || floor !== runtime.owner.floor) return floor === runtime.owner.floor ? 1 : 0;
  const dist = Math.hypot(at.x - eye.x, at.z - eye.z);
  if (dist >= FADE_TO) return 0;
  const g = world.floors[floor];
  const base = floor * STORY_H;
  if (g) for (const s of solidWalls(g)) if (blocks(s, eye.x, eye.y - base, eye.z, at.x, at.y - base, at.z)) return 0;
  return dist <= FADE_FROM ? 1 : 1 - (dist - FADE_FROM) / (FADE_TO - FADE_FROM);
}

/** Drives a label element's opacity from tagAlpha, at most every 100 ms. `at` returns the tag's world position, or null. */
export function useLabelGate(el: RefObject<HTMLElement | null>, at: () => Vector3 | null, floor: () => number) {
  const last = useRef(0);
  const shown = useRef(-1);
  useFrame((state) => {
    const now = performance.now();
    if (now - last.current < EVERY_MS) return;
    last.current = now;
    const node = el.current;
    const p = at();
    if (!node || !p) return;
    const first = runtime.view.blend;
    const a = first < 0.5 ? 1 : tagAlpha(state.camera.position, p, floor());
    if (Math.abs(a - shown.current) < 0.02) return;
    shown.current = a;
    node.style.opacity = String(a);
    node.style.visibility = a < 0.03 ? 'hidden' : 'visible';
  });
}
