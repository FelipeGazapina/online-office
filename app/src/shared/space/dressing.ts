// What a desk wears besides its computer: the small things of whoever works there. Like the computer (`setups.ts`) it is derived from the
// story and never stored, so older buildings get it too and it follows its desk when the desk moves. A desk's id picks, zone by zone, one of
// a few arrangements (papers with a mug on them, a notebook with a phone on it, a cactus beside a cat) and a few degrees of turn for each
// thing. Desks settle in the order of their ids and take nothing a neighbour already wears, so a row of desks is a row of different people.
// What the owner puts on a desk wins: an arrangement that would touch one of the owner's things is left out and the rest stay.
import { ITEM_DEFS } from './catalog.ts';
import { floorItems, isTop } from './geom.ts';
import { gap, hash, NEIGHBOUR_GAP } from './setups.ts';
import { supportViolation, topRect, topsClash, topViolation, unitsOverlap } from './surface.ts';
import type { FloorItem, ItemId, Rot, Story, TopItem } from './types.ts';

/** A thing of an arrangement: [def, u, v, { rot, look, ang, lvl }] in 12.5 cm units of the desk's own frame, like the dressing of a table. */
export type Spot = readonly [def: string, u: number, v: number, extra?: { rot?: Rot; look?: number; ang?: number; lvl?: number }];
/** A place on a desk an arrangement goes. `skip` is how often the dice leave it empty; zones that draw on the same `list` (the three along the back) share its arrangements. */
type Zone = { name: string; list: string; origin: readonly [number, number]; skip: number; pool: readonly (readonly Spot[])[] };

/** The plant models. A pod (the desks of one block) wears each of them at most this often, so the same leaves are not on every desk. */
export const PLANT_MODELS: ReadonlySet<string> = new Set(['potted_plant', 'succulent', 'succulent_trio', 'cactus', 'snake_plant', 'pothos']);
export const PLANTS_PER_POD = 2;
/** A desk is full at this many things, and has this many in front, where the hands work, or the zones its dice skipped are filled in. */
const FULL = 7;
const IN_FRONT = 3;

// Along the back edge, 4 units wide and 2 deep: three of these sit side by side. A thing with a face (a frame, a clock, a cat) turns to the sitter (rot 2).
const BACK: readonly (readonly Spot[])[] = [
  [['potted_plant', 1, 0, { ang: 15 }]],
  [['books_row', 0, 0, { rot: 2 }], ['rubber_duck', 3, 0, { rot: 2 }]],
  [['succulent', 0, 0], ['frame_small', 2, 1, { rot: 2, ang: -8 }]],
  [['desk_organizer', 0, 0, { rot: 2 }], ['sticky_notes', 3, 1, { ang: 14 }]],
  [['cactus', 0, 1], ['cat_statue', 1, 0, { rot: 2 }], ['candle', 3, 0]],
  [['snake_plant', 0, 0], ['mug', 2, 0, { look: 2 }]],
  [['picture_frame', 0, 0, { rot: 2, ang: 4 }], ['candle', 2, 0, { look: 1 }]],
  [['books', 0, 0, { ang: 3 }], ['trophy', 0, 0, { lvl: 1, ang: -6 }]],
  [['pothos', 0, 0], ['puzzle_cube', 2, 0, { ang: 25 }]],
  [['speaker', 0, 1], ['phone_stand', 2, 1, { rot: 2, ang: -15 }]],
  [['succulent_trio', 0, 0], ['desk_clock', 0, 1, { rot: 2 }]],
  [['vase', 0, 0], ['sticky_notes', 2, 1, { ang: -12, look: 1 }]],
  [['books_row', 0, 0, { rot: 2, look: 1 }], ['cat_statue', 3, 0, { rot: 3, look: 1 }]],
  [['magazine', 0, 0, { rot: 1, ang: -6 }], ['takeaway_cup', 1, 0, { lvl: 1, ang: 20 }]],
  [['laptop', 0, 0, { rot: 2, ang: 6 }], ['sticky_notes', 3, 0, { look: 2 }]],
  [['snack_bowl', 0, 0, { look: 1 }], ['tumbler', 3, 0]],
  [['pen_cup', 0, 0], ['stapler', 1, 1, { ang: 8 }], ['calculator', 3, 0, { ang: -6 }]],
  [['tablet', 0, 1, { rot: 2, ang: -6 }], ['headphones', 2, 0, { ang: 30 }]],
  [['letter_tray', 0, 0, { rot: 2 }], ['candle', 3, 0, { look: 3 }]],
  [['snack_bowl', 0, 0], ['water_bottle', 2, 0]],
];

// Beside the keyboard on the side of low u, where the hands work: flat things at an angle, with something standing on them. (u grows toward the mouse.)
const LEFT: readonly (readonly Spot[])[] = [
  [['papers', 0, 1, { ang: -12 }], ['mug', 1, 1, { lvl: 1, ang: 40 }], ['pen_cup', 3, 3]],
  [['notebook', 0, 0, { ang: 8 }], ['phone_stand', 1, 0, { lvl: 1, rot: 2, ang: -15 }], ['glasses', 0, 3, { ang: 25 }], ['sticky_notes', 3, 2, { ang: -10 }]],
  [['folder', 0, 2, { ang: -5 }], ['notebook', 0, 2, { lvl: 1, ang: 14, look: 2 }], ['sticky_notes', 2, 2, { lvl: 2, ang: 20 }], ['water_bottle', 3, 0]],
  [['magazine', 0, 1, { ang: -9 }], ['takeaway_cup', 1, 2, { lvl: 1 }], ['headphones', 2, 3, { ang: 30 }]],
  [['snack_bowl', 0, 3], ['tumbler', 3, 1], ['sticky_notes', 0, 1, { ang: 30, look: 2 }], ['takeaway_cup', 1, 1, { look: 2 }]],
  [['tablet', 0, 0, { ang: -8 }], ['papers', 0, 2, { ang: 6, look: 1 }], ['pen_cup', 3, 2], ['stapler', 0, 4, { ang: 12 }]],
  [['desk_organizer', 0, 2], ['sticky_notes', 3, 0, { ang: 16 }], ['calculator', 3, 3]],
  [['letter_tray', 0, 1, { ang: -4 }], ['coaster', 3, 1], ['stapler', 0, 4, { ang: -10 }]],
  [['books', 0, 1, { ang: 6 }], ['books', 0, 1, { lvl: 1, look: 1, ang: -9 }], ['glasses', 0, 1, { lvl: 2, ang: 22 }], ['candle', 3, 3]],
  [['papers', 0, 0, { ang: 18, look: 1 }], ['folder', 1, 2, { ang: -7, look: 2 }], ['pen_cup', 3, 0]],
  [['notebook', 0, 3, { ang: -6, look: 1 }], ['mug', 1, 3, { lvl: 1, look: 3, ang: 60 }], ['puzzle_cube', 3, 1, { ang: 20 }]],
  [['magazine', 0, 0, { rot: 1, ang: 7, look: 2 }], ['coaster', 3, 2, { look: 1 }], ['rubber_duck', 3, 3, { ang: -30 }]],
  [['papers', 0, 3, { ang: 8 }], ['glasses', 0, 3, { lvl: 1, ang: -18 }], ['water_bottle', 3, 0, { look: 1 }]],
  [['folder', 0, 3, { ang: -4, look: 1 }], ['stapler', 0, 0, { ang: 9 }], ['sticky_notes', 3, 3, { look: 3 }]],
];

// Beside the mouse, on the side of high u: the thing that is drunk, eaten or listened to.
const RIGHT: readonly (readonly Spot[])[] = [
  [['water_bottle', 10, 0], ['coaster', 10, 2], ['mug', 10, 2, { lvl: 1, ang: -30 }]],
  [['notebook', 10, 0, { rot: 1, ang: -6 }], ['mug', 10, 0, { lvl: 1, look: 1, ang: 90 }], ['tumbler', 11, 4]],
  [['takeaway_cup', 10, 0], ['snack_bowl', 10, 2], ['candle', 11, 4, { look: 2 }]],
  [['headphones', 10, 0, { ang: 20 }], ['mug', 10, 3, { look: 4 }], ['frame_small', 11, 5, { rot: 2, ang: 10 }]],
  [['papers', 10, 0, { rot: 1, ang: 10 }], ['pen_cup', 10, 3], ['stapler', 10, 4, { ang: -8 }]],
  [['trophy', 10, 0], ['coaster', 10, 3, { look: 2 }], ['takeaway_cup', 10, 3, { lvl: 1, look: 2 }]],
  [['phone_stand', 10, 0, { rot: 2, ang: 14 }], ['sticky_notes', 11, 2, { ang: 25 }], ['water_bottle', 10, 3, { look: 2 }]],
  [['rubber_duck', 11, 0, { ang: -20 }], ['tumbler', 10, 2, { look: 3 }], ['puzzle_cube', 11, 4, { ang: 35 }]],
  [['tumbler', 10, 0, { look: 2 }], ['speaker', 10, 3]],
];

// In front of the keyboard, along the edge the sitter leans on, one thing deep.
const FRONT: readonly (readonly Spot[])[] = [
  [['glasses', 4, 0, { ang: 14 }]],
  [['sticky_notes', 8, 0, { ang: 20 }], ['pen_cup', 10, 0, { look: 1 }]],
  [['stapler', 6, 0, { ang: -5 }]],
  [['tablet', 5, 0, { ang: 6 }]],
  [['phone_stand', 5, 0, { rot: 2, ang: 12 }], ['puzzle_cube', 8, 0, { ang: 30, look: 1 }]],
];

export const ZONES: readonly Zone[] = [
  { name: 'back-left', list: 'back', origin: [0, 6], skip: 0.1, pool: BACK },
  { name: 'back-middle', list: 'back', origin: [4, 6], skip: 0.45, pool: BACK },
  { name: 'back-right', list: 'back', origin: [8, 6], skip: 0.2, pool: BACK },
  { name: 'left', list: 'left', origin: [0, 0], skip: 0.1, pool: LEFT },
  { name: 'right', list: 'right', origin: [0, 0], skip: 0.25, pool: RIGHT },
  { name: 'front', list: 'front', origin: [0, 0], skip: 0.6, pool: FRONT },
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

const key = (i: { def: string; look?: number }) => `${i.def}#${i.look ?? 0}`;
const cache = new WeakMap<Story, readonly TopItem[]>();

/** What a story's desks wear, as ordinary small things standing on them. Their ids are not in the building file and the rules never see them. */
export function dressingOf(story: Story): readonly TopItem[] {
  const hit = cache.get(story);
  if (hit) return hit;
  const desks = floorItems(story)
    .filter((i) => ITEM_DEFS[i.def]?.setups)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const owned = new Map<ItemId, TopItem[]>();
  for (const i of story.items) if (isTop(i)) (owned.get(i.on) ?? owned.set(i.on, []).get(i.on)!).push(i);
  const worn = new Map<ItemId, readonly TopItem[]>();
  // The plants of a pod include the ones the owner stood on its other things, such as the huddle table, so the pod never shows more than it should.
  const plants = new Map<string, number>();
  const blockOf = new Map(floorItems(story).map((i) => [i.id, i.blockId]));
  for (const i of story.items) {
    const block = isTop(i) && PLANT_MODELS.has(i.def) ? blockOf.get(i.on) : undefined;
    if (block) plants.set(`${block}|${i.def}`, (plants.get(`${block}|${i.def}`) ?? 0) + 1);
  }
  // How often a pod has used each arrangement: a desk reaches for the ones its pod has used least, so a pod of seven shows seven.
  const used = new Map<string, number>();
  const out: TopItem[] = [];
  for (const desk of desks) {
    const taken = new Set(desks.flatMap((o) => (worn.has(o.id) && gap(desk, o) < NEIGHBOUR_GAP ? worn.get(o.id)!.map(key) : [])));
    const mine: TopItem[] = [];
    const pod = `${desk.blockId ?? ''}`;
    const laidIn = new Set<string>();
    // A second round fills a desk that the dice left bare, or with nothing in front where the hands work, from the zones it skipped or could not use.
    for (const round of [0, 1]) {
      if (round === 1 && mine.length >= FULL && mine.filter((i) => i.v < 4).length >= IN_FRONT) break;
      for (const zone of ZONES) {
        if (laidIn.has(zone.name)) continue;
        const seed = hash(`${desk.id}/${zone.name}`);
        const dice = seeded(seed);
        const skipped = dice() < zone.skip;
        if (skipped && round === 0) continue;
        const useKey = (n: number) => `${pod}|${zone.list}|${n}`;
        const order = zone.pool.map((_, n) => n).sort((a, b) => (used.get(useKey(a)) ?? 0) - (used.get(useKey(b)) ?? 0) || hash(`${seed}/${a}`) - hash(`${seed}/${b}`));
        const shift = ([[0, 0], [1, 0], [0, 1], [-1, 0]] as const)[Math.floor(dice() * 4)];
        const looks = Math.floor(dice() * 8);
        for (const n of order) {
          const arrangement = (at: readonly [number, number]) => lay(desk, zone, zone.pool[n], at, looks, hash(`${seed}#${n}`), taken, mine, owned.get(desk.id) ?? []);
          const laid = arrangement(shift) ?? arrangement([0, 0]);
          if (!laid || laid.some((i) => PLANT_MODELS.has(i.def) && (plants.get(`${pod}|${i.def}`) ?? 0) >= PLANTS_PER_POD)) continue;
          for (const i of laid) if (PLANT_MODELS.has(i.def)) plants.set(`${pod}|${i.def}`, (plants.get(`${pod}|${i.def}`) ?? 0) + 1);
          used.set(useKey(n), (used.get(useKey(n)) ?? 0) + 1);
          mine.push(...laid);
          laidIn.add(zone.name);
          break;
        }
      }
    }
    worn.set(desk.id, mine);
    out.push(...mine);
  }
  cache.set(story, out);
  return out;
}

/** An arrangement laid on a desk, or null when anything of it does not stand: off the top, in the computer, on one of the owner's things, on another of the desk's, or in the way of what a neighbour wears. */
function lay(desk: FloorItem, zone: Zone, spots: readonly Spot[], shift: readonly [number, number], looks: number, seed: number, taken: ReadonlySet<string>, mine: readonly TopItem[], owner: readonly TopItem[]): TopItem[] | null {
  const turn = seeded(seed);
  const out: TopItem[] = [];
  for (const [def, u, v, extra = {}] of spots) {
    const d = ITEM_DEFS[def];
    if (mine.some((i) => i.def === def)) return null;
    const n = d.looks ?? 1;
    const look = Array.from({ length: n }, (_, k) => ((extra.look ?? 0) + looks + k) % n).find((l) => !taken.has(`${def}#${l}`));
    if (look === undefined) return null;
    const ang = (extra.ang ?? 0) + Math.round((turn() - 0.5) * 16);
    const item: TopItem = {
      id: `${desk.id}~wear.${mine.length + out.length}` as ItemId,
      def,
      on: desk.id,
      u: zone.origin[0] + u + shift[0],
      v: zone.origin[1] + v + shift[1],
      rot: extra.rot ?? 0,
      ...(look && { look }),
      ...(ang && { ang }),
      ...(extra.lvl && { lvl: extra.lvl }),
    };
    const rect = topRect(item, d);
    const here = [...mine, ...out];
    if (topViolation(item, d, desk) || owner.some((o) => unitsOverlap(topRect(o, ITEM_DEFS[o.def]), rect)) || here.some((o) => topsClash(o, ITEM_DEFS[o.def], item, d)) || supportViolation(item, d, here)) return null;
    out.push(item);
  }
  return out;
}
