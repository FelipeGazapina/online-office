// No model, no Electron. What a surface declares has to be what its model shows, or a lamp floats above a desk or sinks into it:
// 1. the top of every host whose model is built in code lies at its surface height, inside its footprint;
// 2. every small def fits the footprint it takes on a surface, stands on y = 0 and is as tall as it says.
// The hosts drawn from a baked prop (the desks and the bookshelf) are read in e2e-tabletop.mjs, on screen; their files say the top is at
// 0.72 m (desk) and 2 m (bookshelf).
// Run from app/: node verify/tabletop-check.mjs   Exits 1 on any failed check. (An .mjs for the same reason as pod-check.mjs.)
import { readFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { CELL, ITEM_DEFS, TOP_UNIT, placementOf } from '../src/shared/space/index.ts';
import { PROP_DEFS, modelOf } from '../src/renderer/src/scene/building/models.ts';
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
finish();
