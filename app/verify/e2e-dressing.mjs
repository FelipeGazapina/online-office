// What the desks wear, on the real app: the default office draws every thing its desks wear in one mesh, none of it is written to company.json,
// and what the owner puts on a desk takes the place of what stood there and gives it back when it is taken away again.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/e2e-dressing.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clustersOf, dressingOf, floorItems, ITEM_DEFS, topRect } from '../src/shared/space/index.ts';
import { unitsOverlap } from '../src/shared/space/surface.ts';
import { itemRect } from '../src/shared/space/geom.ts';
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const file = join(dataDir, 'company.json');
const story = () => `${store}.building.stories[0]`;
const digest = (items) => items.map((item) => `${item.on}/${item.def}#${item.look ?? 0}@${item.u},${item.v}`).join(' ');

export default async function (s) {
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.sleep(2000);
  const first = await s.eval(story());
  const worn = dressingOf(first);
  const desks = floorItems(first).filter((i) => ITEM_DEFS[i.def].setups);
  assert(desks.length >= 7 && worn.length >= desks.length * 6, `${desks.length} desks of the default office wear ${worn.length} things`);

  const drawn = await s.eval(`__office.probe('dressing')`);
  assert(drawn.length === 1 && drawn[0].things === worn.length && drawn[0].digest === digest(worn), `the scene draws all ${worn.length}, each where the data puts it, in one mesh`);

  // The drawn geometry itself, not only what it was told: it lies over the desks, from the desk top up to a tall plant.
  const [x0, x1, z0, z1] = desks.reduce(([a, b, c, d], desk) => {
    const r = itemRect(desk, ITEM_DEFS[desk.def]);
    return [Math.min(a, r.x0 / 2), Math.max(b, r.x1 / 2), Math.min(c, r.z0 / 2), Math.max(d, r.z1 / 2)];
  }, [Infinity, -Infinity, Infinity, -Infinity]);
  const { min, max } = drawn[0].box;
  assert(min.x >= x0 - 0.15 && max.x <= x1 + 0.15 && min.z >= z0 - 0.15 && max.z <= z1 + 0.15 && min.y >= 0.7 && max.y <= 1.2, `the geometry spans x ${min.x.toFixed(1)} to ${max.x.toFixed(1)}, z ${min.z.toFixed(1)} to ${max.z.toFixed(1)}, y ${min.y.toFixed(2)} to ${max.y.toFixed(2)}, over the desks (x ${x0} to ${x1}, z ${z0} to ${z1})`);

  for (let i = 0; i < 50 && !JSON.parse(readFileSync(file, 'utf8')).building; i++) await s.sleep(200);
  const disk = readFileSync(file, 'utf8');
  assert(JSON.parse(disk).building && !disk.includes('~wear'), 'the building file holds the desks and none of what they wear');

  const deskWith = desks.find((d) => clustersOf(first).get(d.id).length === 3);
  const laid = clustersOf(first).get(deskWith.id);
  const target = laid[laid.length - 1].things.find((i) => !i.lvl && i.def !== 'mug') ?? laid[laid.length - 1].things[0];
  const desk = deskWith;
  const onDesk = worn.filter((i) => i.on === desk.id);
  const mug = { id: 'owner-mug', def: 'mug', on: desk.id, u: target.u, v: target.v, rot: 0 };
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify([{ t: 'items', story: 0, put: [mug], del: [] }])} })`);
  await s.waitFor(`${story()}.items.some((i) => i.id === 'owner-mug')`, 6000);
  await s.sleep(500);
  const next = dressingOf(await s.eval(story()));
  const left = next.filter((i) => i.on === desk.id);
  const gone = !left.some((i) => i.def === target.def && i.u === target.u && i.v === target.v);
  const earlier = laid.slice(0, -1).flatMap((c) => c.things);
  const kept = earlier.every((m) => left.some((i) => i.def === m.def && i.look === m.look && i.u === m.u && i.v === m.v));
  assert(gone && kept && left.length >= onDesk.length - 5 && left.every((i) => !unitsOverlap(topRect(i, ITEM_DEFS[i.def]), topRect(mug, ITEM_DEFS.mug))), `the mug takes the place of the ${target.def} that stood there, nothing worn touches it, the clusters before it stay and the desk still wears ${left.length} things (${onDesk.length} before)`);
  const redrawn = await s.eval(`__office.probe('dressing')`);
  assert(redrawn.length === 1 && redrawn[0].digest === digest(next) && redrawn[0].digest !== drawn[0].digest, `and the scene draws the ${next.length} that are left, with the mug's desk changed`);

  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify([{ t: 'items', story: 0, put: [], del: [mug.id] }])} })`);
  await s.waitFor(`!${story()}.items.some((i) => i.id === 'owner-mug')`, 6000);
  await s.sleep(500);
  const back = await s.eval(`__office.probe('dressing')`);
  assert(back.length === 1 && back[0].digest === digest(worn), 'taking the mug away gives the desk its things back');
}
