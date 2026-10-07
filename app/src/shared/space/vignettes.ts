// Vignettes: small things put together the way a person sets a table, one entry in the catalog that lands as several items. A flat base
// (a tray, a runner, a stack of books), what stands on it, and one thing that is the focus, with the heights stepping up toward it. The
// data here is plain, so the catalog turns each into a def (`groupDef`) and the build tool turns each into items (`compose.ts`).
import type { GroupMember, ItemDef } from './types.ts';

export type Vignette = { id: string; name: string; looks: number; members: readonly GroupMember[] };

// A look number shifts every member to its next look, so a second tray of the same set is not the same colours.
export const VIGNETTES: readonly Vignette[] = [
  {
    id: 'vg_stack',
    name: 'Book stack with plant',
    looks: 3,
    members: [
      { def: 'books', u: 0, v: 0, ang: -4 },
      { def: 'books', u: 0, v: 0, lvl: 1, look: 1, ang: 7 },
      { def: 'succulent', u: 0, v: 0, lvl: 2, ang: 14 },
    ],
  },
  {
    id: 'vg_coffee',
    name: 'Coffee tray',
    looks: 3,
    members: [
      { def: 'tray', u: 0, v: 0 },
      { def: 'notebook', u: 0, v: 1, lvl: 1, ang: -6 },
      { def: 'mug', u: 1, v: 2, lvl: 2, ang: 30 },
      { def: 'takeaway_cup', u: 3, v: 0, lvl: 1 },
      { def: 'sticky_notes', u: 3, v: 2, lvl: 1, ang: 16 },
    ],
  },
  {
    id: 'vg_runner',
    name: 'Runner with candles',
    looks: 4,
    members: [
      { def: 'runner', u: 0, v: 0 },
      { def: 'succulent', u: 0, v: 0, lvl: 1, ang: 12 },
      { def: 'candle', u: 2, v: 1, lvl: 1 },
      { def: 'candle', u: 3, v: 0, lvl: 1, look: 2 },
      { def: 'books_row', u: 4, v: 0, lvl: 1 },
      { def: 'cat_statue', u: 7, v: 0, lvl: 1, rot: 3 },
    ],
  },
  {
    id: 'vg_study',
    name: 'Study corner',
    looks: 3,
    members: [
      { def: 'books_row', u: 0, v: 0 },
      { def: 'pen_cup', u: 3, v: 0 },
      { def: 'sticky_notes', u: 4, v: 0, ang: -12 },
      { def: 'notebook', u: 0, v: 2, ang: 4 },
      { def: 'mug', u: 2, v: 3, lvl: 1, ang: -20 },
      { def: 'calculator', u: 3, v: 2, ang: 10 },
    ],
  },
  {
    id: 'vg_reading',
    name: 'Reading nook',
    looks: 3,
    members: [
      { def: 'books', u: 0, v: 0, look: 2, ang: 5 },
      { def: 'books', u: 0, v: 0, lvl: 1, ang: -8 },
      { def: 'glasses', u: 0, v: 0, lvl: 2, ang: 24 },
      { def: 'candle', u: 3, v: 0, look: 1 },
      { def: 'mug', u: 4, v: 1, look: 3, ang: 18 },
    ],
  },
  {
    id: 'vg_snack',
    name: 'Snack break',
    looks: 3,
    members: [
      { def: 'magazine', u: 0, v: 0, ang: -7 },
      { def: 'magazine', u: 0, v: 0, lvl: 1, look: 2, ang: 8 },
      { def: 'snack_bowl', u: 2, v: 1 },
      { def: 'tumbler', u: 4, v: 0 },
      { def: 'coaster', u: 4, v: 1 },
      { def: 'takeaway_cup', u: 4, v: 1, lvl: 1, look: 1 },
    ],
  },
  {
    id: 'vg_gadgets',
    name: 'Gadget tray',
    looks: 2,
    members: [
      { def: 'tray', u: 0, v: 0, look: 1 },
      { def: 'headphones', u: 0, v: 0, lvl: 1, ang: 14 },
      { def: 'phone_stand', u: 2, v: 0, lvl: 1, ang: -12 },
      { def: 'speaker', u: 3, v: 0, lvl: 1 },
      { def: 'tablet', u: 2, v: 2, lvl: 1, ang: -6 },
    ],
  },
];

const rectOf = (m: GroupMember, defs: (id: string) => ItemDef) => {
  const t = defs(m.def).top!;
  const swap = (m.rot ?? 0) % 2 === 1;
  const [w, d] = swap ? [t.d, t.w] : [t.w, t.d];
  return { u0: m.u, v0: m.v, u1: m.u + w, v1: m.v + d };
};

/** How high a member's foot is above the group's top: what it rests on, which has its own lift. */
function liftOf(group: readonly GroupMember[], m: GroupMember, defs: (id: string) => ItemDef): number {
  if (!m.lvl) return 0;
  const r = rectOf(m, defs);
  const [mu, mv] = [(r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2];
  let best = 0;
  for (const o of group) {
    if ((o.lvl ?? 0) !== m.lvl - 1 || o === m) continue;
    const q = rectOf(o, defs);
    if (mu >= q.u0 && mu <= q.u1 && mv >= q.v0 && mv <= q.v1) best = Math.max(best, liftOf(group, o, defs) + defs(o.def).height);
  }
  return best;
}

/** The def a vignette is in the catalog: a small thing whose footprint and height are those of its members together. */
export function groupDef(v: Vignette, defs: (id: string) => ItemDef): ItemDef {
  const rects = v.members.map((m) => rectOf(m, defs));
  const [u1, v1] = [Math.max(...rects.map((r) => r.u1)), Math.max(...rects.map((r) => r.v1))];
  const height = Math.max(...v.members.map((m) => liftOf(v.members, m, defs) + defs(m.def).height));
  return { id: v.id, kind: 'decor', w: 1, d: 1, height: Math.round(height * 1000) / 1000, walkable: false, placement: 'surface', top: { w: u1, d: v1 }, looks: v.looks, group: v.members };
}
