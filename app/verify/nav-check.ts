// Proves the walkable grid and the path search in plain Node. Run: node verify/nav-check.ts
import {
  deskPose,
  getLayout,
  OWNER_DESK,
  OWNER_START,
  WALL_MARGIN,
  type Box,
  type Layout,
  type Vec2,
} from '../src/renderer/src/layout.ts';
import { buildNavGrid, findApproach, findPath, navFor, type NavGrid } from '../src/renderer/src/nav.ts';
import type { BlockId, ProjectBlock } from '../src/shared/protocol.ts';

let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  console.log(ok ? `ok: ${what}` : `FAIL: ${what}${detail && ` | ${detail}`}`);
  if (!ok) failed++;
};

const CELL = 0.25;
const CLEARANCE = 0.35;
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const last = (path: readonly Vec2[]) => path[path.length - 1];
const box = (cx: number, cz: number, hw: number, hd: number): Box => ({ cx, cz, hw, hd });
const gridOf = (layout: Layout) => buildNavGrid(layout, { cell: CELL, clearance: CLEARANCE });
const arena = (obstacles: Box[], size = 20): Layout => ({
  bounds: { x0: 0, x1: size, z0: 0, z1: size, cols: 1, rows: 1 },
  ghostSlot: null,
  obstacles,
  plants: [],
});
const blocksOf = (n: number): ProjectBlock[] =>
  Array.from({ length: n }, (_, slot) => ({ id: `b${slot}` as BlockId, name: `Block ${slot}`, cwd: `/work/b${slot}`, color: '#5b8def', slot }));

// The oracle shares no code with nav.ts. It samples segments and tests points against the obstacles grown by the clearance.
const grow = (boxes: readonly Box[]) => boxes.map((b) => box(b.cx, b.cz, b.hw + CLEARANCE, b.hd + CLEARANCE));
const insideBox = (p: Vec2, b: Box) => Math.abs(p.x - b.cx) < b.hw - 1e-6 && Math.abs(p.z - b.cz) < b.hd - 1e-6;
const insideWalk = (p: Vec2, layout: Layout) => {
  const { bounds } = layout;
  const eps = 1e-9;
  return (
    p.x >= bounds.x0 + WALL_MARGIN - eps && p.x <= bounds.x1 - WALL_MARGIN + eps && p.z >= bounds.z0 + WALL_MARGIN - eps && p.z <= bounds.z1 - WALL_MARGIN + eps
  );
};
function firstHit(points: readonly Vec2[], boxes: readonly Box[]): Vec2 | null {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const steps = Math.max(1, Math.ceil(dist(a, b) / 0.02));
    for (let s = 0; s <= steps; s++) {
      const p = { x: a.x + ((b.x - a.x) * s) / steps, z: a.z + ((b.z - a.z) * s) / steps };
      if (boxes.some((o) => insideBox(p, o))) return p;
    }
  }
  return null;
}
const pathLength = (points: readonly Vec2[]) => points.slice(1).reduce((sum, p, i) => sum + dist(points[i], p), 0);
const fmt = (p: Vec2) => `(${p.x.toFixed(2)}, ${p.z.toFixed(2)})`;

type Trip = { name: string; from: Vec2; goal: Vec2; path: Vec2[] | null };
const walked = (trips: Trip[]) => trips.flatMap((t) => (t.path ? [{ ...t, path: t.path }] : []));
const report = (names: string[]) => names.slice(0, 3).join('; ');

const seat = { x: OWNER_DESK.x + 0.9, z: OWNER_DESK.z };
const layouts = [1, 2, 3].map((n) => ({ n, label: `${n} block${n > 1 ? 's' : ''}`, layout: getLayout(blocksOf(n)) }));

for (const { n, label, layout } of layouts) {
  const nav = gridOf(layout);
  const boxes = grow(layout.obstacles);

  const approaches: Trip[] = [];
  const snaps: Trip[] = [];
  for (let slot = 0; slot < n; slot++) {
    for (let d = 0; d < 5; d++) {
      const pose = deskPose(slot, d);
      const where = `block ${slot} desk ${d}`;
      for (const [name, from] of [['the seat', seat], ['the start', OWNER_START]] as const) {
        const path = findApproach(nav, from, pose.chair, { dist: 1, others: [] });
        approaches.push({ name: `${name} to ${where}`, from, goal: pose.chair, path });
      }
      snaps.push({ name: `the start to the middle of ${where}`, from: OWNER_START, goal: pose.desk, path: findPath(nav, OWNER_START, pose.desk) });
    }
  }
  const spots = walked(approaches);
  const snapped = walked(snaps);
  const routes = [...spots, ...snapped];

  const missing = [...approaches, ...snaps].filter((t) => !t.path).map((t) => t.name);
  check(missing.length === 0 && spots.length === 10 * n && snapped.length === 5 * n, `${label}: ${spots.length} talk spots and ${snapped.length} desk-center goals all have a path`, report(missing));

  const offRing = spots.filter((t) => Math.abs(dist(last(t.path), t.goal) - 1) > 1e-9);
  check(offRing.length === 0, `${label}: every talk spot is exactly 1 m from its chair`, report(offRing.map((t) => `${t.name} ends ${dist(last(t.path), t.goal)} m away`)));

  const spotsInside = spots.filter((t) => boxes.some((o) => insideBox(last(t.path), o)));
  check(spotsInside.length === 0, `${label}: every talk spot is outside all obstacles grown by ${CLEARANCE}`, report(spotsInside.map((t) => `${t.name} ends at ${fmt(last(t.path))}`)));

  const entering = routes.flatMap((t) => {
    const hit = firstHit([t.from, ...t.path], boxes);
    return hit ? [`${t.name} enters an obstacle at ${fmt(hit)}`] : [];
  });
  check(entering.length === 0, `${label}: no segment of ${routes.length} paths enters an obstacle grown by ${CLEARANCE}, sampled every 0.02 m`, report(entering));

  const outOfBounds = routes.filter((t) => t.path.some((p) => !insideWalk(p, layout)));
  check(outOfBounds.length === 0, `${label}: every point of ${routes.length} paths stays inside the bounds inset by ${WALL_MARGIN}`, report(outOfBounds.map((t) => t.name)));

  const snapInside = snapped.filter((t) => boxes.some((o) => insideBox(last(t.path), o)));
  const snapFar = snapped.filter((t) => dist(last(t.path), t.goal) >= 2);
  check(snapInside.length === 0 && snapFar.length === 0, `${label}: a goal in the middle of a desk snaps outside every grown obstacle and within 2 m`, report([...snapInside, ...snapFar].map((t) => t.name)));

  let unsafe = 0;
  for (let i = 0; i < nav.open.length; i++) {
    if (!nav.open[i]) continue;
    const x = nav.x0 + (i % nav.cols) * nav.cell;
    const z = nav.z0 + Math.floor(i / nav.cols) * nav.cell;
    for (const fx of [0, 0.5, 1]) {
      for (const fz of [0, 0.5, 1]) {
        const p = { x: x + fx * nav.cell, z: z + fz * nav.cell };
        if (boxes.some((o) => insideBox(p, o)) || !insideWalk(p, layout)) unsafe++;
      }
    }
  }
  check(unsafe === 0, `${label}: every corner, edge midpoint and center of every open cell keeps the clearance and the wall margin`, `${unsafe} unsafe samples`);

  const a = { x: -6, z: 6 };
  const b = { x: -2, z: 3 };
  const direct = findPath(nav, a, b);
  check(direct !== null && direct.length === 1 && direct[0].x === b.x && direct[0].z === b.z, `${label}: open floor between two points gives exactly [goal]`, JSON.stringify(direct));

  const before = nav.open.slice();
  const again = findPath(nav, OWNER_START, deskPose(0, 4).desk);
  const first = findPath(nav, OWNER_START, deskPose(n - 1, 0).chair);
  const second = findPath(nav, OWNER_START, deskPose(n - 1, 0).chair);
  const untouched = before.every((v, i) => v === nav.open[i]);
  check(untouched && again !== null && first !== second && JSON.stringify(first) === JSON.stringify(second), `${label}: findPath leaves the grid alone and returns a fresh array each call`);

  const fromDesk = findPath(nav, OWNER_DESK, OWNER_START);
  const leaves = fromDesk !== null && firstHit(fromDesk, boxes) === null && !boxes.some((o) => insideBox(fromDesk[0], o));
  check(leaves, `${label}: a walk that starts inside the owner's desk leaves it and never re-enters an obstacle`, JSON.stringify(fromDesk));
}

const enclosed = [box(10, 7, 3.5, 0.5), box(10, 13, 3.5, 0.5), box(7, 10, 0.5, 3.5), box(13, 10, 0.5, 3.5)];
const pocket = { x: 10, z: 10 };
const outside = { x: 2, z: 2 };
check(findPath(gridOf(arena(enclosed)), outside, pocket) === null, 'a goal inside a sealed pocket has no path');
check(findPath(gridOf(arena(enclosed)), pocket, outside) === null, 'a start inside a sealed pocket has no path out');
const opened = findPath(gridOf(arena(enclosed.slice(0, 3))), outside, pocket);
check(opened !== null && last(opened) === pocket && firstHit([outside, ...opened], grow(enclosed.slice(0, 3))) === null, 'the same pocket with one wall removed has a clean path that ends at the goal', JSON.stringify(opened));

const diagonalWall = [1, 3, 5, 7, 9, 11].map((c) => box(c, c, 1, 1));
const squeezeGrid = buildNavGrid(arena(diagonalWall, 12), { cell: CELL, clearance: 0 });
const east = { x: 10, z: 1.5 };
const west = { x: 1.5, z: 10 };
check(findPath(squeezeGrid, east, west) === null, 'boxes that touch only at corners seal a wall, so a path never cuts a corner');
const gap = buildNavGrid(arena(diagonalWall.filter((_, i) => i !== 2), 12), { cell: CELL, clearance: 0 });
check(findPath(gap, east, west) !== null, 'the same wall with one box removed can be crossed');

const wall = [box(10, 7.5, 0.5, 7.5)];
const around = findPath(gridOf(arena(wall)), { x: 5, z: 5 }, { x: 15, z: 5 });
const cornerZ = 15 + CLEARANCE;
const best = 2 * Math.hypot(5 - (10 - 0.5 - CLEARANCE), cornerZ - 5) + 1 + 2 * CLEARANCE;
const got = around ? pathLength([{ x: 5, z: 5 }, ...around]) : Infinity;
check(got >= best - 1e-6 && got < best + 0.5, `a detour around a wall is within 0.5 m of the shortest route (${got.toFixed(2)} m against ${best.toFixed(2)} m)`);

const empty = buildNavGrid(arena([], 1), { cell: CELL, clearance: CLEARANCE });
check(findPath(empty, { x: 0.5, z: 0.5 }, { x: 0.2, z: 0.8 }) === null, 'a layout with no open cell gives null');

const lobby = gridOf(layouts[0].layout);
const same = findPath(lobby, OWNER_START, OWNER_START);
check(same !== null && same.length === 1 && same[0].x === OWNER_START.x && same[0].z === OWNER_START.z, 'a goal equal to the start gives [goal]');

const crowdTarget = { x: -4.8, z: 4 };
const crowd = [{ x: -6, z: 4 }];
const crowded = findApproach(lobby, OWNER_START, crowdTarget, { dist: 1, others: crowd });
const margin = crowded ? dist(last(crowded), crowd[0]) - dist(last(crowded), crowdTarget) : -1;
check(crowded !== null && margin >= 0.3, `a talk spot next to someone else keeps the target clearly nearest (${margin.toFixed(2)} m margin)`);

const cornered = findApproach(gridOf(arena(enclosed)), outside, pocket, { dist: 1, others: [] });
check(cornered === null, 'a talk spot in a sealed pocket has no path');

const grids = layouts.map((l) => navFor(l.layout));
check(navFor(layouts[0].layout) === grids[0] && navFor(layouts[2].layout) === grids[2], 'navFor returns the same grid for the same layout object');
check(new Set(grids).size === 3, 'navFor returns a different grid for a different layout object');
check(grids[0].cell === 0.25 && grids[0].boxes[0].hw === layouts[0].layout.obstacles[0].hw + CLEARANCE, 'navFor builds with cell 0.25 and the owner radius as clearance');

const desk = deskPose(0, 0).desk;
const through = [{ x: desk.x - 3, z: desk.z }, { x: desk.x + 3, z: desk.z }];
const graze = [{ x: desk.x - 3, z: desk.z + 0.4 + CLEARANCE }, { x: desk.x + 3, z: desk.z + 0.4 + CLEARANCE }];
const deskBoxes = grow(layouts[0].layout.obstacles);
check(firstHit(through, deskBoxes) !== null, 'the oracle flags a segment that goes through a desk');
check(firstHit(graze, deskBoxes) === null, 'the oracle lets a segment that only grazes the grown desk edge pass');

process.exit(failed ? 1 : 0);
