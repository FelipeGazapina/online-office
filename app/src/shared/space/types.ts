// Units: meters, +x east, +z south. Floor coordinates are absolute integer TILES (1 m). Items sit on absolute integer
// CELLS (half tiles, 0.5 m). Nothing in this folder imports React, three, or electron.

export const TILE = 1;
export const CELL = 0.5;
export const NAV_CELL = 0.25;
export const STORY_H = 3.2;
export const MAX_LOT = 64;
export const MAX_STORIES = 4;
export const NAV_CLEARANCE = 0.35;
export const WALL_HALF = 0.08;

export type BlockId = string;
export type EmployeeId = string;
export type ItemId = string & { readonly __item: true };
export type Rot = 0 | 1 | 2 | 3;
export type PaintId = number;
export type Vec2 = { x: number; z: number };

export type Lot = { x0: number; z0: number; w: number; h: number };

export type WallDir = 'e' | 's' | 'sd' | 'nd';
export type WallRef = { x: number; z: number; d: WallDir };
export type WallSeg = WallRef & { style: number; open?: 'door' | 'window' | 'arch' };

export type Story = {
  rev: number;
  paint: Uint8Array;
  halfB: Readonly<Record<number, PaintId>>;
  walls: readonly WallSeg[];
  items: readonly Item[];
};
/**
 * `shelled` says how far the pod migration got: 1 once every project block's own pieces (rug, pod boundary, decor, huddle) exist
 * as items, 2 once they also stand with the block's desks. A building below 2 is migrated on load, once.
 */
/** `bare` drops the stock reception, kitchen, lounge, lobby and rug the scene draws on every lot, for an office the owner builds from nothing. */
export type Building = { v: 1; lot: Lot; stories: readonly Story[]; shelled?: 1 | 2; bare?: true };

export type Item = {
  id: ItemId;
  def: string;
  x: number;
  z: number;
  rot: Rot;
  blockId?: BlockId;
  tint?: number;
};

/** A floor item lies on the ground: people walk over it, objects stand on it, and two floor items never overlap. Everything else is an object. */
export type ItemLayer = 'floor' | 'object';
export type ItemKind = 'bench_desk' | 'po_desk' | 'owner_desk' | 'decor' | 'table' | 'seat' | 'board' | 'terminal' | 'stairs';
export type ItemDef = {
  id: string;
  kind: ItemKind;
  w: number;
  d: number;
  height: number;
  walkable: boolean;
  layer?: ItemLayer;
  seat?: { chair: Vec2; exit: Vec2; yaw: number };
  stairs?: { rise: 1; holeLen: number };
};

export type FloorCell = { x: number; z: number; half: 0 | 1; paint: PaintId };
export type BuildOp =
  | { t: 'lot'; lot: Lot }
  | { t: 'stories'; count: number }
  | { t: 'walls'; story: number; put: readonly WallSeg[]; del: readonly WallRef[] }
  | { t: 'floor'; story: number; cells: readonly FloorCell[] }
  | { t: 'items'; story: number; put: readonly Item[]; del: readonly ItemId[] }
  | { t: 'bare'; on: boolean };

export type ViolationKind =
  | 'out_of_lot'
  | 'no_floor'
  | 'overlap'
  | 'wall_through_item'
  | 'on_hole'
  | 'floor_unsupported'
  | 'stairs_no_upper_story'
  | 'stairs_no_landing'
  | 'stairs_misaligned'
  | 'story_unreachable'
  | 'would_strand_desks'
  | 'story_not_empty'
  | 'bad_opening'
  | 'bad_diagonal_half'
  | 'bad_paint'
  | 'unknown_item'
  | 'desk_wrong_block'
  | 'desk_wrong_kind'
  | 'desk_double_occupied'
  | 'desk_unreachable';
export type Violation = { kind: ViolationKind; story: number; at?: Vec2; ids?: ItemId[] };

export type SpaceContext = {
  blocks: ReadonlySet<BlockId>;
  employees: ReadonlyMap<EmployeeId, { blockId: BlockId; orchestrator: boolean }>;
  seats: ReadonlyMap<EmployeeId, ItemId>;
};

export type Applied =
  | { ok: true; building: Building; forward: readonly BuildOp[]; inverse: readonly BuildOp[] }
  | { ok: false; violations: readonly Violation[] };

export type Room = { id: number; story: number; area: number; bbox: Lot; doors: readonly WallRef[]; items: readonly ItemId[] };

export type FloorRender = {
  floor: { position: Float32Array; index: Uint32Array; paint: Uint8Array };
  walls: Readonly<Record<'solid' | 'door' | 'window' | 'arch', Float32Array>>;
  /** Per variant, two floats per segment: the unit normal pointing to the side with less floor, which an outside camera sees. Zero for a wall with floor on both sides or on neither. */
  wallNormals: Readonly<Record<'solid' | 'door' | 'window' | 'arch', Float32Array>>;
  items: ReadonlyMap<string, { matrices: Float32Array; ids: readonly ItemId[] }>;
  rails: Float32Array;
};

export type FloorGeometry = {
  index: number;
  lot: Lot;
  story: Story;
  hole: Uint8Array;
  occ: Uint16Array;
  /** Like `occ`, for floor-layer items only: the cell's floor item, as its index in the story plus one. */
  floorOcc: Uint16Array;
  overlaps: readonly (readonly [ItemId, ItemId])[];
  wallAt: ReadonlyMap<number, WallSeg>;
  roomOf: Uint16Array;
  rooms: readonly Room[];
  render: FloorRender;
};

export type SeatPose = { floor: number; desk: Vec2; chair: Vec2; exit: Vec2; yaw: number };

export type FloorNav = {
  floor: number;
  cols: number;
  rows: number;
  x0: number;
  z0: number;
  open: Uint8Array;
  doors: ReadonlyMap<string, Uint32Array>;
  component: Uint16Array;
};
export type StairLink = {
  from: { floor: number; at: Vec2 };
  to: { floor: number; at: Vec2 };
  cost: number;
  itemId: ItemId;
  heightAt(p: Vec2): number;
};
export type FloorPos = { floor: number; x: number; z: number };
export type Leg = { floor: number; path: Vec2[]; via?: StairLink };
