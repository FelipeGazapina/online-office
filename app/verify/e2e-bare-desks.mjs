// Desks wear their computer and nothing else, on the real app: the scene draws no small thing the building does not hold, every desk's computer is drawn
// and the computers vary, and what the owner puts on a desk is drawn once where it was put and is gone when it is taken away.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/e2e-bare-desks.mjs
// OFFICE_OWNER_COMPANY=<path to a company.json> runs it on a scratch copy of that company instead of the fixture: every block's cwd becomes the scratch repo
// and every employee loses its workspace path, so nothing points at the owner's repos or worktrees. The file itself is only read.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { floorItems, footprint, isTop, ITEM_DEFS, parseBuilding } from '../src/shared/space/index.ts';
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
const source = process.env.OFFICE_OWNER_COMPANY;
const company = JSON.parse(readFileSync(source ?? new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
if (source) {
  for (const b of company.blocks) b.cwd = repo;
  for (const e of company.employees) delete e.workspace;
}
writeFileSync(join(dataDir, 'company.json'), JSON.stringify(company));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const file = join(dataDir, 'company.json');
const small = (def) => ITEM_DEFS[def]?.placement === 'surface';
const tops = (b) => b.stories.flatMap((st) => st.items.filter(isTop));
const onDisk = () => parseBuilding(JSON.parse(readFileSync(file, 'utf8')).building, () => {});

export default async function (s) {
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.sleep(2500);
  const b0 = await s.eval(`${store}.building`);
  const start = tops(b0);
  const desks = b0.stories.flatMap((st, level) => floorItems(st).filter((i) => ITEM_DEFS[i.def].setups).map((d) => ({ ...d, level })));
  assert(desks.length >= 4, `${desks.length} desks across ${b0.stories.length} floors, and ${start.length} small things the building holds`);
  const bareDesks = desks.filter((d) => !start.some((t) => t.on === d.id));
  assert(bareDesks.length > 0, `${bareDesks.length} of them have nothing of the owner's on them`);

  const drawnOf = async () => {
    const found = new Map();
    for (const m of await s.eval(`__office.probe('model')`)) if (small(m.def)) found.set(m.def, (found.get(m.def) ?? 0) + m.count);
    return found;
  };
  const held = (list) => {
    const n = new Map();
    for (const t of list.filter((i) => small(i.def))) n.set(t.def, (n.get(t.def) ?? 0) + 1);
    return n;
  };
  const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  const before = await drawnOf();
  assert(same(before, held(start)), `the scene draws the ${start.length} small things the building holds and no others (${JSON.stringify([...before])})`);

  const meshes = await s.eval(`__office.probe('screens')`);
  const lit = meshes.flatMap((m) => m.desks);
  assert(new Set(lit).size === lit.length && desks.every((d) => lit.includes(d.id)), `every one of the ${desks.length} desks has a computer screen, each drawn once`);
  const setups = new Set(meshes.map((m) => m.setup));
  assert(setups.size >= 4, `the computers vary: ${setups.size} different setups are drawn`);

  for (let i = 0; i < 50 && !JSON.parse(readFileSync(file, 'utf8')).building; i++) await s.sleep(200);
  assert(tops(onDisk()).length === start.length, 'the building file holds no small thing the owner did not put there');

  const desk = bareDesks[0];
  const things = [
    { id: 'owner-mug', def: 'mug', on: desk.id, u: 1, v: 6, rot: 0 },
    { id: 'owner-duck', def: 'rubber_duck', on: desk.id, u: 10, v: 6, rot: 0 },
  ];
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify([{ t: 'items', story: desk.level, put: things, del: [] }])} })`);
  await s.waitFor(`${store}.building.stories[${desk.level}].items.filter((i) => i.id.startsWith('owner-')).length === 2`, 6000);
  await s.sleep(600);
  const placed = await s.eval(`${store}.building`);
  assert(same(await drawnOf(), held(tops(placed))) && tops(placed).length === start.length + 2, 'the scene then draws the two and still no other small thing');
  for (const def of ['mug', 'rubber_duck']) {
    const at = (await s.eval(`__office.instances(${JSON.stringify(def)})`)).filter((p) => Math.abs(p.y - (desk.level * 3.2 + ITEM_DEFS[desk.def].surface.height)) < 0.05);
    const f = footprint(ITEM_DEFS[desk.def], desk.rot);
    const box = { x0: desk.x / 2, x1: (desk.x + f.w) / 2, z0: desk.z / 2, z1: (desk.z + f.d) / 2 };
    const over = at.filter((p) => p.x > box.x0 - 0.1 && p.x < box.x1 + 0.1 && p.z > box.z0 - 0.1 && p.z < box.z1 + 0.1);
    assert(over.length === 1, `the ${def} is drawn once, at the height of the desk top and over its footprint`);
  }
  for (let i = 0; i < 50 && tops(onDisk()).length !== start.length + 2; i++) await s.sleep(200);
  assert(tops(onDisk()).length === start.length + 2, 'company.json holds the two the owner put down');

  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify([{ t: 'items', story: desk.level, put: [], del: things.map((t) => t.id) }])} })`);
  await s.waitFor(`!${store}.building.stories[${desk.level}].items.some((i) => i.id.startsWith('owner-'))`, 6000);
  await s.sleep(600);
  assert(same(await drawnOf(), before), 'taking them away leaves the desk as bare as before, with nothing drawn in their place');
}
