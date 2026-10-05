import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Matrix4, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STORY_H, WALL_HALF, type FloorGeometry } from '../../../../shared/space/index.ts';

export type Variant = 'solid' | 'door' | 'window' | 'arch';
export const VARIANTS: readonly Variant[] = ['solid', 'door', 'window', 'arch'];

const T = WALL_HALF * 2;
const CURB = 0.4;
const WHITE: [number, number, number] = [1, 1, 1];
const CAP: [number, number, number] = [1.18, 1.18, 1.18];

const part = (w: number, h: number, d: number, y: number, color: [number, number, number], depth = d) => {
  const g = new BoxGeometry(w, h, depth).toNonIndexed();
  g.translate(0, y, 0);
  g.setAttribute('color', new Float32BufferAttribute(Array.from({ length: g.getAttribute('position').count }, () => color).flat(), 3));
  return g;
};
const merge = (parts: BufferGeometry[]) => {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('A wall model failed to merge');
  return g;
};
const cap = (y: number) => part(1, 0.08, T + 0.06, y, CAP);

// Each model is one unit long along x, centered on its segment, standing on the floor.
const geometries: Record<Variant, () => BufferGeometry> = {
  solid: () => merge([part(1, STORY_H, T, STORY_H / 2, WHITE), cap(STORY_H + 0.04)]),
  door: () => merge([part(1, 1, T, STORY_H - 0.5, WHITE), cap(STORY_H + 0.04)]),
  arch: () => merge([part(1, 0.6, T, STORY_H - 0.3, WHITE), cap(STORY_H + 0.04)]),
  window: () => merge([part(1, 0.9, T, 0.45, WHITE), part(1, 1.1, T, STORY_H - 0.55, WHITE), cap(STORY_H + 0.04), cap(0.94)]),
};
const built = new Map<string, BufferGeometry>();
export const wallModel = (v: Variant): BufferGeometry => {
  let g = built.get(v);
  if (!g) built.set(v, (g = geometries[v]()));
  return g;
};
export const curbModel = (): BufferGeometry => {
  let g = built.get('curb');
  if (!g) built.set('curb', (g = merge([part(1, CURB, T, CURB / 2, WHITE), cap(CURB + 0.04)])));
  return g;
};
export const glassModel = (): BufferGeometry => {
  let g = built.get('glass');
  if (!g) {
    g = new PlaneGeometry(1, 1.2);
    g.translate(0, 1.5, 0);
    built.set('glass', g);
  }
  return g;
};

export type WallRecord = { variant: Variant; x: number; z: number; angle: number; len: number; style: number; nx: number; nz: number };

export function wallRecords(g: FloorGeometry): Record<Variant, WallRecord[]> {
  const out: Record<Variant, WallRecord[]> = { solid: [], door: [], window: [], arch: [] };
  for (const variant of VARIANTS) {
    const m = g.render.walls[variant];
    const n = g.render.wallNormals[variant];
    for (let i = 0; i < m.length / 5; i++) {
      out[variant].push({ variant, x: m[i * 5], z: m[i * 5 + 1], angle: m[i * 5 + 2], len: m[i * 5 + 3], style: m[i * 5 + 4], nx: n[i * 2], nz: n[i * 2 + 1] });
    }
  }
  return out;
}

const q = new Quaternion();
const up = new Vector3(0, 1, 0);
const pos = new Vector3();
const scl = new Vector3();
export const ZERO = new Matrix4().makeScale(0, 0, 0);

export function wallMatrix(r: WallRecord, out = new Matrix4()): Matrix4 {
  q.setFromAxisAngle(up, r.angle);
  // A straight segment is lengthened by a wall's thickness so two walls meet in a corner without a notch.
  scl.set(r.len + (r.angle === 0 || r.angle === -Math.PI / 2 ? T : 0), 1, 1);
  return out.compose(pos.set(r.x, 0, r.z), q, scl);
}

/** The wall faces the camera when its outward normal points at it. `yaw` is the camera's heading, the way view.yaw runs. */
export const facesCamera = (r: WallRecord, yaw: number): boolean => -Math.sin(yaw) * r.nx - Math.cos(yaw) * r.nz > 0.35;

/** The camera's heading snapped to one of eight directions, so the cutaway only changes when the view turns far enough. */
export const octantOf = (yaw: number): number => ((Math.round(yaw / (Math.PI / 4)) % 8) + 8) % 8;
