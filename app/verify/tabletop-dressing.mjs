// A dressed office, as data: what stands where on a team's desks, its huddle table, a meeting table and a shelf. Shared by the shots
// script and e2e-tabletop so the picture the panel sees is the one the rules accepted. A spot is [def, u, v, { rot, look, ang, lvl }]
// in 12.5 cm units of the host's own frame (a team desk is 12 by 8, its monitor and keyboard are already on it).
import { applyOps, blockItems, floorItems, ITEM_DEFS } from '../src/shared/space/index.ts';

// Four ways to clutter a team desk. Each keeps to one corner and lets another stay bare, so a row of them is not a row of copies.
const DESKS = [
  // a student's: notebook with a mug on it, headphones, a succulent, a bottle by the mouse hand
  [
    ['notebook', 0, 1, { look: 0, ang: -5 }],
    ['mug', 1, 1, { lvl: 1, look: 1, ang: 24 }],
    ['headphones', 0, 4, { look: 0, ang: 8 }],
    ['succulent', 0, 6, { look: 0, ang: 20 }],
    ['water_bottle', 10, 0, { look: 0 }],
    ['sticky_notes', 11, 2, { look: 0, ang: -14 }],
    ['books_row', 3, 6, { look: 1 }],
    ['frame_small', 7, 6, { look: 1, ang: -6 }],
    ['desk_clock', 9, 6, { ang: 4 }],
  ],
  // a tidy one: folder under the lamp, tumbler, organizer at the back
  [
    ['folder', 0, 0, { look: 1, ang: 3 }],
    ['notebook', 0, 2, { look: 2, ang: -3 }],
    ['coaster', 0, 5, { look: 1 }],
    ['mug', 0, 5, { lvl: 1, look: 0 }],
    ['tumbler', 10, 0, { look: 2 }],
    ['phone_stand', 11, 2, { look: 0, rot: 3, ang: -10 }],
    ['desk_organizer', 3, 6, { look: 0, ang: 2 }],
    ['succulent_trio', 6, 6, { look: 0 }],
    ['lamp_desk', 9, 5, { ang: 10 }],
  ],
  // a busy one: magazines, snack bowl, calculator, papers
  [
    ['magazine', 0, 1, { look: 1, ang: -9 }],
    ['magazine', 0, 1, { lvl: 1, look: 3, ang: 7 }],
    ['takeaway_cup', 0, 5, { look: 1 }],
    ['snack_bowl', 1, 6, { look: 0 }],
    ['calculator', 10, 1, { look: 0, ang: 12 }],
    ['papers', 3, 6, { look: 1, ang: -4 }],
    ['stapler', 7, 6, { look: 1, ang: 6 }],
    ['pen_cup', 10, 3, { look: 2 }],
    ['candle', 9, 6, { look: 2 }],
  ],
  // the corner one: laptop and a stack of books, a cat
  [
    ['laptop', 0, 0, { rot: 2, ang: 6 }],
    ['books', 0, 3, { look: 2, ang: -7 }],
    ['books', 0, 3, { lvl: 1, look: 0, ang: 9 }],
    ['mug', 0, 3, { lvl: 2, look: 3, ang: 30 }],
    ['cat_statue', 11, 0, { look: 0, rot: 3 }],
    ['lunchbox', 3, 6, { look: 2, ang: -3 }],
    ['sticky_notes', 7, 6, { look: 1, ang: 18 }],
    ['glasses', 9, 6, { look: 1, ang: -20 }],
    ['pen_cup', 10, 2, { look: 0 }],
  ],
];

// The PO's desk has its own pad of papers on the left, so the clutter keeps to the right and the back.
const PO = [
  ['succulent', 0, 4, { look: 1, ang: 10 }],
  ['notebook', 0, 6, { look: 1, ang: 4 }],
  ['coaster', 10, 0, { look: 2 }],
  ['tumbler', 10, 0, { lvl: 1, look: 1 }],
  ['sticky_notes', 11, 2, { look: 2, ang: 16 }],
  ['frame_small', 10, 4, { look: 3, ang: -5 }],
  ['books_row', 4, 6, { look: 0 }],
  ['cat_statue', 8, 6, { look: 1, rot: 3 }],
];

// A round top: everything stays within three units of its middle.
const HUDDLE = [
  ['succulent', 5, 3, { look: 3, ang: 15 }],
  ['notebook', 3, 5, { look: 3, ang: 10 }],
  ['mug', 4, 5, { lvl: 1, look: 2, ang: -30 }],
  ['snack_bowl', 7, 5, { look: 2 }],
  ['books', 6, 1, { look: 1, ang: -18 }],
  ['headphones', 3, 2, { look: 1, ang: 40 }],
  ['tumbler', 8, 3, { look: 0 }],
];

const TABLE = [
  ['vase', 12, 4, { ang: 0 }],
  ['laptop', 3, 2, { rot: 0, ang: -4 }],
  ['laptop', 3, 8, { rot: 2, ang: 5 }],
  ['folder', 8, 4, { look: 0, ang: -8 }],
  ['coaster', 15, 3, { look: 0 }],
  ['water_bottle', 15, 3, { look: 2, lvl: 1 }],
  ['books_row', 18, 8, { look: 2 }],
  ['succulent_trio', 12, 8, { look: 1 }],
];

const SHELF = [
  ['books_row', 1, 0, { look: 0 }],
  ['succulent', 6, 0, { look: 2 }],
  ['frame_small', 9, 0, { look: 2, ang: -6 }],
  ['candle', 11, 0, { look: 1 }],
  ['cat_statue', 13, 1, { look: 1 }],
];

/** Every spot this plan fills, as ops for a story: which hosts are dressed and with what. Hosts that are missing are skipped. */
export function dressingOps(building, { block = 'blk-a', story = 0, table = 'meeting_table:00', shelf = 'bookshelf:50', huddle = `${block}:pod_huddle_table:00` } = {}) {
  const items = floorItems(building.stories[story]);
  const desks = blockItems(building.stories[story], block).filter((i) => i.def === 'bench_desk' || i.def === 'po_desk');
  const plans = [...desks.map((d, n) => [d.id, d.def === 'po_desk' ? PO : DESKS[n % DESKS.length]]), [huddle, HUDDLE], [table, TABLE], [shelf, SHELF]].filter(([id]) => items.some((i) => i.id === id));
  const put = [];
  plans.forEach(([host, spots], n) => {
    spots.forEach(([def, u, v, extra = {}], k) => {
      // The same cluster on another desk takes the next look of each thing, so a row of desks is not a row of copies.
      const looks = ITEM_DEFS[def].looks ?? 1;
      const look = ((extra.look ?? 0) + n) % looks;
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
