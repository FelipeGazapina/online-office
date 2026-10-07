// No desk wears anything on its own, checked as data with no app. A desk keeps its computer (setups) and its computer varies from desk to desk; whatever else
// stands on a desk is a thing the owner put there, stored in the building, and nothing else changes when it comes or goes. Every small thing the owner can put
// on a top is in the Tabletop catalog, and the owner's own dressing plan (tabletop-dressing.mjs), which the shots and e2e-tabletop put on tables, is accepted.
// Run from app/: node verify/dressing-check.mjs   Exits 1 on any failed check.
import { applyOps, blockItems, encodeBuilding, floorItems, isTop, ITEM_DEFS, legacyBuilding, NEIGHBOUR_GAP, parseBuilding, SETUP_COUNT, setupsOf, teamKit, VIGNETTES } from '../src/shared/space/index.ts';
import { itemRect } from '../src/shared/space/geom.ts';
import { ENTRIES } from '../src/renderer/src/hud/build/catalog.ts';
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

// Six teams the way the kit lays them out: seven desks each, as the default office has them.
let office = legacyBuilding([], []).building;
const teams = Array.from({ length: 6 }, (_, slot) => ({ id: `blk-${slot}`, slot }));
for (const t of teams) office = must(applyOps(office, teamKit(office, t.id, t.slot), noCtx));
const story = office.stories[0];
const desks = floorItems(story).filter((i) => ITEM_DEFS[i.def].setups);
const standing = (s, desk) => s.items.filter((i) => i.on === desk.id);

check(desks.length === 42, `${desks.length} desks in six teams`);
check(desks.every((d) => standing(story, d).length === 0) && !story.items.some(isTop), 'a fresh team office has nothing on any desk, and nothing standing on anything else either');
const first = legacyBuilding([{ id: 'blk-a', slot: 0 }], [{ id: 'e1', blockId: 'blk-a', desk: 0, orchestrator: true }, { id: 'e2', blockId: 'blk-a', desk: 1, orchestrator: false }]).building.stories[0];
const firstDesks = floorItems(first).filter((i) => ITEM_DEFS[i.def].setups);
check(firstDesks.length >= 2 && !first.items.some(isTop), `and so does the default office (${firstDesks.length} desks)`);

const setups = setupsOf(story);
check(new Set(desks.map((d) => setups.get(d.id))).size === SETUP_COUNT, `all ${SETUP_COUNT} computers are in use across ${desks.length} desks`);
const perTeam = teams.map((t) => new Set(blockItems(story, t.id).filter((i) => ITEM_DEFS[i.def].setups).map((d) => setups.get(d.id))).size);
check(perTeam.every((n) => n >= 5), `each team shows at least five different computers (${perTeam.join(', ')})`);
const alike = desks.flatMap((a, n) => desks.slice(n + 1).filter((b) => gap(a, b) < NEIGHBOUR_GAP && setups.get(a.id) === setups.get(b.id)).map((b) => `${a.id}~${b.id}`));
check(alike.length === 0, 'no two neighbouring desks share a computer', alike.slice(0, 6).join(' '));

{
  const [a, b] = desks;
  const mug = { id: 'owner-mug', def: 'mug', on: a.id, u: 1, v: 6, rot: 0 };
  const duck = { id: 'owner-duck', def: 'rubber_duck', on: a.id, u: 10, v: 6, rot: 0 };
  const placed = must(applyOps(office, [{ t: 'items', story: 0, put: [mug, duck], del: [] }], noCtx));
  const s = placed.stories[0];
  check(standing(s, a).map((i) => i.id).sort().join() === 'owner-duck,owner-mug' && s.items.length === story.items.length + 2, 'a mug and a duck the owner puts on a desk are the only things on it, and the story gains those two');
  check(standing(s, b).length === 0 && desks.slice(1).every((d) => standing(s, d).length === 0), 'and no other desk gains anything');
  const stored = parseBuilding(encodeBuilding(placed), () => {}).stories[0];
  check(stored.items.filter(isTop).map((i) => i.id).sort().join() === 'owner-duck,owner-mug', 'the building file holds exactly those two small things');
  const gone = must(applyOps(placed, [{ t: 'items', story: 0, put: [], del: ['owner-mug', 'owner-duck'] }], noCtx)).stories[0];
  check(!gone.items.some(isTop) && gone.items.length === story.items.length, 'taking them away leaves the desk bare, with nothing worn in their place');
  check(setupsOf(s).get(a.id) === setups.get(a.id), "and putting things on a desk does not change its computer");
}

{
  const listed = new Set(ENTRIES.filter((e) => e.kind === 'item' && e.tab === 'tabletop').map((e) => e.def));
  const missing = Object.values(ITEM_DEFS).filter((d) => d.placement === 'surface' && !d.group && !listed.has(d.id)).map((d) => d.id);
  check(missing.length === 0, `every small thing is a card in the Tabletop tab (${Object.values(ITEM_DEFS).filter((d) => d.placement === 'surface' && !d.group).length} of them)`, missing.join(' '));
  check(VIGNETTES.every((v) => listed.has(v.id)), `and so is each of the ${VIGNETTES.length} sets`);
  const names = ENTRIES.filter((e) => e.tab === 'tabletop' && e.kind === 'item' && !e.id.startsWith('tabletop:')).map((e) => e.name);
  check(new Set(names).size === names.length, 'and no two cards of the tab share a name', names.filter((n, i) => names.indexOf(n) !== i).join(' '));
}

{
  const { building } = legacyBuilding([{ id: 'blk-a', slot: 0 }, { id: 'blk-b', slot: 1 }], [{ id: 'e1', blockId: 'blk-a', desk: 0, orchestrator: true }, { id: 'e2', blockId: 'blk-a', desk: 0, orchestrator: false }, { id: 'e3', blockId: 'blk-a', desk: 1, orchestrator: false }, { id: 'e4', blockId: 'blk-b', desk: 0, orchestrator: false }]);
  const ctx = { blocks: new Set(['blk-a', 'blk-b']), employees: new Map(), seats: new Map() };
  const { ok, refused } = acceptedDressing(building, ctx);
  check(refused.length === 0 && ok.length >= 40, `the owner's dressing plan is accepted by the building's rules (${ok.length} things, ${refused.length} refused)`, JSON.stringify(refused));
}
finish();
