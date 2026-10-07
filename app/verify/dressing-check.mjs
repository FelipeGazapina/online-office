// What the desks wear (shared/space/dressing.ts), checked as data with no app: the things are legal ones on the desk, no two desks that stand
// next to each other wear the same thing, a pod shows no plant model more than twice, every desk has a story of its own, and what the
// owner puts down wins. Also the owner's own dressing plan (tabletop-dressing.mjs), which the shots and e2e-tabletop put on tables, is accepted.
// Run from app/: node verify/dressing-check.mjs   Exits 1 on any failed check.
import { applyOps, blockItems, dressingOf, emptyBuilding, floorItems, ITEM_DEFS, legacyBuilding, NEIGHBOUR_GAP, PAINT, PLANT_MODELS, PLANTS_PER_POD, teamKit, ZONES, encodeBuilding } from '../src/shared/space/index.ts';
import { itemRect } from '../src/shared/space/geom.ts';
import { supportViolation, topRect, topsClash, topViolation, unitsOverlap } from '../src/shared/space/surface.ts';
import { paintRect } from '../src/shared/space/builders.ts';
import { check, finish } from './check.ts';
import { acceptedDressing } from './tabletop-dressing.mjs';

const noCtx = { blocks: new Set(), employees: new Map(), seats: new Map() };
const must = (r) => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.violations)}`);
  return r.building;
};
const gap = (a, b) => {
  const [p, q] = [itemRect(a, ITEM_DEFS[a.def]), itemRect(b, ITEM_DEFS[b.def])];
  return Math.max(q.x0 - p.x1, p.x0 - q.x1, q.z0 - p.z1, p.z0 - q.z1, 0);
};
const key = (i) => `${i.def}#${i.look ?? 0}`;

// Six teams the way the kit lays them out: seven desks each, as the default office has them.
let office = legacyBuilding([], []).building;
const teams = Array.from({ length: 6 }, (_, slot) => ({ id: `blk-${slot}`, slot }));
for (const t of teams) office = must(applyOps(office, teamKit(office, t.id, t.slot), noCtx));
const story = office.stories[0];
const desks = floorItems(story).filter((i) => ITEM_DEFS[i.def].setups);
const wear = dressingOf(story);
const on = (desk, items = wear) => items.filter((i) => i.on === desk.id);

check(dressingOf(story) === wear, 'the dressing of a story is made once per story');
check(desks.length === 42 && desks.every((d) => on(d).length >= 6), `${desks.length} desks, each in at least six things`, desks.map((d) => on(d).length).join());
check(new Set(wear.map((i) => i.id)).size === wear.length, 'every thing has an id of its own');

// The things are the building's own kind of thing: put down as real ones, the rules accept every one, in the order of a stack.
const real = must(applyOps(office, [{ t: 'items', story: 0, put: wear, del: [] }], noCtx));
check(real.stories[0].items.length === story.items.length + wear.length, `the rules accept all ${wear.length} things on ${desks.length} desks when put down as real ones`);
check(!JSON.stringify(encodeBuilding(office)).includes('~wear'), 'nothing of it is written to the building file');

// No two desks within a meter of each other wear the same thing (a def in the same look); no two share the same arrangement of the zone either.
const neighbours = desks.flatMap((a, n) => desks.slice(n + 1).filter((b) => gap(a, b) < NEIGHBOUR_GAP).map((b) => [a, b]));
const shared = neighbours.flatMap(([a, b]) => {
  const mine = new Set(on(a).map(key));
  return on(b).filter((i) => mine.has(key(i))).map((i) => `${a.id}~${b.id}:${key(i)}`);
});
check(neighbours.length >= 60 && shared.length === 0, `${neighbours.length} pairs of neighbouring desks share no thing`, shared.slice(0, 6).join(' '));
const signature = (d) => on(d).map(key).sort().join(',');
check(new Set(desks.map(signature)).size === desks.length, `${desks.length} different ways to dress ${desks.length} desks`);

// A pod shows each plant model at most twice, and every pod has a mix of species.
const pods = teams.map((t) => blockItems(story, t.id).filter((i) => ITEM_DEFS[i.def].setups));
const plantsIn = (pod) => {
  const n = new Map();
  for (const d of pod) for (const i of on(d)) if (PLANT_MODELS.has(i.def)) n.set(i.def, (n.get(i.def) ?? 0) + 1);
  return n;
};
check(pods.every((pod) => [...plantsIn(pod).values()].every((n) => n <= PLANTS_PER_POD)), `no pod shows a plant model more than ${PLANTS_PER_POD} times`, pods.map((p) => JSON.stringify([...plantsIn(p)])).join(' '));
check(pods.every((pod) => plantsIn(pod).size >= 3), 'and every pod shows at least three kinds of plant', pods.map((p) => plantsIn(p).size).join());
check(pods.every((pod) => new Set(pod.flatMap((d) => on(d).map((i) => i.def))).size >= 25), 'a pod of seven desks shows at least 25 kinds of thing', pods.map((p) => new Set(p.flatMap((d) => on(d).map((i) => i.def))).size).join());

// Each desk has a story: things at different heights, some in front where the hands work (not only along the back edge), and some resting on each other.
const heights = (d) => new Set(on(d).map((i) => Math.round(ITEM_DEFS[i.def].height * 100))).size;
const front = (d) => on(d).filter((i) => i.v < 4).length;
const stacked = (d) => on(d).filter((i) => (i.lvl ?? 0) > 0).length;
check(desks.every((d) => heights(d) >= 5), 'every desk has things of at least five different heights', desks.map(heights).join());
check(desks.every((d) => front(d) >= 2), 'every desk has at least two things in front, where the hands work', desks.map(front).join());
check(desks.filter((d) => stacked(d) >= 1).length >= desks.length * 0.6, `${desks.filter((d) => stacked(d) >= 1).length} of ${desks.length} desks have a thing resting on another`);
const spread = desks.map((d) => on(d).length);
check(Math.max(...spread) - Math.min(...spread) >= 4, `desks differ in how full they are (${Math.min(...spread)} to ${Math.max(...spread)} things)`);

// Every arrangement fits a bare desk where it is written, so none of the data is dead, and none stands in the computer.
const bare = floorItems(must(applyOps(emptyBuilding({ x0: 0, z0: 0, w: 6, h: 4 }, 1), [paintRect(0, { x: 0, z: 0, w: 6, h: 4 }, PAINT.woodLight), { t: 'items', story: 0, put: [{ id: 'd', def: 'bench_desk', x: 2, z: 2, rot: 0 }], del: [] }], noCtx)).stories[0])[0];
const dead = [];
for (const zone of ZONES) {
  zone.pool.forEach((spots, n) => {
    const put = [];
    for (const [def, u, v, x = {}] of spots) {
      const item = { id: `${zone.name}${n}${put.length}`, def, on: 'd', u: zone.origin[0] + u, v: zone.origin[1] + v, rot: x.rot ?? 0, ...(x.lvl && { lvl: x.lvl }) };
      const d = ITEM_DEFS[def];
      const bad = !d || topViolation(item, d, bare) || put.some((o) => topsClash(o, ITEM_DEFS[o.def], item, d) || (o.lvl ?? 0) === (item.lvl ?? 0) && unitsOverlap(topRect(o, ITEM_DEFS[o.def]), topRect(item, d))) || supportViolation(item, d, put);
      if (bad) dead.push(`${zone.name}#${n}:${def}`);
      put.push(item);
    }
  });
}
check(dead.length === 0, `all ${new Set(ZONES.map((z) => z.pool)).size} lists of arrangements (${[...new Set(ZONES.map((z) => z.pool))].reduce((n, p) => n + p.length, 0)} in all) fit a bare desk`, dead.join(' '));

// What the owner puts on a desk wins: nothing worn touches it, and the rest of the desk and the desks of other teams stay as they were.
{
  const desk = desks[3];
  const mine = on(desk);
  const target = mine.find((i) => i.v < 4);
  const owner = { id: 'owner-mug', def: 'mug', on: desk.id, u: target.u, v: target.v, rot: 0 };
  const after = must(applyOps(office, [{ t: 'items', story: 0, put: [owner], del: [] }], noCtx));
  const next = dressingOf(after.stories[0]);
  const touching = on(desk, next).filter((i) => unitsOverlap(topRect(i, ITEM_DEFS[i.def]), topRect(owner, ITEM_DEFS.mug)));
  check(touching.length === 0, 'nothing worn stands where the owner put a mug');
  const kept = on(desk, next).filter((i) => mine.some((m) => key(m) === key(i) && m.u === i.u && m.v === i.v));
  check(kept.length >= mine.length - 4 && kept.length < mine.length, `the desk keeps most of what it wore (${kept.length} of ${mine.length} things)`);
  const others = desks.filter((d) => d.id !== desk.id && gap(d, desk) >= NEIGHBOUR_GAP && d.blockId !== desk.blockId);
  check(others.every((d) => signature(d) === on(d, next).map(key).sort().join(',')), 'desks of other teams wear the same things as before');
}

// The plants the owner stood on a pod's huddle table count toward the pod's two of each model.
{
  const { building: pods } = legacyBuilding([{ id: 'blk-a', slot: 0 }, { id: 'blk-b', slot: 1 }], [{ id: 'e1', blockId: 'blk-a', desk: 0, orchestrator: true }, { id: 'e2', blockId: 'blk-b', desk: 0, orchestrator: true }]);
  const huddle = 'blk-a:pod_huddle_table:00';
  const spots = [['potted_plant', 2, 0], ['potted_plant', 5, 0], ['succulent', 2, 5], ['succulent', 5, 5]];
  const planted = must(applyOps(pods, [{ t: 'items', story: 0, put: spots.map(([def, u, v], n) => ({ id: `plant-${n}`, def, on: huddle, u, v, rot: 0 })), del: [] }], noCtx)).stories[0];
  const wearing = (story, block, defs) => blockItems(story, block).filter((i) => ITEM_DEFS[i.def].setups).flatMap((d) => dressingOf(story).filter((i) => i.on === d.id && defs.includes(i.def)));
  check(wearing(pods.stories[0], 'blk-a', ['potted_plant', 'succulent']).length > 0, 'a pod with a bare huddle table wears potted plants and succulents on its desks');
  check(wearing(planted, 'blk-a', ['potted_plant', 'succulent']).length === 0, 'with two of each on its huddle table, its desks wear neither');
  check(wearing(planted, 'blk-b', ['potted_plant', 'succulent']).length === wearing(pods.stories[0], 'blk-b', ['potted_plant', 'succulent']).length, 'and the other pod is not held to it');
}

// A packed floor of desks with ids picked to collide: still nothing shared between neighbours, over many layouts.
let worst = 0;
let plantsOver = 0;
for (let round = 0; round < 60; round++) {
  const grid = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) grid.push({ id: `d${(round * 7919 + r * 31 + c * 7) % 1000}-${r}${c}`, def: round % 2 ? 'bench_desk' : 'po_desk', x: 2 + c * 3, z: 2 + r * 2, rot: (r + c) % 2 ? 2 : 0 });
  const packed = must(applyOps(emptyBuilding({ x0: 0, z0: 0, w: 14, h: 10 }, 1), [paintRect(0, { x: 0, z: 0, w: 14, h: 10 }, PAINT.woodLight), { t: 'items', story: 0, put: grid, del: [] }], noCtx));
  const s = packed.stories[0];
  const ds = floorItems(s).filter((i) => ITEM_DEFS[i.def].setups);
  const w = dressingOf(s);
  for (const [n, a] of ds.entries()) {
    for (const b of ds.slice(n + 1)) {
      if (gap(a, b) >= NEIGHBOUR_GAP) continue;
      const mine = new Set(on(a, w).map(key));
      worst += on(b, w).filter((i) => mine.has(key(i))).length;
    }
  }
  const per = new Map();
  for (const i of w) if (PLANT_MODELS.has(i.def)) per.set(i.def, (per.get(i.def) ?? 0) + 1);
  plantsOver += [...per.values()].filter((n) => n > PLANTS_PER_POD).length;
  must(applyOps(packed, [{ t: 'items', story: 0, put: w, del: [] }], noCtx));
}
check(worst === 0, 'a packed floor of 24 desks, 60 layouts: no two neighbours share a thing, and the rules accept every thing', String(worst));
check(plantsOver === 0, 'and one pod of them never shows a plant model more than twice', String(plantsOver));

// The owner's dressing plan of tables and shelves, as the shots and e2e-tabletop put it down, is accepted by the rules.
{
  const { building } = legacyBuilding([{ id: 'blk-a', slot: 0 }, { id: 'blk-b', slot: 1 }], [{ id: 'e1', blockId: 'blk-a', desk: 0, orchestrator: true }, { id: 'e2', blockId: 'blk-a', desk: 0, orchestrator: false }, { id: 'e3', blockId: 'blk-a', desk: 1, orchestrator: false }, { id: 'e4', blockId: 'blk-b', desk: 0, orchestrator: false }]);
  const ctx = { blocks: new Set(['blk-a', 'blk-b']), employees: new Map(), seats: new Map() };
  const { ok, refused } = acceptedDressing(building, ctx);
  check(refused.length === 0 && ok.length >= 40, `the dressing plan is accepted by the building's rules (${ok.length} things, ${refused.length} refused)`, JSON.stringify(refused));
}
finish();
