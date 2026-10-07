// Every simple furniture def as one merged geometry with its colors baked in as vertex colors, so a def costs one draw
// call per story however many of it there are. A model sits on the floor with its origin at the middle of the item's
// footprint and faces +z at rot 0, the way the space module's seats do.
import { BufferGeometry, IcosahedronGeometry, PlaneGeometry } from 'three';
import { ITEM_DEFS, STORY_H } from '../../../../shared/space/index.ts';
import type { PropName } from '../props.ts';
import { FURNITURE } from './furniture.ts';
import { POD_DYNAMIC } from './pod.ts';
import { TABLETOP_MODELS } from './tabletop.ts';
import { computerOf, screensOf } from './computer.ts';
import { at, bbox, blob, box, cyl, merge, paint } from './parts.ts';

export { blob, box, cyl, merge, paint, screensOf };

const WOOD = '#efe0c6';
const DARK = '#3a3f4e';
const PANEL = '#e2d1b3';
// White parts take the instance color, so a team's chairs come out in the team's color.
const TINT: [number, number, number] = [1, 1, 1];

// With `body` false only what sits on the desk is built: the textured desk prop supplies the top, legs and drawers, and what is left is the
// computer in one of its setups (`computer.ts`). The rest of a desk's clutter, the mug, lamp, plant and papers, are small items the owner
// places: `ITEM_DEFS.bench_desk.surface.blocked` is exactly the computer.
function desk(po: boolean, body = true, setup = 0) {
  const computer = computerOf(po, setup);
  if (!body) return computer;
  const parts = [bbox(1.46, 0.06, 0.94, 0, 0.72, 0, WOOD, 0.025), bbox(1.3, 0.4, 0.03, 0, 0.5, 0.4, PANEL, 0.01), ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(0.06, 0.7, 0.06, sx * 0.67, 0.35, sz * 0.42, DARK)))];
  return merge([...parts, computer]);
}

export function chairModel(): BufferGeometry {
  return merge([
    cyl(0.28, 0.28, 0.035, 0, 0.02, 0, '#2b2e38', 20),
    cyl(0.035, 0.05, 0.3, 0, 0.19, 0, '#2b2e38', 10),
    cyl(0.1, 0.1, 0.05, 0, 0.34, 0, '#3a3f4e', 12),
    bbox(0.5, 0.1, 0.5, 0, 0.4, 0, TINT, 0.045),
    bbox(0.46, 0.5, 0.09, 0, 0.75, -0.25, TINT, 0.045),
    bbox(0.34, 0.06, 0.05, 0, 0.5, -0.2, '#3a3f4e', 0.02),
    ...[-1, 1].flatMap((sx) => [bbox(0.05, 0.04, 0.34, sx * 0.29, 0.58, -0.04, '#2b2e38', 0.015), box(0.03, 0.18, 0.03, sx * 0.29, 0.49, -0.04, '#2b2e38')]),
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

function build(def: string, look: number): BufferGeometry {
  const small = TABLETOP_MODELS[def];
  if (small) return small(look);
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
        bbox(1.9, 0.4, 0.9, 0, 0.2, 0.05, '#7c9c92', 0.07),
        bbox(1.9, 0.5, 0.2, 0, 0.65, -0.4, '#6d8d83', 0.08),
        bbox(0.2, 0.3, 0.9, -0.95, 0.55, 0.05, '#6d8d83', 0.08),
        bbox(0.2, 0.3, 0.9, 0.95, 0.55, 0.05, '#6d8d83', 0.08),
        bbox(1.55, 0.12, 0.7, 0, 0.46, 0.1, '#86a89d', 0.05),
      ]);
    case 'coffee_machine':
      return merge([box(0.4, 0.6, 0.35, 0, 0.3, 0, '#444a55'), box(0.3, 0.08, 0.3, 0, 0.64, 0, '#d95d63')]);
    case 'meeting_table':
      return merge([
        bbox(2.9, 0.1, 1.4, 0, 0.7, 0, '#d8b47d', 0.04),
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
      const made = FURNITURE[def];
      if (made) return made();
      const d = ITEM_DEFS[def];
      return merge([box(d.w / 2 - 0.04, d.height, d.d / 2 - 0.04, 0, d.height / 2, 0, '#b8b2a7')]);
    }
  }
}

/** Defs drawn from a baked prop model; a def whose entry has `onTop` keeps its procedural desk-top clutter on top of the model. */
export const PROP_DEFS: Readonly<Record<string, { prop: PropName; onTop?: (def: string, setup: number) => BufferGeometry }>> = {
  sofa: { prop: 'sofa' },
  armchair: { prop: 'armchair' },
  bookshelf: { prop: 'bookshelf' },
  plant: { prop: 'plant_ficus' },
  plant_large: { prop: 'plant_tall' },
  plant_fern: { prop: 'plant_syngonium' },
  plant_small: { prop: 'plant_succulent' },
  plant_cactus: { prop: 'plant_succulent' },
  lamp_desk: { prop: 'desk_lamp' },
  laptop: { prop: 'laptop' },
  picture_frame: { prop: 'picture_frame' },
  vase: { prop: 'vase' },
  desk_clock: { prop: 'desk_clock' },
  bench_desk: { prop: 'desk', onTop: (_, setup) => desk(false, false, setup) },
  po_desk: { prop: 'desk', onTop: (_, setup) => desk(true, false, setup) },
};
const onTopCache = new Map<string, BufferGeometry>();
export const onTopOf = (def: string, setup = 0): BufferGeometry | undefined => {
  const make = PROP_DEFS[def]?.onTop;
  if (!make) return undefined;
  const key = `${def}#${setup}`;
  let g = onTopCache.get(key);
  if (!g) onTopCache.set(key, (g = make(def, setup)));
  return g;
};

const cache = new Map<string, BufferGeometry>();
/** The model of a def in one of its looks (a colour or a style: same footprint and height). Look 0 is the def's first. */
export function modelOf(def: string, look = 0): BufferGeometry {
  const key = look ? `${def}#${look}` : def;
  let g = cache.get(key);
  if (!g) cache.set(key, (g = build(def, look)));
  return g;
}

/** Defs that carry their own behavior or texture and are drawn one by one by React, not instanced. */
export const DYNAMIC: ReadonlySet<string> = new Set(['owner_desk', 'board_terminal', 'whiteboard', 'team_sign', ...POD_DYNAMIC]);

/** Instance color of a def when its item has no tint. */
export const DEFAULT_TINT: Readonly<Record<string, number>> = { chair: 0x5c7892 };
