// Verification hooks: the render loop can be throttled in background tabs, so tests advance the sim by hand.
import { _roots } from '@react-three/fiber';
import { Matrix4, Raycaster, Vector2, Vector3, type InstancedMesh, type Mesh, type Object3D } from 'three';
import type { Building } from '../../shared/space/index.ts';
import type { BlockId, Employee, EmployeeId, ModelId, ProjectBlock } from '../../shared/protocol.ts';
import { DESKS_PER_BLOCK } from '../../shared/protocol.ts';
import { applyOps, CELL, legacyBuilding, rectWalls, STORY_H, type BuildOp, type Item, type ItemId, type SpaceContext, type WallSeg } from '../../shared/space/index.ts';
import { defOf, floorItems, itemRect } from '../../shared/space/geom.ts';
import { benchItem } from '../../shared/space/kit.ts';
import { applyServerMessage } from './office.ts';
import { loadMailFixture } from './hud/chat/fixture.ts';
import { renders } from './hud/chat/renders.ts';
import { KEYS_INTENT, runtime } from './runtime.ts';
import { modelOf, PROP_DEFS } from './scene/building/models.ts';
import { propOf } from './scene/props.ts';
import { floorBase, tripTo, worldFor } from './world.ts';
import { inView, stepSim, tripEnd, walkTo } from './sim.ts';
import { get, sendTap, set, setSetting, useStore } from './store.ts';

const intentState = () => {
  const i = runtime.owner.intent;
  if (i.kind !== 'walk') return { kind: i.kind };
  const end = tripEnd(i.trip);
  return { kind: i.kind, goal: i.goal, dest: end.at, floor: end.floor, left: end.waypoints, legs: end.legs };
};

// Test-only: replaces the company in the renderer store with `count` fake employees spread over as many blocks as they
// need, two thirds of them working so their avatars animate. Main never hears about them, so no snapshot may arrive after.
function injectFake(count: number, floors = 1, tops = 0) {
  const company = get().company;
  if (!company) throw new Error('no company yet');
  const colors = ['#e07a5f', '#3d85c6', '#81b29a', '#f2cc8f'];
  const blocks: ProjectBlock[] = Array.from({ length: Math.max(1, Math.ceil(count / DESKS_PER_BLOCK)) }, (_, slot) => ({
    id: `fake-block-${slot}` as BlockId,
    name: `Fake ${slot}`,
    cwd: `/tmp/fake-${slot}`,
    color: colors[slot % colors.length],
    slot,
  }));
  const desks = Array.from({ length: count }, (_, i) => ({ id: `fake-emp-${i}`, blockId: blocks[Math.floor(i / DESKS_PER_BLOCK)].id, desk: i % DESKS_PER_BLOCK, orchestrator: false }));
  const legacy = legacyBuilding(blocks.map((b) => ({ id: b.id, slot: b.slot })), desks);
  const stacked = floors > 1 ? stackStories(legacy.building, legacy.seats, desks, blocks, floors) : legacy;
  const { building, seats } = tops ? { building: decorate(stacked.building, tops), seats: stacked.seats } : stacked;
  const employees: Employee[] = Array.from({ length: count }, (_, i) => ({
    id: `fake-emp-${i}` as EmployeeId,
    name: `Fake ${i}`,
    provider: 'claude-code',
    blockId: blocks[Math.floor(i / DESKS_PER_BLOCK)].id,
    seat: seats.get(`fake-emp-${i}`) ?? null,
    status: i % 3 === 2 ? { kind: 'idle' } : { kind: 'working', task: 'fake task', startedAt: Date.now() },
    activity: 'typing',
    model: 'fake' as ModelId,
    permissions: { mode: company.settings.defaultPermissions, alwaysAllow: [] },
    subagents: [],
    hiredAt: Date.now(),
  }));
  set({ company: { ...company, blocks, employees }, building });
}

// Test-only: up to `count` small things spread over the bench desks, eight to a desk, in the free strips beside the computer.
function decorate(b: Building, count: number): Building {
  const spots: [string, number, number, 0 | 1 | 2 | 3][] = [['lamp_desk', 0, 0, 0], ['laptop', 0, 3, 2], ['books', 0, 5, 0], ['mug', 10, 1, 0], ['pen_cup', 11, 2, 0], ['desk_clock', 10, 4, 2], ['vase', 4, 6, 0], ['picture_frame', 7, 6, 2]];
  let left = count;
  const ops: BuildOp[] = b.stories.map((story, s) => {
    const put: Item[] = [];
    for (const desk of floorItems(story)) {
      if (desk.def !== 'bench_desk') continue;
      for (const [def, u, v, rot] of spots) if (left > 0 && left-- > 0) put.push({ id: `${desk.id}:top:${def}` as ItemId, def, on: desk.id, u, v, rot });
    }
    return { t: 'items' as const, story: s, put, del: [] };
  });
  const noCtx: SpaceContext = { blocks: new Set(), employees: new Map(), seats: new Map() };
  const applied = applyOps(b, ops, noCtx);
  if (!applied.ok) throw new Error(`could not decorate: ${applied.violations.map((v) => v.kind).join(', ')}`);
  return applied.building;
}

// Test-only: the legacy office with `floors - 1` stories on top, each lot-wide with its own windows, an inner wall, stairs
// up from the story below, decor, and bench desks that take an even share of the employees off the ground floor.
function stackStories(ground: Building, groundSeats: Map<string, ItemId>, desks: { id: string; blockId: string }[], blocks: ProjectBlock[], floors: number) {
  const lot = ground.lot;
  const seats = new Map(groundSeats);
  const ops: BuildOp[] = [{ t: 'stories', count: floors }, { t: 'items', story: 0, put: [{ id: 'stairs:00' as ItemId, def: 'stairs', x: 16, z: 4, rot: 0 }], del: [] }];
  const share = Math.ceil(desks.length / floors);
  for (let story = 1; story < floors; story++) {
    const cells = Array.from({ length: lot.w * lot.h }, (_, i) => ({ x: lot.x0 + (i % lot.w), z: lot.z0 + Math.floor(i / lot.w), half: 0 as const, paint: story + 1 }));
    const walls: WallSeg[] = rectWalls({ x: lot.x0, z: lot.z0, w: lot.w, h: lot.h }, 2).map((w, i) => (i % 6 >= 1 && i % 6 <= 4 ? { ...w, open: 'window' as const } : w));
    for (let i = 0; i < 12; i++) walls.push({ x: -6 + i, z: -2, d: 'e', style: 2, ...(i === 5 ? { open: 'door' as const } : {}) });
    const items: Item[] = desks.slice(story * share, (story + 1) * share).map((d, n) => {
      const slot = blocks.findIndex((b) => b.id === d.blockId);
      const item = { ...benchItem(d.blockId, slot, n), id: `${d.blockId}:bench_desk:${story}${n}` as ItemId };
      seats.set(d.id, item.id);
      return item;
    });
    const put = (def: string, x: number, z: number): Item => ({ id: `${def}:${story}0` as ItemId, def, x, z, rot: 0 });
    items.push(put('plant', -30, -30), put('sofa', 20, 10), put('bookshelf', -34, -38), put('meeting_table', 20, -20));
    if (story < floors - 1) items.push({ id: `stairs:0${story}` as ItemId, def: 'stairs', x: 30, z: 4, rot: 0 });
    ops.push({ t: 'floor', story, cells }, { t: 'walls', story, put: walls, del: [] }, { t: 'items', story, put: items, del: [] });
  }
  const ctx: SpaceContext = {
    blocks: new Set(blocks.map((b) => b.id)),
    employees: new Map(desks.map((d) => [d.id, { blockId: d.blockId, orchestrator: false }])),
    seats,
  };
  const built = applyOps(ground, ops, ctx);
  if (!built.ok) throw new Error(`the ${floors}-story fixture is illegal: ${JSON.stringify(built.violations)}`);
  return { building: built.building, seats };
}

// Test-only: real frame times over `ms` of requestAnimationFrame, plus the renderer's draw-call counters and the frame
// budget, which holds still when the machine is busy: CPU ms spent inside gl.render per frame, and GPU ms per frame from
// timer queries where the driver offers them (the mean of the resolved frames, null when it does not).
function measureFrames(ms: number) {
  const root = _roots.values().next().value;
  if (!root) throw new Error('no canvas');
  const { gl } = root.store.getState();
  const info = gl.info;
  const ctx = gl.getContext() as WebGL2RenderingContext;
  const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2');
  const queries: WebGLQuery[] = [];
  let cpu = 0;
  let renders = 0;
  const render = gl.render.bind(gl);
  gl.render = (scene, camera) => {
    const q = ext ? ctx.createQuery() : null;
    if (q) ctx.beginQuery(ext!.TIME_ELAPSED_EXT, q);
    const t0 = performance.now();
    render(scene, camera);
    cpu += performance.now() - t0;
    renders++;
    if (q) {
      ctx.endQuery(ext!.TIME_ELAPSED_EXT);
      queries.push(q);
    }
  };
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let drawCalls = 0;
    let triangles = 0;
    let last = 0;
    let start = 0;
    const tick = (t: number) => {
      if (!start) start = t;
      if (last) deltas.push(t - last);
      last = t;
      drawCalls = Math.max(drawCalls, info.render.calls);
      triangles = Math.max(triangles, info.render.triangles);
      if (t - start < ms) return void requestAnimationFrame(tick);
      gl.render = render;
      setTimeout(() => {
        const gpu = queries.filter((q) => ctx.getQueryParameter(q, ctx.QUERY_RESULT_AVAILABLE)).map((q) => ctx.getQueryParameter(q, ctx.QUERY_RESULT) / 1e6);
        const disjoint = ext ? ctx.getParameter(ext.GPU_DISJOINT_EXT) : true;
        resolve({ deltas, drawCalls, triangles, cpuMs: cpu / Math.max(1, renders), gpuMs: gpu.length && !disjoint ? gpu.reduce((a, b) => a + b, 0) / gpu.length : null });
      }, 300);
    };
    requestAnimationFrame(tick);
  });
}

// Test-only: what a real click at a viewport pixel reaches. It raycasts the pixel through the objects the event system
// listens to, nearest first, and names the first one with an onClick: the floor, a piece of furniture a click walks to,
// a fixture that does something else when clicked (the project computer, the whiteboard), an avatar, or nothing.
// For the floor and furniture it also says where the walk that click starts would end, or null when there is no way there.
function pick(x: number, y: number) {
  const root = _roots.values().next().value;
  if (!root) return null;
  const { camera, size, internal } = root.store.getState();
  const caster = new Raycaster();
  caster.setFromCamera(new Vector2(((x - size.left) / size.width) * 2 - 1, -((y - size.top) / size.height) * 2 + 1), camera);
  const handled = (o: Object3D | null): boolean => !!o && (!!(o as { __r3f?: { handlers?: { onClick?: unknown } } }).__r3f?.handlers?.onClick || handled(o.parent));
  const first = caster.intersectObjects(internal.interaction, true).find((h) => handled(h.object));
  if (!first) return { kind: 'nothing' as const };
  const { point, object } = first;
  const floor = Math.max(0, Math.floor((point.y + 0.5) / STORY_H));
  const instanced = (object as InstancedMesh).isInstancedMesh;
  // The floor is the one clickable mesh drawn with a list of materials, one per paint.
  const onFloor = !instanced && Array.isArray((object as Mesh).material);
  const item = floorItems(get().building!.stories[floor]!).find((i) => {
    const def = defOf(i);
    if (!def) return false;
    const r = itemRect(i, def);
    return point.x >= r.x0 * CELL && point.x <= r.x1 * CELL && point.z >= r.z0 * CELL && point.z <= r.z1 * CELL;
  });
  const kind = onFloor ? ('floor' as const) : instanced ? (item ? ('furniture' as const) : ('avatar' as const)) : ('fixture' as const);
  const world = worldFor(get().building, get().meetingDoor);
  const { pos } = runtime.owner;
  const trip = kind === 'floor' || kind === 'furniture' ? world && tripTo(world, { floor: runtime.owner.floor, x: pos.x, z: pos.z }, { floor, x: point.x, z: point.z }) : null;
  const end = trip ? tripEnd(trip) : null;
  return {
    kind,
    what: kind === 'floor' ? 'floor' : `${item?.def ?? object.type}${item ? ` ${item.id}` : ''}`,
    point: { x: +point.x.toFixed(2), y: +point.y.toFixed(2), z: +point.z.toFixed(2) },
    floor,
    walk: end ? { x: +end.at.x.toFixed(2), z: +end.at.z.toFixed(2), waypoints: end.waypoints } : null,
  };
}

// Test-only: how many wall pieces stand at full height, and how many curbs stand where the cutaway dropped a wall.
function wallStats() {
  const root = _roots.values().next().value;
  if (!root) throw new Error('no canvas');
  const stats = { full: 0, curbs: 0, hidden: 0 };
  root.store.getState().scene.traverse((o) => {
    const tag = o.userData?.wall as string | undefined;
    const mesh = o as import('three').InstancedMesh;
    if (!tag || !mesh.isInstancedMesh) return;
    if (tag === 'curb') return void (stats.curbs += mesh.count);
    if (tag !== 'solid') return;
    for (let i = 0; i < mesh.count; i++) (mesh.instanceMatrix.array[i * 16] === 0 ? stats.hidden++ : stats.full++);
  });
  return stats;
}

// Test-only: the scene meshes a build-mode piece tagged `userData.probe`, with their data and the color they draw in.
function probe(name: string) {
  const root = _roots.values().next().value;
  if (!root) return [];
  const found: Record<string, unknown>[] = [];
  root.store.getState().scene.traverse((o) => {
    const data = o.userData as Record<string, unknown> | undefined;
    if (data?.probe !== name) return;
    const m = (o as import('three').Mesh).material as import('three').MeshBasicMaterial | undefined;
    found.push({ ...data, color: m?.color ? `#${m.color.getHexString()}` : null, opacity: m?.opacity ?? null });
  });
  return found;
}

/** Where every instance of a def's model stands in the world, read from the meshes the scene draws: the way to tell that a thing is where its data says. */
function instances(def: string) {
  const root = _roots.values().next().value;
  if (!root) return [];
  const baked = PROP_DEFS[def];
  const geometry = baked ? propOf(baked.prop).geometry : modelOf(def);
  const m = new Matrix4();
  const out: { x: number; y: number; z: number; yaw: number }[] = [];
  root.store.getState().scene.traverse((o: Object3D) => {
    const mesh = o as InstancedMesh;
    if (!mesh.isInstancedMesh || mesh.geometry !== geometry) return;
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.premultiply(mesh.matrixWorld);
      const e = m.elements;
      out.push({ x: +e[12].toFixed(3), y: +e[13].toFixed(3), z: +e[14].toFixed(3), yaw: +Math.atan2(e[8], e[0]).toFixed(3) });
    }
  });
  return out;
}

export function installDebug() {
  (window as unknown as { __office: unknown }).__office = {
    step(seconds: number, fps = 30) {
      for (let i = 0; i < seconds * fps; i++) stepSim(1 / fps);
    },
    teleport(x: number, z: number, yaw = runtime.owner.yaw) {
      runtime.owner.pos.set(x, runtime.owner.pos.y, z);
      runtime.owner.yaw = yaw;
      runtime.owner.intent = KEYS_INTENT;
      runtime.queueYaw = yaw;
      runtime.view.yaw = yaw;
    },
    hold(code: string, on = true) {
      if (on) runtime.keys.add(code);
      else runtime.keys.delete(code);
    },
    state: () => ({
      owner: { x: runtime.owner.pos.x, y: runtime.owner.pos.y, z: runtime.owner.pos.z, floor: runtime.owner.floor, yaw: runtime.owner.yaw, approach: runtime.owner.approach, inView: inView(get().talkingTo) },
      avatars: [...runtime.avatars.values()].map((a) => ({ id: a.id, x: +a.pos.x.toFixed(2), z: +a.pos.z.toFixed(2), floor: a.floor, seated: a.seated, speed: +a.speed.toFixed(2) })),
      talkingTo: get().talkingTo,
      askerId: get().askerId,
      intent: intentState(),
      camera: get().camera,
      view: { yaw: runtime.view.yaw, isoYawTarget: runtime.view.isoYawTarget },
    }),
    // Where a point of the office lands on screen, in viewport pixels, through the camera as it is right now. That is
    // the camera a real click is raycast through, so a mouse event sent there hits that point.
    project(x: number, y: number, z: number) {
      const root = _roots.values().next().value;
      if (!root) return null;
      const { camera, size } = root.store.getState();
      const p = new Vector3(x, y, z).project(camera);
      return { x: size.left + ((p.x + 1) / 2) * size.width, y: size.top + ((1 - p.y) / 2) * size.height };
    },
    pick,
    // Test-only: stands the owner on another story at once, so the overview draws every story up to it.
    ownerTo(floor: number, x: number, z: number) {
      runtime.owner.floor = floor;
      runtime.owner.pos.set(x, floorBase(floor), z);
      runtime.owner.intent = KEYS_INTENT;
    },
    wallStats,
    probe,
    instances,
    // The same walk a floor click starts, aimed at any story. The overview draws only the stories up to the owner's, so a click cannot reach a higher one yet.
    walkTo: (floor: number, x: number, z: number) => walkTo({ kind: 'point', at: { x, z }, floor }),
    injectFake,
    // Test-only: the chat with a whole conversation in it. Main never hears about these people.
    loadMailFixture() {
      const company = get().company;
      if (!company) throw new Error('no company yet');
      return loadMailFixture(company);
    },
    renders,
    // Test-only: hand every message the UI would send to `fn` instead of main.
    tapSend(fn: (m: unknown) => void) {
      sendTap.fn = fn;
    },
    measureFrames,
    setCamera: () => setSetting('camera', 'iso'),
    apply: applyServerMessage,
    store: useStore,
    set,
  };
}
