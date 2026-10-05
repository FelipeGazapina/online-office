import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import { FLOOR_PAINTS, PAINT, type FloorGeometry } from '../../../../shared/space/index.ts';

const cache = new WeakMap<FloorGeometry, BufferGeometry | null>();

const WOOD_DARK: [number, number, number] = [0.58, 0.44, 0.36];

/**
 * One merged mesh for a whole story: every painted tile in one vertex buffer, two index ranges. Wood is textured by the
 * plank map and tinted by its vertex color; every other paint is a flat color.
 */
export function floorGeometry(g: FloorGeometry): BufferGeometry | null {
  if (cache.has(g)) return cache.get(g)!;
  const { position, index, paint } = g.render.floor;
  let geo: BufferGeometry | null = null;
  if (index.length) {
    const wood: number[] = [];
    const flat: number[] = [];
    for (let t = 0; t < index.length; t += 3) {
      const p = paint[index[t]];
      (p === PAINT.woodLight || p === PAINT.woodDark ? wood : flat).push(index[t], index[t + 1], index[t + 2]);
    }
    const n = position.length / 3;
    const uv = new Float32Array(n * 2);
    const normal = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    const c = new Color();
    for (let i = 0; i < n; i++) {
      uv[i * 2] = position[i * 3] / 4;
      uv[i * 2 + 1] = position[i * 3 + 2] / 4;
      normal[i * 3 + 1] = 1;
      const p = paint[i];
      if (p === PAINT.woodLight) color.set([1, 1, 1], i * 3);
      else if (p === PAINT.woodDark) color.set(WOOD_DARK, i * 3);
      else {
        c.set(FLOOR_PAINTS[p].color);
        color.set([c.r, c.g, c.b], i * 3);
      }
    }
    geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(position, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(normal, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new Float32BufferAttribute(color, 3));
    geo.setIndex(new Uint32BufferAttribute([...wood, ...flat], 1));
    geo.addGroup(0, wood.length, 0);
    geo.addGroup(wood.length, flat.length, 1);
    geo.computeBoundingSphere();
  }
  cache.set(g, geo);
  return geo;
}
