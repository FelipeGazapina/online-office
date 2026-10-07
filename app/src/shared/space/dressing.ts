// What a desk wears besides its computer: the small things of whoever works there. Like the computer (`setups.ts`) it is derived from the
// story and never stored, so older buildings get it too and it follows its desk when the desk moves.
//
// A desk wears two or three clusters, one in each of its zones: left of the keyboard, right of the mouse, along the back. A cluster is three
// or five things with a height step (one tall, one mid, one low) and at least one thing resting on another, in the way a plant stands on a
// stack of books beside a mug. The working zone in front of the keyboard stays clear. A desk's id picks which zones, which cluster of each and a
// few degrees of turn for each thing. Desks settle in the order of their ids and take nothing a neighbour already wears, so a row of desks is
// a row of different people. What the owner puts on a desk wins: a cluster that would touch one of the owner's things is left out.
import { ITEM_DEFS } from './catalog.ts';
import { floorItems, isTop } from './geom.ts';
import { gap, hash, NEIGHBOUR_GAP } from './setups.ts';
import { supportViolation, topRect, topsClash, topViolation, unitsOverlap } from './surface.ts';
import type { FloorItem, ItemDef, ItemId, Rot, Story, TopItem, UnitRect } from './types.ts';

/** A thing of a cluster: [def, u, v, { rot, look, ang, lvl }] in 12.5 cm units from its zone's origin, in the desk's own frame (u toward the mouse, v away from the sitter). */
export type Spot = readonly [def: string, u: number, v: number, extra?: { rot?: Rot; look?: number; ang?: number; lvl?: number }];

/**
 * Three things, or five with `plus`: one tall, one mid, one low. The type carries the rule that a cluster has an odd count with a height step, and
 * the dressing check reads the heights and that something rests on something (`lvl`), which a type cannot say.
 */
export type Cluster = { tall: Spot; mid: Spot; low: Spot; plus?: readonly [Spot, Spot] };
export type Tier = 'tall' | 'mid' | 'low';
export type ZoneName = 'left' | 'right' | 'back';
type Zone = {
  name: ZoneName;
  origin: readonly [number, number];
  /** Where the cluster may be moved to along its zone, tried in the order the dice give. */
  anchors: readonly (readonly [number, number])[];
  /** Where the zone's things may stand, as [u0, v0, u1, v1] in desk units. The three zones of a desk share no cell. */
  window: readonly (readonly [number, number, number, number])[];
  pool: readonly Cluster[];
};

/** The plant models. A pod (the desks of one block) wears each of them at most this often, so the same leaves are not on every desk. */
export const PLANT_MODELS: ReadonlySet<string> = new Set(['potted_plant', 'succulent', 'succulent_trio', 'cactus', 'snake_plant', 'pothos']);
export const PLANTS_PER_POD = 2;
/** Odd props that are somebody's: two neighbouring desks never both wear one, in any look. Other things only differ in look. */
export const STRICT: ReadonlySet<string> = new Set(['puzzle_cube', 'rubber_duck', 'cat_statue', 'trophy', 'phone', 'headphones']);
/** A desk wears each kind of thing once, except these: paper and notes pile up. */
export const MANY: ReadonlySet<string> = new Set(['papers', 'sticky_notes']);
/** The part of a desk the hands work in, [u0, v0, u1, v1]: the keyboard, the mouse and the strip in front of them. Nothing is worn there but one notebook. */
export const WORKING: readonly [number, number, number, number] = [4, 0, 10, 5];

/** How high a thing stands decides its place in a cluster: from 20 cm it is tall (a plant, a bottle), from 10 cm mid (a stack of books, a frame), else low (a mug, a notebook, a phone). */
export const tierOf = (def: ItemDef): Tier => (def.height >= 0.2 ? 'tall' : def.height >= 0.1 ? 'mid' : 'low');
export const spotsOf = (c: Cluster): readonly Spot[] => [c.tall, c.mid, c.low, ...(c.plus ?? [])];

// Left of the keyboard, 4 units wide. A cluster is at most 5 deep and moves along the strip, so a PO desk, which has a second screen up to v = 3, takes it behind that.
const LEFT: readonly Cluster[] = [
  { tall: ['potted_plant', 1, 0, { lvl: 1, ang: 10 }], mid: ['books', 0, 0, { ang: -4 }], low: ['mug', 3, 1, { ang: 50 }] },
  { tall: ['snake_plant', 0, 2], mid: ['takeaway_cup', 2, 0, { lvl: 1, ang: 40 }], low: ['notebook', 0, 0, { ang: 8 }] },
  { tall: ['water_bottle', 2, 2, { lvl: 1 }], mid: ['succulent', 0, 2, { lvl: 1, ang: 15 }], low: ['tray', 0, 0, { rot: 1 }], plus: [['notebook', 0, 0, { lvl: 1, ang: -6 }], ['mug', 1, 0, { lvl: 2, ang: 70 }]] },
  { tall: ['books_row', 0, 2, { rot: 2 }], mid: ['pen_cup', 2, 0, { lvl: 1 }], low: ['papers', 0, 0, { ang: -12 }] },
  { tall: ['trophy', 0, 2], mid: ['tablet', 0, 0, { lvl: 1, rot: 2, ang: 6 }], low: ['folder', 0, 0, { ang: -5 }] },
  { tall: ['vase', 2, 1], mid: ['headphones', 0, 0, { lvl: 1, ang: 30 }], low: ['magazine', 0, 0, { ang: -9 }] },
  { tall: ['pothos', 0, 2], mid: ['books', 0, 0, { ang: 6 }], low: ['mug', 3, 0, { lvl: 1, ang: -30 }], plus: [['glasses', 0, 0, { lvl: 1, ang: 22 }], ['coaster', 3, 0]] },
  { tall: ['water_bottle', 3, 0], mid: ['cactus', 1, 0, { lvl: 1, ang: 20 }], low: ['notebook', 0, 0, { ang: -7 }] },
  { tall: ['potted_plant', 0, 2], mid: ['desk_clock', 2, 2, { rot: 2 }], low: ['papers', 0, 0, { ang: 18 }], plus: [['mug', 0, 0, { lvl: 1, ang: 30 }], ['rubber_duck', 2, 1, { lvl: 1, ang: -30 }]] },
  { tall: ['snake_plant', 0, 2], mid: ['cat_statue', 1, 0, { lvl: 1, rot: 2 }], low: ['magazine', 0, 0, { rot: 1, ang: 5 }] },
  { tall: ['water_bottle', 3, 1], mid: ['succulent', 0, 2, { ang: 14 }], low: ['phone', 0, 0, { lvl: 1, ang: -25 }], plus: [['notebook', 0, 0, { ang: 5 }], ['mug', 2, 0, { lvl: 1, ang: 80 }]] },
];

// Right of the mouse: 2 units wide along the front, 3 in the corner at the back. A thing may not stand in u 9 before v 5, where the mouse goes.
const RIGHT: readonly Cluster[] = [
  { tall: ['snake_plant', 1, 3], mid: ['takeaway_cup', 1, 0, { lvl: 1, ang: 30 }], low: ['notebook', 1, 0, { rot: 1, ang: 6 }] },
  { tall: ['water_bottle', 2, 1, { lvl: 1 }], mid: ['books', 1, 0, { rot: 1, ang: -5 }], low: ['mug', 1, 3, { ang: 80 }] },
  { tall: ['potted_plant', 1, 3, { ang: -10 }], mid: ['tumbler', 1, 0, { lvl: 1 }], low: ['magazine', 1, 0, { ang: 8 }] },
  { tall: ['water_bottle', 2, 3], mid: ['pen_cup', 1, 3], low: ['mug', 1, 0, { lvl: 1, ang: -30 }], plus: [['papers', 1, 0, { rot: 1, ang: 8 }], ['sticky_notes', 2, 1, { lvl: 1, ang: 20 }]] },
  { tall: ['vase', 1, 3], mid: ['headphones', 1, 0, { lvl: 1, ang: 15 }], low: ['notebook', 1, 0, { rot: 1, ang: -6 }] },
  { tall: ['potted_plant', 1, 2, { lvl: 1, ang: 8 }], mid: ['books', 1, 1, { rot: 1, ang: 4 }], low: ['mug', 1, 0, { lvl: 1, ang: 40 }], plus: [['coaster', 1, 0], ['candle', 2, 0]] },
  { tall: ['pothos', 1, 5, { lvl: 1, ang: 12 }], mid: ['books', 0, 5, { ang: 4 }], low: ['mug', 0, 7, { ang: 60 }] },
  { tall: ['trophy', 1, 5, { lvl: 1, ang: -8 }], mid: ['frame_small', 0, 7, { rot: 2, ang: 10 }], low: ['folder', 0, 5, { ang: 7 }] },
  { tall: ['potted_plant', 1, 3], mid: ['tumbler', 2, 0, { lvl: 1 }], low: ['phone', 1, 0, { lvl: 1, ang: 15 }], plus: [['notebook', 1, 0, { rot: 1, ang: -4 }], ['puzzle_cube', 2, 1, { lvl: 1, ang: 30 }]] },
];

// Along the back, behind the monitor: 5 units wide and 2 deep, a cluster up to 4 wide. A thing with a face (a frame, a clock, a cat) turns to the sitter (rot 2).
const BACK: readonly Cluster[] = [
  { tall: ['potted_plant', 0, 0, { lvl: 1, ang: 8 }], mid: ['books', 0, 0, { ang: 3 }], low: ['candle', 3, 0] },
  { tall: ['picture_frame', 0, 0, { lvl: 1, rot: 2, ang: 4 }], mid: ['succulent', 3, 0], low: ['papers', 0, 0, { ang: -6 }] },
  { tall: ['books_row', 0, 0, { rot: 2 }], mid: ['cat_statue', 3, 0, { lvl: 1, rot: 2 }], low: ['coaster', 3, 0] },
  { tall: ['water_bottle', 3, 0], mid: ['frame_small', 1, 0, { lvl: 1, rot: 2, ang: -10 }], low: ['notebook', 0, 0, { ang: 4 }] },
  { tall: ['snake_plant', 3, 0], mid: ['books', 0, 0, { ang: -4 }], low: ['mug', 0, 0, { lvl: 1, ang: 55 }], plus: [['glasses', 1, 1, { lvl: 1, ang: 18 }], ['sticky_notes', 2, 0, { lvl: 1, ang: 24 }]] },
  { tall: ['potted_plant', 3, 0, { ang: 10 }], mid: ['tablet', 0, 0, { lvl: 1, rot: 2, ang: -6 }], low: ['folder', 0, 0, { ang: 5 }] },
  { tall: ['pothos', 3, 0, { ang: -10 }], mid: ['tumbler', 2, 0, { lvl: 1 }], low: ['phone', 0, 0, { lvl: 1, ang: 15 }], plus: [['notebook', 0, 0, { ang: -3 }], ['sticky_notes', 1, 1, { lvl: 1, ang: -12 }]] },
  { tall: ['vase', 3, 0], mid: ['speaker', 1, 0, { lvl: 1 }], low: ['magazine', 0, 0, { rot: 1, ang: 7 }] },
];

export const ZONES: readonly Zone[] = [
  { name: 'left', origin: [0, 0], anchors: [[0, 0], [0, 3], [0, 1], [0, 2]], window: [[0, 0, 4, 8]], pool: LEFT },
  { name: 'right', origin: [9, 0], anchors: [[0, 0]], window: [[10, 0, 12, 5], [9, 5, 12, 8]], pool: RIGHT },
  { name: 'back', origin: [4, 6], anchors: [[0, 0], [1, 0]], window: [[4, 6, 9, 8]], pool: BACK },
];

/** A small generator of numbers in [0, 1) from a seed, so every choice of a desk comes from its id and nothing else. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
  };
}

/** What two desks must not both wear: an odd prop in any look, any other thing in the same look. */
export const wornKey = (i: { def: string; look?: number }): string => (STRICT.has(i.def) ? i.def : `${i.def}#${i.look ?? 0}`);
const cache = new WeakMap<Story, ReadonlyMap<ItemId, readonly Worn[]>>();
const flatCache = new WeakMap<Story, readonly TopItem[]>();

/** One cluster as worn on one desk. */
export type Worn = { zone: ZoneName; things: readonly TopItem[] };

/** The clusters of every desk of a story, by desk. */
export function clustersOf(story: Story): ReadonlyMap<ItemId, readonly Worn[]> {
  const hit = cache.get(story);
  if (hit) return hit;
  const desks = floorItems(story)
    .filter((i) => ITEM_DEFS[i.def]?.setups)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const owned = new Map<ItemId, TopItem[]>();
  for (const i of story.items) if (isTop(i)) (owned.get(i.on) ?? owned.set(i.on, []).get(i.on)!).push(i);
  const worn = new Map<ItemId, readonly Worn[]>();
  // The plants of a pod include the ones the owner stood on its other things, such as the huddle table, so the pod never shows more than it should.
  const plants = new Map<string, number>();
  const blockOf = new Map(floorItems(story).map((i) => [i.id, i.blockId]));
  for (const i of story.items) {
    const block = isTop(i) && PLANT_MODELS.has(i.def) ? blockOf.get(i.on) : undefined;
    if (block) plants.set(`${block}|${i.def}`, (plants.get(`${block}|${i.def}`) ?? 0) + 1);
  }
  // How often a pod has used each cluster: a desk reaches for the ones its pod has used least, so a pod of seven shows seven.
  const used = new Map<string, number>();
  for (const desk of desks) {
    const taken = new Set(desks.flatMap((o) => (worn.has(o.id) && gap(desk, o) < NEIGHBOUR_GAP ? worn.get(o.id)!.flatMap((w) => w.things.map(wornKey)) : [])));
    const mine: Worn[] = [];
    const pod = `${desk.blockId ?? ''}`;
    const plan = seeded(hash(`${desk.id}/plan`));
    const want = plan() < 0.5 ? 2 : 3;
    // One desk in two has a cluster of five; the rest have threes only, so the desks differ in how full they are and none is cluttered.
    let fives = plan() < 0.5 ? 1 : 0;
    const order = ZONES.map((z) => ({ z, k: plan() })).sort((a, b) => a.k - b.k).map(({ z }) => z);
    for (const zone of order) {
      if (mine.length >= want) break;
      const seed = hash(`${desk.id}/${zone.name}`);
      const dice = seeded(seed);
      const useKey = (n: number) => `${pod}|${zone.name}|${n}`;
      const picks = zone.pool.map((_, n) => n).sort((a, b) => (used.get(useKey(a)) ?? 0) - (used.get(useKey(b)) ?? 0) || hash(`${seed}/${a}`) - hash(`${seed}/${b}`));
      const turn = Math.floor(dice() * zone.anchors.length);
      const anchors = zone.anchors.map((_, k) => zone.anchors[(k + turn) % zone.anchors.length]);
      const looks = Math.floor(dice() * 8);
      const flat = mine.flatMap((w) => w.things);
      for (const n of picks) {
        const cluster = zone.pool[n];
        if (cluster.plus && !fives) continue;
        const laid = anchors.map((at) => lay(desk, zone, cluster, at, looks, hash(`${seed}#${n}`), taken, flat, owned.get(desk.id) ?? [], mine.length)).find((l) => l !== null);
        if (!laid || laid.some((i) => PLANT_MODELS.has(i.def) && (plants.get(`${pod}|${i.def}`) ?? 0) >= PLANTS_PER_POD)) continue;
        for (const i of laid) if (PLANT_MODELS.has(i.def)) plants.set(`${pod}|${i.def}`, (plants.get(`${pod}|${i.def}`) ?? 0) + 1);
        used.set(useKey(n), (used.get(useKey(n)) ?? 0) + 1);
        if (cluster.plus) fives--;
        mine.push({ zone: zone.name, things: laid });
        break;
      }
    }
    worn.set(desk.id, mine);
  }
  cache.set(story, worn);
  return worn;
}

/** What a story's desks wear, as ordinary small things standing on them. Their ids are not in the building file and the rules never see them. */
export function dressingOf(story: Story): readonly TopItem[] {
  const hit = flatCache.get(story);
  if (hit) return hit;
  const out = [...clustersOf(story).values()].flatMap((cs) => cs.flatMap((c) => c.things));
  flatCache.set(story, out);
  return out;
}

const inside = (r: UnitRect, w: readonly [number, number, number, number]) => r.u0 >= w[0] && r.v0 >= w[1] && r.u1 <= w[2] && r.v1 <= w[3];

/** A cluster laid on a desk, or null when anything of it does not stand: out of its zone, in the computer, on one of the owner's things, on another of the desk's, a kind the desk wears already, or a thing a neighbour wears. */
function lay(desk: FloorItem, zone: Zone, cluster: Cluster, at: readonly [number, number], looks: number, seed: number, taken: ReadonlySet<string>, mine: readonly TopItem[], owner: readonly TopItem[], k: number): TopItem[] | null {
  const turn = seeded(seed);
  const out: TopItem[] = [];
  // What rests on something is laid after it.
  const spots = [...spotsOf(cluster)].sort((a, b) => (a[3]?.lvl ?? 0) - (b[3]?.lvl ?? 0));
  for (const [def, u, v, extra = {}] of spots) {
    const d = ITEM_DEFS[def];
    if (!MANY.has(def) && [...mine, ...out].some((i) => i.def === def)) return null;
    const n = d.looks ?? 1;
    const look = Array.from({ length: n }, (_, j) => ((extra.look ?? 0) + looks + j) % n).find((l) => !taken.has(wornKey({ def, look: l })));
    if (look === undefined) return null;
    const ang = (extra.ang ?? 0) + Math.round((turn() - 0.5) * 16);
    const item: TopItem = {
      id: `${desk.id}~wear.${zone.name}${k}.${out.length}` as ItemId,
      def,
      on: desk.id,
      u: zone.origin[0] + at[0] + u,
      v: zone.origin[1] + at[1] + v,
      rot: extra.rot ?? 0,
      ...(look && { look }),
      ...(ang && { ang }),
      ...(extra.lvl && { lvl: extra.lvl }),
    };
    const rect = topRect(item, d);
    const here = [...mine, ...out];
    if (!zone.window.some((w) => inside(rect, w)) || topViolation(item, d, desk) || owner.some((o) => unitsOverlap(topRect(o, ITEM_DEFS[o.def]), rect)) || here.some((o) => topsClash(o, ITEM_DEFS[o.def], item, d)) || supportViolation(item, d, here)) return null;
    out.push(item);
  }
  return out;
}
