// The two pictures the panel compares to Sims 4: an item held over a table with its green footprint, and a dressed office.
// Writes place.png and decorated.png (1440x900) to OFFICE_SHOTS_DIR (default /tmp/office-shots).
// Run: pnpm build:verify && OFFICE_SHOTS_DIR=... OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/shots-tabletop.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkOps, footprint, floorItems, ITEM_DEFS, hostToWorld, parseBuilding } from '../src/shared/space/index.ts';
import { assert, scratch } from './lib.mjs';
import { acceptedDressing } from './tabletop-dressing.mjs';
import { drive } from './tabletop-drive.mjs';

const { dataDir, repo } = scratch();
const SHOTS = process.env.OFFICE_SHOTS_DIR ?? '/tmp/office-shots';
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const file = join(dataDir, 'company.json');
const PLACE_HOST = process.env.OFFICE_PLACE_HOST ?? 'blk-a:pod_huddle_table:00';
const PLACE_ITEM = process.env.OFFICE_PLACE_ITEM ?? 'succulent';
const disk = () => JSON.parse(readFileSync(file, 'utf8'));
const ctxOf = (c) => ({
  blocks: new Set(c.blocks.map((b) => b.id)),
  employees: new Map(c.employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.role === 'orchestrator' }])),
  seats: new Map(c.employees.filter((e) => e.seat).map((e) => [e.id, e.seat])),
});

export default async function (s) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  await s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);
  await s.sleep(800);
  const d = drive(s, { shots: SHOTS });

  for (let i = 0; i < 50 && !disk().building; i++) await s.sleep(200);
  const saved = parseBuilding(disk().building, () => {});
  const ctx = ctxOf(disk());
  const { ok, refused, building: dressed } = acceptedDressing(saved, ctx);
  console.log(`dressing: ${ok.length} things accepted, ${refused.length} refused`, JSON.stringify(refused));
  assert(refused.length === 0 && ok.length >= 40, `the dressing plan is accepted by the building's rules (${ok.length} things)`);
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify([{ t: 'items', story: 0, put: ok, del: [] }])} })`);
  await d.waitBuilding(`b.stories[0].items.filter((i) => i.on !== undefined).length === ${ok.length}`, 'the dressing did not arrive');
  const b = dressed;
  const host = floorItems(b.stories[0]).find((i) => i.id === PLACE_HOST);
  const hostDef = ITEM_DEFS[host.def];
  // The free spot of the table nearest its middle, by the building's own rules: the one a person would aim at.
  const want = ITEM_DEFS[PLACE_ITEM].top;
  const rect = hostDef.surface.rect;
  const [mu, mv] = [(rect.u0 + rect.u1) / 2, (rect.v0 + rect.v1) / 2];
  let spot = null;
  for (let u = rect.u0; u <= rect.u1 - want.w; u++) {
    for (let v = rect.v0; v <= rect.v1 - want.d; v++) {
      const d = Math.hypot(u + want.w / 2 - mu, v + want.d / 2 - mv);
      const free = checkOps(b, [{ t: 'items', story: 0, put: [{ id: 'probe', def: PLACE_ITEM, on: host.id, u, v, rot: 0 }], del: [] }], ctx).length === 0;
      if (free && (!spot || d < spot.d)) spot = { u, v, d };
    }
  }
  assert(!!spot, `the table has a free spot for a ${PLACE_ITEM}`);

  // decorated.png: the row and the huddle table as the panel sees the office
  const middle = (h) => {
    const f = footprint(ITEM_DEFS[h.def], h.rot);
    return { x: (h.x + f.w / 2) / 2, z: (h.z + f.d / 2) / 2 };
  };
  const desks = floorItems(b.stories[0]).filter((i) => i.blockId === 'blk-a' && (i.def === 'bench_desk' || i.def === 'po_desk'));
  const taken = new Set(await s.eval(`${store}.company.employees.map((e) => e.seat)`));
  const row = middle(desks.find((i) => !taken.has(i.id)) ?? desks[0]);
  const table = middle(host);
  await s.eval(`__office.teleport(${(row.x + table.x) / 2 - 0.9}, ${(row.z + table.z) / 2 + 1.0}, Math.PI)`);
  await s.sleep(1500);
  const closer = Number(process.env.OFFICE_DECORATED_ZOOM ?? 500);
  await d.zoom(-closer);
  await d.shotTo('decorated');
  await d.zoom(closer);


  // place.png: the item in hand over a table, its footprint green on the top, the catalog folded to its bar
  await d.enterBuild();
  await d.zoom(-1400);
  await d.choose(PLACE_ITEM);
  const top = hostToWorld(host, hostDef, spot.u + want.w / 2, spot.v + want.d / 2);
  const px = await d.centerOn(top.x, hostDef.surface.height, top.z);
  await d.hoverPx(px);
  await s.sleep(400);
  const foot = await d.probeOf('top-footprint');
  console.log('footprint', JSON.stringify(foot));
  await d.shotTo('place');
  await s.press('Escape');
  await d.park();
  await d.exitBuild();

}
