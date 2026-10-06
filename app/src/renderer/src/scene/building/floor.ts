import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import { FLOOR_PAINTS, PAINT, type FloorGeometry } from '../../../../shared/space/index.ts';

const cache = new WeakMap<FloorGeometry, BufferGeometry | null>();

const WOOD_DARK: [number, number, number] = [0.58, 0.44, 0.36];

// The floor surfaces, in material order. Each is textured and tinted by its vertex colour.
export const FLOOR_FAMILIES = ['wood', 'carpet', 'tile', 'concrete'] as const;
type Family = (typeof FLOOR_FAMILIES)[number];
const familyOf = (p: number): Family =>
  p === PAINT.woodLight || p === PAINT.woodDark ? 'wood' : p === PAINT.carpetBlue || p === PAINT.carpetGray || p === PAINT.carpetRed ? 'carpet' : p === PAINT.tileWhite || p === PAINT.tileDark ? 'tile' : 'concrete';

const THRESHOLD_COLOR = new Color('#6f5a42');
const THRESHOLD_HALF_WIDTH = 0.05;
const THRESHOLD_Y = 0.012;

/**
 * One merged mesh for a whole story: every painted tile in one vertex buffer, one index range per surface. UVs are floor
 * metres, so each surface's texture repeats at its own real-world size. Where two different paints meet, a thin
 * threshold strip lies along the seam so zones read as separate rooms from up close.
 */
export function floorGeometry(g: FloorGeometry): BufferGeometry | null {
  if (cache.has(g)) return cache.get(g)!;
  const { position, index, paint } = g.render.floor;
  let geo: BufferGeometry | null = null;
  if (index.length) {
    const ranges: Record<Family, number[]> = { wood: [], carpet: [], tile: [], concrete: [] };
    for (let t = 0; t < index.length; t += 3) ranges[familyOf(paint[index[t]])].push(index[t], index[t + 1], index[t + 2]);
    const n = position.length / 3;
    const pos: number[] = Array.from(position);
    const uv: number[] = [];
    const normal: number[] = [];
    const color: number[] = [];
    const c = new Color();
    for (let i = 0; i < n; i++) {
      uv.push(position[i * 3], position[i * 3 + 2]);
      normal.push(0, 1, 0);
      const p = paint[i];
      if (p === PAINT.woodLight) color.push(1, 1, 1);
      else if (p === PAINT.woodDark) color.push(...WOOD_DARK);
      else {
        c.set(FLOOR_PAINTS[p].color);
        color.push(c.r, c.g, c.b);
      }
    }

    const { lot, story } = g;
    const y = (position[1] ?? 0) + THRESHOLD_Y;
    const strip = (x0: number, z0: number, x1: number, z1: number) => {
      const base = pos.length / 3;
      pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      for (let k = 0; k < 4; k++) {
        normal.push(0, 1, 0);
        color.push(THRESHOLD_COLOR.r, THRESHOLD_COLOR.g, THRESHOLD_COLOR.b);
      }
      uv.push(x0, z0, x1, z0, x1, z1, x0, z1);
      ranges.concrete.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    const paintAt = (tx: number, tz: number) => (tx < lot.x0 || tz < lot.z0 || tx >= lot.x0 + lot.w || tz >= lot.z0 + lot.h ? 0 : story.paint[(tz - lot.z0) * lot.w + (tx - lot.x0)]);
    const w = THRESHOLD_HALF_WIDTH;
    for (let tz = lot.z0; tz < lot.z0 + lot.h; tz++) {
      for (let tx = lot.x0; tx < lot.x0 + lot.w; tx++) {
        const here = paintAt(tx, tz);
        if (!here) continue;
        const east = paintAt(tx + 1, tz);
        const south = paintAt(tx, tz + 1);
        if (east && east !== here && familyOf(east) !== familyOf(here)) strip(tx + 1 - w, tz, tx + 1 + w, tz + 1);
        if (south && south !== here && familyOf(south) !== familyOf(here)) strip(tx, tz + 1 - w, tx + 1, tz + 1 + w);
      }
    }

    geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('normal', new Float32BufferAttribute(normal, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new Float32BufferAttribute(color, 3));
    const all: number[] = [];
    FLOOR_FAMILIES.forEach((f, m) => {
      geo!.addGroup(all.length, ranges[f].length, m);
      all.push(...ranges[f]);
    });
    geo.setIndex(new Uint32BufferAttribute(all, 1));
    geo.computeBoundingSphere();
  }
  cache.set(g, geo);
  return geo;
}
