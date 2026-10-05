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
export const ITEM_DEFS: Readonly<Record<string, ItemDef>> = Object.freeze(Object.fromEntries(defs.map((d) => [d.id, d])));

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
