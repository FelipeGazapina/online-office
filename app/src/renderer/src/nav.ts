// Where the owner can walk. A grid of cells that are safe to stand in, A* over it, and a line-of-sight pull that straightens the result.
import { OWNER_RADIUS, WALL_MARGIN, type Box, type Layout, type Vec2 } from './layout.ts';

type Rect = { readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number };

export type NavGrid = {
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly cols: number;
  readonly rows: number;
  readonly open: Uint8Array;
  readonly walk: Rect;
  readonly boxes: readonly Box[];
};

const NAV_CELL = 0.25;
const EPS = 1e-9;
// Places to stand around someone are tried on a circle of this many evenly spaced points.
const SPOTS = 24;
// A spot is preferred when the target is at least this much nearer to it than anyone else is.
const ALONE = 0.3;
const STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

export function buildNavGrid(layout: Layout, opts: { cell: number; clearance: number }): NavGrid {
  const { bounds, obstacles } = layout;
  const { cell, clearance } = opts;
  const cols = Math.ceil((bounds.x1 - bounds.x0) / cell);
  const rows = Math.ceil((bounds.z1 - bounds.z0) / cell);
  const walk = {
    x0: bounds.x0 + WALL_MARGIN,
    x1: bounds.x1 - WALL_MARGIN,
    z0: bounds.z0 + WALL_MARGIN,
    z1: bounds.z1 - WALL_MARGIN,
  };
  const boxes = obstacles.map((b) => ({ cx: b.cx, cz: b.cz, hw: b.hw + clearance, hd: b.hd + clearance }));
  const open = new Uint8Array(cols * rows);
  // A cell is open only when its whole square is clear. Every point in an open cell then keeps the clearance from
  // each obstacle and the margin from the walls, so a path through open cells never triggers the collision push.
  for (let row = 0; row < rows; row++) {
    const z0 = bounds.z0 + row * cell;
    const z1 = z0 + cell;
    for (let col = 0; col < cols; col++) {
      const x0 = bounds.x0 + col * cell;
      const x1 = x0 + cell;
      const inside = x0 >= walk.x0 && x1 <= walk.x1 && z0 >= walk.z0 && z1 <= walk.z1;
      const blocked = boxes.some((b) => x0 < b.cx + b.hw && x1 > b.cx - b.hw && z0 < b.cz + b.hd && z1 > b.cz - b.hd);
      if (inside && !blocked) open[row * cols + col] = 1;
    }
  }
  return { cell, x0: bounds.x0, z0: bounds.z0, cols, rows, open, walk, boxes };
}

function cellAt(grid: NavGrid, p: Vec2): number {
  const col = Math.floor((p.x - grid.x0) / grid.cell);
  const row = Math.floor((p.z - grid.z0) / grid.cell);
  return col >= 0 && col < grid.cols && row >= 0 && row < grid.rows ? row * grid.cols + col : -1;
}

function centerOf(grid: NavGrid, cell: number): Vec2 {
  const col = cell % grid.cols;
  const row = (cell - col) / grid.cols;
  return { x: grid.x0 + (col + 0.5) * grid.cell, z: grid.z0 + (row + 0.5) * grid.cell };
}

function snapToOpen(grid: NavGrid, p: Vec2): number {
  const at = cellAt(grid, p);
  if (at >= 0 && grid.open[at]) return at;
  let best = -1;
  let bestD = Infinity;
  for (let cell = 0; cell < grid.open.length; cell++) {
    if (!grid.open[cell]) continue;
    const c = centerOf(grid, cell);
    const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
    if (d < bestD) {
      best = cell;
      bestD = d;
    }
  }
  return best;
}

// The part of the segment o + t * d, t in [0, 1], that lies between lo and hi on one axis, as [enter, exit].
function span(o: number, d: number, lo: number, hi: number): [number, number] {
  if (d === 0) return o >= lo && o <= hi ? [0, 1] : [1, 0];
  const t0 = (lo - o) / d;
  const t1 = (hi - o) / d;
  return [Math.min(t0, t1), Math.max(t0, t1)];
}

// Slab test against the box shrunk by EPS, so a segment that only touches the box does not enter it.
function crosses(box: Box, a: Vec2, b: Vec2): boolean {
  const [xIn, xOut] = span(a.x, b.x - a.x, box.cx - box.hw + EPS, box.cx + box.hw - EPS);
  const [zIn, zOut] = span(a.z, b.z - a.z, box.cz - box.hd + EPS, box.cz + box.hd - EPS);
  return Math.max(0, xIn, zIn) <= Math.min(1, xOut, zOut);
}

function clear(grid: NavGrid, a: Vec2, b: Vec2): boolean {
  const { walk } = grid;
  const inWalk = (p: Vec2) => p.x >= walk.x0 && p.x <= walk.x1 && p.z >= walk.z0 && p.z <= walk.z1;
  return inWalk(a) && inWalk(b) && !grid.boxes.some((box) => crosses(box, a, b));
}

// Binary min-heap of cells ordered by score[cell]. Pushing a cell that is already inside moves it up.
function cellHeap(score: Float64Array) {
  const items = new Int32Array(score.length);
  const slot = new Int32Array(score.length).fill(-1);
  let size = 0;
  const put = (i: number, cell: number) => {
    items[i] = cell;
    slot[cell] = i;
  };
  const up = (from: number, cell: number) => {
    let i = from;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (score[items[parent]] <= score[cell]) break;
      put(i, items[parent]);
      i = parent;
    }
    put(i, cell);
  };
  const down = (cell: number) => {
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      if (child + 1 < size && score[items[child + 1]] < score[items[child]]) child++;
      if (score[items[child]] >= score[cell]) break;
      put(i, items[child]);
      i = child;
    }
    put(i, cell);
  };
  return {
    empty: () => size === 0,
    push(cell: number) {
      up(slot[cell] >= 0 ? slot[cell] : size++, cell);
    },
    pop(): number {
      const top = items[0];
      slot[top] = -1;
      const last = items[--size];
      if (size > 0) down(last);
      return top;
    },
  };
}

// A* over the open cells, 8 neighbors. Returns the cells from start to goal, or null when the goal cannot be reached.
function search(grid: NavGrid, start: number, goal: number): number[] | null {
  const { cols, rows, open } = grid;
  const goalCol = goal % cols;
  const goalRow = (goal - goalCol) / cols;
  const octile = (col: number, row: number) => {
    const dx = Math.abs(col - goalCol);
    const dz = Math.abs(row - goalRow);
    return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
  };
  const cost = new Float64Array(open.length).fill(Infinity);
  const score = new Float64Array(open.length);
  const parent = new Int32Array(open.length).fill(-1);
  const done = new Uint8Array(open.length);
  const queue = cellHeap(score);
  cost[start] = 0;
  score[start] = octile(start % cols, Math.floor(start / cols));
  queue.push(start);
  while (!queue.empty()) {
    const cell = queue.pop();
    if (cell === goal) {
      const cells: number[] = [];
      for (let c = goal; c !== -1; c = parent[c]) cells.push(c);
      return cells.reverse();
    }
    done[cell] = 1;
    const col = cell % cols;
    const row = (cell - col) / cols;
    for (const [dc, dr] of STEPS) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const next = nr * cols + nc;
      if (!open[next] || done[next]) continue;
      const diagonal = dc !== 0 && dr !== 0;
      if (diagonal && !(open[row * cols + nc] && open[nr * cols + col])) continue;
      const g = cost[cell] + (diagonal ? Math.SQRT2 : 1);
      if (g >= cost[next]) continue;
      cost[next] = g;
      parent[next] = cell;
      score[next] = g + octile(nc, nr);
      queue.push(next);
    }
  }
  return null;
}

// Greedy string pull: from each anchor, jump to the farthest later point it sees. The next point is taken without a
// test. Open cells are adjacent, and the first anchor is `from`, which can sit inside an obstacle and has to leave.
function pull(grid: NavGrid, points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let far = points.length - 1;
    while (far > anchor + 1 && !clear(grid, points[anchor], points[far])) far--;
    out.push(points[far]);
    anchor = far;
  }
  return out;
}

export function findPath(grid: NavGrid, from: Vec2, to: Vec2): Vec2[] | null {
  const goalCell = snapToOpen(grid, to);
  if (goalCell < 0) return null;
  const goal = cellAt(grid, to) === goalCell ? to : centerOf(grid, goalCell);
  if (clear(grid, from, goal)) return [goal];
  const cells = search(grid, snapToOpen(grid, from), goalCell);
  if (!cells) return null;
  const raw = [from, ...cells.map((c) => centerOf(grid, c)), goal];
  return pull(grid, raw.filter((p, i) => i === 0 || p.x !== raw[i - 1].x || p.z !== raw[i - 1].z));
}

// Where to stand to talk to someone at `target`, and the way there. The last point is the spot.
export function findApproach(grid: NavGrid, from: Vec2, target: Vec2, opts: { dist: number; others: readonly Vec2[] }): Vec2[] | null {
  const { dist, others } = opts;
  const spots: { p: Vec2; alone: boolean; d: number }[] = [];
  for (let k = 0; k < SPOTS; k++) {
    const angle = (2 * Math.PI * k) / SPOTS;
    const p = { x: target.x + dist * Math.cos(angle), z: target.z + dist * Math.sin(angle) };
    const cell = cellAt(grid, p);
    if (cell < 0 || !grid.open[cell]) continue;
    const alone = others.every((o) => distance(p, o) - distance(p, target) >= ALONE);
    spots.push({ p, alone, d: distance(p, from) });
  }
  spots.sort((a, b) => (a.alone === b.alone ? a.d - b.d : a.alone ? -1 : 1));
  for (const { p } of spots) {
    const path = findPath(grid, from, p);
    if (path) return path;
  }
  return null;
}

const grids = new WeakMap<Layout, NavGrid>();

export function navFor(layout: Layout): NavGrid {
  let grid = grids.get(layout);
  if (!grid) {
    grid = buildNavGrid(layout, { cell: NAV_CELL, clearance: OWNER_RADIUS });
    grids.set(layout, grid);
  }
  return grid;
}
