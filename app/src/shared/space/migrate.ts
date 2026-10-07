// Load-time migration from the office where each team's pod was drawn by fixed-position code to the one where every piece of
// it is an item. A team's desks may have been moved or turned before the pod became items, so the pod is placed with them: the
// pose that carries the team's slot layout onto the desks, board and sign as they stand now is read from those pieces, and the
// pod goes there when it passes the rules a block move uses. Otherwise it stays where the static pod stood.
import { ITEM_DEFS, PAINT } from './catalog.ts';
import { inLotTile, itemRect, tileIndex } from './geom.ts';
import { blockCenter, coreItems, shellItems } from './kit.ts';
import { applyAll, itemInLot } from './story.ts';
import { applyOps, findItem, locateItem } from './validate.ts';
import type { Building, BlockId, BuildOp, FloorCell, Item, ItemId, Rot, SpaceContext, Vec2, Violation } from './types.ts';

/** How a team's slot layout was carried to where its pieces stand: turned `quarter` quarter turns clockwise about the cell origin (x, z) -> (-z, x), then shifted by (dx, dz) cells. */
export type SlotPose = { quarter: Rot; dx: number; dz: number };
export type ShellBlock = { id: BlockId; slot: number; name?: string };
/** A piece of a pod the rules refuse at the team's pose. It stays at the slot spot, where the static pod stood. */
export type LeftPiece = { id: ItemId; why: string };
export type ShellOutcome =
  | { kind: 'placed'; block: ShellBlock; pose: SlotPose; agree: number; of: number; left: readonly LeftPiece[] }
  | { kind: 'fell_back'; block: ShellBlock; why: string };
/** What the desks, board and sign say about where their team stands, or why they do not say. */
export type SlotReading = { story: number; pose: SlotPose; agree: number; of: number } | { why: string };

const turn = (q: Rot, p: Vec2): Vec2 => (q === 0 ? p : q === 1 ? { x: -p.z, z: p.x } : q === 2 ? { x: -p.x, z: -p.z } : { x: p.z, z: -p.x });

// The minimum corner of an item's footprint once the layout is turned, before the shift.
function turnedCorner(item: Item, quarter: Rot): Vec2 {
  const r = itemRect(item, ITEM_DEFS[item.def]);
  const a = turn(quarter, { x: r.x0, z: r.z0 });
  const c = turn(quarter, { x: r.x1, z: r.z1 });
  return { x: Math.min(a.x, c.x), z: Math.min(a.z, c.z) };
}

function carry(item: Item, pose: SlotPose): Item {
  const at = turnedCorner(item, pose.quarter);
  return { ...item, x: at.x + pose.dx, z: at.z + pose.dz, rot: ((item.rot + pose.quarter) % 4) as Rot };
}

const isSlot = (p: SlotPose) => p.quarter === 0 && p.dx === 0 && p.dz === 0;
const sameSpot = (a: Item, b: Item) => a.x === b.x && a.z === b.z && a.rot === b.rot;

/**
 * Where a team stands, read from its core pieces (desks, PO desk, board, terminal, sign). Each piece found by id gives the one
 * pose that takes its slot spot to its spot now; the pose most pieces give wins, so a desk the owner moved alone is outvoted.
 * The pieces of the floor that holds most of them count. A tie between poses reads as no answer.
 */
export function inferSlotPose(b: Building, blockId: BlockId, slot: number): SlotReading {
  const cores = coreItems(blockId, slot);
  let story = 0;
  let pairs: { was: Item; now: Item }[] = [];
  for (let s = 0; s < b.stories.length; s++) {
    const here = cores.flatMap((was) => {
      const now = findItem(b.stories[s], was.id);
      return now?.def === was.def ? [{ was, now }] : [];
    });
    if (here.length > pairs.length) {
      story = s;
      pairs = here;
    }
  }
  if (!pairs.length) return { why: 'none of its desks, board or sign is left to read its place from' };
  const votes = new Map<string, { pose: SlotPose; n: number }>();
  for (const { was, now } of pairs) {
    const quarter = ((now.rot - was.rot + 4) % 4) as Rot;
    const at = turnedCorner(was, quarter);
    const key = `${quarter},${now.x - at.x},${now.z - at.z}`;
    votes.set(key, { pose: { quarter, dx: now.x - at.x, dz: now.z - at.z }, n: (votes.get(key)?.n ?? 0) + 1 });
  }
  const [first, second] = [...votes.values()].sort((a, c) => c.n - a.n);
  if (second && second.n === first.n) return { why: `its pieces do not agree where it stands: the best two readings got ${first.n} of ${pairs.length} each` };
  return { story, pose: first.pose, agree: first.n, of: pairs.length };
}

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

// The rules look at the pieces only, not at who sits where: moving a pod changes no desk.
const NO_SEATS: SpaceContext = { blocks: new Set(), employees: new Map(), seats: new Map() };

function describe(piece: Item, violations: readonly Violation[]): string {
  return violations
    .map((v) => {
      const others = (v.ids ?? []).filter((id) => id !== piece.id);
      return others.length ? `${v.kind} with ${others.join(', ')}` : v.kind;
    })
    .join(', ');
}

type Job = {
  block: ShellBlock;
  story: number;
  reading: SlotReading;
  /** Pieces already standing at their slot spot, which follow the team. */
  lift: Item[];
  /** Pieces the team has no item for yet. */
  add: Item[];
};

function jobFor(b: Building, block: ShellBlock, fresh: boolean): Job {
  const reading = inferSlotPose(b, block.id, block.slot);
  const story = 'pose' in reading ? reading.story : 0;
  const lift: Item[] = [];
  const add: Item[] = [];
  for (const piece of shellItems(block.id, block.slot)) {
    const found = locateItem(b, piece.id);
    if (!found) {
      if (fresh) add.push(piece);
    } else if (found.story === story && sameSpot(found.item, piece)) lift.push(found.item);
  }
  return { block, story, reading, lift, add };
}

function settle(b: Building, job: Job, report: (outcome: ShellOutcome) => void): Building {
  const { block, story, reading, lift, add } = job;
  let cur = add.length ? applyAll(b, [{ t: 'floor', story: 0, cells: carpetUnder(b, block.slot) }], []).b : b;
  const atSlot = (pieces: readonly Item[]) => {
    cur = applyAll(cur, [{ t: 'items', story, put: pieces.filter((i) => itemInLot(cur.lot, i)), del: [] }], []).b;
  };
  if (!('pose' in reading)) {
    report({ kind: 'fell_back', block, why: reading.why });
    atSlot([...lift, ...add]);
    return cur;
  }
  const { pose, agree, of } = reading;
  const stay: Item[] = [];
  const left: LeftPiece[] = [];
  for (const piece of [...lift, ...add]) {
    if (isSlot(pose)) {
      stay.push(piece);
      continue;
    }
    const placed = applyOps(cur, [{ t: 'items', story, put: [carry(piece, pose)], del: [] }], NO_SEATS);
    if (placed.ok) cur = placed.building;
    else {
      stay.push(piece);
      left.push({ id: piece.id, why: describe(piece, placed.violations) });
    }
  }
  atSlot(stay);
  report({ kind: 'placed', block, pose, agree, of, left });
  return cur;
}

/**
 * Gives every block of `blocks` its pod as items, placed with the block's desks, board and sign, and returns the building at
 * `shelled` 2. A building already there comes back as it is.
 * - Never migrated: every piece the team lacks is added.
 * - At `shelled` 1, where the earlier migration put each pod at its slot spot whatever the desks did: the pieces still exactly
 *   at their slot spot are carried to the team. A piece anywhere else is one the owner moved and keeps its place, and a piece
 *   that is gone stays gone. A piece the owner put back on its slot spot by hand cannot be told from an untouched one.
 * Each piece goes to the team's pose when it passes the rules of a block move, as a piece placed alone does. One the rules
 * refuse (an owner's cabinet in the way, the edge of the lot) stays at its slot spot and `report` names it and says why. A team
 * whose pieces give no pose keeps its whole pod at the slot spot. Pieces about to move are lifted first, so a piece is not
 * refused for the sake of the pod it is about to replace.
 */
export function addShells(b: Building, blocks: readonly ShellBlock[], report: (outcome: ShellOutcome) => void = () => {}): Building {
  if (b.shelled === 2) return b;
  const fresh = b.shelled === undefined;
  const jobs = blocks.map((block) => jobFor(b, block, fresh)).filter((j) => j.lift.length + j.add.length > 0);
  const lifting: BuildOp[] = jobs.filter((j) => j.lift.length).map((j) => ({ t: 'items', story: j.story, put: [], del: j.lift.map((i) => i.id) }));
  let cur = applyAll(b, lifting, []).b;
  for (const job of jobs) cur = settle(cur, job, report);
  return { ...cur, shelled: 2 };
}
