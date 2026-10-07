// No model, no Electron. What a surface declares has to be what its model shows, or a lamp floats above a desk or sinks into it:
// 1. the top of every host whose model is built in code lies at its surface height, inside its footprint;
// 2. every small def fits the footprint it takes on a surface, stands on y = 0 and is as tall as it says.
// The hosts drawn from a baked prop (the desks and the bookshelf) are read in e2e-tabletop.mjs, on screen; their files say the top is at
// 0.72 m (desk) and 2 m (bookshelf).
// Run from app/: node verify/tabletop-check.mjs   Exits 1 on any failed check. (An .mjs for the same reason as pod-check.mjs.)
import { readFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { CELL, ITEM_DEFS, SETUP_COUNT, TOP_UNIT, placementOf } from '../src/shared/space/index.ts';
import { PROP_DEFS, computerOf, modelOf } from '../src/renderer/src/scene/building/models.ts';
import { TABLETOP_MODELS } from '../src/renderer/src/scene/building/tabletop.ts';
import { check, finish } from './check.ts';

const SLACK = 0.02;
const upFaces = (geometry) => {
  const pos = geometry.getAttribute('position');
  const faces = [];
  const [a, b, c, n] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  const read = (i) => (geometry.index ? geometry.index.getX(i) : i);
  const count = geometry.index ? geometry.index.count : pos.count;
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(pos, read(i));
    b.fromBufferAttribute(pos, read(i + 1));
    c.fromBufferAttribute(pos, read(i + 2));
    n.subVectors(c, b).cross(new Vector3().subVectors(a, b));
    const area = n.length() / 2;
    if (n.normalize().y > 0.9) faces.push({ x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3, area });
  }
  return faces;
};

const hosts = Object.values(ITEM_DEFS).filter((d) => d.surface && !PROP_DEFS[d.id]);
check(hosts.length >= 10, `${hosts.length} hosts are modeled in code`);
for (const def of hosts) {
  const { height, rect } = def.surface;
  // The model is centered on its footprint, and the rect is in units from the footprint's corner. The top is the level where
  // most of the upward-facing area inside the rect lies: a monitor or a keyboard on it covers far less than the slab does.
  const [cx, cz] = [(def.w * CELL) / 2, (def.d * CELL) / 2];
  const levels = new Map();
  for (const f of upFaces(modelOf(def.id))) {
    const u = (f.x + cx) / TOP_UNIT;
    const v = (f.z + cz) / TOP_UNIT;
    if (u < rect.u0 || u > rect.u1 || v < rect.v0 || v > rect.v1 || Math.abs(f.y - height) > 0.3) continue;
    const key = Math.round(f.y / 0.005) * 0.005;
    levels.set(key, (levels.get(key) ?? 0) + f.area);
  }
  const [top] = [...levels].sort((p, q) => q[1] - p[1]).map(([y]) => y);
  check(top !== undefined && Math.abs(top - height) <= SLACK, `${def.id}: its top is at ${top?.toFixed(3)} m, the surface says ${height} m`);
}

// What a baked prop measures, read from its file: the position accessor of the one mesh a .glb holds.
const bakedBox = (prop) => {
  const file = readFileSync(new URL(`../src/renderer/src/assets/models/${prop}.glb`, import.meta.url));
  const json = JSON.parse(file.subarray(20, 20 + file.readUInt32LE(12)).toString());
  const { min, max } = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  return new Box3(new Vector3(...min), new Vector3(...max));
};

// A desk's computer stays within what the desk declares `blocked`: what stands lower than a screen's clearance, on the top, lies inside those rects (give or
// take two centimeters), so a thing the owner puts beside it never stands inside a keyboard or a screen's foot. What is higher than that floats over the top.
for (const id of ['bench_desk', 'po_desk']) {
  const def = ITEM_DEFS[id];
  const { rect, blocked, height } = def.surface;
  const box = (r) => ({ x0: r.u0 * TOP_UNIT - (def.w * CELL) / 2 - 0.02, x1: r.u1 * TOP_UNIT - (def.w * CELL) / 2 + 0.02, z0: r.v0 * TOP_UNIT - (def.d * CELL) / 2 - 0.02, z1: r.v1 * TOP_UNIT - (def.d * CELL) / 2 + 0.02 });
  const on = box(rect);
  const allowed = blocked.map(box);
  check(def.setups === SETUP_COUNT, `${id}: ${SETUP_COUNT} setups`);
  for (let setup = 0; setup < SETUP_COUNT; setup++) {
    const pos = computerOf(id === 'po_desk', setup).getAttribute('position');
    const stray = [];
    for (let i = 0; i < pos.count; i++) {
      const [x, y, z] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      // Higher than a screen's clearance floats over the top; a cable lies flat under half a centimeter; the back edge of the desk is where a clamp holds an arm.
      if (y > height + 0.075 || y < height + 0.0055 || z >= 0.465 || x < on.x0 || x > on.x1 || z < on.z0 || z > on.z1) continue;
      if (!allowed.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1)) stray.push(`(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
    }
    const tall = new Box3().setFromBufferAttribute(pos).max.y;
    check(stray.length === 0 && tall <= height + 0.48, `${id} setup ${setup}: what stands low on the top is inside the declared rects, and its highest point is ${tall.toFixed(2)} m`, stray.slice(0, 4).join(' '));
  }
}

const small = Object.values(ITEM_DEFS).filter((d) => placementOf(d) !== 'floor');
check(small.length >= 44, `${small.length} defs may stand on a surface`);
// A look is a colour or a style, never another size: every look of every def fits the same footprint and stands as tall as the def says.
for (const def of small) {
  const baked = PROP_DEFS[def.id];
  const looks = baked ? 1 : (def.looks ?? 1);
  const [w, d] = [def.top.w * TOP_UNIT, def.top.d * TOP_UNIT];
  for (let look = 0; look < looks; look++) {
    const box = baked ? bakedBox(baked.prop) : new Box3().setFromBufferAttribute(modelOf(def.id, look).getAttribute('position'));
    const at = `${def.id}${baked ? ` (${baked.prop})` : looks > 1 ? ` look ${look}` : ''}`;
    // A set is laid out by its members' own units, so it only has to stay inside its footprint; a single model is also centered on it.
    const inside = box.max.x - box.min.x <= w + (def.group ? 0.04 : 0.01) && box.max.z - box.min.z <= d + (def.group ? 0.04 : 0.01);
    const fits = def.group ? inside && box.min.x >= -w / 2 - 0.03 && box.max.x <= w / 2 + 0.03 && box.min.z >= -d / 2 - 0.03 && box.max.z <= d / 2 + 0.03 : inside && Math.abs(box.max.x + box.min.x) <= 0.03 && Math.abs(box.max.z + box.min.z) <= 0.03;
    check(fits, `${at}: the model fits its ${def.top.w} by ${def.top.d} units on a top (${(box.max.x - box.min.x).toFixed(2)} by ${(box.max.z - box.min.z).toFixed(2)} m of ${w} by ${d} m)`);
    check(box.min.y >= -0.001 && Math.abs(box.max.y - def.height) <= 0.02, `${at}: it stands on y = 0 and is ${box.max.y.toFixed(2)} m tall, the def says ${def.height} m`);
  }
  if (looks > 1) {
    const [a, b] = [modelOf(def.id, 0).getAttribute('color'), modelOf(def.id, 1).getAttribute('color')];
    check(a && b && a.array.some((v, i) => v !== b.array[i]), `${def.id}: look 1 is not look 0 over again`);
  }
}
// The size of every small thing is the size of the thing in the world, in centimeters: [longer side, shorter side, height, the sides held to 10%].
// Everything else is held to 30% (and a centimeter and a half), which catches a cube drawn as big as a mug and a phone as wide as a notebook. A model
// drawn in code and the baked prop of the same def are both held to it, because either may be what the owner puts down.
const REAL = {
  laptop: [33, 23, 24],
  books: [24, 17, 9],
  papers: [29, 21, 5],
  mug: [11, 8, 9, 'h'],
  picture_frame: [20, 10, 22],
  vase: [16, 16, 34],
  pen_cup: [8, 8, 15],
  desk_clock: [11, 5, 13],
  trophy: [16, 12, 22],
  notebook: [30, 21, 3],
  folder: [32, 23, 3],
  magazine: [30, 22, 1],
  coaster: [10, 10, 1],
  lunchbox: [22, 15, 8],
  books_row: [32, 16, 25],
  sticky_notes: [8, 8, 3],
  headphones: [19, 8, 9],
  water_bottle: [7, 7, 23],
  tumbler: [8, 8, 17],
  takeaway_cup: [8, 8, 14],
  desk_organizer: [30, 20, 13],
  frame_small: [11, 6, 14],
  succulent: [14, 14, 16],
  succulent_trio: [34, 10, 11],
  potted_plant: [21, 19, 34],
  cable_tray: [34, 10, 6],
  snack_bowl: [20, 20, 9],
  calculator: [17, 10, 2.5],
  phone_stand: [10, 10, 15],
  phone: [14.7, 7.1, 0.8, 'wd'],
  tablet: [21, 13, 15],
  candle: [8, 8, 9],
  cat_statue: [8, 7, 15],
  letter_tray: [32, 24, 10],
  glasses: [13, 10, 2],
  stapler: [15, 4.5, 5],
  speaker: [9, 9, 11],
  cactus: [11, 8, 14],
  snake_plant: [16, 16, 34],
  pothos: [22, 20, 20],
  rubber_duck: [9, 6, 7],
  puzzle_cube: [5.7, 5.7, 5.7, 'wdh'],
  tray: [48, 35, 3],
  runner: [100, 24, 1],
  lamp_desk: [29, 9.4, 42],
  plant_small: [28, 26, 42],
  plant_cactus: [28, 26, 42],
  coffee_machine: [40, 35, 68],
};
const alone = small.filter((d) => !d.group);
check(alone.every((d) => REAL[d.id]) && Object.keys(REAL).every((id) => ITEM_DEFS[id]), `every one of the ${alone.length} small defs has its real size listed, and every listed size is a def`, alone.filter((d) => !REAL[d.id]).map((d) => d.id).join(' '));
const cm = (n) => n * 100;
const size = (box) => [...[cm(box.max.x - box.min.x), cm(box.max.z - box.min.z)].sort((a, b) => b - a), cm(box.max.y)];
for (const def of alone) {
  const [w, d, h, strict = ''] = REAL[def.id] ?? [];
  if (w === undefined) continue;
  const baked = PROP_DEFS[def.id];
  const models = [...(TABLETOP_MODELS[def.id] || !baked ? [[`${def.id}`, (look) => new Box3().setFromBufferAttribute(modelOf(def.id, look).getAttribute('position'))]] : []), ...(baked ? [[`${def.id} (${baked.prop})`, () => bakedBox(baked.prop)]] : [])];
  for (const [at, boxOf] of models) {
    for (let look = 0; look < (at === def.id ? (def.looks ?? 1) : 1); look++) {
      const got = size(boxOf(look));
      const off = [['w', got[0], w], ['d', got[1], d], ['h', got[2], h]].filter(([k, v, real]) => Math.abs(v - real) > Math.max(strict.includes(k) ? 0.1 : 0.3, 0) * real + (strict.includes(k) ? 0.7 : 1.5));
      check(off.length === 0, `${at}${(def.looks ?? 1) > 1 && at === def.id ? ` look ${look}` : ''}: ${got.map((n) => n.toFixed(1)).join(' x ')} cm against ${w} x ${d} x ${h} cm in the world`, off.map(([k, v, real]) => `${k} ${v.toFixed(1)} vs ${real}`).join(', '));
    }
  }
}
finish();
