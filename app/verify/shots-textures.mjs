// The pictures that judge the texture work (R2): the same framings on the base build and on the shrunk one, so a blind panel and
// verify/texture-diff.mjs can tell whether anything is lost. Build mode at the nearest zoom (5 m), a person's-eye view at a desk,
// and the sofa, the bookshelf, the armchair, a plant, the lamp and the small things of a dressed table close up.
// Writes <OFFICE_SHOT_PHASE>-<name>.png (before or after) at 1440x900 to OFFICE_SHOTS_DIR.
// Run: pnpm build:verify && OFFICE_SHOT_PHASE=after OFFICE_SHOTS_DIR=<dir> OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9343 node verify/cdp.mjs verify/shots-textures.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { floorItems, parseBuilding, seatPose } from '../src/shared/space/index.ts';
import { assert, scratch } from './lib.mjs';
import { acceptedDressing } from './tabletop-dressing.mjs';
import { drive } from './tabletop-drive.mjs';

const { dataDir, repo } = scratch();
const PHASE = process.env.OFFICE_SHOT_PHASE ?? 'after';
const SHOTS = process.env.OFFICE_SHOTS_DIR ?? '/tmp/office-shots';
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5', OFFICE_RAM_AGENTS: 'fake' };

const store = '__office.store.getState()';
const file = join(dataDir, 'company.json');
const disk = () => JSON.parse(readFileSync(file, 'utf8'));
const ctxOf = (c) => ({
  blocks: new Set(c.blocks.map((b) => b.id)),
  employees: new Map(c.employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.role === 'orchestrator' }])),
  seats: new Map(c.employees.filter((e) => e.seat).map((e) => [e.id, e.seat])),
});
const LOOK_SPEED = 0.0024;

export default async function (s) {
  await s.resize(1440, 900);
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.eval('__office.step(8)');
  await s.eval(`document.documentElement.classList.remove('test-run'); document.querySelector('.test-banner')?.remove();`);
  await s.sleep(800);
  const d = drive(s, { shots: SHOTS });
  const shot = (name) => d.shotTo(`${PHASE}-${name}`);

  // The same dressed office the tabletop pictures use: laptops, a vase and frames on the meeting table, books on the shelf.
  for (let i = 0; i < 50 && !disk().building; i++) await s.sleep(200);
  const saved = parseBuilding(disk().building, () => {});
  const { ok, building: dressed } = acceptedDressing(saved, ctxOf(disk()));
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify([{ t: 'items', story: 0, put: ok, del: [] }])} })`);
  await d.waitBuilding(`b.stories[0].items.filter((i) => i.on !== undefined).length === ${ok.length}`, 'the dressing did not arrive');
  await s.sleep(800);

  const first = (def) => s.eval(`__office.instances(${JSON.stringify(def)})[0] ?? null`);
  const found = {};
  for (const def of ['sofa', 'bookshelf', 'armchair', 'plant', 'plant_large', 'lamp', 'laptop', 'vase', 'picture_frame', 'desk_clock', 'lamp_desk', 'plant_small', 'bench_desk']) found[def] = await first(def);
  console.log('instances found:', JSON.stringify(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v && { x: v.x, y: v.y, z: v.z, yaw: v.yaw }]))));
  assert(found.sofa && found.bookshelf, 'the office has a sofa and a bookshelf to photograph');

  // First person: stand `dist` m in front of `p` (its facing is +z turned by its yaw), eye at the owner's height, looking at `aimY`.
  const asFirst = async () => {
    await s.press('Tab');
    await s.waitFor('window.__officeCamera && Math.abs(window.__officeCamera.blend - 1) < 0.001', 10000);
  };
  const look = async (p, { dist, aimY, side = 0, from = 'front' }) => {
    const face = p.yaw + (from === 'front' ? 0 : Math.PI);
    const fx = Math.sin(face), fz = Math.cos(face);
    const x = p.x + fx * dist + fz * side;
    const z = p.z + fz * dist - fx * side;
    const yaw = Math.atan2(p.x - x, p.z - z);
    await s.eval(`__office.teleport(${x}, ${z}, ${yaw})`);
    await s.sleep(400);
    const cam = await s.eval('window.__officeCamera');
    const want = Math.atan2(aimY - 1.6, dist);
    await s.drag({ x: 700, y: 400 }, { x: 700, y: 400 + Math.round((cam.pitch - want) / LOOK_SPEED) }, 6);
    await s.sleep(500);
  };

  // Build mode at the nearest zoom, centred on a thing.
  const build = async (p, aimY) => {
    await s.eval(`__office.teleport(${p.x + 4}, ${p.z + 4}, 0)`);
    await s.sleep(400);
    await d.enterBuild();
    await d.zoomTo(5);
    await d.centerOn(p.x, aimY, p.z);
    await d.park();
    await s.sleep(500);
  };

  // person's eye at a desk
  const items = floorItems(dressed.stories[0]);
  const taken = new Set(await s.eval(`${store}.company.employees.map((e) => e.seat)`));
  const desks = items.filter((i) => i.blockId === 'blk-a' && (i.def === 'bench_desk' || i.def === 'po_desk'));
  const freeDesk = desks.find((i) => !taken.has(i.id)) ?? desks[0];
  const seat = seatPose(dressed, freeDesk.id);
  await asFirst();
  await s.eval(`__office.teleport(${seat.chair.x}, ${seat.chair.z}, ${seat.yaw})`);
  await s.sleep(500);
  await s.drag({ x: 700, y: 360 }, { x: 700, y: 560 });
  await s.sleep(600);
  await shot('fp-desk');

  await look(found.sofa, { dist: 1.6, aimY: 0.5 });
  await shot('fp-sofa');
  await look(found.sofa, { dist: 1.1, aimY: 0.4, side: 0.5 });
  await shot('fp-sofa-near');
  await look(found.bookshelf, { dist: 1.5, aimY: 1.0 });
  await shot('fp-bookshelf');
  if (found.armchair) {
    await look(found.armchair, { dist: 1.4, aimY: 0.5 });
    await shot('fp-armchair');
  }
  if (found.plant_large ?? found.plant) {
    await look(found.plant_large ?? found.plant, { dist: 1.3, aimY: 0.8 });
    await shot('fp-plant');
  }
  for (const [def, name, dist, aimY] of [['vase', 'fp-vase', 0.7, 0.85], ['laptop', 'fp-laptop', 0.8, 0.85], ['picture_frame', 'fp-frame', 0.7, 0.85], ['desk_clock', 'fp-clock', 0.6, 0.8], ['lamp_desk', 'fp-desklamp', 0.8, 0.9]]) {
    if (!found[def]) continue;
    await look(found[def], { dist, aimY });
    await shot(name);
  }
  // the floor and a wall a metre away, which is as close as the surface maps get
  const at = await s.eval('__office.state().owner');
  await look({ x: at.x, z: at.z, yaw: at.yaw }, { dist: 0.001, aimY: 0.0 });
  await shot('fp-floor');
  await s.press('Tab');
  await s.waitFor('window.__officeCamera && Math.abs(window.__officeCamera.blend) < 0.001', 10000);

  // build mode at 5 m
  await build(found.sofa, 0.4);
  await shot('build-sofa');
  await d.exitBuild();
  await build(found.bookshelf, 1.0);
  await shot('build-bookshelf');
  await d.exitBuild();
  await build(found.laptop ?? found.vase ?? found.bench_desk, 0.8);
  await shot('build-table');
  await d.exitBuild();
  await build(found.bench_desk, 0.75);
  await shot('build-desks');
  await d.exitBuild();
}
