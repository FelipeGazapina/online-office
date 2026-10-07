import type { ItemDef, ItemLayer, Placement, Rot, Surface } from './types.ts';
import { groupDef, VIGNETTES } from './vignettes.ts';

// How many computers a desk can wear (`setups.ts`). Kept here so the catalog does not import the module that imports it.
const SETUP_COUNT = 8;

export const FLOOR_PAINTS: readonly { name: string; color: string }[] = [
  { name: 'none', color: '#000000' },
  { name: 'wood_light', color: '#d9b98a' },
  { name: 'wood_dark', color: '#7a5233' },
  { name: 'concrete', color: '#a9acb0' },
  { name: 'carpet_blue', color: '#5d7fa6' },
  { name: 'carpet_gray', color: '#8a8f98' },
  { name: 'carpet_red', color: '#a2474c' },
  { name: 'tile_white', color: '#e8e8e4' },
  { name: 'tile_dark', color: '#3b3f46' },
];
export const PAINT = {
  none: 0,
  woodLight: 1,
  woodDark: 2,
  concrete: 3,
  carpetBlue: 4,
  carpetGray: 5,
  carpetRed: 6,
  tileWhite: 7,
  tileDark: 8,
} as const;

export const WALL_STYLES: readonly { name: string; color: string }[] = [
  { name: 'plaster', color: '#d8c4aa' },
  { name: 'brick', color: '#a65b45' },
  { name: 'white', color: '#f1efe9' },
  { name: 'wood_panel', color: '#8c6a4a' },
  { name: 'concrete', color: '#9aa0a6' },
  { name: 'terracotta', color: '#b8694a' },
  { name: 'walnut', color: '#7d553a' },
];

const desk = (id: string, kind: 'bench_desk' | 'po_desk' | 'owner_desk'): ItemDef => ({
  id,
  kind,
  w: 3,
  d: 2,
  height: 0.75,
  walkable: false,
  setups: kind === 'owner_desk' ? undefined : SETUP_COUNT,
  seat: { chair: { x: 1.5, z: -0.8 }, exit: { x: 1.5, z: -3 }, yaw: 0 },
});

const defs: ItemDef[] = [
  desk('bench_desk', 'bench_desk'),
  desk('po_desk', 'po_desk'),
  desk('owner_desk', 'owner_desk'),
  { id: 'board_terminal', kind: 'terminal', w: 2, d: 1, height: 1.1, walkable: false },
  { id: 'whiteboard', kind: 'board', w: 9, d: 1, height: 1.9, walkable: false },
  { id: 'team_sign', kind: 'decor', w: 2, d: 1, height: 1.2, walkable: false },
  { id: 'plant', kind: 'decor', w: 1, d: 1, height: 1.1, walkable: false },
  { id: 'sofa', kind: 'seat', w: 4, d: 2, height: 0.85, walkable: false },
  { id: 'coffee_machine', kind: 'decor', w: 1, d: 1, height: 0.68, walkable: false },
  { id: 'meeting_table', kind: 'table', w: 6, d: 3, height: 0.75, walkable: false },
  { id: 'chair', kind: 'seat', w: 1, d: 1, height: 0.9, walkable: false },
  { id: 'rug', kind: 'decor', w: 6, d: 4, height: 0.02, walkable: true, layer: 'floor' },
  { id: 'bookshelf', kind: 'decor', w: 4, d: 1, height: 2.0, walkable: false },
  { id: 'stairs', kind: 'stairs', w: 2, d: 8, height: 3.2, walkable: false, stairs: { rise: 1, holeLen: 3 } },
];

// The rest of the build catalog, in half-meter cells. These are furnishings: nobody sits at them, and only the rugs can be walked over.
const piece = (id: string, kind: ItemDef['kind'], w: number, d: number, height: number, walkable = false): ItemDef => ({ id, kind, w, d, height, walkable, ...(walkable && { layer: 'floor' as const }) });

const more: ItemDef[] = [
  // desks
  piece('standing_desk', 'table', 3, 2, 1.1),
  piece('l_desk', 'table', 4, 4, 0.75),
  piece('corner_desk', 'table', 4, 4, 0.75),
  piece('meeting_pod', 'table', 6, 6, 1.5),
  piece('reception_desk', 'table', 6, 2, 1.25),
  piece('pair_desk', 'table', 6, 2, 1.1),
  // seating
  piece('armchair', 'seat', 2, 2, 0.95),
  piece('bench', 'seat', 4, 1, 0.5),
  piece('beanbag', 'seat', 2, 2, 0.7),
  piece('stool', 'seat', 1, 1, 0.7),
  piece('loveseat', 'seat', 3, 2, 0.85),
  piece('ottoman', 'seat', 1, 1, 0.45),
  // tables
  piece('meeting_round', 'table', 4, 4, 0.8),
  piece('meeting_long', 'table', 8, 3, 0.8),
  piece('coffee_table', 'table', 2, 2, 0.45),
  piece('side_table', 'table', 1, 1, 0.55),
  piece('high_table', 'table', 3, 2, 1.1),
  piece('cafe_table', 'table', 2, 2, 0.8),
  piece('folding_table', 'table', 4, 2, 0.8),
  // decor
  piece('rug_small', 'decor', 4, 3, 0.03, true),
  piece('rug_round', 'decor', 4, 4, 0.03, true),
  piece('lamp_floor', 'decor', 1, 1, 1.7),
  piece('lamp_desk', 'decor', 1, 1, 0.42),
  piece('wall_art', 'decor', 2, 1, 1.4),
  piece('clock', 'decor', 1, 1, 1.75),
  piece('divider', 'decor', 4, 1, 1.65),
  // plants
  piece('plant_small', 'decor', 1, 1, 0.42),
  piece('plant_large', 'decor', 1, 1, 1.9),
  piece('plant_tree', 'decor', 2, 2, 2.5),
  piece('plant_cactus', 'decor', 1, 1, 0.42),
  piece('plant_fern', 'decor', 1, 1, 0.85),
  piece('plant_planter', 'decor', 3, 1, 0.8),
  piece('plant_hedge', 'decor', 4, 1, 1.15),
  // storage
  piece('cabinet', 'decor', 2, 1, 1.2),
  piece('lockers', 'decor', 4, 1, 1.8),
  piece('filing', 'decor', 1, 1, 1.3),
  piece('shelf_low', 'decor', 4, 1, 0.95),
  piece('wardrobe', 'decor', 3, 1, 2.0),
  piece('sideboard', 'decor', 4, 1, 0.9),
  piece('cubby', 'decor', 3, 1, 1.1),
];

// Small things for the top of a desk, a table, a counter or a shelf. On the floor they have a nominal one cell footprint, which only
// the ghost shows when the pointer is not over a surface. Their real footprint is `top`, in TOP_UNITs (12.5 cm). `looks` is how many
// colours or styles the model has (none changes the footprint or the height), `stackable` says other small things may rest on it.
const small = (id: string, w: number, d: number, height: number, extra: Pick<ItemDef, 'looks' | 'stackable'> = {}): ItemDef => ({ id, kind: 'decor', w: 1, d: 1, height, walkable: false, placement: 'surface', top: { w, d }, ...extra });
const flat = { stackable: true } as const;

const tabletop: ItemDef[] = [
  small('laptop', 3, 2, 0.28),
  small('books', 3, 2, 0.1, { looks: 3, ...flat }),
  small('papers', 3, 2, 0.04, { looks: 2, ...flat }),
  small('mug', 1, 1, 0.09, { looks: 5 }),
  small('picture_frame', 2, 1, 0.25),
  small('vase', 2, 2, 0.34),
  small('pen_cup', 1, 1, 0.16, { looks: 3 }),
  small('desk_clock', 2, 1, 0.15),
  small('trophy', 2, 2, 0.22, { looks: 2 }),
  small('notebook', 3, 2, 0.03, { looks: 4, ...flat }),
  small('folder', 3, 2, 0.03, { looks: 4, ...flat }),
  small('magazine', 2, 3, 0.012, { looks: 4, ...flat }),
  small('coaster', 1, 1, 0.012, { looks: 3, ...flat }),
  small('lunchbox', 3, 2, 0.08, { looks: 3, ...flat }),
  small('books_row', 3, 2, 0.26, { looks: 3 }),
  small('sticky_notes', 1, 1, 0.03, { looks: 4 }),
  small('headphones', 2, 2, 0.1, { looks: 3 }),
  small('water_bottle', 1, 1, 0.23, { looks: 4 }),
  small('tumbler', 1, 1, 0.17, { looks: 4 }),
  small('takeaway_cup', 1, 1, 0.14, { looks: 3 }),
  small('desk_organizer', 3, 2, 0.13, { looks: 3 }),
  small('frame_small', 1, 1, 0.14, { looks: 4 }),
  small('succulent', 2, 2, 0.16, { looks: 4 }),
  small('succulent_trio', 3, 1, 0.11, { looks: 2 }),
  small('cable_tray', 3, 1, 0.07, { looks: 2 }),
  small('snack_bowl', 2, 2, 0.09, { looks: 3 }),
  small('calculator', 1, 2, 0.025, { looks: 2 }),
  small('phone_stand', 1, 1, 0.14, { looks: 2 }),
  small('tablet', 2, 1, 0.15, { looks: 2 }),
  small('candle', 1, 1, 0.09, { looks: 4 }),
  small('cat_statue', 1, 1, 0.15, { looks: 2 }),
  small('letter_tray', 3, 2, 0.1, { looks: 2 }),
  small('glasses', 2, 1, 0.02, { looks: 3 }),
  small('stapler', 2, 1, 0.05, { looks: 3 }),
  small('speaker', 1, 1, 0.12, { looks: 3 }),
  small('tray', 4, 3, 0.03, { looks: 3, ...flat }),
  small('runner', 8, 2, 0.012, { looks: 4, ...flat }),
];

// Set pieces: a vignette is one def to the catalog and a handful of the small things above once it is down.
const vignettes: ItemDef[] = VIGNETTES.map((v) => groupDef(v, (id) => tabletop.find((d) => d.id === id)!));

// What a project block brings besides its desks, board, terminal and sign. The kit places these around the block's middle
// (kit.ts shellItems); each is an ordinary item, so the owner can pick, move and delete it alone. The floor ones lie under
// everything else: the rug, the low boundary around it, the glass rail at its front.
const pod: ItemDef[] = [
  piece('pod_rug', 'decor', 18, 14, 0.03, true),
  piece('pod_rail_back', 'decor', 20, 1, 0.56, true),
  piece('pod_rail_side', 'decor', 14, 1, 0.56, true),
  piece('pod_glass_rail', 'decor', 6, 1, 0.78, true),
  piece('pod_slat_wall', 'decor', 13, 2, 2.84),
  piece('pod_credenza', 'decor', 2, 6, 0.76),
  piece('pod_printer', 'decor', 1, 1, 1.0),
  piece('pod_cooler', 'decor', 1, 1, 1.35),
  piece('pod_bin', 'decor', 1, 1, 0.34),
  piece('pod_shelf', 'decor', 1, 5, 1.65),
  piece('pod_boxes', 'decor', 1, 1, 0.65),
  piece('pod_pouf', 'seat', 2, 2, 0.4),
  piece('pod_huddle_table', 'table', 3, 3, 0.73),
  piece('pod_daily_sign', 'decor', 3, 1, 1.37),
];

// The tops of furniture, in TOP_UNITs from the footprint's corner in its unturned frame. `blocked` is what a def's model already
// carries on its top: the monitor, the keyboard and the mouse of a desk. A rect inside the footprint keeps a thing off the
// rim of a round or rounded top.
const bench: Surface = { height: 0.72, rect: { u0: 0, v0: 0, u1: 12, v1: 8 }, blocked: [{ u0: 4, v0: 1, u1: 10, v1: 4 }, { u0: 3, v0: 5, u1: 9, v1: 6 }] };
const SURFACES: Readonly<Record<string, Surface>> = {
  bench_desk: bench,
  po_desk: { ...bench, blocked: [...bench.blocked!, { u0: 0, v0: 1, u1: 4, v1: 3 }] },
  standing_desk: { height: 1.1, rect: { u0: 0, v0: 0, u1: 12, v1: 8 }, blocked: [{ u0: 3, v0: 5, u1: 9, v1: 6 }, { u0: 4, v0: 1, u1: 8, v1: 3 }] },
  meeting_table: { height: 0.75, rect: { u0: 1, v0: 1, u1: 23, v1: 11 } },
  meeting_round: { height: 0.76, rect: { u0: 3, v0: 3, u1: 13, v1: 13 }, round: true },
  meeting_long: { height: 0.77, rect: { u0: 1, v0: 1, u1: 31, v1: 11 } },
  coffee_table: { height: 0.445, rect: { u0: 1, v0: 1, u1: 7, v1: 7 } },
  side_table: { height: 0.54, rect: { u0: 1, v0: 1, u1: 3, v1: 3 }, round: true },
  high_table: { height: 1.08, rect: { u0: 1, v0: 1, u1: 11, v1: 7 } },
  cafe_table: { height: 0.765, rect: { u0: 2, v0: 2, u1: 6, v1: 6 }, round: true },
  folding_table: { height: 0.765, rect: { u0: 1, v0: 1, u1: 15, v1: 7 } },
  pod_huddle_table: { height: 0.725, rect: { u0: 2, v0: 0, u1: 10, v1: 8 }, round: true },
  pod_credenza: { height: 0.76, rect: { u0: 0, v0: 1, u1: 6, v1: 20 } },
  shelf_low: { height: 0.94, rect: { u0: 1, v0: 0, u1: 15, v1: 4 } },
  sideboard: { height: 0.89, rect: { u0: 1, v0: 0, u1: 15, v1: 4 } },
  cabinet: { height: 1.2, rect: { u0: 1, v0: 0, u1: 7, v1: 4 } },
  cubby: { height: 1.1, rect: { u0: 1, v0: 0, u1: 11, v1: 3 } },
  filing: { height: 1.3, rect: { u0: 0, v0: 0, u1: 4, v1: 4 } },
  bookshelf: { height: 2.0, rect: { u0: 1, v0: 0, u1: 15, v1: 3 } },
};
// Existing floor defs that are small enough to stand on a surface too.
const ALSO_ON_TOP: Readonly<Record<string, { placement: Placement; top: { w: number; d: number } }>> = {
  lamp_desk: { placement: 'both', top: { w: 3, d: 3 } },
  plant_small: { placement: 'both', top: { w: 3, d: 3 } },
  plant_cactus: { placement: 'both', top: { w: 4, d: 4 } },
  coffee_machine: { placement: 'both', top: { w: 4, d: 3 } },
};

const withTops = (d: ItemDef): ItemDef => ({ ...d, ...(SURFACES[d.id] && { surface: SURFACES[d.id] }), ...ALSO_ON_TOP[d.id] });

export const ITEM_DEFS: Readonly<Record<string, ItemDef>> = Object.freeze(Object.fromEntries([...defs, ...more, ...tabletop, ...vignettes, ...pod].map((d) => [d.id, withTops(d)])));

export const layerOf = (def: ItemDef): ItemLayer => def.layer ?? 'object';
export const placementOf = (def: ItemDef): Placement => def.placement ?? 'floor';

export const YAW: readonly number[] = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

/** Footprint in cells after rotation. */
export function footprint(def: ItemDef, rot: Rot): { w: number; d: number } {
  return rot % 2 === 0 ? { w: def.w, d: def.d } : { w: def.d, d: def.w };
}

/** A rot-0 local point (cells from the min corner) turned into the rotated footprint's frame. */
export function rotateLocal(def: ItemDef, rot: Rot, p: { x: number; z: number }): { x: number; z: number } {
  switch (rot) {
    case 0:
      return { x: p.x, z: p.z };
    case 1:
      return { x: def.d - p.z, z: p.x };
    case 2:
      return { x: def.w - p.x, z: def.d - p.z };
    case 3:
      return { x: p.z, z: def.w - p.x };
  }
}

export const PAINT_COUNT = FLOOR_PAINTS.length;
