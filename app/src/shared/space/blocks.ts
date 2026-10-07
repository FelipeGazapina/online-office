// Moving a project block as one unit. A block is every item of one story that carries its blockId (desks, PO desk,
// board, terminal, sign, and the pod around them: rug, boundary, decor, huddle). A move turns them together in quarter turns and shifts them together, then goes
// through the same `items` op and rules as a single piece, so overlap, lot, wall and desk checks need no second path.
import { footprint, ITEM_DEFS } from './catalog.ts';
import { itemAt } from './buildersGesture.ts';
import { defOf, itemRect, type CellRect } from './geom.ts';
import type { BlockId, BuildOp, Item, Rot, Story, Vec2 } from './types.ts';
import { CELL } from './types.ts';

/** Where a block ends up: turned `quarter` quarter turns clockwise (the way `rot` grows), its bounding box starting at cell `origin`. */
export type BlockPose = { quarter: Rot; origin: Vec2 };

export function blockItems(story: Story, blockId: BlockId): Item[] {
  return story.items.filter((i) => i.blockId === blockId && ITEM_DEFS[i.def]);
}

/** The cells a set of items covers together, or null for an empty set. */
export function cellBounds(items: readonly Item[]): CellRect | null {
  let box: CellRect | null = null;
  for (const item of items) {
    const def = defOf(item);
    if (!def) continue;
    const r = itemRect(item, def);
    box = box ? { x0: Math.min(box.x0, r.x0), z0: Math.min(box.z0, r.z0), x1: Math.max(box.x1, r.x1), z1: Math.max(box.z1, r.z1) } : r;
  }
  return box;
}

// One quarter turn inside the bounding box: the map `rotateLocal` applies to the points of one piece, applied to every piece.
function turnOnce(items: readonly Item[]): Item[] {
  const box = cellBounds(items);
  if (!box) return [...items];
  const depth = box.z1 - box.z0;
  return items.map((item) => {
    const f = footprint(ITEM_DEFS[item.def], item.rot);
    return { ...item, x: box.x0 + depth - (item.z - box.z0 + f.d), z: box.z0 + (item.x - box.x0), rot: ((item.rot + 1) % 4) as Rot };
  });
}

export function turnBlock(items: readonly Item[], quarter: Rot): Item[] {
  let out = [...items];
  for (let k = 0; k < quarter; k++) out = turnOnce(out);
  return out;
}

/** The items after the pose: turned, then moved so their bounding box starts at `pose.origin`. */
export function placeBlock(items: readonly Item[], pose: BlockPose): Item[] {
  const turned = turnBlock(items, pose.quarter);
  const box = cellBounds(turned);
  if (!box) return turned;
  const dx = pose.origin.x - box.x0;
  const dz = pose.origin.z - box.z0;
  return turned.map((item) => ({ ...item, x: item.x + dx, z: item.z + dz }));
}

/** The pose that puts the turned block's middle on `center` (in cells), rounded to whole cells. */
export function blockPose(items: readonly Item[], quarter: Rot, center: Vec2): BlockPose {
  const box = cellBounds(turnBlock(items, quarter));
  if (!box) return { quarter, origin: { x: Math.round(center.x), z: Math.round(center.z) } };
  return { quarter, origin: { x: Math.round(center.x - (box.x1 - box.x0) / 2), z: Math.round(center.z - (box.z1 - box.z0) / 2) } };
}

const sameSpot = (a: Item, b: Item) => a.x === b.x && a.z === b.z && a.rot === b.rot;

/**
 * The ops that put every item of the block that changes into its new place, none when the pose changes nothing. With `toStory`
 * the block also changes floors: its pieces leave `storyIndex` and arrive on `toStory`, keeping their ids.
 */
export function moveBlockOps(story: Story, storyIndex: number, blockId: BlockId, pose: BlockPose, toStory = storyIndex): BuildOp[] {
  const items = blockItems(story, blockId);
  const placed = placeBlock(items, pose);
  if (toStory === storyIndex) {
    const put = placed.filter((moved, i) => !sameSpot(moved, items[i]));
    return put.length ? [{ t: 'items', story: storyIndex, put, del: [] }] : [];
  }
  if (!items.length) return [];
  return [
    { t: 'items', story: storyIndex, put: [], del: items.map((i) => i.id) },
    { t: 'items', story: toStory, put: placed, del: [] },
  ];
}

/** The block a point in meters picks: the one whose piece lies under it, else the smallest block whose bounding box holds it. */
export function blockAt(story: Story, p: Vec2): BlockId | null {
  const under = itemAt(story, p);
  if (under?.blockId) return under.blockId;
  const cx = p.x / CELL;
  const cz = p.z / CELL;
  const byBlock = new Map<BlockId, Item[]>();
  for (const item of story.items) if (item.blockId && ITEM_DEFS[item.def]) (byBlock.get(item.blockId) ?? byBlock.set(item.blockId, []).get(item.blockId)!).push(item);
  let best: BlockId | null = null;
  let bestArea = Infinity;
  for (const [id, items] of byBlock) {
    const r = cellBounds(items);
    if (!r || cx < r.x0 || cx >= r.x1 || cz < r.z0 || cz >= r.z1) continue;
    const area = (r.x1 - r.x0) * (r.z1 - r.z0);
    if (area < bestArea) {
      best = id;
      bestArea = area;
    }
  }
  return best;
}
