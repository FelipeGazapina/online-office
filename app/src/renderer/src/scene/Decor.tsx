import { useMemo } from 'react';
import { MeshStandardMaterial, type BufferGeometry } from 'three';
import { box, blob, cyl, leafMass, merge } from './building/models.ts';
import { detail } from './shading.ts';

// Set dressing that the building model has no item for: one merged mesh per room, so a whole room's decor is one draw call.
export const decorMaterial = detail(new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }), 'furniture');

const move = (parts: BufferGeometry[], x: number, z: number) => {
  parts.forEach((g) => g.translate(x, 0, z));
  return parts;
};

// `s` scales the plant; 1 is about 1.1 m tall, the size of a floor plant in a real office.
export const pottedPlant = (x: number, z: number, s = 1): BufferGeometry[] => [
  cyl(0.2 * s, 0.15 * s, 0.36 * s, x, 0.18 * s, z, '#f1ebe0'),
  cyl(0.21 * s, 0.21 * s, 0.03 * s, x, 0.37 * s, z, '#4a3a2b'),
  leafMass(0.24 * s, x, 0.62 * s, z, '#4d8a5d'),
  leafMass(0.18 * s, x + 0.14 * s, 0.78 * s, z + 0.07 * s, '#78b97a'),
  leafMass(0.19 * s, x - 0.13 * s, 0.82 * s, z - 0.05 * s, '#5f9f6c'),
  leafMass(0.16 * s, x + 0.03 * s, 0.98 * s, z, '#8ccb84'),
  leafMass(0.15 * s, x - 0.07 * s, 0.56 * s, z + 0.13 * s, '#78b97a'),
];

// A framed picture hung on a wall: a dark frame, a mat and a few blocks of color. `face` is +1 for a wall that looks toward +z, -1 for -z.
const PALETTES = [['#d9724c', '#f2c14e', '#3f6f9f'], ['#2f6f73', '#e8d9b5', '#c8553d'], ['#6a4c93', '#f4a259', '#e9e4da'], ['#4f7ea3', '#d9b45a', '#78b97a']];
function art(x: number, y: number, z: number, w: number, h: number, face: 1 | -1, n: number): BufferGeometry[] {
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
function shelf(x: number, z: number, len: number, n: number): BufferGeometry[] {
  const books = ['#b85c4a', '#4f7ea3', '#d9b45a', '#6a8f5a', '#e9e4da', '#6a4c93'];
  const out = [box(0.4, 0.9, len, x, 0.45, z, '#8c6a4a'), box(0.44, 0.04, len + 0.04, x, 0.92, z, '#6a4d34')];
  for (let i = 0; i < Math.floor(len / 0.2) - 1; i++) out.push(box(0.26, 0.22 + (i % 3) * 0.05, 0.1, x, 1.05 + (i % 3) * 0.025, z - len / 2 + 0.25 + i * 0.2, books[(i + n) % books.length]));
  return out;
}

function reception(): BufferGeometry[] {
  return move(
    [
      box(4.2, 1.9, 0.3, 0, 0.95, -0.95, '#8c6a4a'),
      ...[0.5, 1.0, 1.5].flatMap((y, i) => [box(3.9, 0.04, 0.26, 0, y, -0.94, '#6a4d34'), box(3.9 - i * 0.2, 0.3, 0.2, 0, y + 0.17, -0.94, ['#b85c4a', '#4f7ea3', '#d9b45a'][i])]),
      box(0.5, 0.04, 0.4, -1.4, 1.09, 0, '#2b2e38'),
      box(0.5, 0.32, 0.03, -1.4, 1.27, -0.1, '#1c1f27'),
      cyl(0.09, 0.09, 0.05, 0.8, 1.1, 0.05, '#d9b45a'),
      cyl(0.05, 0.08, 0.2, 1.4, 1.2, -0.05, '#fbf6ec'),
      blob(0.16, 1.4, 1.38, -0.05, '#78b97a'),
      ...pottedPlant(-2.7, -0.3),
      ...pottedPlant(2.7, -0.3),
      box(0.9, 0.42, 0.7, -3.3, 0.21, 0.5, '#7c9c92'),
      box(0.9, 0.34, 0.14, -3.3, 0.55, 0.18, '#6d8d83'),
      box(0.9, 0.42, 0.7, 3.3, 0.21, 0.5, '#7c9c92'),
      box(0.9, 0.34, 0.14, 3.3, 0.55, 0.18, '#6d8d83'),
    ],
    0,
    0,
  );
}

function kitchen(): BufferGeometry[] {
  return [
    box(0.85, 1.85, 0.75, 2.85, 0.93, -0.1, '#e8ecee'),
    box(0.05, 0.6, 0.04, 2.5, 1.3, 0.3, '#9aa0a6'),
    box(0.5, 0.3, 0.38, -1.2, 1.2, -0.05, '#444a55'),
    box(0.3, 0.2, 0.02, -1.15, 1.2, 0.15, '#1c1f27'),
    cyl(0.18, 0.14, 0.1, 0.4, 1.12, 0.05, '#d9b45a'),
    blob(0.1, 0.35, 1.2, 0.05, '#d95d63'),
    blob(0.1, 0.45, 1.2, 0.0, '#f2b84b'),
    cyl(0.22, 0.22, 0.9, -2.85, 0.45, -0.1, '#cfe3f0'),
    cyl(0.2, 0.2, 0.5, -2.85, 1.15, -0.1, '#9fd0ee'),
    ...[-1.4, 0, 1.4].map((x) => cyl(0.2, 0.22, 0.04, x, 0.78, 0.75, '#b8865e')),
    // The counter's top sits at 1.1 m: a sink with a tap, a microwave, a toaster, a kettle, a fruit bowl and a dish rack.
    box(0.7, 0.03, 0.4, 1.05, 1.11, 0.0, '#8d97a1'),
    box(0.06, 0.28, 0.06, 1.05, 1.26, -0.18, '#c4cad1'),
    box(0.2, 0.05, 0.05, 1.05, 1.4, -0.12, '#c4cad1'),
    box(0.55, 0.3, 0.38, -0.4, 1.26, -0.08, '#e8ecee'),
    box(0.34, 0.2, 0.02, -0.44, 1.26, 0.12, '#1c1f27'),
    box(0.3, 0.17, 0.2, 1.75, 1.19, 0.05, '#d95d63'),
    cyl(0.1, 0.12, 0.22, 1.9, 1.21, -0.15, '#c4cad1', 12),
    cyl(0.2, 0.12, 0.1, 0.1, 1.15, 0.1, '#f1ebe0', 14),
    blob(0.06, 0.05, 1.22, 0.1, '#e5483f'),
    blob(0.06, 0.15, 1.22, 0.06, '#f2b84b'),
    box(0.4, 0.04, 0.3, -1.9, 1.12, 0.0, '#c9a77c'),
  ];
}

function lounge(): BufferGeometry[] {
  return [
    box(1.3, 0.05, 0.7, -1.5, 0.36, 0.9, '#d8b47d'),
    ...[-0.55, 0.55].map((x) => box(0.05, 0.34, 0.05, -1.5 + x, 0.17, 0.9, '#3a3f4e')),
    box(0.5, 0.03, 0.34, -1.6, 0.4, 0.9, '#d95d63'),
    box(0.9, 0.42, 0.9, 2.6, 0.21, 0.2, '#c59e73'),
    box(0.9, 0.5, 0.18, 2.6, 0.6, -0.2, '#b4895e'),
    cyl(0.04, 0.04, 1.5, -3.0, 0.75, -0.6, '#2b2e38', 8),
    cyl(0.22, 0.12, 0.28, -3.0, 1.55, -0.6, '#f8e7b8'),
    cyl(0.16, 0.18, 0.04, -3.0, 0.02, -0.6, '#2b2e38'),
    ...pottedPlant(3.0, -0.7, 1),
    cyl(1.25, 1.25, 0.02, 0.2, 0.012, 0.5, '#c8553d', 28),
    cyl(0.9, 0.9, 0.024, 0.2, 0.014, 0.5, '#f2e4c9', 28),
    box(0.8, 0.45, 0.8, -0.2, 0.22, 1.1, '#d9b45a'),
    box(0.8, 0.5, 0.15, -0.2, 0.62, 1.45, '#c79f48'),
    box(0.32, 0.03, 0.22, -1.5, 0.43, 0.9, '#4f7ea3'),
    box(0.3, 0.03, 0.2, -1.5, 0.46, 0.92, '#e9e4da'),
    cyl(0.07, 0.06, 0.12, -1.3, 0.44, 0.9, '#f1ebe0'),
    ...shelf(-3.4, 0.3, 1.8, 1),
  ];
}

function meeting(): BufferGeometry[] {
  return [
    box(2.4, 1.0, 0.05, 0, 1.75, -1.3, '#14181f'),
    box(2.3, 0.9, 0.02, 0, 1.75, -1.27, '#27527a'),
    box(0.5, 0.35, 0.02, -0.6, 1.9, -1.255, '#6fe0b0'),
    box(0.9, 0.06, 0.02, 0.45, 1.95, -1.255, '#b8d7f4'),
    box(0.9, 0.06, 0.02, 0.45, 1.75, -1.255, '#b8d7f4'),
    box(2.6, 0.04, 0.12, 0, 1.2, -1.3, '#2b2e38'),
    ...pottedPlant(-3.4, -1.1),
    ...pottedPlant(3.4, -1.1),
    ...art(-3.0, 1.7, -1.3, 0.9, 0.7, 1, 1),
    ...art(3.0, 1.7, -1.3, 0.9, 0.7, 1, 2),
  ];
}

function lobby(cx: number, z1: number, doorX: number): BufferGeometry[] {
  const out: BufferGeometry[] = [
    box(6.6, 0.02, 3.0, cx, 0.012, 4.9, '#d9c9ad'),
    box(6.0, 0.024, 2.4, cx, 0.014, 4.9, '#9a6a4c'),
    box(5.6, 0.028, 2.0, cx, 0.016, 4.9, '#c58f68'),
    ...[-6.5, -2.5, 8, 16].flatMap((px) => pottedPlant(px, 2.6, 1)),
  ];
  out.push(...pottedPlant(doorX - 2.4, z1 - 0.8, 1.2), ...pottedPlant(doorX + 2.4, z1 - 0.8, 1.2));
  [-12, -8, 8, 12, 16].forEach((dx, n) => out.push(...art(doorX + dx, 1.75, z1 - 0.13, n % 2 ? 1.1 : 0.8, n % 2 ? 0.8 : 1.1, -1, n)));
  out.push(box(2.4, 0.46, 0.5, -15.6, 0.23, z1 - 0.6, '#8c6a4a'), box(2.4, 0.06, 0.55, -15.6, 0.48, z1 - 0.6, '#c59e73'));
  return out;
}

export type DecorSpec = { cx: number; z1: number; right: number; doorX: number };

export function LobbyDecor({ cx, z1, right, doorX }: DecorSpec) {
  const geo = useMemo(() => {
    const rooms = [
      move(reception(), cx, z1 - 1.25),
      move(kitchen(), right, z1 - 4.15),
      move(lounge(), right, z1 - 1.75),
      move(meeting(), cx, -0.45),
      lobby(cx, z1, doorX),
    ];
    return merge(rooms.flat());
  }, [cx, z1, right, doorX]);
  return <mesh geometry={geo} material={decorMaterial} castShadow receiveShadow />;
}

function pod(): BufferGeometry[] {
  return [
    ...pottedPlant(-4.2, 3.1, 1),
    ...pottedPlant(4.2, -3.1, 1),
    box(0.9, 0.7, 2.4, 4.3, 0.35, 0.3, '#efe0c6'),
    box(0.9, 0.04, 2.4, 4.3, 0.72, 0.3, '#c59e73'),
    cyl(0.04, 0.04, 1.4, -4.3, 0.7, -2.6, '#2b2e38', 8),
    cyl(0.2, 0.1, 0.26, -4.3, 1.45, -2.6, '#f8e7b8'),
    cyl(0.5, 0.5, 0.34, 2.4, 0.17, 3.3, '#c9a77c', 14),
    ...shelf(-4.7, 0.6, 2.2, 0),
    ...art(0, 1.35, 0, 0.5, 0.6, 1, 3).map((g) => g.rotateY(Math.PI / 2).translate(-4.55, 0, 1.4)),
    // A printer on its table, a water cooler and a bin along the back of the pod.
    box(0.9, 0.04, 0.55, 2.8, 0.7, -3.5, '#efe0c6'),
    ...[-0.4, 0.4].map((dx) => box(0.05, 0.68, 0.5, 2.8 + dx, 0.34, -3.5, '#3a3f4e')),
    box(0.5, 0.22, 0.4, 2.8, 0.83, -3.5, '#e8ecee'),
    box(0.4, 0.03, 0.3, 2.8, 0.96, -3.5, '#f7f4ec'),
    cyl(0.17, 0.17, 0.95, -2.8, 0.48, -3.6, '#e8ecee', 12),
    cyl(0.15, 0.15, 0.4, -2.8, 1.15, -3.6, '#9fd0ee', 12),
    cyl(0.14, 0.12, 0.34, -1.6, 0.17, -3.6, '#3a3f4e', 10),
    // Boxes of supplies stacked by the shelf.
    box(0.5, 0.35, 0.4, -4.5, 0.18, -1.3, '#c9a77c'),
    box(0.42, 0.3, 0.36, -4.5, 0.5, -1.3, '#d8b88a'),
  ];
}

export function PodDecor() {
  const geo = useMemo(() => merge(pod()), []);
  return <mesh geometry={geo} material={decorMaterial} castShadow receiveShadow />;
}
