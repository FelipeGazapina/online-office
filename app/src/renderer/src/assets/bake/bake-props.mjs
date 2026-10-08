// Rebuilds assets/models/*.glb from the CC0 sources listed in app/assets-LICENSES.md.
//   mkdir /tmp/props && cd /tmp/props && npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer sharp
//   node bake-props.mjs <sources dir> <out dir> [name,name,...]
// With names, only those props are baked, so a source that is not on disk costs nothing.
// <sources dir> holds the Poly Haven glTF folders (<id>/<id>.gltf with its textures) and kenney/<name>.glb from the Kenney Furniture Kit.
// Each source is welded into ONE mesh with ONE material, so a prop is one instanced draw call:
//   - Poly Haven models: their materials' colour, GL normal and ARM (occlusion red, roughness green, metal blue) maps are packed
//     side by side into one atlas per map and the UVs are remapped into it; heavy meshes are simplified with meshoptimizer.
//   - Kenney models carry flat material colours, which become vertex colours; parts named in `tint` become white so the
//     instance colour (a team's colour) paints them.
// Output per prop: <name>.glb (geometry and the material's side) plus <name>-diff.jpg, -nor.jpg and -arm.jpg (occlusion red, roughness green, metal blue).
// Origin at the middle of the footprint, standing on y = 0, facing +z, in metres, sized to the spec.
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const [src = '.', out = './out', only] = process.argv.slice(2);
const wanted = only ? new Set(only.split(',')) : null;
mkdirSync(out, { recursive: true });

// size: [w, h, d] in metres, a number fits one axis (uniform scale), `fit: 'w' | 'h'` picks it.
const SPECS = [
  { name: 'sofa', from: 'sofa_03/sofa_03.gltf', size: [1.9, 0.82, 0.95], uniform: 'w', slot: 1024, maxTris: 3000 },
  { name: 'armchair', from: 'modern_arm_chair_01/modern_arm_chair_01.gltf', size: [0.9, 1, 0.9], uniform: 'w', slot: 512, maxTris: 2500 },
  { name: 'plant_ficus', from: 'potted_plant_01/potted_plant_01.gltf', size: [0.6, 1.1, 0.6], uniform: 'h', slot: 512, maxTris: 1, groups: { _pot: { tris: 1500, flags: ['LockBorder'] }, _leaves: { tris: 2500, error: 1, flags: [] } }, doubleSided: true },
  { name: 'plant_tall', from: 'potted_plant_01/potted_plant_01.gltf', size: [0.9, 1.6, 0.9], uniform: 'h', slot: 512, maxTris: 1, groups: { _pot: { tris: 1500, flags: ['LockBorder'] }, _leaves: { tris: 3000, error: 1, flags: [] } }, doubleSided: true },
  { name: 'plant_syngonium', from: 'potted_plant_02/potted_plant_02.gltf', size: [0.7, 1.3, 0.7], uniform: 'w', slot: 512, maxTris: 1, groups: { _pot: { tris: 1200, flags: ['LockBorder'] }, _leaves: { tris: 2600, error: 1, flags: [] } }, doubleSided: true },
  { name: 'plant_succulent', from: 'potted_plant_04/potted_plant_04.gltf', size: [0.3, 0.42, 0.3], uniform: 'h', slot: 512, maxTris: 3000 },
  { name: 'bookshelf', from: 'wooden_bookshelf_worn/wooden_bookshelf_worn.gltf', size: [1.96, 2, 0.46], slot: 1024, maxTris: 3000 },
  { name: 'desk', from: 'wooden_table_02/wooden_table_02.gltf', size: [1.46, 0.72, 0.94], slot: 1024, rotY: 0 },
  { name: 'lamp', from: 'modern_ceiling_lamp_01/modern_ceiling_lamp_01.gltf', size: [0.42, 1, 0.42], uniform: 'w', slot: 512, anchor: 'top', cutTop: 0.38, maxTris: 1500 },
  // Small things for the top of a desk, a table or a shelf. Sized to the footprint a def takes on a surface (ItemDef.top).
  { name: 'desk_lamp', from: 'desk_lamp_arm_01/desk_lamp_arm_01.gltf', size: [0.3, 0.42, 0.3], uniform: 'h', slot: 512, maxTris: 1200 },
  { name: 'laptop', from: 'classic_laptop/classic_laptop.gltf', size: [0.34, 0.2, 0.25], uniform: 'w', slot: 512, maxTris: 1500 },
  { name: 'picture_frame', from: 'standing_picture_frame_01/standing_picture_frame_01.gltf', size: [0.2, 0.17, 0.08], uniform: 'w', slot: 512, maxTris: 700, rotY: -Math.PI / 2 },
  { name: 'vase', from: 'ceramic_vase_01/ceramic_vase_01.gltf', size: [0.2, 0.34, 0.2], uniform: 'h', slot: 512, maxTris: 900 },
  { name: 'desk_clock', from: 'alarm_clock_01/alarm_clock_01.gltf', size: [0.11, 0.1, 0.06], uniform: 'w', slot: 512, maxTris: 1000 },
  { name: 'chair', from: 'kenney/chairDesk.glb', size: [0.56, 1, 0.56], uniform: 'h', height: 1.0, tint: ['carpet'], rotY: 0 },
];

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const mul = (m, [x, y, z], w = 1) => [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w];

const imageOf = (tex, fallback) => (tex ? Buffer.from(tex.getImage()) : fallback);
const slotOf = async (buf, size, mode) => {
  let img = sharp(buf).resize(size, size, { fit: 'fill' }).removeAlpha();
  if (mode === 'rough') {
    const g = await img.greyscale().raw().toBuffer();
    const o = Buffer.alloc(size * size * 3);
    for (let i = 0; i < g.length; i++) { o[i * 3] = 255; o[i * 3 + 1] = g[i]; o[i * 3 + 2] = 0; }
    return sharp(o, { raw: { width: size, height: size, channels: 3 } });
  }
  return img;
};
const atlas = async (slots, size, quality) => {
  const w = size * slots.length;
  const comps = [];
  for (let i = 0; i < slots.length; i++) comps.push({ input: await slots[i].raw().toBuffer({ resolveWithObject: false }).then((b) => sharp(b, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()), left: i * size, top: 0 });
  return sharp({ create: { width: w, height: size, channels: 3, background: '#808080' } }).composite(comps).jpeg({ quality }).toBuffer();
};

for (const spec of SPECS) {
  if (wanted && !wanted.has(spec.name)) continue;
  const doc = await io.read(join(src, spec.from));
  const root = doc.getRoot();
  const mats = root.listMaterials();
  const pos = [], nor = [], uv = [], col = [], idx = [], triMat = [];
  const kenney = spec.from.startsWith('kenney');
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const base = pos.length / 3;
      const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), T = prim.getAttribute('TEXCOORD_0');
      const mi = mats.indexOf(prim.getMaterial());
      const factor = prim.getMaterial().getBaseColorFactor();
      const white = spec.tint?.includes(prim.getMaterial().getName());
      for (let i = 0; i < P.getCount(); i++) {
        pos.push(...mul(m, P.getElement(i, [])));
        nor.push(...mul(m, N.getElement(i, []), 0));
        const t = T ? T.getElement(i, []) : [0, 0];
        uv.push(t[0], t[1], mi);
        col.push(...(white ? [1, 1, 1] : factor.slice(0, 3)));
      }
      const I = prim.getIndices();
      for (let i = 0; i < I.getCount(); i++) idx.push(base + I.getScalar(i));
      for (let i = 0; i < I.getCount() / 3; i++) triMat.push(prim.getMaterial().getName());
    }
  }
  // normals back to unit length after the node matrices
  for (let i = 0; i < nor.length; i += 3) { const l = Math.hypot(nor[i], nor[i + 1], nor[i + 2]) || 1; nor[i] /= l; nor[i + 1] /= l; nor[i + 2] /= l; }
  // rotate about y, then size and place
  const c = Math.cos(spec.rotY ?? 0), s = Math.sin(spec.rotY ?? 0);
  for (let i = 0; i < pos.length; i += 3) {
    const [x, z] = [pos[i], pos[i + 2]];
    pos[i] = c * x + s * z; pos[i + 2] = -s * x + c * z;
    const [nx, nz] = [nor[i], nor[i + 2]];
    nor[i] = c * nx + s * nz; nor[i + 2] = -s * nx + c * nz;
  }
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
  const dim = lo.map((l, k) => hi[k] - l);
  const target = spec.size;
  let sc;
  if (spec.uniform) { const k = spec.uniform === 'w' ? 0 : 1; const f = (spec.height && spec.uniform === 'h' ? spec.height : target[k]) / dim[k]; sc = [f, f, f]; }
  else sc = target.map((t, k) => t / dim[k]);
  const top = spec.anchor === 'top';
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = (pos[i] - (lo[0] + hi[0]) / 2) * sc[0];
    pos[i + 1] = (pos[i + 1] - (top ? hi[1] : lo[1])) * sc[1];
    pos[i + 2] = (pos[i + 2] - (lo[2] + hi[2]) / 2) * sc[2];
  }
  // `cutTop` shortens a hanging model: triangles wholly within that many metres of the top are dropped, and what hangs below moves up.
  if (spec.cutTop) {
    const kept = [];
    for (let t = 0; t < idx.length; t += 3) if ([0, 1, 2].some((k) => pos[idx[t + k] * 3 + 1] < -spec.cutTop)) kept.push(idx[t], idx[t + 1], idx[t + 2]);
    idx.length = 0;
    idx.push(...kept);
    for (let i = 1; i < pos.length; i += 3) pos[i] += spec.cutTop;
  }
  // simplify
  let indices = Uint32Array.from(idx), posF = Float32Array.from(pos);
  let tris = idx.length / 3;
  if (spec.maxTris && tris > spec.maxTris) {
    // `groups` budgets each material on its own, so a pot keeps its shape while the leaves lose most of theirs.
    const groups = spec.groups ?? { '': { tris: spec.maxTris } };
    const attrs = Float32Array.from(uv.filter((_, i) => i % 3 < 2)); // u, v only
    const out = [];
    for (const [name, g] of Object.entries(groups)) {
      const work = [];
      for (let t = 0; t < idx.length / 3; t++) if (!name || triMat[t].includes(name)) work.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
      const [simp] = g.plain
        ? MeshoptSimplifier.simplify(Uint32Array.from(work), posF, 3, g.tris * 3, g.error ?? 0.1, g.flags ?? [])
        : MeshoptSimplifier.simplifyWithAttributes(Uint32Array.from(work), posF, 3, attrs, 2, [0.5, 0.5], null, g.tris * 3, g.error ?? 0.1, g.flags ?? []);
      out.push(...simp);
    }
    indices = Uint32Array.from(out);
    tris = indices.length / 3;
  }
  // compact
  const remap = new Map();
  const order = [];
  const newIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) { let n = remap.get(indices[i]); if (n === undefined) { n = order.length; remap.set(indices[i], n); order.push(indices[i]); } newIdx[i] = n; }
  const nm = order.length;
  const out_pos = new Float32Array(nm * 3), out_nor = new Float32Array(nm * 3), out_uv = new Float32Array(nm * 2), out_col = new Float32Array(nm * 3);
  const slots = Math.max(mats.length, 1);
  order.forEach((o, n) => {
    out_pos.set(pos.slice(o * 3, o * 3 + 3), n * 3);
    out_nor.set(nor.slice(o * 3, o * 3 + 3), n * 3);
    const u = uv[o * 3], v = uv[o * 3 + 1], mi = uv[o * 3 + 2];
    // outside 0..1 is wrapped, then squeezed into the material's slot of the atlas
    const fu = u - Math.floor(u), fv = v;
    out_uv[n * 2] = kenney ? 0 : (fu + mi) / slots;
    out_uv[n * 2 + 1] = fv;
    out_col.set(col.slice(o * 3, o * 3 + 3), n * 3);
  });

  const outDoc = new Document();
  const buffer = outDoc.createBuffer();
  const acc = (arr, type) => outDoc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const prim = outDoc.createPrimitive()
    .setAttribute('POSITION', acc(out_pos, 'VEC3'))
    .setAttribute('NORMAL', acc(out_nor, 'VEC3'))
    .setIndices(acc(nm < 65536 ? Uint16Array.from(newIdx) : newIdx, 'SCALAR'));
  const material = outDoc.createMaterial(spec.name).setDoubleSided(!!spec.doubleSided);
  if (kenney) {
    prim.setAttribute('COLOR_0', acc(out_col, 'VEC3'));
    material.setRoughnessFactor(0.7).setMetallicFactor(0);
  } else {
    prim.setAttribute('TEXCOORD_0', acc(out_uv, 'VEC2')).setMaterial(material);
    const diffS = [], norS = [], armS = [];
    // A material without a map (a laptop's screen glass) gets a flat one from its factors.
    const flat = (r, g, bl) => sharp({ create: { width: 4, height: 4, channels: 3, background: { r, g, b: bl } } }).png().toBuffer();
    const srgb = (v) => Math.round(Math.pow(v, 1 / 2.2) * 255);
    for (const m of mats) {
      const [cr, cg, cb] = m.getBaseColorFactor();
      diffS.push(await slotOf(imageOf(m.getBaseColorTexture(), await flat(srgb(cr), srgb(cg), srgb(cb))), spec.slot, 'rgb'));
      norS.push(await slotOf(imageOf(m.getNormalTexture(), await flat(128, 128, 255)), spec.slot, 'rgb'));
      const mr = m.getMetallicRoughnessTexture();
      const uri = mr?.getURI() ?? '';
      armS.push(await slotOf(imageOf(mr, await flat(255, Math.round(m.getRoughnessFactor() * 255), Math.round(m.getMetallicFactor() * 255))), spec.slot, !mr || /arm/i.test(uri) ? 'rgb' : 'rough'));
    }
    // The maps stay beside the model as plain JPEGs: a packaged page reads those through <img>, which GLB-embedded images (blob: URLs) can't use.
    for (const [suffix, slotList] of [['diff', diffS], ['nor', norS], ['arm', armS]]) await writeFile(join(out, `${spec.name}-${suffix}.jpg`), await atlas(slotList, spec.slot, 85));
  }
  prim.setMaterial(material);
  const mesh = outDoc.createMesh(spec.name).addPrimitive(prim);
  outDoc.createScene().addChild(outDoc.createNode(spec.name).setMesh(mesh));
  const glb = await io.writeBinary(outDoc);
  await writeFile(join(out, `${spec.name}.glb`), glb);
  console.log(spec.name.padEnd(16), `${tris} tris`, `${(glb.length / 1024).toFixed(0)} KB`, 'size', dim.map((d, k) => (d * sc[k]).toFixed(2)).join(' x '));
}
