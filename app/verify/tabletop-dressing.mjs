// What the owner puts on a team's huddle table, a meeting table and a shelf, as data. The team desks are not here: each wears its own things
// from the building itself (`shared/space/dressing.ts`). Shared by the shots script, perf-dressed and dressing-check so the picture the panel
// sees is the one the rules accepted. A spot is [def, u, v, { rot, look, ang, lvl }] in 12.5 cm units of the host's own frame.
import { applyOps, composeVignette, floorItems, ITEM_DEFS } from '../src/shared/space/index.ts';

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
  const plans = [[huddle, HUDDLE], [table, TABLE], [shelf, SHELF]].filter(([id]) => items.some((i) => i.id === id));
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
