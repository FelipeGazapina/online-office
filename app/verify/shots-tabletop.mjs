// The pictures the panel compares to Sims 4: an item held over a table with its green footprint (place), a dressed desk pod and table seen close
// (decorated, in build mode with a small thing in hand) and a person's-eye view of a dressed desk (close). Writes them at 1440x900 to
// OFFICE_SHOTS_DIR (default /tmp/office-shots).
// Run: pnpm build:verify && OFFICE_SHOTS_DIR=... OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9341 node verify/cdp.mjs verify/shots-tabletop.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkOps, footprint, floorItems, ITEM_DEFS, hostToWorld, parseBuilding, seatPose } from '../src/shared/space/index.ts';
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
const DECORATED_DIST = Number(process.env.OFFICE_DECORATED_DIST ?? 7.5);
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

  const middle = (h) => {
    const f = footprint(ITEM_DEFS[h.def], h.rot);
    return { x: (h.x + f.w / 2) / 2, z: (h.z + f.d / 2) / 2 };
  };
  const desks = floorItems(b.stories[0]).filter((i) => i.blockId === 'blk-a' && (i.def === 'bench_desk' || i.def === 'po_desk'));
  const taken = new Set(await s.eval(`${store}.company.employees.map((e) => e.seat)`));
  const row = middle(desks.find((i) => !taken.has(i.id)) ?? desks[0]);
  const table = middle(host);

  // close.png: a person's-eye view of a dressed desk
  const freeDesk = desks.find((i) => !taken.has(i.id)) ?? desks[0];
  const seat = seatPose(b, freeDesk.id);
  await s.press('Tab');
  await s.waitFor('window.__officeCamera && Math.abs(window.__officeCamera.blend - 1) < 0.001', 10000);
  await s.eval(`__office.teleport(${seat.chair.x}, ${seat.chair.z}, ${seat.yaw})`);
  await s.sleep(500);
  await s.drag({ x: 700, y: 360 }, { x: 700, y: 560 });
  await s.sleep(600);
  await d.shotTo('close');
  await s.press('Tab');
  await s.waitFor('window.__officeCamera && Math.abs(window.__officeCamera.blend) < 0.001', 10000);

  // decorated.png: build mode with a small thing in hand, so the catalog is folded to its bar, and the pointer parked off the office. The pod is
  // in the upper half and the huddle table in the lower right, 7.5 meters from the point looked at.
  await s.eval(`__office.teleport(${table.x + 5}, ${table.z + 8}, 0)`);
  await s.sleep(500);
  await d.enterBuild();
  await d.zoomTo(DECORATED_DIST);
  await d.choose(PLACE_ITEM);
  await d.park();
  const aim = { x: row.x + (table.x - row.x) * 0.25, z: row.z + (table.z - row.z) * 0.25 };
  await d.centerOn(aim.x, 0.75, aim.z);
  await d.park();
  await s.sleep(400);
  await d.shotTo('decorated');
  await s.press('Escape');

  // place.png: the item in hand over a table, its footprint green on the top, the catalog folded to its bar. The owner stands well away from it.
  // The framing is the one of b4c: 8 meters from the point looked at, which was the nearest the overview used to come.
  await d.zoomTo(8);
  await d.choose(PLACE_ITEM);
  const top = hostToWorld(host, hostDef, spot.u + want.w / 2, spot.v + want.d / 2);
  const px = await d.centerOn(top.x, hostDef.surface.height, top.z);
  await d.hoverPx(px);
  await s.sleep(400);
  const foot = await d.probeOf('top-footprint');
  assert(foot?.ok === true && foot.color === '#2fe06a' && (await d.probeOf('surface'))?.ok === true, 'the footprint on the table and the outline of its top are green before the shot');
  await d.shotTo('place');
  await s.press('Escape');
  await d.park();
  await d.exitBuild();
}
