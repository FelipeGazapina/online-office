// Every simple furniture def as one merged geometry with its colors baked in as vertex colors, so a def costs one draw
// call per story however many of it there are. A model sits on the floor with its origin at the middle of the item's
// footprint and faces +z at rot 0, the way the space module's seats do.
import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry, PlaneGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ITEM_DEFS, STORY_H } from '../../../../shared/space/index.ts';

export const paint = (g: BufferGeometry, color: string | number | [number, number, number]): BufferGeometry => {
  const flat = g.index ? g.toNonIndexed() : g;
  const n = flat.getAttribute('position').count;
  const c = Array.isArray(color) ? new Color(color[0], color[1], color[2]) : new Color(color as string);
  const rgb = Array.isArray(color) ? color : [c.r, c.g, c.b];
  flat.setAttribute('color', new Float32BufferAttribute(Array.from({ length: n }, () => rgb).flat(), 3));
  if (!flat.getAttribute('uv')) flat.setAttribute('uv', new Float32BufferAttribute(new Float32Array(n * 2), 2));
  return flat;
};
const at = (g: BufferGeometry, x: number, y: number, z: number) => g.translate(x, y, z);

export const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string | [number, number, number]) => paint(at(new BoxGeometry(w, h, d), x, y, z), color);
export const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number, color: string, seg = 14) => paint(at(new CylinderGeometry(rt, rb, h, seg), x, y, z), color);
export const blob = (r: number, x: number, y: number, z: number, color: string) => paint(at(new IcosahedronGeometry(r, 0), x, y, z), color);
export const merge = (parts: BufferGeometry[]) => {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('A furniture model failed to merge');
  g.computeBoundingSphere();
  return g;
};

const WOOD = '#efe0c6';
const DARK = '#3a3f4e';
const PANEL = '#e2d1b3';
// White parts take the instance color, so a team's chairs come out in the team's color.
const TINT: [number, number, number] = [1, 1, 1];

function desk(po: boolean) {
  const parts = [
    box(1.46, 0.06, 0.94, 0, 0.72, 0, WOOD),
    box(1.3, 0.4, 0.03, 0, 0.5, 0.4, PANEL),
    box(0.5, 0.025, 0.16, 0, 0.755, -0.12, '#2b2e38'),
    cyl(0.05, 0.045, 0.1, 0.58, 0.8, -0.12, '#fbf6ec', 12),
    box(0.06, 0.1, 0.06, 0, 0.86, 0.2, '#2b2e38'),
    box(0.72, 0.44, 0.04, 0, 1.1, 0.2, '#1c1f27'),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(0.06, 0.7, 0.06, sx * 0.67, 0.35, sz * 0.42, DARK))),
  ];
  parts.push(
    box(0.3, 0.02, 0.1, 0.34, 0.76, -0.3, '#fbf6ec'),
    box(0.3, 0.021, 0.025, 0.34, 0.765, -0.3, po ? '#d97757' : '#3a3f4e'),
    box(0.16, 0.025, 0.2, 0.58, 0.76, -0.02, '#f4f0e6'),
    cyl(0.07, 0.09, 0.02, -0.62, 0.77, 0.3, '#2b2e38', 10),
    box(0.02, 0.24, 0.02, -0.62, 0.9, 0.3, '#2b2e38'),
    box(0.14, 0.05, 0.1, -0.62, 1.03, 0.27, '#f2b84b'),
  );
  if (po) parts.push(box(0.32, 0.02, 0.12, -0.5, 0.76, -0.22, '#d97757'));
  // Desk life: a mug with a handle and coffee, a mouse on a pad, loose papers, sticky notes, a cable run and a small plant.
  parts.push(
    cyl(0.04, 0.04, 0.012, 0.58, 0.855, -0.12, '#4a2f20', 10),
    box(0.03, 0.05, 0.015, 0.63, 0.82, -0.12, '#fbf6ec'),
    box(0.2, 0.006, 0.18, 0.36, 0.76, -0.12, '#2b2e38'),
    box(0.055, 0.025, 0.09, 0.36, 0.775, -0.12, '#e8e6e0'),
    box(0.22, 0.012, 0.3, -0.42, 0.77, -0.2, '#f7f4ec'),
    box(0.2, 0.012, 0.28, -0.4, 0.782, -0.16, '#e3ecf5'),
    box(0.07, 0.07, 0.006, -0.3, 1.22, 0.172, '#f7d94c'),
    box(0.06, 0.06, 0.006, -0.22, 1.16, 0.172, '#f29bb5'),
    box(0.02, 0.02, 0.42, 0.1, 0.74, 0.42, '#1c1f27'),
    box(0.02, 0.62, 0.02, 0.1, 0.4, 0.62, '#1c1f27'),
    cyl(0.05, 0.04, 0.07, -0.58, 0.8, 0.0, '#c9a77c', 8),
    blob(0.07, -0.58, 0.88, 0.0, '#5f9f6c'),
  );
  return merge(parts);
}

export function chairModel(): BufferGeometry {
  return merge([
    cyl(0.26, 0.26, 0.04, 0, 0.02, 0, '#2b2e38', 16),
    cyl(0.04, 0.04, 0.32, 0, 0.2, 0, '#2b2e38', 8),
    box(0.5, 0.09, 0.5, 0, 0.38, 0, TINT),
    box(0.5, 0.56, 0.07, 0, 0.72, -0.25, TINT),
  ]);
}

const LEAVES = ['#5f9f6c', '#78b97a', '#4d8a5d', '#8ccb84'];
// A potted plant about 1.1 m tall: a short pot and a loose crown of smooth leaf masses, not a few big spiky stones.
export const leafMass = (r: number, x: number, y: number, z: number, color: string) => paint(at(new IcosahedronGeometry(r, 1), x, y, z), color);
function plant() {
  const leaves: [number, number, number, number][] = [
    [0, 0.62, 0, 0.24],
    [0.14, 0.78, 0.07, 0.18],
    [-0.13, 0.82, -0.05, 0.19],
    [0.03, 0.98, -0.02, 0.16],
    [-0.07, 0.56, 0.13, 0.15],
    [0.12, 0.58, -0.1, 0.14],
  ];
  return merge([cyl(0.2, 0.15, 0.36, 0, 0.18, 0, '#f1ebe0'), cyl(0.21, 0.21, 0.03, 0, 0.37, 0, '#4a3a2b'), ...leaves.map(([x, y, z, r], i) => leafMass(r, x, y, z, LEAVES[i % LEAVES.length]))]);
}

function stairs(): BufferGeometry {
  // Sixteen steps from the foot of the run, half a tile before the base tile's middle, up to a full story at its top.
  const steps = 16;
  const run = 3.5;
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const top = ((i + 0.5) / steps) * STORY_H;
    const z = -2 + (i + 0.5) * (run / steps);
    parts.push(box(0.96, top, run / steps, 0, top / 2, z, i % 2 ? '#d8c4aa' : '#cdb99d'));
  }
  for (const sx of [-1, 1]) parts.push(box(0.04, 0.9, run, sx * 0.5, 0.45, -0.25, '#c9cdd8'));
  const g = merge(parts);
  return g;
}

function build(def: string): BufferGeometry {
  switch (def) {
    case 'bench_desk':
      return desk(false);
    case 'po_desk':
      return desk(true);
    case 'chair':
      return chairModel();
    case 'plant':
      return plant();
    case 'stairs':
      return stairs();
    case 'sofa':
      return merge([
        box(1.9, 0.4, 0.9, 0, 0.2, 0.05, '#7c9c92'),
        box(1.9, 0.5, 0.2, 0, 0.65, -0.4, '#6d8d83'),
        box(0.2, 0.3, 0.9, -0.95, 0.55, 0.05, '#6d8d83'),
        box(0.2, 0.3, 0.9, 0.95, 0.55, 0.05, '#6d8d83'),
      ]);
    case 'coffee_machine':
      return merge([box(0.4, 0.6, 0.35, 0, 0.3, 0, '#444a55'), box(0.3, 0.08, 0.3, 0, 0.64, 0, '#d95d63')]);
    case 'meeting_table':
      return merge([
        box(2.9, 0.1, 1.4, 0, 0.7, 0, '#d8b47d'),
        ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(0.08, 0.66, 0.08, sx * 1.35, 0.33, sz * 0.62, DARK))),
      ]);
    case 'rug':
      return merge([box(2.95, 0.02, 1.95, 0, 0.01, 0, '#cbd7e0')]);
    case 'bookshelf':
      return merge([
        box(2, 2, 0.45, 0, 1, 0, '#8c6a4a'),
        ...[0.35, 0.8, 1.25, 1.7].map((y) => box(1.9, 0.04, 0.4, 0, y, 0.03, '#6a4d34')),
        ...[0.55, 1.0, 1.45].map((y, i) => box(1.7 - i * 0.2, 0.3, 0.3, 0, y, 0.04, ['#b85c4a', '#4f7ea3', '#d9b45a'][i])),
      ]);
    case 'rail':
      return merge([box(1, 0.9, 0.04, 0, 0.45, 0, '#c9cdd8')]);
    default: {
      const d = ITEM_DEFS[def];
      return merge([box(d.w / 2 - 0.04, d.height, d.d / 2 - 0.04, 0, d.height / 2, 0, '#b8b2a7')]);
    }
  }
}

const cache = new Map<string, BufferGeometry>();
export function modelOf(def: string): BufferGeometry {
  let g = cache.get(def);
  if (!g) cache.set(def, (g = build(def)));
  return g;
}

/** Defs that carry their own behavior or texture and are drawn one by one by React, not instanced. */
export const DYNAMIC: ReadonlySet<string> = new Set(['owner_desk', 'board_terminal', 'whiteboard', 'team_sign']);

/** Instance color of a def when its item has no tint. */
export const DEFAULT_TINT: Readonly<Record<string, number>> = { chair: 0x5c7892 };

export const screenGeometry = (): BufferGeometry => {
  const g = new PlaneGeometry(0.64, 0.36);
  g.rotateY(Math.PI);
  g.translate(0, 1.1, 0.2 - 0.022);
  return g;
};
