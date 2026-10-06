// Mutable build-mode state that changes every pointer move and must not re-render React: the ghost under the cursor, the
// modifier keys held, and where the build camera looks. Anything the HUD shows lives in the store instead.
import type { Company } from '../../../../shared/protocol.ts';
import { footprint, ITEM_DEFS, type Item, type SpaceContext, type TileRect, type Vec2, type ViolationKind, type WallRef, type WallSeg } from '../../../../shared/space/index.ts';

export type Ghost =
  | { kind: 'run'; refs: readonly WallRef[]; start: Vec2; end: Vec2; erase: boolean; ok: boolean }
  | { kind: 'room'; rect: TileRect; ok: boolean }
  | { kind: 'tiles'; tiles: readonly Vec2[]; ok: boolean }
  | { kind: 'walls'; walls: readonly WallSeg[]; ok: boolean }
  | { kind: 'vertex'; at: Vec2 }
  | { kind: 'item'; item: Item; ok: boolean }
  | { kind: 'outline'; item: Item };

export const draft = {
  ghost: null as Ghost | null,
  // Bumped whenever `ghost` is replaced, so the scene redraws it without React state on the pointer path.
  version: 0,
  cursor: { x: 0, z: 0, valid: false },
  // Where the furniture ghost stands in meters and on which floor. The walls between it and the camera step out of the way.
  focus: null as { x: number; z: number; level: number } | null,
};

/** Center of an item's footprint in meters. */
export function centerOf(item: Item): Vec2 {
  const f = footprint(ITEM_DEFS[item.def], item.rot);
  return { x: item.x / 2 + f.w / 4, z: item.z / 2 + f.d / 4 };
}

export function setGhost(g: Ghost | null, level = 0) {
  draft.ghost = g;
  draft.focus = g?.kind === 'item' ? { ...centerOf(g.item), level } : null;
  draft.version++;
}

export const modifiers = { shift: false, ctrl: false };

// Where the build camera looks. Panning moves it; the camera rig eases toward it.
// `dist` remembers how far out the overview was, so leaving build mode puts the camera back.
export const buildView = { x: 0, z: 0, dist: 0, keys: new Set<string>(), edge: { x: 0, z: 0 } };
export const BUILD_DIST = 34;

export function spaceContext(company: Company | null): SpaceContext {
  return {
    blocks: new Set(company?.blocks.map((b) => b.id) ?? []),
    employees: new Map((company?.employees ?? []).map((e) => [e.id, { blockId: e.blockId, orchestrator: e.role === 'orchestrator' }])),
    seats: new Map((company?.employees ?? []).flatMap((e) => (e.seat ? [[e.id, e.seat] as const] : []))),
  };
}

export const VIOLATION_TEXT: Readonly<Record<ViolationKind, string>> = {
  out_of_lot: 'Outside the lot',
  no_floor: 'Needs floor underneath',
  overlap: 'Something is in the way',
  wall_through_item: 'A wall cuts through it',
  on_hole: 'The stairwell is below',
  floor_unsupported: 'No floor below to hold it up',
  stairs_no_upper_story: 'Add a floor above first',
  stairs_no_landing: 'Needs floor at the top',
  stairs_misaligned: 'Stairs sit on whole tiles',
  story_unreachable: 'That floor has no stairs yet',
  would_strand_desks: 'It would cut desks off',
  story_not_empty: 'That floor still has things on it',
  bad_opening: 'It does not fit that wall',
  bad_diagonal_half: 'Diagonal walls need a half floor',
  bad_paint: 'Unknown paint',
  unknown_item: 'Unknown item',
  desk_wrong_block: 'A desk belongs to its team',
  desk_wrong_kind: 'Wrong kind of desk',
  desk_double_occupied: 'Two people on one desk',
  desk_unreachable: 'People could not walk to it',
};
