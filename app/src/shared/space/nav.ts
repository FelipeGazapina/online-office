// Per-floor walkable grid, A* with a line-of-sight pull, and the stair graph between floors.
import { defOf, floorItems, hasFloorAt, itemRect, stairsInfo, tileIndex, wallName, wkey } from './geom.ts';
import { NAV_CELL, NAV_CLEARANCE, STORY_H, WALL_HALF, type FloorGeometry, type FloorNav, type FloorPos, type Leg, type StairLink, type Vec2, type WallSeg } from './types.ts';

const EPS = 1e-9;
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

const navCache = new WeakMap<FloorGeometry, Map<number, FloorNav>>();

export function navOf(g: FloorGeometry, clearance: number = NAV_CLEARANCE): FloorNav {
  let byClearance = navCache.get(g);
  if (!byClearance) navCache.set(g, (byClearance = new Map()));
  let nav = byClearance.get(clearance);
  if (!nav) byClearance.set(clearance, (nav = buildNav(g, clearance)));
  return nav;
}

function buildNav(g: FloorGeometry, clearance: number): FloorNav {
  const { lot, story, hole, wallAt } = g;
  const cols = lot.w * 4;
  const rows = lot.h * 4;
  const open = new Uint8Array(cols * rows);
  const X = lot.x0;
  const Z = lot.z0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tx = X + (col >> 2);
      const tz = Z + (row >> 2);
      const ti = tileIndex(lot, tx, tz);
      if (hole[ti] || !hasFloorAt(story, ti)) continue;
      const sd = wallAt.has(wkey(tx, tz, 'sd'));
      const nd = wallAt.has(wkey(tx, tz, 'nd'));
      if (!sd && !nd) {
        open[row * cols + col] = story.paint[ti] > 0 ? 1 : 0;
        continue;
      }
      const fx = (col & 3) * NAV_CELL + NAV_CELL / 2;
      const fz = (row & 3) * NAV_CELL + NAV_CELL / 2;
      const half = sd ? (fx > fz ? 0 : 1) : fx + fz < 1 ? 0 : 1;
      open[row * cols + col] = (half === 0 ? story.paint[ti] : (story.halfB[ti] ?? 0)) > 0 ? 1 : 0;
    }
  }

  const range = (lo: number, hi: number, origin: number, max: number): [number, number] => [
    Math.max(0, Math.floor((lo - origin) / NAV_CELL + EPS)),
    Math.min(max - 1, Math.ceil((hi - origin) / NAV_CELL - EPS) - 1),
  ];
  const eachCell = (x0: number, x1: number, z0: number, z1: number, fn: (i: number) => void) => {
    const [c0, c1] = range(x0, x1, X, cols);
    const [r0, r1] = range(z0, z1, Z, rows);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * cols + c);
  };
  const close = (i: number) => {
    open[i] = 0;
  };

  const h = WALL_HALF + clearance;
  const rect = (w: WallSeg, span: number): [number, number, number, number] =>
    w.d === 'e' ? [w.x - span, w.x + 1 + span, w.z - h, w.z + h] : [w.x - h, w.x + h, w.z - span, w.z + 1 + span];
  const doorSegs: WallSeg[] = [];
  for (const w of story.walls) {
    if (w.open === 'door') {
      doorSegs.push(w);
      continue;
    }
    if (w.open === 'arch') continue;
    if (w.d === 'e' || w.d === 's') {
      const [x0, x1, z0, z1] = rect(w, h);
      eachCell(x0, x1, z0, z1, close);
      continue;
    }
    const ax = w.x;
    const az = w.d === 'sd' ? w.z : w.z + 1;
    const dz = w.d === 'sd' ? 1 : -1;
    const reach = h + NAV_CELL * Math.SQRT1_2;
    eachCell(w.x - reach, w.x + 1 + reach, w.z - reach, w.z + 1 + reach, (i) => {
      const px = X + (i % cols) * NAV_CELL + NAV_CELL / 2;
      const pz = Z + Math.floor(i / cols) * NAV_CELL + NAV_CELL / 2;
      const t = Math.min(1, Math.max(0, (px - ax + (pz - az) * dz) / 2));
      if (Math.hypot(px - (ax + t), pz - (az + t * dz)) < reach) close(i);
    });
  }
  for (const item of floorItems(story)) {
    const def = defOf(item);
    if (!def || def.walkable) continue;
    const r = itemRect(item, def);
    eachCell(r.x0 / 2 - clearance, r.x1 / 2 + clearance, r.z0 / 2 - clearance, r.z1 / 2 + clearance, close);
  }

  const doors = new Map<string, Uint32Array>();
  for (const w of doorSegs) {
    const [x0, x1, z0, z1] = rect(w, 0);
    const cells: number[] = [];
    eachCell(x0, x1, z0, z1, (i) => {
      if (open[i]) cells.push(i);
    });
    doors.set(wallName(w), Uint32Array.from(cells));
  }

  const component = new Uint16Array(open.length);
  const queue = new Int32Array(open.length);
  let label = 0;
  for (let s = 0; s < open.length; s++) {
    if (!open[s] || component[s]) continue;
    label = Math.min(label + 1, 65535);
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    component[s] = label;
    while (head < tail) {
      const c = queue[head++];
      const col = c % cols;
      const row = (c - col) / cols;
      for (const [dc, dr] of STEPS.slice(0, 4)) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const n = nr * cols + nc;
        if (open[n] && !component[n]) {
          component[n] = label;
          queue[tail++] = n;
        }
      }
    }
  }

  return { floor: g.index, cols, rows, x0: X, z0: Z, open, doors, component };
}

/** Closing a door blocks its nav cells in place. The cells were open only because the door was open, so reopening restores them. */
export function closeDoor(nav: FloorNav, wallKey: string): void {
  for (const i of nav.doors.get(wallKey) ?? []) nav.open[i] = 0;
}
export function openDoor(nav: FloorNav, wallKey: string): void {
  for (const i of nav.doors.get(wallKey) ?? []) nav.open[i] = 1;
}

const cellAt = (nav: FloorNav, p: Vec2): number => {
  const col = Math.floor((p.x - nav.x0) / NAV_CELL);
  const row = Math.floor((p.z - nav.z0) / NAV_CELL);
  return col >= 0 && col < nav.cols && row >= 0 && row < nav.rows ? row * nav.cols + col : -1;
};
const centerOf = (nav: FloorNav, cell: number): Vec2 => {
  const col = cell % nav.cols;
  const row = (cell - col) / nav.cols;
  return { x: nav.x0 + (col + 0.5) * NAV_CELL, z: nav.z0 + (row + 0.5) * NAV_CELL };
};

/** The open cell nearest to p, or -1 when the floor has none. */
export function snapToOpen(nav: FloorNav, p: Vec2): number {
  const at = cellAt(nav, p);
  if (at >= 0 && nav.open[at]) return at;
  let best = -1;
  let bestD = Infinity;
  for (let cell = 0; cell < nav.open.length; cell++) {
    if (!nav.open[cell]) continue;
    const c = centerOf(nav, cell);
    const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
    if (d < bestD) {
      best = cell;
      bestD = d;
    }
  }
  return best;
}

function clear(nav: FloorNav, a: Vec2, b: Vec2): boolean {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / 0.05));
  const ca = cellAt(nav, a);
  const cb = cellAt(nav, b);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const c = cellAt(nav, { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    if (c < 0) return false;
    if (!nav.open[c] && c !== ca && c !== cb) return false;
  }
  return true;
}

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

function search(nav: FloorNav, start: number, goal: number): number[] | null {
  const { cols, rows, open } = nav;
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

function pull(nav: FloorNav, points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let far = points.length - 1;
    while (far > anchor + 1 && !clear(nav, points[anchor], points[far])) far--;
    out.push(points[far]);
    anchor = far;
  }
  return out;
}

/** Waypoints from `from` (excluded) to `to` (snapped to the nearest open cell), or null when the floor does not connect them. */
export function findPath(nav: FloorNav, from: Vec2, to: Vec2): Vec2[] | null {
  const goalCell = snapToOpen(nav, to);
  if (goalCell < 0) return null;
  const goal = cellAt(nav, to) === goalCell ? to : centerOf(nav, goalCell);
  if (clear(nav, from, goal)) return [goal];
  const startCell = snapToOpen(nav, from);
  if (startCell < 0 || nav.component[startCell] !== nav.component[goalCell]) return null;
  const cells = search(nav, startCell, goalCell);
  if (!cells) return null;
  const raw = [from, ...cells.map((c) => centerOf(nav, c)), goal];
  return pull(nav, raw.filter((p, i) => i === 0 || p.x !== raw[i - 1].x || p.z !== raw[i - 1].z));
}

export function stairLinks(floors: readonly FloorGeometry[]): readonly StairLink[] {
  const links: StairLink[] = [];
  floors.forEach((g, floor) => {
    if (floor + 1 >= floors.length) return;
    for (const item of floorItems(g.story)) {
      const def = defOf(item);
      if (!def?.stairs) continue;
      const info = stairsInfo(item, def);
      if (!info.aligned) continue;
      links.push({
        from: { floor, at: info.approach },
        to: { floor: floor + 1, at: info.top },
        cost: Math.hypot(info.top.x - info.approach.x, info.top.z - info.approach.z) + STORY_H,
        itemId: item.id,
        heightAt: info.heightAt,
      });
    }
  });
  return links;
}

const reversed = (l: StairLink): StairLink => ({ ...l, from: l.to, to: l.from });
const lengthOf = (from: Vec2, path: readonly Vec2[]) => {
  let total = 0;
  let prev = from;
  for (const p of path) {
    total += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  return total;
};

type Step = { from: number; link?: StairLink; path?: Vec2[] };

/**
 * Dijkstra over the few stair links, with each same-floor hop priced by the real A* path. A leg ends with `via` when it
 * ends at a staircase. Null when the floors do not connect.
 */
export function route(floors: readonly FloorGeometry[], from: FloorPos, to: FloorPos): readonly Leg[] | null {
  if (!floors[from.floor] || !floors[to.floor]) return null;
  const links = stairLinks(floors);
  const nodes: { floor: number; at: Vec2 }[] = [
    { floor: from.floor, at: { x: from.x, z: from.z } },
    { floor: to.floor, at: { x: to.x, z: to.z } },
  ];
  for (const l of links) nodes.push({ floor: l.from.floor, at: l.from.at }, { floor: l.to.floor, at: l.to.at });
  const dist = nodes.map(() => Infinity);
  const how: (Step | undefined)[] = nodes.map(() => undefined);
  const settled = nodes.map(() => false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!settled[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === 1) break;
    settled[u] = true;
    const relax = (v: number, cost: number, step: Step) => {
      if (!settled[v] && dist[u] + cost < dist[v]) {
        dist[v] = dist[u] + cost;
        how[v] = step;
      }
    };
    for (let v = 0; v < nodes.length; v++) {
      if (v === u || nodes[v].floor !== nodes[u].floor) continue;
      const path = findPath(navOf(floors[nodes[u].floor]), nodes[u].at, nodes[v].at);
      if (path) relax(v, lengthOf(nodes[u].at, path), { from: u, path });
    }
    if (u >= 2) {
      const li = (u - 2) >> 1;
      const forward = u % 2 === 0;
      relax(forward ? u + 1 : u - 1, links[li].cost, { from: u, link: forward ? links[li] : reversed(links[li]) });
    }
  }
  if (dist[1] === Infinity) return null;
  const steps: Step[] = [];
  for (let n = 1; n !== 0; n = how[n]!.from) steps.push(how[n]!);
  steps.reverse();
  const legs: Leg[] = [];
  let cur: Leg = { floor: from.floor, path: [] };
  for (const s of steps) {
    if (s.path) cur.path.push(...s.path);
    else {
      cur.via = s.link;
      legs.push(cur);
      cur = { floor: s.link!.to.floor, path: [] };
    }
  }
  legs.push(cur);
  return legs;
}
