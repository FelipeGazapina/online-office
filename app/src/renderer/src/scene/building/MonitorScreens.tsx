// A desk's screens show what its sitter is doing. One mesh draws the screens of every desk in a setup. The biggest screen of a desk
// whose sitter is an employee shows that employee's terminal (scene/terminalAtlas.ts), and each frame sets the brightness of the
// others. A terminal is redrawn only when it changed, only when its desk is on screen and big enough to read, and a few times a
// second at the most, so fifteen working employees cost a couple of small canvas draws a frame.
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, Color, Frustum, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3, type BufferGeometry, type PerspectiveCamera } from 'three';
import { PROVIDERS, type Employee } from '../../../../shared/protocol.ts';
import { ITEM_DEFS, STORY_H, YAW, floorItems, setupsOf, type FloorGeometry } from '../../../../shared/space/index.ts';
import { enterMonitor, useMonitor } from '../../computer.ts';
import { modelLabel, startTerminalFeed, terminalBlocks, terminalLive, terminalVersion } from '../../hud/terminal/feed.ts';
import { runtime } from '../../runtime.ts';
import { get } from '../../store.ts';
import { monitorPoses } from '../monitorPose.ts';
import { atlas, columnsFor } from '../terminalAtlas.ts';
import { poolTexture, codeTexture } from '../textures.ts';
import { screensOf, terminalScreenOf } from './computer.ts';
import { screenMaterial, termMap } from './screenMaterial.ts';

const screenMat = screenMaterial(codeTexture());
// The light a screen throws on the desk in front of it, tinted by what the screen shows.
const glowMaterial = new MeshBasicMaterial({ map: poolTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 });
const glowGeometry = new PlaneGeometry(1.2, 0.8).rotateX(-Math.PI / 2).translate(0, 0.78, -0.12);

const up = new Vector3(0, 1, 0);
const one = new Vector3(1, 1, 1);
const q = new Quaternion();
const color = new Color();
const frustum = new Frustum();
const projection = new Matrix4();
const mat = new Matrix4();
const point = new Vector3();
const place3 = new Vector3();

// A terminal on a screen smaller than this many pixels across cannot be read, so it keeps what it showed.
const MIN_READABLE_PX = 12;
// The same terminal is drawn at most this often, and no more than this many are drawn in a frame.
const REDRAW_MS = 250;
const DRAWS_PER_FRAME = 2;
// The owner is this close to a desk for F to open its terminal, in meters.
const REACH = 2.7;

const budget = { frame: -1, left: 0, turn: 0 };

export function Screens({ geom }: { geom: FloorGeometry }) {
  const { gl } = useThree();
  const meshes = useRef(new Map<number, InstancedMesh>());
  const desks = useMemo(() => floorItems(geom.story).filter((i) => i.def === 'bench_desk' || i.def === 'po_desk'), [geom]);
  const sitters = useRef<{ company: unknown; bySeat: Map<string, Employee>; rects: number }>({ company: null, bySeat: new Map(), rects: -1 });
  // Each desk's place in the mesh of its setup, so a frame can colour it without searching.
  const slots = useMemo(() => {
    const setups = setupsOf(geom.story);
    const counts = new Map<number, number>();
    return desks.map((d) => {
      const setup = setups.get(d.id) ?? 0;
      const local = counts.get(setup) ?? 0;
      counts.set(setup, local + 1);
      const f = d.rot % 2 === 0 ? { w: ITEM_DEFS[d.def].w, d: ITEM_DEFS[d.def].d } : { w: ITEM_DEFS[d.def].d, d: ITEM_DEFS[d.def].w };
      // The desk's middle in meters from the story's origin, and the shape of the terminal on its screen.
      const x = (d.x + f.w / 2) / 2;
      const z = (d.z + f.d / 2) / 2;
      const screen = terminalScreenOf(setup);
      return { desk: d, setup, local, x, z, screen, cols: columnsFor(screen.w / screen.h) };
    });
  }, [desks, geom]);
  const used = useMemo(() => [...new Set(slots.map((s) => s.setup))].sort((a, b) => a - b), [slots]);
  const glow = useRef<InstancedMesh>(null);
  // One geometry per mesh: the screens of the setup, and for each instance the rectangle of the atlas its terminal is in.
  const geometries = useMemo(() => {
    const out = new Map<number, BufferGeometry>();
    for (const setup of used) {
      const g = screensOf(setup).clone();
      g.setAttribute('iRect', new InstancedBufferAttribute(new Float32Array(slots.filter((s) => s.setup === setup).length * 4), 4));
      out.set(setup, g);
    }
    return out;
  }, [used, slots]);
  useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries]);
  useEffect(() => startTerminalFeed(), []);

  const matrixOf = (m: Matrix4, d: (typeof desks)[number]) => {
    const def = ITEM_DEFS[d.def];
    const f = d.rot % 2 === 0 ? { w: def.w, d: def.d } : { w: def.d, d: def.w };
    return m.compose(place3.set((d.x + f.w / 2) / 2, 0, (d.z + f.d / 2) / 2), q.setFromAxisAngle(up, YAW[d.rot]), one);
  };

  useLayoutEffect(() => {
    for (const [setup, mesh] of meshes.current) {
      for (const s of slots) {
        if (s.setup !== setup) continue;
        mesh.setMatrixAt(s.local, matrixOf(mat, s.desk));
        mesh.setColorAt(s.local, color.set('#6a7898').multiplyScalar(0.45));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    const g = glow.current;
    if (!g) return;
    desks.forEach((d, i) => g.setMatrixAt(i, matrixOf(mat, d)));
    g.instanceMatrix.needsUpdate = true;
    sitters.current.company = null;
  }, [slots, desks, geometries]);

  useEffect(
    () => () => {
      for (const [id, pose] of monitorPoses) if (pose.floor === geom.index) monitorPoses.delete(id);
    },
    [geom],
  );

  useFrame((state, dt) => {
    const { company } = get();
    const a = atlas();
    let rects = sitters.current.rects;
    if (sitters.current.company !== company) {
      sitters.current = { company, bySeat: new Map((company?.employees ?? []).flatMap((e) => (e.seat ? [[e.seat as string, e] as const] : []))), rects: -1 };
      rects = -1;
      a.forget(new Set((company?.employees ?? []).map((e) => e.id)));
      for (const s of slots) {
        const e = sitters.current.bySeat.get(s.desk.id);
        if (!e) continue;
        const sc = s.screen;
        const cos = Math.cos(YAW[s.desk.rot]);
        const sin = Math.sin(YAW[s.desk.rot]);
        const rot = (x: number, z: number): [number, number] => [x * cos + z * sin, -x * sin + z * cos];
        const [cx, cz] = rot(sc.x, sc.z);
        const [nx, nz] = rot(sc.nx, sc.nz);
        monitorPoses.set(e.id, { center: new Vector3(s.x + cx, geom.index * STORY_H + sc.y, s.z + cz), normal: new Vector3(nx, sc.ny, nz).normalize(), w: sc.w, h: sc.h, floor: geom.index });
      }
    }
    const t = state.clock.elapsedTime;
    codeTexture().offset.y -= dt * 0.1;

    // The terminals. A new texture or a new company means every rectangle is read again.
    if (termMap.value !== a.texture) {
      termMap.value = a.texture;
      rects = -1;
    }
    if (rects !== a.revision) {
      for (const [setup, g] of geometries) {
        const attr = g.getAttribute('iRect') as InstancedBufferAttribute;
        for (const s of slots) {
          if (s.setup !== setup) continue;
          const e = sitters.current.bySeat.get(s.desk.id);
          const r = e ? a.rectOf(e.id) : [0, 0, 0, 0];
          attr.setXYZW(s.local, r[0]!, r[1]!, r[2]!, r[3]!);
        }
        attr.needsUpdate = true;
      }
      rects = a.revision;
    }
    sitters.current.rects = rects;

    const camera = state.camera as PerspectiveCamera;
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const tanHalf = Math.tan(camera.fov * (Math.PI / 360));
    if (budget.frame !== state.gl.info.render.frame) {
      budget.frame = state.gl.info.render.frame;
      budget.left = DRAWS_PER_FRAME;
    }
    const now = Date.now();
    const owner = runtime.owner;
    let nearest: { id: Employee['id']; d: number } | null = null;

    slots.forEach(({ desk, setup, local, x, z, screen, cols }, i) => {
      const e = sitters.current.bySeat.get(desk.id);
      const kind = e?.status.kind ?? 'none';
      if (kind === 'working') {
        color.set(PROVIDERS[e!.provider].color).lerp(new Color('#ffffff'), 0.3).multiplyScalar(0.9 + Math.sin(t * 3 + i) * 0.15);
      } else if (kind === 'blocked_on_owner') {
        color.set('#ffb340').multiplyScalar(0.55 + (Math.sin(t * 6) + 1) * 0.3);
      } else if (kind === 'error') {
        color.set('#ff4d4d');
      } else {
        // A desk nobody sits at has its screen on standby: lit dimly, so a row of empty desks is not a row of black slabs.
        color.set('#6a7898').multiplyScalar(0.45);
      }
      meshes.current.get(setup)?.setColorAt(local, color);
      glow.current?.setColorAt(i, color.multiplyScalar(0.28));
      if (!e) return;

      if (geom.index === owner.floor) {
        const d = Math.hypot(owner.pos.x - x, owner.pos.z - z);
        if (d < REACH && (!nearest || d < nearest.d)) nearest = { id: e.id, d };
      }
      if (budget.left <= 0) return;
      point.set(x, geom.index * STORY_H + screen.y, z);
      if (!frustum.containsPoint(point)) return;
      const dist = camera.position.distanceTo(point);
      const px = (screen.w / (2 * dist * tanHalf)) * state.size.height;
      const zoomed = useMonitor.getState().open === e.id;
      if (px < MIN_READABLE_PX && !zoomed) return;
      const s = e.status;
      const key = [
        terminalVersion(e.id),
        s.kind,
        s.kind === 'working' ? `${s.startedAt}@${Math.floor(now / 500)}` : s.kind === 'blocked_on_owner' ? s.question.id : s.kind === 'error' ? s.message : '',
        e.permissions.mode,
        e.name,
        e.model,
        cols,
      ].join('|');
      if (key === a.keyOf(e.id) || performance.now() - a.drawnAt(e.id) < REDRAW_MS) return;
      a.draw(e.id, key, { blocks: terminalBlocks(e.id), live: terminalLive(e.id), status: s, who: e.name, model: modelLabel(e.model), mode: e.permissions.mode, cols, now });
      budget.left--;
    });
    for (const m of meshes.current.values()) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (glow.current?.instanceColor) glow.current.instanceColor.needsUpdate = true;
    a.flush(gl);
    // Only the story the owner is on says who is within reach.
    if (geom.index === owner.floor) {
      const id = (nearest as { id: Employee['id'] } | null)?.id ?? null;
      if (useMonitor.getState().near !== id) useMonitor.setState({ near: id });
    }
  });

  const onScreen = (setup: number) => (e: ThreeEvent<MouseEvent>) => {
    // A drag turned the view. A click opens the terminal of the employee at that desk.
    if (e.delta >= 6 || e.instanceId === undefined) return;
    const s = get();
    if (s.build || s.modal || s.menu || s.portalMode) return;
    const slot = slots.filter((x) => x.setup === setup)[e.instanceId];
    const sitter = slot && sitters.current.bySeat.get(slot.desk.id);
    if (!sitter) return;
    e.stopPropagation();
    enterMonitor(sitter.id);
  };

  return (
    <>
      {used.map((setup) => {
        const mine = slots.filter((s) => s.setup === setup);
        // For the tests: which desk each screen of this mesh belongs to and the colour it is lit with right now.
        const probe = {
          probe: 'screens',
          setup,
          desks: mine.map((s) => s.desk.id),
          get colors() {
            return Array.from(meshes.current.get(setup)?.instanceColor?.array ?? []);
          },
        };
        return (
          <instancedMesh
            key={`${setup}:${mine.length}`}
            ref={(m: InstancedMesh | null) => void (m ? meshes.current.set(setup, m) : meshes.current.delete(setup))}
            args={[geometries.get(setup)!, screenMat, mine.length]}
            frustumCulled={false}
            userData={probe}
            onClick={onScreen(setup)}
          />
        );
      })}
      {desks.length > 0 && <instancedMesh key={`glow${desks.length}`} ref={glow} args={[glowGeometry, glowMaterial, desks.length]} frustumCulled={false} renderOrder={3} />}
    </>
  );
}
