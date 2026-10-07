// The dressed office the shots show, checked as data with no app: the plan is accepted by the building's rules, no two desks that stand
// next to each other wear the same computer or the same dressing, and every desk is built around one thing of its own.
// Run from app/: node verify/dressing-check.mjs   Exits 1 on any failed check.
import { ITEM_DEFS, legacyBuilding, NEIGHBOUR_GAP, setupsOf, blockItems } from '../src/shared/space/index.ts';
import { itemRect } from '../src/shared/space/geom.ts';
import { check, finish } from './check.ts';
import { acceptedDressing, dressingOps } from './tabletop-dressing.mjs';

const { building } = legacyBuilding([{ id: 'blk-a', slot: 0 }, { id: 'blk-b', slot: 1 }], [{ id: 'e1', blockId: 'blk-a', desk: 0, orchestrator: true }, { id: 'e2', blockId: 'blk-a', desk: 0, orchestrator: false }, { id: 'e3', blockId: 'blk-a', desk: 1, orchestrator: false }, { id: 'e4', blockId: 'blk-b', desk: 0, orchestrator: false }]);
const ctx = { blocks: new Set(['blk-a', 'blk-b']), employees: new Map(), seats: new Map() };
const { ok, refused, building: dressed } = acceptedDressing(building, ctx);
check(refused.length === 0 && ok.length >= 60, `the dressing plan is accepted by the building's rules (${ok.length} things, ${refused.length} refused)`, JSON.stringify(refused));

const story = dressed.stories[0];
const desks = blockItems(story, 'blk-a').filter((i) => ITEM_DEFS[i.def].setups);
const setups = setupsOf(story);
const gap = (a, b) => {
  const [p, q] = [itemRect(a, ITEM_DEFS[a.def]), itemRect(b, ITEM_DEFS[b.def])];
  return Math.max(q.x0 - p.x1, p.x0 - q.x1, q.z0 - p.z1, p.z0 - q.z1, 0);
};
// What stands on a desk, as the list of its things and their looks, whatever order they were put down in.
const dressing = (desk) => story.items.filter((i) => i.on === desk.id).map((i) => `${i.def}#${i.look ?? 0}`).sort().join(',');
const heights = (desk) => new Set(story.items.filter((i) => i.on === desk.id).map((i) => Math.round(ITEM_DEFS[i.def].height * 100))).size;

let alike = [];
let sameSetup = [];
for (const [n, a] of desks.entries()) {
  for (const b of desks.slice(n + 1)) {
    if (gap(a, b) >= NEIGHBOUR_GAP) continue;
    if (dressing(a) === dressing(b)) alike.push(`${a.id}~${b.id}`);
    if (setups.get(a.id) === setups.get(b.id)) sameSetup.push(`${a.id}~${b.id}`);
  }
}
check(desks.length >= 7 && sameSetup.length === 0, `${desks.length} desks of a team: no two neighbours wear the same computer`, sameSetup.join());
check(alike.length === 0, 'and no two neighbours carry the same things', alike.join());
check(desks.every((d) => heights(d) >= 4), 'every desk has things of at least four different heights on it', desks.map((d) => heights(d)).join());

// Each desk is built around one thing: a set, or a stack of something with a tall piece on it.
const sets = (desk) => dressingOps(building).filter((i) => i.on === desk.id && i.id.includes('~vg_')).length;
check(desks.filter((d) => d.def === 'bench_desk').every((d) => sets(d) >= 3 || story.items.some((i) => i.on === d.id && (i.lvl ?? 0) >= 1)), 'every team desk has a set or a stack on it');
const kinds = new Set(desks.map((d) => dressing(d)));
check(kinds.size === desks.length, `${kinds.size} different ways to dress the ${desks.length} desks`);
finish();
