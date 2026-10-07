import { applyOps, clustersOf, floorItems, ITEM_DEFS, legacyBuilding, teamKit, blockItems } from '../src/shared/space/index.ts';
const noCtx = { blocks: new Set(), employees: new Map(), seats: new Map() };
let office = legacyBuilding([], []).building;
for (let slot = 0; slot < 6; slot++) office = applyOps(office, teamKit(office, `blk-${slot}`, slot), noCtx).building;
const story = office.stories[0];
const c = clustersOf(story);
for (const d of floorItems(story).filter((i) => ITEM_DEFS[i.def].setups).slice(0, 14)) {
  console.log(d.id, (c.get(d.id) ?? []).map((w) => w.zone + ':' + w.things.map((t) => t.def + (t.lvl ? '^' + t.lvl : '')).join('+')).join('  |  '));
}
const pod = new Map();
for (const d of floorItems(story).filter((i) => ITEM_DEFS[i.def].setups)) for (const w of c.get(d.id) ?? []) for (const t of w.things) pod.set(d.blockId + '|' + t.def, (pod.get(d.blockId + '|' + t.def) ?? 0) + 1);
console.log([...pod].filter(([k]) => /plant|succ|cactus|pothos/.test(k)).filter(([k]) => k.startsWith('blk-0')).join(' '));
