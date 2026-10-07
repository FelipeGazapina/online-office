// Which way every chair of the real office faces, measured from the meshes the renderer draws.
// For each chair it takes the backrest (the vertices in the top of the model) against the base (the vertices near the floor), in
// world space, and compares that direction with the direction to the nearest edge of the desk or table it belongs to.
// A chair is right when its backrest points away from that table: the angle between the two directions is near 180 degrees.
// It also checks that a seated employee faces the desk. Real Electron app over CDP; the scene is read through three's devtools
// hook, installed before the page loads, so no app code has to expose it.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9373 node verify/cdp.mjs verify/e2e-chairs.mjs
// OFFICE_SHOT_PREFIX names the screenshots (default ""), so a before run can save "before-" shots. OFFICE_CHAIR_SHOTS=0 skips them.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CELL, ITEM_DEFS, blockCenter, footprint } from '../src/shared/space/index.ts';
import { assert, scratch } from './lib.mjs';

const SHOTS = '/Users/feliperico/.claude/orchestrate/online-office-game/shots/b6';
const PREFIX = process.env.OFFICE_SHOT_PREFIX ?? '';
const { dataDir, repo } = scratch();
mkdirSync(join(repo, 'b'));
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const DEG = 180 / Math.PI;
// A chair is right when its backrest points at least this far from the table (180 is straight away).
const AWAY = 150;
// A seated employee is right when the way they face is within this many degrees of the desk.
const TOWARD = 25;
const DESKS = new Set(['bench_desk', 'po_desk', 'owner_desk']);
// Seating whose item footprint holds the chair, and that has a backrest to measure.
const BACKED = new Set(['chair', 'sofa', 'armchair', 'loveseat']);
// A table smaller than this is a side table, not what a seat faces.
const MIN_TABLE_M2 = 0.9;
// How far from a table a sofa or armchair still counts as facing it.
const REACH = 2;

// Reads the scene that three announced to the devtools hook. Runs in the page, so it is a string.
const COLLECT = `(() => {
  const scenes = window.__scenes;
  for (const s of scenes) s.updateMatrixWorld(true);
  const at = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
  const mul = (a, b) => {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
  };
  const mean = (pts) => pts.length ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length, pts.reduce((s, p) => s + p[2], 0) / pts.length] : null;
  const verts = (geo) => { const p = geo.attributes.position; const out = []; for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)]); return out; };
  // The base is the bottom third of the model and the backrest is its top 40%, both as the mean of their vertices.
  const bands = (pts) => {
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
    const h = hi - lo;
    return { h, lo, base: mean(pts.filter((p) => p[1] <= lo + 0.3 * h)), top: mean(pts.filter((p) => p[1] >= lo + 0.6 * h)), pts };
  };
  const extent = (pts) => { const b = [Infinity, -Infinity, Infinity, -Infinity]; for (const p of pts) { b[0] = Math.min(b[0], p[0]); b[1] = Math.max(b[1], p[0]); b[2] = Math.min(b[2], p[2]); b[3] = Math.max(b[3], p[2]); } return [b[1] - b[0], b[3] - b[2]]; };
  const out = { chairs: [], pods: [], people: [] };

  for (const scene of scenes) scene.traverse((o) => {
    if (o.isInstancedMesh && o.visible && o.count > 0) {
      const { h, lo, base, top, pts } = bands(verts(o.geometry));
      const [w, d] = extent(pts);
      const colors = o.geometry.attributes.color;
      if (h >= 0.7 && h <= 1.3 && w <= 2.2 && d <= 2.2) {
        for (let i = 0; i < o.count; i++) {
          const m = mul(o.matrixWorld.elements, o.instanceMatrix.array.slice(i * 16, i * 16 + 16));
          if (m[0] === 0 && m[5] === 0 && m[10] === 0) continue;
          const b = at(m, ...base);
          const t = at(m, ...top);
          out.chairs.push({ src: 'instanced', coloured: !!colors, verts: o.geometry.attributes.position.count, h: +h.toFixed(2), w: +w.toFixed(2), d: +d.toFixed(2), base: [b[0], b[2]], back: [t[0], t[2]], y: b[1] });
        }
      }
      // A meeting pod is one merged model; its four chairs are the sky-blue vertices, told apart by which side of the pod they are on.
      if (colors && h >= 1.4 && h <= 1.6 && w >= 2.8 && w <= 3.2 && d >= 2.8 && d <= 3.2) {
        const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        const sky = [lin(0x4f / 255), lin(0x7e / 255), lin(0xa3 / 255)];
        const near = (i) => Math.abs(colors.getX(i) - sky[0]) < 0.02 && Math.abs(colors.getY(i) - sky[1]) < 0.02 && Math.abs(colors.getZ(i) - sky[2]) < 0.02;
        const side = (p) => (Math.abs(p[0]) > Math.abs(p[2]) ? (p[0] > 0 ? 'e' : 'w') : (p[2] > 0 ? 's' : 'n'));
        const seat = { n: [], e: [], s: [], w: [] }, back = { n: [], e: [], s: [], w: [] };
        const p = o.geometry.attributes.position;
        for (let v = 0; v < p.count; v++) {
          if (!near(v)) continue;
          const q = [p.getX(v), p.getY(v), p.getZ(v)];
          (q[1] < 0.5 ? seat : back)[side(q)].push(q);
        }
        for (let i = 0; i < o.count; i++) {
          const m = mul(o.matrixWorld.elements, o.instanceMatrix.array.slice(i * 16, i * 16 + 16));
          for (const k of ['n', 'e', 's', 'w']) {
            const b = at(m, ...mean(seat[k])), t = at(m, ...mean(back[k]));
            out.pods.push({ base: [b[0], b[2]], back: [t[0], t[2]], centre: [m[12], m[14]] });
          }
        }
      }
    }
    if (o.userData && o.userData.probe === 'chair') {
      const pts = [];
      o.traverse((c) => { if (c.isMesh && c.geometry.attributes.position) for (const p of verts(c.geometry)) pts.push(at(c.matrixWorld.elements, ...p)); });
      const { base, top } = bands(pts);
      const tables = [];
      for (const sib of o.parent ? o.parent.children : []) {
        if (sib === o || !sib.isMesh || !sib.geometry.attributes.position) continue;
        const world = verts(sib.geometry).map((p) => at(sib.matrixWorld.elements, ...p));
        let hi = -Infinity;
        for (const p of world) hi = Math.max(hi, p[1]);
        const [w, d] = extent(world);
        if (hi >= 0.55 && hi <= 1.25 && w * d >= 0.8) tables.push({ kind: sib.geometry.type, box: [Math.min(...world.map((p) => p[0])), Math.max(...world.map((p) => p[0])), Math.min(...world.map((p) => p[2])), Math.max(...world.map((p) => p[2]))] });
      }
      out.chairs.push({ src: 'group', tables, base: [base[0], base[2]], back: [top[0], top[2]], y: base[1] });
    }
  });

  // A seated employee: the root of the person is the shallowest group standing at their feet, and it turns by their yaw.
  const seated = __office.state().avatars.filter((a) => a.seated);
  for (const a of seated) {
    let best = null;
    for (const scene of scenes) scene.traverse((o) => {
      if (!o.isGroup) return;
      const e = o.matrixWorld.elements;
      if (Math.hypot(e[12] - a.x, e[14] - a.z) > 0.03) return;
      let depth = 0; for (let p = o.parent; p; p = p.parent) depth++;
      if (!best || depth < best.depth) best = { depth, fwd: [e[8], e[10]] };
    });
    out.people.push({ id: a.id, at: [a.x, a.z], fwd: best ? best.fwd : null });
  }
  return out;
})()`;

const len = (v) => Math.hypot(v[0], v[1]);
const unit = (v) => [v[0] / len(v), v[1] / len(v)];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, unit(a)[0] * unit(b)[0] + unit(a)[1] * unit(b)[1]))) * DEG;

// The items of the ground floor as rectangles in metres.
const rects = (items) =>
  items.map((it) => {
    const def = ITEM_DEFS[it.def];
    const f = footprint(def, it.rot);
    return { item: it, def, box: [it.x * CELL, (it.x + f.w) * CELL, it.z * CELL, (it.z + f.d) * CELL] };
  });
const inside = (p, box, pad = 0.05) => p[0] >= box[0] - pad && p[0] <= box[1] + pad && p[1] >= box[2] - pad && p[1] <= box[3] + pad;
const nearest = (p, box) => [Math.min(Math.max(p[0], box[0]), box[1]), Math.min(Math.max(p[1], box[2]), box[3])];
const away = (p, box) => {
  const n = nearest(p, box);
  return Math.hypot(n[0] - p[0], n[1] - p[1]);
};

async function session() {
  const port = process.env.OFFICE_CDP_PORT ?? 9333;
  const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && t.url.startsWith('file:'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  };
  return {
    call: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); }),
    close: () => ws.close(),
  };
}

async function save(s, name) {
  if (process.env.OFFICE_CHAIR_SHOTS === '0') return;
  const path = await s.shot(name);
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(path, join(SHOTS, `${PREFIX}${name}.png`));
}

export default async (s) => {
  // three announces every scene it builds to window.__THREE_DEVTOOLS__ when that exists, so install it for the next load.
  const raw = await session();
  await raw.call('Page.enable');
  await raw.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__THREE_DEVTOOLS__ = new EventTarget(); window.__scenes = []; __THREE_DEVTOOLS__.addEventListener('observe', (e) => { if (e.detail && e.detail.isScene) window.__scenes.push(e.detail); });`,
  });
  // A reload asked for while the window is still settling can be dropped, so ask again until the hook is on the page.
  for (let attempt = 0; attempt < 4 && !(await s.eval('Array.isArray(window.__scenes)').catch(() => false)); attempt++) {
    await raw.call('Page.reload');
    await s.sleep(2500);
  }
  raw.close();
  await s.waitFor('!!window.__office && !!window.office && window.__scenes.length > 0');
  await s.waitFor(`!!${store}.company && !!${store}.building`);
  await s.resize(1440, 900);

  // A meeting pod is the one catalog piece with its chairs built in. Put one on the first free spot east of the hall.
  let podAt = null;
  for (const [x, z] of [[14, -6], [20, -6], [14, 0], [20, 0], [26, -6], [26, 0], [14, 6], [20, 6]]) {
    await s.eval(`window.office.send({ type: 'build', ops: [{ t: 'items', story: 0, put: [{ id: 'meeting_pod:90', def: 'meeting_pod', x: ${x}, z: ${z}, rot: 0 }], del: [] }] })`);
    podAt = await s.waitFor(`${store}.building.stories[0].items.some((i) => i.id === 'meeting_pod:90')`, 1500).then(() => [x, z], () => null);
    if (podAt) break;
  }
  assert(podAt, `a meeting pod is placed (${podAt})`);
  await s.eval('__office.step(8)');
  await s.sleep(2500);

  const building = await s.eval(`${store}.building`);
  const items = rects(building.stories[0].items);
  const data = await s.eval(COLLECT);

  const rows = [];
  const tableFor = (p, wanted) => {
    let best = null;
    for (const r of items) {
      if (!wanted(r)) continue;
      const dist = away(p, r.box);
      if (!best || dist < best.dist) best = { dist, r };
    }
    return best;
  };
  for (const c of data.chairs) {
    const back = [c.back[0] - c.base[0], c.back[1] - c.base[1]];
    if (c.src === 'group') {
      let best = null;
      for (const t of c.tables) {
        const dist = away(c.base, t.box);
        if (!best || dist < best.dist) best = { dist, box: t.box, kind: t.kind };
      }
      if (!best) continue;
      const to = nearest(c.base, best.box).map((v, k) => v - c.base[k]);
      rows.push({ kind: best.kind === 'CylinderGeometry' ? 'huddle chair (Chair)' : 'kitchen chair (Chair)', back, to, at: c.base });
      continue;
    }
    const held = items.find((r) => BACKED.has(r.def.id) && inside(c.base, r.box));
    if (held) {
      // A chair or sofa inside its own footprint. A sofa and an armchair face a coffee table, not a side table.
      const t = tableFor(c.base, (r) => r.def.kind === 'table' && (r.box[1] - r.box[0]) * (r.box[3] - r.box[2]) >= MIN_TABLE_M2);
      if (!t || t.dist > REACH) { rows.push({ kind: `${held.def.id} (no table in reach)`, back, to: null, at: c.base }); continue; }
      rows.push({ kind: held.def.id === 'chair' ? `catalog chair at ${t.r.def.id}` : held.def.id, back, to: nearest(c.base, t.r.box).map((v, k) => v - c.base[k]), at: c.base });
      continue;
    }
    // A chair-sized model that is not inside any piece of furniture and stands at a desk is that desk's chair.
    if (c.coloured && c.w <= 0.7 && c.d <= 0.7) {
      const t = tableFor(c.base, (r) => DESKS.has(r.def.kind));
      if (t && t.dist < 1.0) rows.push({ kind: `${t.r.def.id} chair`, back, to: nearest(c.base, t.r.box).map((v, k) => v - c.base[k]), at: c.base });
    }
  }
  for (const p of data.pods) {
    const back = [p.back[0] - p.base[0], p.back[1] - p.base[1]];
    rows.push({ kind: 'meeting_pod chair (built in)', back, to: [p.centre[0] - p.base[0], p.centre[1] - p.base[1]], at: p.base });
  }

  const byKind = new Map();
  for (const r of rows) {
    if (!r.to) { byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), null]); continue; }
    byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), +angle(r.back, r.to).toFixed(1)]);
  }
  console.log('\nbackrest vs direction to its table (180 = backrest straight away from the table, 0 = backrest toward it)');
  console.log('kind'.padEnd(34), 'n'.padStart(3), 'min'.padStart(7), 'max'.padStart(7), '  verdict');
  const wrong = [];
  for (const [kind, angles] of [...byKind].sort()) {
    const known = angles.filter((a) => a !== null);
    if (!known.length) { console.log(kind.padEnd(34), String(angles.length).padStart(3), '      -       -   not paired'); continue; }
    const ok = known.every((a) => a >= AWAY);
    if (!ok) wrong.push(kind);
    console.log(kind.padEnd(34), String(known.length).padStart(3), String(Math.min(...known)).padStart(7), String(Math.max(...known)).padStart(7), ok ? '  right' : '  WRONG');
  }

  const deskChairs = rows.filter((r) => /_desk chair$/.test(r.kind)).length;
  const desks = items.filter((r) => DESKS.has(r.def.kind)).length;
  assert(deskChairs === desks, `every desk has its chair in the scene (${deskChairs} chairs, ${desks} desks)`);
  assert(rows.some((r) => r.kind.startsWith('catalog chair')), 'the meeting table has its catalog chairs');
  assert(rows.some((r) => r.kind === 'meeting_pod chair (built in)'), 'the meeting pod has its chairs');

  // A seated employee faces the desk: the direction they turn to is the direction of the desk's nearest edge.
  let people = 0;
  for (const p of data.people) {
    assert(p.fwd, `found the scene object of seated employee ${p.id}`);
    const desk = tableFor(p.at, (r) => DESKS.has(r.def.kind));
    const to = nearest(p.at, desk.r.box).map((v, k) => v - p.at[k]);
    const off = angle(p.fwd, to);
    assert(off <= TOWARD, `employee ${p.id} at ${desk.r.def.id} faces the desk (${off.toFixed(1)} degrees off, limit ${TOWARD})`);
    people++;
  }
  assert(people >= 3, `at least three employees are seated (${people})`);

  // The camera follows the owner, so a shot is the owner put next to what it should show, zoomed in the way a player zooms.
  const zoomBy = (deltaY) => s.eval(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY} }))`);
  const huddle = blockCenter(0);
  await zoomBy(-1200);
  await s.eval('__office.teleport(-12, -4.7, Math.PI)');
  await s.sleep(2500);
  await save(s, 'desks');
  await s.eval(`__office.teleport(${huddle.x + 3.3}, ${huddle.z + 4.2}, Math.PI)`);
  await s.sleep(2500);
  await save(s, 'huddle');
  await s.eval('__office.teleport(0, 3.2, Math.PI)');
  await s.sleep(2500);
  await save(s, 'meeting');

  assert(wrong.length === 0, `every chair kind faces its table (wrong: ${wrong.join(', ') || 'none'})`);
};
