// What the desks wear (shared/space/dressing.ts), checked as data with no app. The rules of a cluster, for every arrangement in the data and for every
// cluster a desk of the default office wears: two or three clusters a desk, three or five things in each with a tall, a mid and a low one, something
// resting on something, all of them within a hand's reach of each other and inside their zone, the working zone in front of the keyboard clear, no kind of
// thing twice on a desk but paper and notes. Also: the things are legal ones on the desk, no two desks that stand next to each other wear the same thing,
// a pod shows no plant model more than twice, and what the owner puts down wins. The owner's own dressing plan (tabletop-dressing.mjs), which the shots
// and e2e-tabletop put on tables, is accepted.
// Run from app/: node verify/dressing-check.mjs   Exits 1 on any failed check.
import { applyOps, blockItems, clustersOf, dressingOf, emptyBuilding, floorItems, ITEM_DEFS, legacyBuilding, MANY, NEIGHBOUR_GAP, PAINT, PLANT_MODELS, PLANTS_PER_POD, spotsOf, teamKit, tierOf, WORKING, wornKey, ZONES, encodeBuilding } from '../src/shared/space/index.ts';
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
const key = wornKey;

// Six teams the way the kit lays them out: seven desks each, as the default office has them.
let office = legacyBuilding([], []).building;
const teams = Array.from({ length: 6 }, (_, slot) => ({ id: `blk-${slot}`, slot }));
for (const t of teams) office = must(applyOps(office, teamKit(office, t.id, t.slot), noCtx));
const story = office.stories[0];
const desks = floorItems(story).filter((i) => ITEM_DEFS[i.def].setups);
const wear = dressingOf(story);
const on = (desk, items = wear) => items.filter((i) => i.on === desk.id);

check(dressingOf(story) === wear, 'the dressing of a story is made once per story');
check(desks.length === 42 && desks.every((d) => on(d).length >= 6 && on(d).length <= 11), `${desks.length} desks, each in six to eleven things`, desks.map((d) => on(d).length).join());
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

// The rules of a cluster. `rules` returns what is wrong with a cluster of things (a list of the spots of the data, or what a desk wears), or nothing.
const rectOf = (i) => topRect(i, ITEM_DEFS[i.def]);
const apart = (a, b) => Math.max(b.u0 - a.u1, a.u0 - b.u1, b.v0 - a.v1, a.v0 - b.v1, 0);
const inWindow = (r, window) => window.some((w) => r.u0 >= w[0] && r.v0 >= w[1] && r.u1 <= w[2] && r.v1 <= w[3]);
const rules = (things, zone) => {
  const bad = [];
  const rects = things.map(rectOf);
  if (![3, 5].includes(things.length)) bad.push(`${things.length} things`);
  const tiers = new Set(things.map((i) => tierOf(ITEM_DEFS[i.def])));
  if (tiers.size < 3) bad.push(`tiers ${[...tiers].join()}`);
  if (!things.some((i) => (i.lvl ?? 0) > 0)) bad.push('nothing rests on anything');
  const reached = new Set([0]);
  for (let grew = true; grew; ) {
    grew = false;
    rects.forEach((r, n) => {
      if (!reached.has(n) && [...reached].some((m) => apart(r, rects[m]) <= 1)) (reached.add(n), (grew = true));
    });
  }
  if (reached.size < things.length) bad.push('a thing stands apart from the rest');
  if (!rects.every((r) => inWindow(r, zone.window))) bad.push('out of its zone');
  const [w, d] = [Math.max(...rects.map((r) => r.u1)) - Math.min(...rects.map((r) => r.u0)), Math.max(...rects.map((r) => r.v1)) - Math.min(...rects.map((r) => r.v0))];
  if (w > 5 || d > 5) bad.push(`${w} by ${d} units is not a cluster`);
  return bad;
};
const asThings = (spots, at = [0, 0], zone) => spots.map(([def, u, v, x = {}], n) => ({ id: `s${n}`, def, on: 'd', u: zone.origin[0] + at[0] + u, v: zone.origin[1] + at[1] + v, rot: x.rot ?? 0, ...(x.lvl && { lvl: x.lvl }) }));

// Every cluster in the data: the slots hold what their name says, and it fits a bare desk of each kind where it is written (some anchor of its zone).
const bare = (id) => floorItems(must(applyOps(emptyBuilding({ x0: 0, z0: 0, w: 6, h: 4 }, 1), [paintRect(0, { x: 0, z: 0, w: 6, h: 4 }, PAINT.woodLight), { t: 'items', story: 0, put: [{ id: 'd', def: id, x: 2, z: 2, rot: 0 }], del: [] }], noCtx)).stories[0])[0];
const fits = (things, desk) => {
  const put = [];
  for (const item of [...things].sort((a, b) => (a.lvl ?? 0) - (b.lvl ?? 0))) {
    const d = ITEM_DEFS[item.def];
    if (!d || topViolation(item, d, desk) || put.some((o) => topsClash(o, ITEM_DEFS[o.def], item, d)) || supportViolation(item, d, put)) return false;
    put.push(item);
  }
  return true;
};
const desksBare = { bench_desk: bare('bench_desk'), po_desk: bare('po_desk') };
const dead = [];
const slots = [];
const lonely = [];
let poFits = 0;
const poZones = new Map();
for (const zone of ZONES) {
  zone.pool.forEach((cluster, n) => {
    const at = `${zone.name}#${n}`;
    for (const slot of ['tall', 'mid', 'low']) if (tierOf(ITEM_DEFS[cluster[slot][0]]) !== slot) slots.push(`${at}:${cluster[slot][0]} is not ${slot}`);
    const spots = spotsOf(cluster);
    for (const [def] of spots) if (!MANY.has(def) && spots.filter((s) => s[0] === def).length > 1) slots.push(`${at}:${def} twice`);
    const [anyBench, anyPo] = ['bench_desk', 'po_desk'].map((k) => zone.anchors.some((a) => fits(asThings(spots, a, zone), desksBare[k]) && rules(asThings(spots, a, zone), zone).length === 0));
    if (!anyBench) dead.push(`${at}:${rules(asThings(spots, zone.anchors[0], zone), zone).join('+') || 'does not fit a bench desk'}`);
    if (anyPo) poZones.set(zone.name, (poZones.get(zone.name) ?? 0) + 1);
  });
}
check(slots.length === 0, 'in every cluster of the data the tall, mid and low slots hold a tall, a mid and a low thing, and no kind is twice but paper and notes', slots.join(' '));
check(dead.length === 0, `all ${ZONES.reduce((n, z) => n + z.pool.length, 0)} clusters of the data (${ZONES.map((z) => `${z.pool.length} ${z.name}`).join(', ')}) are three or five things of three heights, one on another, within reach, in their zone, and fit a bare desk`, dead.join(' '));
check(ZONES.every((z) => (poZones.get(z.name) ?? 0) >= 4), `a PO desk, whose second screen takes the front left, still fits at least four clusters of each zone`, JSON.stringify([...poZones]));
const cells = (z) => z.window.flatMap(([u0, v0, u1, v1]) => Array.from({ length: (u1 - u0) * (v1 - v0) }, (_, k) => `${u0 + (k % (u1 - u0))},${v0 + Math.floor(k / (u1 - u0))}`));
const seen = new Set();
const twice = ZONES.flatMap((z) => cells(z).filter((c) => (seen.has(c) ? true : (seen.add(c), false))));
check(twice.length === 0, 'the three zones of a desk share no cell', twice.join(' '));
const working = [...seen].filter((c) => { const [u, v] = c.split(',').map(Number); return u >= WORKING[0] && u < WORKING[2] && v >= WORKING[1] && v < WORKING[3]; });
check(working.length === 0, 'and none of them is in the working zone in front of the keyboard');

// Every cluster a desk of the default office wears obeys the same rules, and a desk wears two or three of them, one a zone.
const clusters = clustersOf(story);
const broken = [];
for (const d of desks) {
  const worn = clusters.get(d.id) ?? [];
  if (worn.length < 2 || worn.length > 3 || new Set(worn.map((w) => w.zone)).size !== worn.length) broken.push(`${d.id}: ${worn.map((w) => w.zone).join()}`);
  for (const w of worn) for (const why of rules(w.things, ZONES.find((z) => z.name === w.zone))) broken.push(`${d.id}/${w.zone}: ${why}`);
  const kinds = on(d).map((i) => i.def).filter((def) => !MANY.has(def));
  if (new Set(kinds).size !== kinds.length) broken.push(`${d.id}: a kind twice`);
  const inWork = on(d).filter((i) => apart(rectOf(i), { u0: WORKING[0], v0: WORKING[1], u1: WORKING[2], v1: WORKING[3] }) === 0 && unitsOverlap(rectOf(i), { u0: WORKING[0], v0: WORKING[1], u1: WORKING[2], v1: WORKING[3] }) && i.def !== 'notebook');
  if (inWork.length) broken.push(`${d.id}: ${inWork.map((i) => i.def).join()} in the working zone`);
}
check(broken.length === 0, `each of the ${desks.length} desks wears two or three clusters of three or five, one a zone, and nothing in front of the keyboard`, broken.slice(0, 6).join(' | '));
const counts = desks.map((d) => (clusters.get(d.id) ?? []).length);
const sizes = desks.flatMap((d) => (clusters.get(d.id) ?? []).map((w) => w.things.length));
check(counts.includes(2) && counts.includes(3) && sizes.includes(3) && sizes.includes(5), `desks differ in how full they are (${counts.filter((n) => n === 2).length} desks of two clusters, ${counts.filter((n) => n === 3).length} of three; ${sizes.filter((n) => n === 3).length} clusters of three things, ${sizes.filter((n) => n === 5).length} of five)`);
const spread = desks.map((d) => on(d).length);
check(Math.max(...spread) - Math.min(...spread) >= 3, `from ${Math.min(...spread)} to ${Math.max(...spread)} things a desk, ${(spread.reduce((a, b) => a + b, 0) / spread.length).toFixed(1)} on average`);
check(pods.every((pod) => new Set(pod.flatMap((d) => on(d).map((i) => i.def))).size >= 20), 'a pod of seven desks shows at least 20 kinds of thing', pods.map((p) => new Set(p.flatMap((d) => on(d).map((i) => i.def))).size).join());

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
