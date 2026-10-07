// A dressed office, as data: what stands where on a team's desks, its huddle table, a meeting table and a shelf. Shared by the shots
// script and e2e-tabletop so the picture the panel sees is the one the rules accepted. A spot is [def, u, v, { rot, look, ang, lvl }]
// in 12.5 cm units of the host's own frame (a team desk is 12 by 8, its monitor and keyboard are already on it).
import { applyOps, blockItems, composeVignette, floorItems, ITEM_DEFS } from '../src/shared/space/index.ts';

// How a team desk is dressed. A spot is [def, u, v, { rot, look, ang, lvl }]; a def that starts with `vg_` is a set (a vignette), put down the way the
// build tool puts it down, as its members. Every desk has one thing it is built around, a set or a stack, on one side of the computer, and
// a few things of its own beside it; the side, the set and the mix change from desk to desk so a row of them reads as a row of different people.
const DESKS = [
  // coffee tray on the left, a bottle on the right, a plant and a frame at the back
  [
    ['vg_coffee', 0, 1, { look: 0 }],
    ['water_bottle', 10, 0, { look: 0 }],
    ['potted_plant', 10, 6, { look: 1, ang: 20 }],
    ['frame_small', 6, 7, { look: 2, ang: -6 }],
    ['sticky_notes', 11, 3, { look: 0, ang: 14 }],
  ],
  // a stack of books with a plant on top on the right, headphones and a mug on the left
  [
    ['vg_stack', 10, 1, { rot: 1, look: 1 }],
    ['headphones', 0, 3, { look: 0, ang: 8 }],
    ['mug', 0, 1, { look: 2, ang: 14 }],
    ['lamp_desk', 0, 5, { ang: 10 }],
    ['candle', 10, 6, { look: 2 }],
  ],
  // a runner across the back with its candles, a notebook and a pen cup in front of it
  [
    ['vg_runner', 2, 6, { look: 1 }],
    ['notebook', 0, 1, { look: 3, ang: -4 }],
    ['pen_cup', 0, 4, { look: 2 }],
    ['tumbler', 10, 1, { look: 2 }],
    ['phone_stand', 11, 4, { look: 0, rot: 3, ang: -10 }],
  ],
  // a gadget tray on the left and a reading nook along the back
  [
    ['vg_gadgets', 0, 1, { look: 1 }],
    ['vg_reading', 4, 6, { look: 2 }],
    ['mug', 10, 2, { look: 4, ang: -16 }],
    ['cat_statue', 11, 0, { look: 0, rot: 3 }],
  ],
  // a snack break down the left side, a small stack at the right
  [
    ['vg_snack', 0, 0, { rot: 1, look: 2 }],
    ['vg_stack', 10, 4, { rot: 1, look: 2 }],
    ['lamp_desk', 0, 5, { ang: -8 }],
    ['succulent_trio', 8, 7, { look: 1 }],
    ['water_bottle', 10, 0, { look: 3 }],
  ],
  // the laptop one: a laptop beside the computer, books in a row, glasses on a folder
  [
    ['laptop', 0, 1, { rot: 2, ang: 6 }],
    ['folder', 0, 4, { look: 1, ang: -3 }],
    ['glasses', 0, 4, { lvl: 1, look: 1, ang: -20 }],
    ['books_row', 4, 6, { look: 1 }],
    ['lunchbox', 8, 6, { look: 2, ang: -3 }],
    ['pen_cup', 10, 1, { look: 0 }],
    ['sticky_notes', 11, 4, { look: 1, ang: 18 }],
  ],
];

// The PO's desk has its own planner on the left, so the arrangement keeps to the right and the back.
const PO = [
  ['vg_runner', 2, 6, { look: 2 }],
  ['tumbler', 10, 1, { look: 1 }],
  ['coaster', 10, 3, { look: 1 }],
  ['mug', 10, 3, { lvl: 1, look: 0 }],
  ['frame_small', 11, 4, { look: 3, ang: -5 }],
];

// A round top: a runner along one side with the plant, candles and the cat, a tray and a bowl on the other, and the middle left open.
const HUDDLE = [
  ['vg_runner', 2, 0, { look: 1 }],
  ['vg_coffee', 2, 5, { look: 1 }],
  ['snack_bowl', 7, 6, { look: 2 }],
  ['headphones', 8, 3, { look: 1, ang: 40 }],
];

const TABLE = [
  ['vg_runner', 8, 5, { look: 3 }],
  ['vg_study', 1, 1, { look: 1 }],
  ['vg_snack', 17, 3, { look: 0 }],
  ['laptop', 3, 8, { rot: 2, ang: 5 }],
  ['laptop', 18, 1, { rot: 0, ang: -4 }],
  ['water_bottle', 20, 6, { look: 2 }],
  ['vase', 12, 2, { ang: 0 }],
];

const SHELF = [
  ['vg_stack', 1, 0, { look: 0 }],
  ['vg_runner', 4, 0, { look: 2 }],
  ['frame_small', 13, 1, { look: 2, ang: -6 }],
];

/** Every spot this plan fills, as ops for a story: which hosts are dressed and with what. Hosts that are missing are skipped. */
export function dressingOps(building, { block = 'blk-a', story = 0, table = 'meeting_table:00', shelf = 'bookshelf:50', huddle = `${block}:pod_huddle_table:00` } = {}) {
  const items = floorItems(building.stories[story]);
  const desks = blockItems(building.stories[story], block).filter((i) => i.def === 'bench_desk' || i.def === 'po_desk');
  const plans = [...desks.map((d, n) => [d.id, d.def === 'po_desk' ? PO : DESKS[n % DESKS.length]]), [huddle, HUDDLE], [table, TABLE], [shelf, SHELF]].filter(([id]) => items.some((i) => i.id === id));
  const put = [];
  plans.forEach(([host, spots], n) => {
    spots.forEach(([def, u, v, extra = {}], k) => {
      // The same cluster on another host takes the next look of each thing, so a row of desks is not a row of copies.
      const looks = ITEM_DEFS[def].looks ?? 1;
      const look = ((extra.look ?? 0) + n) % looks;
      if (ITEM_DEFS[def].group) {
        put.push(...composeVignette(ITEM_DEFS[def], host, { rot: extra.rot ?? 0, u, v }, look, (member, i) => `${host}~${def}${k}.${i}:${member}`));
        return;
      }
      const ang = (extra.ang ?? 0) + (extra.ang ? (n % 3) * 3 : 0);
      put.push({ id: `${host}~${def}${k}`, def, on: host, u, v, rot: extra.rot ?? 0, ...(look && { look }), ...(ang && { ang }), ...(extra.lvl && { lvl: extra.lvl }) });
    });
  });
  return put;
}

/** The plan run through the building's own rules one spot at a time, so a stack lands after what carries it. Returns what stays and what was refused. */
export function acceptedDressing(building, ctx, options) {
  const ok = [];
  const refused = [];
  let now = building;
  for (const item of dressingOps(building, options)) {
    const r = applyOps(now, [{ t: 'items', story: options?.story ?? 0, put: [item], del: [] }], ctx);
    if (r.ok) {
      ok.push(item);
      now = r.building;
    } else refused.push({ id: item.id, def: item.def, why: r.violations[0].kind });
  }
  return { ok, refused, building: now };
}
