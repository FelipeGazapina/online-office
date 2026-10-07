// The catalog's furniture beyond the first dozen pieces: one merged model per def, in meters, centered on the footprint
// and facing +z at rot 0. Every one is a handful of boxes, cylinders and blobs so a def still costs one draw call.
import type { BufferGeometry } from 'three';
import { POD_MODELS } from './pod.ts';
import { bbox, blob, box, cyl, merge, rbox } from './parts.ts';

const WOOD = '#efe0c6';
const WALNUT = '#8c6a4a';
const OAK = '#d8b47d';
const DARK = '#3a3f4e';
const INK = '#2b2e38';
const CREAM = '#f4f0e6';
const STEEL = '#c9cdd8';
const SAGE = '#7c9c92';
const CLAY = '#c8745a';
const SKY = '#4f7ea3';
const LEAF = ['#5f9f6c', '#78b97a', '#4d8a5d', '#8ccb84'];

const legs = (w: number, d: number, h: number, inset = 0.06, color = DARK) =>
  [-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(0.05, h, 0.05, sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset), color)));
const monitor = (x: number, y: number, z: number, yaw = 0) => [rbox(0.62, 0.38, 0.04, x, y + 0.3, z, yaw, '#1c1f27'), rbox(0.06, 0.28, 0.06, x, y + 0.14, z, yaw, INK)];
const pot = (x: number, z: number, r: number, h: number, color = CREAM) => cyl(r, r * 0.72, h, x, h / 2, z, color);
const chairAt = (x: number, z: number, yaw: number) => [
  rbox(0.4, 0.07, 0.4, x, 0.42, z, yaw, SKY),
  rbox(0.4, 0.4, 0.06, x + Math.sin(yaw) * -0.2, 0.68, z - Math.cos(yaw) * 0.2, yaw, SKY),
  cyl(0.03, 0.03, 0.4, x, 0.2, z, INK, 8),
];

const bush = (r: number, x: number, y: number, z: number, i: number) => blob(r, x, y, z, LEAF[i % LEAF.length]);

export const FURNITURE: Readonly<Record<string, () => BufferGeometry>> = {
  // ---- desks
  standing_desk: () =>
    merge([
      box(1.46, 0.05, 0.9, 0, 1.08, 0, OAK),
      box(0.08, 1.04, 0.7, -0.6, 0.52, 0, DARK),
      box(0.08, 1.04, 0.7, 0.6, 0.52, 0, DARK),
      box(1.2, 0.04, 0.5, 0, 0.12, 0, DARK),
      ...monitor(0, 1.1, 0.15),
      box(0.4, 0.02, 0.14, 0, 1.12, -0.2, INK),
    ]),
  l_desk: () =>
    merge([
      box(1.9, 0.06, 0.8, 0, 0.72, -0.6, WOOD),
      box(0.8, 0.06, 1.2, -0.55, 0.72, 0.4, WOOD),
      box(0.06, 0.7, 0.06, 0.9, 0.35, -0.9, DARK),
      box(0.06, 0.7, 0.06, 0.9, 0.35, -0.3, DARK),
      box(0.06, 0.7, 0.06, -0.9, 0.35, -0.9, DARK),
      box(0.06, 0.7, 0.06, -0.9, 0.35, 0.9, DARK),
      box(0.06, 0.7, 0.06, -0.2, 0.35, 0.9, DARK),
      ...monitor(0.3, 0.72, -0.7),
      ...monitor(-0.55, 0.72, 0.6, Math.PI / 2),
    ]),
  corner_desk: () =>
    merge([
      box(1.9, 0.06, 0.7, 0, 0.72, -0.65, WOOD),
      box(0.7, 0.06, 1.2, -0.6, 0.72, 0.35, WOOD),
      rbox(1.0, 0.06, 0.5, -0.2, 0.72, 0.0, Math.PI / 4, WOOD),
      box(0.06, 0.7, 0.06, 0.9, 0.35, -0.95, DARK),
      box(0.06, 0.7, 0.06, -0.9, 0.35, 0.9, DARK),
      box(0.06, 0.7, 0.06, -0.3, 0.35, 0.9, DARK),
      box(0.06, 0.7, 0.06, 0.9, 0.35, -0.35, DARK),
      ...monitor(-0.05, 0.72, -0.75),
      box(0.4, 0.02, 0.14, 0.4, 0.76, -0.45, INK),
    ]),
  meeting_pod: () =>
    merge([
      cyl(0.8, 0.8, 0.06, 0, 0.72, 0, OAK, 24),
      cyl(0.07, 0.1, 0.7, 0, 0.35, 0, DARK, 10),
      ...[0, 1, 2, 3].flatMap((i) => chairAt(Math.sin((i * Math.PI) / 2) * 1.2, Math.cos((i * Math.PI) / 2) * 1.2, ((i * Math.PI) / 2 + Math.PI) % (Math.PI * 2))),
      box(0.05, 1.5, 3, -1.45, 0.75, 0, '#cfd9d4'),
      box(0.05, 1.5, 3, 1.45, 0.75, 0, '#cfd9d4'),
      box(2.9, 1.5, 0.05, 0, 0.75, -1.45, '#cfd9d4'),
    ]),
  reception_desk: () =>
    merge([
      box(2.9, 1.0, 0.7, 0, 0.5, 0.1, WALNUT),
      box(2.96, 0.06, 0.82, 0, 1.03, 0.1, CREAM),
      box(2.9, 0.4, 0.05, 0, 1.2, -0.2, WALNUT),
      ...monitor(-0.6, 1.06, 0.1, Math.PI),
      box(0.3, 0.02, 0.2, 0.7, 1.07, 0.15, INK),
    ]),
  pair_desk: () =>
    merge([
      box(2.9, 0.06, 0.9, 0, 0.72, 0, WOOD),
      box(2.9, 0.4, 0.04, 0, 0.9, 0, '#dfe5e8'),
      ...[-1, 1].map((sx) => box(0.06, 0.7, 0.86, sx * 1.42, 0.35, 0, DARK)),
      ...monitor(-0.7, 0.75, 0.2),
      ...monitor(0.7, 0.75, -0.2, Math.PI),
    ]),

  // ---- seating
  armchair: () =>
    merge([
      bbox(0.9, 0.35, 0.85, 0, 0.3, 0.02, '#c8745a', 0.07),
      bbox(0.9, 0.55, 0.18, 0, 0.7, -0.38, '#b6644c', 0.07),
      bbox(0.16, 0.3, 0.85, -0.45, 0.55, 0.02, '#b6644c', 0.06),
      bbox(0.16, 0.3, 0.85, 0.45, 0.55, 0.02, '#b6644c', 0.06),
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(0.06, 0.12, 0.06, sx * 0.38, 0.06, sz * 0.36, WALNUT))),
    ]),
  bench: () =>
    merge([
      bbox(1.9, 0.08, 0.4, 0, 0.45, 0, WALNUT, 0.03),
      box(0.08, 0.42, 0.34, -0.8, 0.21, 0, DARK),
      box(0.08, 0.42, 0.34, 0.8, 0.21, 0, DARK),
      box(1.9, 0.04, 0.34, 0, 0.12, 0, DARK),
    ]),
  beanbag: () => merge([blob(0.52, 0, 0.32, 0, '#e0a458'), blob(0.4, 0.05, 0.55, -0.15, '#e8b56c')]),
  stool: () => merge([cyl(0.2, 0.2, 0.06, 0, 0.66, 0, CLAY, 16), cyl(0.03, 0.03, 0.64, 0, 0.32, 0, INK, 8), cyl(0.18, 0.18, 0.03, 0, 0.02, 0, INK, 14), cyl(0.12, 0.12, 0.02, 0, 0.3, 0, INK, 12)]),
  loveseat: () =>
    merge([
      bbox(1.4, 0.4, 0.85, 0, 0.2, 0.03, '#5d7fa6', 0.07),
      bbox(1.4, 0.5, 0.18, 0, 0.65, -0.35, '#4f6f95', 0.07),
      bbox(0.16, 0.3, 0.85, -0.7, 0.55, 0.03, '#4f6f95', 0.06),
      bbox(0.16, 0.3, 0.85, 0.7, 0.55, 0.03, '#4f6f95', 0.06),
    ]),
  ottoman: () => merge([bbox(0.46, 0.34, 0.46, 0, 0.2, 0, '#a2474c', 0.07), box(0.5, 0.06, 0.5, 0, 0.4, 0, '#b05a5f')]),

  // ---- tables
  meeting_round: () => merge([cyl(1.0, 1.0, 0.08, 0, 0.72, 0, OAK, 28), cyl(0.1, 0.16, 0.7, 0, 0.35, 0, DARK, 10), cyl(0.5, 0.5, 0.04, 0, 0.02, 0, DARK, 18)]),
  meeting_long: () => merge([bbox(3.9, 0.1, 1.4, 0, 0.72, 0, OAK, 0.04), box(0.12, 0.7, 1.1, -1.7, 0.35, 0, DARK), box(0.12, 0.7, 1.1, 1.7, 0.35, 0, DARK), box(3.2, 0.06, 0.1, 0, 0.5, 0, DARK)]),
  coffee_table: () => merge([bbox(0.9, 0.05, 0.9, 0, 0.42, 0, WALNUT, 0.02), ...legs(0.9, 0.9, 0.4, 0.07, DARK), cyl(0.07, 0.07, 0.01, 0.1, 0.46, 0.1, SKY, 12)]),
  side_table: () => merge([cyl(0.22, 0.22, 0.04, 0, 0.52, 0, WALNUT, 16), cyl(0.03, 0.03, 0.5, 0, 0.25, 0, DARK, 8), cyl(0.15, 0.15, 0.03, 0, 0.02, 0, DARK, 12)]),
  high_table: () => merge([bbox(1.4, 0.06, 0.9, 0, 1.05, 0, OAK, 0.025), ...legs(1.4, 0.9, 1.02, 0.08, STEEL), box(1.2, 0.03, 0.7, 0, 0.3, 0, STEEL)]),
  cafe_table: () => merge([cyl(0.45, 0.45, 0.05, 0, 0.74, 0, CREAM, 22), cyl(0.04, 0.04, 0.72, 0, 0.36, 0, INK, 8), cyl(0.28, 0.28, 0.03, 0, 0.02, 0, INK, 16)]),
  folding_table: () => merge([box(1.9, 0.05, 0.9, 0, 0.74, 0, '#e8e2d4'), ...legs(1.9, 0.9, 0.72, 0.12, STEEL), box(1.6, 0.03, 0.04, 0, 0.3, 0, STEEL)]),

  // ---- decor
  rug_small: () => merge([box(1.95, 0.02, 1.45, 0, 0.01, 0, '#e3c9a8'), box(1.6, 0.025, 1.1, 0, 0.012, 0, '#c8745a')]),
  rug_round: () => merge([cyl(0.98, 0.98, 0.02, 0, 0.01, 0, '#a2c4b8', 28), cyl(0.7, 0.7, 0.025, 0, 0.012, 0, '#f1ebe0', 28), cyl(0.4, 0.4, 0.03, 0, 0.014, 0, '#7c9c92', 24)]),
  lamp_floor: () => merge([cyl(0.18, 0.2, 0.04, 0, 0.02, 0, INK, 14), cyl(0.025, 0.025, 1.4, 0, 0.72, 0, INK, 8), cyl(0.13, 0.22, 0.28, 0, 1.55, 0, '#fff0c8', 14)]),
  lamp_desk: () => merge([cyl(0.14, 0.16, 0.03, 0, 0.015, 0, INK, 12), cyl(0.02, 0.02, 0.32, 0, 0.18, 0, INK, 8), cyl(0.07, 0.14, 0.16, 0, 0.42, 0, '#f2b84b', 12)]),
  wall_art: () => merge([box(0.9, 0.7, 0.05, 0, 1.0, 0, WALNUT), box(0.78, 0.58, 0.02, 0, 1.0, 0.03, '#f1ebe0'), box(0.5, 0.3, 0.02, 0.02, 1.02, 0.045, '#4f7ea3'), blob(0.1, -0.15, 1.08, 0.06, '#e0a458'), box(0.04, 0.7, 0.04, -0.25, 0.35, -0.2, WALNUT), box(0.04, 0.7, 0.04, 0.25, 0.35, -0.2, WALNUT)]),
  clock: () => merge([box(0.44, 1.7, 0.3, 0, 0.85, 0, WALNUT), box(0.34, 0.34, 0.02, 0, 1.38, 0.16, CREAM), box(0.02, 0.12, 0.02, 0, 1.4, 0.18, INK), box(0.1, 0.02, 0.02, 0.03, 1.38, 0.18, INK), box(0.3, 0.55, 0.02, 0, 0.62, 0.16, '#6a4d34')]),
  divider: () => merge([box(1.9, 1.5, 0.06, 0, 0.85, 0, '#cfd9d4'), box(1.94, 0.06, 0.1, 0, 1.62, 0, DARK), box(0.08, 1.6, 0.4, -0.95, 0.8, 0, DARK), box(0.08, 1.6, 0.4, 0.95, 0.8, 0, DARK)]),

  // ---- plants
  plant_small: () => merge([pot(0, 0, 0.16, 0.22), bush(0.17, 0, 0.36, 0, 0), bush(0.12, 0.08, 0.46, 0.03, 1)]),
  plant_large: () => merge([pot(0, 0, 0.3, 0.5), bush(0.42, 0, 1.0, 0, 0), bush(0.32, 0.25, 1.3, 0.1, 1), bush(0.3, -0.22, 1.35, -0.1, 2), bush(0.26, 0.02, 1.7, 0.02, 3)]),
  plant_tree: () => merge([pot(0, 0, 0.42, 0.6), cyl(0.07, 0.1, 1.3, 0, 1.2, 0, '#6a4d34', 8), bush(0.7, 0, 2.0, 0, 0), bush(0.5, 0.4, 1.8, 0.2, 1), bush(0.5, -0.4, 1.9, -0.2, 2)]),
  plant_cactus: () => merge([pot(0, 0, 0.2, 0.26, CLAY), cyl(0.1, 0.1, 0.6, 0, 0.55, 0, '#5f9f6c', 10), cyl(0.05, 0.05, 0.25, 0.15, 0.6, 0, '#5f9f6c', 8), box(0.18, 0.05, 0.05, 0.08, 0.5, 0, '#5f9f6c')]),
  plant_fern: () => merge([pot(0, 0, 0.26, 0.4, OAK), ...[0, 1, 2, 3, 4, 5].map((i) => blob(0.2, Math.cos(i) * 0.22, 0.6 + (i % 2) * 0.1, Math.sin(i) * 0.22, LEAF[i % 4]))]),
  plant_planter: () => merge([box(1.4, 0.4, 0.4, 0, 0.2, 0, WALNUT), ...[-0.5, -0.17, 0.17, 0.5].map((x, i) => bush(0.24, x, 0.52 + (i % 2) * 0.08, 0, i))]),
  plant_hedge: () => merge([box(1.9, 0.3, 0.45, 0, 0.15, 0, WALNUT), ...[-0.75, -0.25, 0.25, 0.75].map((x, i) => bush(0.36, x, 0.62, 0, i)), ...[-0.5, 0, 0.5].map((x, i) => bush(0.3, x, 0.9, 0, i + 1))]),

  // ---- storage
  cabinet: () => merge([box(0.9, 1.2, 0.45, 0, 0.6, 0, '#e2d1b3'), box(0.42, 1.1, 0.02, -0.22, 0.6, 0.235, '#d4c2a2'), box(0.42, 1.1, 0.02, 0.22, 0.6, 0.235, '#d4c2a2'), box(0.04, 0.2, 0.03, -0.03, 0.6, 0.26, INK), box(0.04, 0.2, 0.03, 0.03, 0.6, 0.26, INK)]),
  lockers: () => merge([box(1.9, 1.8, 0.5, 0, 0.9, 0, '#7d8fa3'), ...[-0.72, -0.24, 0.24, 0.72].flatMap((x) => [box(0.4, 1.6, 0.02, x, 0.9, 0.26, '#8ea1b5'), box(0.04, 0.2, 0.03, x + 0.14, 0.9, 0.29, INK)])]),
  filing: () => merge([box(0.5, 1.3, 0.5, 0, 0.65, 0, STEEL), ...[0.2, 0.55, 0.9, 1.15].map((y) => box(0.42, 0.28, 0.02, 0, y, 0.26, '#dfe3ea')), ...[0.2, 0.55, 0.9, 1.15].map((y) => box(0.14, 0.03, 0.03, 0, y + 0.08, 0.28, INK))]),
  shelf_low: () => merge([box(1.9, 0.9, 0.4, 0, 0.45, 0, WALNUT), box(1.8, 0.04, 0.36, 0, 0.45, 0.01, '#6a4d34'), ...[-0.5, 0.1, 0.55].map((x, i) => box(0.3, 0.3, 0.26, x, 0.64, 0.02, ['#b85c4a', '#d9b45a', SKY][i])), box(1.9, 0.04, 0.44, 0, 0.92, 0, '#6a4d34')]),
  wardrobe: () => merge([box(1.4, 2.0, 0.5, 0, 1.0, 0, '#e2d1b3'), box(0.66, 1.9, 0.02, -0.34, 1.0, 0.26, '#d4c2a2'), box(0.66, 1.9, 0.02, 0.34, 1.0, 0.26, '#d4c2a2'), box(0.04, 0.3, 0.03, -0.05, 1.0, 0.285, INK), box(0.04, 0.3, 0.03, 0.05, 1.0, 0.285, INK)]),
  sideboard: () => merge([box(1.9, 0.8, 0.45, 0, 0.45, 0, WALNUT), ...legs(1.9, 0.4, 0.06, 0.08, INK), ...[-0.62, 0, 0.62].map((x) => box(0.58, 0.68, 0.02, x, 0.45, 0.235, '#7a5a3c')), box(1.94, 0.04, 0.5, 0, 0.87, 0, OAK)]),
  cubby: () => merge([box(1.4, 1.1, 0.4, 0, 0.55, 0, OAK), ...[-0.23, 0.23].map((x) => box(0.02, 1.0, 0.36, x, 0.55, 0.03, WALNUT)), ...[0.37, 0.73].map((y) => box(1.3, 0.03, 0.36, 0, y, 0.03, WALNUT)), ...[-0.46, 0, 0.46].map((x, i) => box(0.28, 0.25, 0.25, x, 0.5, 0.04, [SAGE, '#e0a458', SKY][i]))]),

  // ---- the pieces of a team's pod
  ...POD_MODELS,
};
