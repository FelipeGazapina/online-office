// Load-time migration from the office where each team's pod was drawn by fixed-position code to the one where every piece of
// it is an item. The pieces go exactly where the static pod drew them, so the office looks the same before anything moves.
import { PAINT } from './catalog.ts';
import { inLotTile, tileIndex } from './geom.ts';
import { blockCenter, shellItems } from './kit.ts';
import { applyAll, itemInLot } from './story.ts';
import type { Building, BlockId, BuildOp, FloorCell, ItemId } from './types.ts';

// The 9 by 7 tiles of carpet the static office painted under each team's rug. The rug is an item now, so the paint under it
// would stay behind when the block moves. Only tiles still wearing the color the office gave them are cleared.
const RUG_PAINTS = [PAINT.carpetBlue, PAINT.carpetRed, PAINT.carpetGray];
function carpetUnder(b: Building, slot: number): FloorCell[] {
  const c = blockCenter(slot);
  const story = b.stories[0];
  const cells: FloorCell[] = [];
  for (let z = c.z - 3; z < c.z + 4; z++) {
    for (let x = c.x - 5; x < c.x + 4; x++) {
      if (!inLotTile(b.lot, x, z)) continue;
      const paint = story.paint[tileIndex(b.lot, x, z)];
      if (paint === PAINT.carpetBlue || paint === RUG_PAINTS[slot % RUG_PAINTS.length]) cells.push({ x, z, half: 0, paint: PAINT.woodLight });
    }
  }
  return cells;
}

/**
 * Gives every block of `blocks` the pieces it lacks. A building already `shelled` comes back as it is, so a piece the owner
 * deleted stays deleted; without the flag, a piece is added only when no item has its id, so a half-done run finishes.
 */
export function addShells(b: Building, blocks: readonly { id: BlockId; slot: number }[]): Building {
  if (b.shelled) return b;
  const have = new Set<ItemId>(b.stories.flatMap((s) => s.items.map((i) => i.id)));
  const ops: BuildOp[] = [];
  const cells: FloorCell[] = [];
  const put = blocks.flatMap((block) => {
    const missing = shellItems(block.id, block.slot).filter((i) => !have.has(i.id) && itemInLot(b.lot, i));
    if (missing.length) cells.push(...carpetUnder(b, block.slot));
    return missing;
  });
  if (cells.length) ops.push({ t: 'floor', story: 0, cells });
  if (put.length) ops.push({ t: 'items', story: 0, put, del: [] });
  return { ...applyAll(b, ops, []).b, shelled: true };
}
