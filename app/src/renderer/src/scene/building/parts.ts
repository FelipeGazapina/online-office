// Primitive pieces every furniture model is merged from: boxes, cylinders and blobs with their color baked in as vertex colors.
import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry, LatheGeometry, Vector2 } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const paint = (g: BufferGeometry, color: string | number | [number, number, number]): BufferGeometry => {
  const flat = g.index ? g.toNonIndexed() : g;
  const n = flat.getAttribute('position').count;
  const c = Array.isArray(color) ? new Color(color[0], color[1], color[2]) : new Color(color as string);
  const rgb = Array.isArray(color) ? color : [c.r, c.g, c.b];
  flat.setAttribute('color', new Float32BufferAttribute(Array.from({ length: n }, () => rgb).flat(), 3));
  if (!flat.getAttribute('uv')) flat.setAttribute('uv', new Float32BufferAttribute(new Float32Array(n * 2), 2));
  return flat;
};
export const at = (g: BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z);

export const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string | [number, number, number]) => paint(at(new BoxGeometry(w, h, d), x, y, z), color);
export const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number, color: string, seg = 14) => paint(at(new CylinderGeometry(rt, rb, h, seg), x, y, z), color);
export const blob = (r: number, x: number, y: number, z: number, color: string) => paint(at(new IcosahedronGeometry(r, 0), x, y, z), color);
export const merge = (parts: BufferGeometry[]) => {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('A furniture model failed to merge');
  g.computeBoundingSphere();
  return g;
};
/** A box turned about the vertical axis through its own middle. */
export const rbox = (w: number, h: number, d: number, x: number, y: number, z: number, yaw: number, color: string) => {
  const g = new BoxGeometry(w, h, d);
  g.rotateY(yaw);
  return paint(at(g, x, y, z), color);
};

/** A box with softened edges: the bevel catches a highlight where a plain box would give a hard corner. */
export const bbox = (w: number, h: number, d: number, x: number, y: number, z: number, color: string | [number, number, number], radius = 0.04) =>
  paint(at(new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, Math.min(w, h, d) / 2 - 0.002)), x, y, z), color);

/** A part leaned about the point (x, y, z) by `rx` and `rz` radians: the geometry is built with its pivot at the origin, leaned, then moved there. */
export const lean = (g: BufferGeometry, rx: number, rz: number, x: number, y: number, z: number) => g.rotateX(rx).rotateZ(rz).translate(x, y, z);

/** A smooth vessel: `profile` is the outline as [radius, height] pairs from the bottom up, turned about the vertical axis. */
export const lathe = (profile: readonly (readonly [number, number])[], x: number, y: number, z: number, color: string, seg = 20) =>
  paint(at(new LatheGeometry(profile.map(([r, h]) => new Vector2(r, h)), seg), x, y, z), color);
