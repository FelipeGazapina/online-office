import type { ItemDef, Rot } from './types.ts';

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
  { id: 'coffee_machine', kind: 'decor', w: 1, d: 1, height: 1.0, walkable: false },
  { id: 'meeting_table', kind: 'table', w: 6, d: 3, height: 0.75, walkable: false },
  { id: 'chair', kind: 'seat', w: 1, d: 1, height: 0.9, walkable: false },
  { id: 'rug', kind: 'decor', w: 6, d: 4, height: 0.02, walkable: true },
  { id: 'bookshelf', kind: 'decor', w: 4, d: 1, height: 2.0, walkable: false },
  { id: 'stairs', kind: 'stairs', w: 2, d: 8, height: 3.2, walkable: false, stairs: { rise: 1, holeLen: 3 } },
];

// The rest of the build catalog, in half-meter cells. These are furnishings: nobody sits at them, and only the rugs can be walked over.
const piece = (id: string, kind: ItemDef['kind'], w: number, d: number, height: number, walkable = false): ItemDef => ({ id, kind, w, d, height, walkable });

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
  piece('lamp_desk', 'decor', 1, 1, 0.5),
  piece('wall_art', 'decor', 2, 1, 1.4),
  piece('clock', 'decor', 1, 1, 1.75),
  piece('divider', 'decor', 4, 1, 1.65),
  // plants
  piece('plant_small', 'decor', 1, 1, 0.55),
  piece('plant_large', 'decor', 1, 1, 1.9),
  piece('plant_tree', 'decor', 2, 2, 2.5),
  piece('plant_cactus', 'decor', 1, 1, 0.85),
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

export const ITEM_DEFS: Readonly<Record<string, ItemDef>> = Object.freeze(Object.fromEntries([...defs, ...more].map((d) => [d.id, d])));

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
