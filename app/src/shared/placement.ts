// Where a block stands on the office floor. Units are meters, +x east, +z south. Main validates a move with this and the
// renderer draws and walks with it, so both agree on where a block is and what it covers.
import type { BlockPlace, ProjectBlock, Turns } from './protocol.ts';

export const BLOCK_W = 10;
export const BLOCK_D = 8;
export const AISLE = 2;
export const COLS = 3;
export const X0 = -18;
export const LOBBY_Z0 = -1;
// A move snaps to this grid, so blocks line up and a nudge is one step.
export const PLACE_STEP = 0.5;
// How far the office may grow to hold a moved block: six block widths east, four block depths north.
export const PLACE_AREA = { x0: X0 + AISLE / 2, x1: X0 + 6 * (BLOCK_W + AISLE) - AISLE / 2, z0: -4 * (BLOCK_D + AISLE) + AISLE / 2, z1: LOBBY_Z0 } as const;

export type Footprint = { x0: number; x1: number; z0: number; z1: number };

export function slotPlace(slot: number): BlockPlace {
  const col = slot % COLS;
  const row = Math.floor(slot / COLS);
  return {
    x: X0 + AISLE / 2 + BLOCK_W / 2 + col * (BLOCK_W + AISLE),
    z: -(BLOCK_D / 2 + 1) - row * (BLOCK_D + AISLE),
    turns: 0,
  };
}

// A block that was never moved stands in its grid slot.
export const placementOf = (block: Pick<ProjectBlock, 'slot' | 'place'>): BlockPlace => block.place ?? slotPlace(block.slot);

export function footprint(p: BlockPlace): Footprint {
  const hw = (p.turns % 2 ? BLOCK_D : BLOCK_W) / 2;
  const hd = (p.turns % 2 ? BLOCK_W : BLOCK_D) / 2;
  return { x0: p.x - hw, x1: p.x + hw, z0: p.z - hd, z1: p.z + hd };
}

// Touching is fine: each rug is inset half a meter, so two blocks edge to edge still leave a one-meter aisle.
const overlap = (a: Footprint, b: Footprint) => a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.z0 < b.z1 - 1e-6 && b.z0 < a.z1 - 1e-6;

// Why a block cannot stand at `p`, or null when it can. `others` are the blocks that stay where they are.
export function placeProblem(p: BlockPlace, others: readonly Pick<ProjectBlock, 'slot' | 'place' | 'name'>[]): string | null {
  const f = footprint(p);
  const a = PLACE_AREA;
  if (f.x0 < a.x0 - 1e-6 || f.x1 > a.x1 + 1e-6 || f.z0 < a.z0 - 1e-6 || f.z1 > a.z1 + 1e-6) return 'That spot is outside the office floor.';
  const hit = others.find((o) => overlap(f, footprint(placementOf(o))));
  return hit ? `That spot overlaps ${hit.name}.` : null;
}

export const snapPlace = (p: BlockPlace): BlockPlace => ({
  x: Math.round(p.x / PLACE_STEP) * PLACE_STEP,
  z: Math.round(p.z / PLACE_STEP) * PLACE_STEP,
  turns: ((((Math.round(p.turns) % 4) + 4) % 4) as Turns),
});

// The first grid slot whose spot no block covers. A new block goes there.
export function nextSlot(blocks: readonly Pick<ProjectBlock, 'slot' | 'place'>[]): number {
  const covered = blocks.map((b) => footprint(placementOf(b)));
  let slot = 0;
  while (covered.some((f) => overlap(f, footprint(slotPlace(slot))))) slot++;
  return slot;
}
