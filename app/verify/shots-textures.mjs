// The pictures that judge the texture work (R2): the same framings on the base build and on the shrunk one, so a blind panel and
// verify/texture-diff.mjs can tell whether anything is lost. Build mode at the nearest zoom (5 m), a person's-eye view at a desk,
// and the sofa, the bookshelf, the armchair, a plant, the lamp and the small things of a dressed table close up.
// Writes <OFFICE_SHOT_PHASE>-<name>.png (before or after) at 1440x900 to OFFICE_SHOTS_DIR.
// Run: pnpm build:verify && OFFICE_SHOT_PHASE=after OFFICE_SHOTS_DIR=<dir> OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9343 node verify/cdp.mjs verify/shots-textures.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, floorItems, ITEM_DEFS, parseBuilding, seatPose } from '../src/shared/space/index.ts';
import { assert, scratch } from './lib.mjs';
import { acceptedDressing } from './tabletop-dressing.mjs';
import { drive } from './tabletop-drive.mjs';

const { dataDir, repo } = scratch();
mkdirSync(join(repo, 'b'));
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
  const ctx = ctxOf(disk());
  const { ok, building: dressed0 } = acceptedDressing(saved, ctx);
  // The small baked props the dressing leaves out (frame, clock, desk lamp, succulent) stand on the meeting table too, so each is photographed.
  let dressed = dressed0;
  const host = floorItems(dressed.stories[0]).find((i) => i.id === 'meeting_table:00');
  const rect = ITEM_DEFS[host.def].surface.rect;
  const more = [];
  for (const def of ['picture_frame', 'desk_clock', 'lamp_desk', 'plant_small']) {
    const want = ITEM_DEFS[def].top;
    let spot = null;
    for (let v = rect.v1 - want.d; v >= rect.v0 && !spot; v--) {
      for (let u = rect.u0; u <= rect.u1 - want.w && !spot; u++) {
        const item = { id: `${host.id}~extra-${def}`, def, on: host.id, u, v, rot: 0 };
        const r = applyOps(dressed, [{ t: 'items', story: 0, put: [item], del: [] }], ctx);
        if (r.ok) {
          spot = item;
          dressed = r.building;
        }
      }
    }
    if (spot) more.push(spot);
  }
  console.log(`extra props placed: ${more.map((m) => m.def).join(', ')}`);
  const all = [...ok, ...more];
  await s.eval(`window.office.send({ type: 'build', ops: ${JSON.stringify([{ t: 'items', story: 0, put: all, del: [] }])} })`);
  await d.waitBuilding(`b.stories[0].items.filter((i) => i.on !== undefined).length === ${all.length}`, 'the dressing did not arrive');
  await s.sleep(800);

  const first = (def) => s.eval(`__office.instances(${JSON.stringify(def)})[0] ?? null`);
  const found = {};
  for (const def of ['sofa', 'bookshelf', 'armchair', 'plant', 'plant_large', 'laptop', 'vase', 'picture_frame', 'desk_clock', 'lamp_desk', 'plant_small', 'bench_desk']) found[def] = await first(def);
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

  // A standing place `dist` m from a small thing, where nothing pushes the owner away and the middle of the view lands on it.
  const aimAt = async (p, aimY, dists = [0.75, 1.0, 1.3]) => {
    for (const dist of dists) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * 2 * Math.PI;
        const x = p.x + Math.sin(a) * dist;
        const z = p.z + Math.cos(a) * dist;
        await s.eval(`__office.teleport(${x}, ${z}, ${Math.atan2(p.x - x, p.z - z)}); __office.step(0.25)`);
        const at = await s.eval('__office.state().owner');
        if (Math.hypot(at.x - x, at.z - z) > 0.04) continue;
        const cam = await s.eval('window.__officeCamera');
        const want = Math.atan2(aimY - 1.6, dist);
        await s.drag({ x: 700, y: 400 }, { x: 700, y: 400 + Math.round((cam.pitch - want) / LOOK_SPEED) }, 6);
        await s.sleep(450);
        const hit = await s.eval('__office.pick(720, 450)');
        if (hit?.point && Math.hypot(hit.point.x - p.x, hit.point.z - p.z) < 0.45) return { dist, a: +a.toFixed(2) };
      }
    }
    return null;
  };

  // Build mode at the nearest zoom, looking at a thing. Build mode looks at where the owner stands when it is entered and keeps looking
  // there, so in one task the owner is put on the thing, build mode is entered, and the owner is put far away, out of the picture. No
  // step of the simulation runs in between to push the owner off the furniture, so the thing is in the middle of the view to the
  // centimetre and a second run frames the same picture; panning by key would not.
  const build = async (p) => {
    await s.eval(`(() => {
      __office.teleport(${p.x}, ${p.z});
      document.querySelector('[data-testid="build-enter"]').click();
      __office.teleport(${p.x + 40}, ${p.z + 40});
    })()`);
    await s.waitFor(`!!${store}.build`, 4000);
    await s.sleep(500);
    await d.zoomTo(5);
    await d.park();
    await d.still();
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
  for (const [def, name] of [['vase', 'fp-vase'], ['laptop', 'fp-laptop'], ['picture_frame', 'fp-frame'], ['desk_clock', 'fp-clock'], ['lamp_desk', 'fp-desklamp'], ['plant_small', 'fp-succulent']]) {
    const p = await first(def);
    if (!p) continue;
    const stood = await aimAt(p, p.y + 0.08);
    console.log(`${name}: ${stood ? `stood ${stood.dist} m away at ${stood.a} rad` : 'no free place with the thing in the middle'}`);
    if (stood) await shot(name);
  }
  // the floor and a wall a metre away, which is as close as the surface maps get
  const at = await s.eval('__office.state().owner');
  await look({ x: at.x, z: at.z, yaw: at.yaw }, { dist: 0.001, aimY: 0.0 });
  await shot('fp-floor');
  await s.press('Tab');
  await s.waitFor('window.__officeCamera && Math.abs(window.__officeCamera.blend) < 0.001', 10000);

  // build mode at 5 m
  await build(found.sofa);
  await shot('build-sofa');
  await d.exitBuild();
  await build(found.bookshelf);
  await shot('build-bookshelf');
  await d.exitBuild();
  await build(found.laptop ?? found.vase ?? found.bench_desk);
  await shot('build-table');
  await d.exitBuild();
  await build(found.bench_desk);
  await shot('build-desks');
  await d.exitBuild();
}
