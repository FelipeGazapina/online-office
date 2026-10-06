// Data folders the startup scripts launch the built app on. Each call makes a fresh scratch folder, so a launch is a cold one.
//   default  an empty office, what a new owner sees.
//   floors3  the e2e-perf fixture (15 employees over 3 stories) written to company.json, so the app loads it at launch
//            the way it would load the owner's saved building. The building mirrors stackStories in src/renderer/src/debug.ts.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKS_PER_BLOCK, XP_FOR_LEVEL, seatCeiling } from '../src/shared/protocol.ts';
import { applyOps, encodeBuilding, legacyBuilding, rectWalls } from '../src/shared/space/index.ts';
import { benchItem } from '../src/shared/space/kit.ts';

const COLORS = ['#e07a5f', '#3d85c6', '#81b29a', '#f2cc8f'];

function stackStories(ground, groundSeats, desks, blocks, floors) {
  const lot = ground.lot;
  const seats = new Map(groundSeats);
  const ops = [{ t: 'stories', count: floors }, { t: 'items', story: 0, put: [{ id: 'stairs:00', def: 'stairs', x: 16, z: 4, rot: 0 }], del: [] }];
  const share = Math.ceil(desks.length / floors);
  for (let story = 1; story < floors; story++) {
    const cells = Array.from({ length: lot.w * lot.h }, (_, i) => ({ x: lot.x0 + (i % lot.w), z: lot.z0 + Math.floor(i / lot.w), half: 0, paint: story + 1 }));
    const walls = rectWalls({ x: lot.x0, z: lot.z0, w: lot.w, h: lot.h }, 2).map((w, i) => (i % 6 >= 1 && i % 6 <= 4 ? { ...w, open: 'window' } : w));
    for (let i = 0; i < 12; i++) walls.push({ x: -6 + i, z: -2, d: 'e', style: 2, ...(i === 5 ? { open: 'door' } : {}) });
    const items = desks.slice(story * share, (story + 1) * share).map((d, n) => {
      const slot = blocks.findIndex((b) => b.id === d.blockId);
      const item = { ...benchItem(d.blockId, slot, n), id: `${d.blockId}:bench_desk:${story}${n}` };
      seats.set(d.id, item.id);
      return item;
    });
    const put = (def, x, z) => ({ id: `${def}:${story}0`, def, x, z, rot: 0 });
    items.push(put('plant', -30, -30), put('sofa', 20, 10), put('bookshelf', -34, -38), put('meeting_table', 20, -20));
    if (story < floors - 1) items.push({ id: `stairs:0${story}`, def: 'stairs', x: 30, z: 4, rot: 0 });
    ops.push({ t: 'floor', story, cells }, { t: 'walls', story, put: walls, del: [] }, { t: 'items', story, put: items, del: [] });
  }
  const ctx = {
    blocks: new Set(blocks.map((b) => b.id)),
    employees: new Map(desks.map((d) => [d.id, { blockId: d.blockId, orchestrator: false }])),
    seats,
  };
  const built = applyOps(ground, ops, ctx);
  if (!built.ok) throw new Error(`the ${floors}-story fixture is illegal: ${JSON.stringify(built.violations)}`);
  return { building: built.building, seats };
}

function floorsCompany(cwd, count, floors) {
  const level = 5;
  const blocks = Array.from({ length: Math.ceil(count / DESKS_PER_BLOCK) }, (_, slot) => ({ id: `fake-block-${slot}`, name: `Fake ${slot}`, cwd, color: COLORS[slot % COLORS.length], slot }));
  const desks = Array.from({ length: count }, (_, i) => ({ id: `fake-emp-${i}`, blockId: blocks[Math.floor(i / DESKS_PER_BLOCK)].id, desk: i % DESKS_PER_BLOCK, orchestrator: false }));
  const legacy = legacyBuilding(blocks.map((b) => ({ id: b.id, slot: b.slot })), desks);
  const { building, seats } = stackStories(legacy.building, legacy.seats, desks, blocks, floors);
  const employees = desks.map((d, i) => ({
    id: d.id,
    name: `Fake ${i}`,
    provider: 'claude-code',
    blockId: d.blockId,
    seat: seats.get(d.id) ?? null,
    status: { kind: 'idle' },
    activity: 'typing',
    model: 'fake',
    permissions: { mode: 'inherit', alwaysAllow: [] },
    hiredAt: Date.now(),
  }));
  return { name: 'Gazapina Labs', level, xp: XP_FOR_LEVEL[level], settings: { seats: seatCeiling(level), defaultModels: {}, defaultPermissions: 'inherit' }, blocks, employees, building: encodeBuilding(building) };
}

export const FIXTURES = ['default', 'floors3'];

export function startupDataDir(fixture = 'default') {
  if (!FIXTURES.includes(fixture)) throw new Error(`unknown fixture ${fixture}, use one of ${FIXTURES.join(', ')}`);
  const dataDir = mkdtempSync(join(tmpdir(), 'office-startup-data-'));
  // Not a git repo, so the app makes no worktrees for the employees at launch and the main process stays out of the measurement.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'office-startup-cwd-')));
  if (fixture === 'floors3') {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'company.json'), JSON.stringify(floorsCompany(cwd, 15, 3)));
  }
  return { dataDir, cwd };
}
