// Pieces of set dressing that more than one model is built from: a framed picture and a low shelf of books.
import type { BufferGeometry } from 'three';
import { bbox, box } from './parts.ts';

// A framed picture hung on a wall: a dark frame, a mat and a few blocks of color. `face` is +1 for a wall that looks toward +z, -1 for -z.
const PALETTES = [['#d9724c', '#f2c14e', '#3f6f9f'], ['#2f6f73', '#e8d9b5', '#c8553d'], ['#6a4c93', '#f4a259', '#e9e4da'], ['#4f7ea3', '#d9b45a', '#78b97a']];
export function art(x: number, y: number, z: number, w: number, h: number, face: 1 | -1, n: number): BufferGeometry[] {
  const pal = PALETTES[n % PALETTES.length];
  const fz = z + face * 0.03;
  return [
    box(w, h, 0.05, x, y, z, '#2b2e38'),
    box(w - 0.1, h - 0.1, 0.02, x, y, fz, '#f7f2e8'),
    box(w * 0.5, h * 0.55, 0.02, x - w * 0.12, y + h * 0.06, fz + face * 0.012, pal[0]),
    box(w * 0.28, h * 0.42, 0.02, x + w * 0.2, y - h * 0.02, fz + face * 0.024, pal[1]),
    box(w * 0.7, h * 0.12, 0.02, x, y - h * 0.3, fz + face * 0.012, pal[2]),
  ];
}

// A low shelf of books with a plant and a framed picture leaning on it. Long side along z.
export function shelf(x: number, z: number, len: number, n: number): BufferGeometry[] {
  const books = ['#b85c4a', '#4f7ea3', '#d9b45a', '#6a8f5a', '#e9e4da', '#6a4c93'];
  const out = [bbox(0.4, 0.9, len, x, 0.45, z, '#8c6a4a', 0.03), bbox(0.44, 0.05, len + 0.04, x, 0.92, z, '#6a4d34', 0.02)];
  for (let i = 0; i < Math.floor(len / 0.2) - 1; i++) out.push(box(0.26, 0.22 + (i % 3) * 0.05, 0.1, x, 1.05 + (i % 3) * 0.025, z - len / 2 + 0.25 + i * 0.2, books[(i + n) % books.length]));
  return out;
}
