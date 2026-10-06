import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, BackSide, BufferGeometry, Color, DoubleSide, Group, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, RepeatWrapping, Vector3 } from 'three';
import { PROVIDERS, type Employee } from '../../../../shared/protocol.ts';
import { ITEM_DEFS, STORY_H, WALL_STYLES, YAW, type FloorGeometry, type ItemId } from '../../../../shared/space/index.ts';
import { hasFloorAt, tileIndex } from '../../../../shared/space/geom.ts';
import { runtime } from '../../runtime.ts';
import { get, set, useStore } from '../../store.ts';
import { walkTo } from '../../sim.ts';
import { chairOf } from '../../world.ts';
import { blobShadowTexture, ceilingTexture, codeTexture, plankTexture, poolTexture, wallAoTexture } from '../textures.ts';
import { detail } from '../shading.ts';
import { floorGeometry } from './floor.ts';
import { box, chairModel, cyl, merge, DEFAULT_TINT, DYNAMIC, modelOf, screenGeometry } from './models.ts';
import { curbModel, facesCamera, frameModel, glassModel, octantOf, VARIANTS, wallMatrix, wallModel, wallRecords, ZERO, type Variant } from './walls.ts';

const up = new Vector3(0, 1, 0);
const q = new Quaternion();
const p3 = new Vector3();
const one = new Vector3(1, 1, 1);
const s3 = new Vector3();
const color = new Color();

const woodMaterial = detail(new MeshStandardMaterial({ map: plankTexture(), vertexColors: true, roughness: 0.85 }), 'floor');
woodMaterial.map!.wrapS = woodMaterial.map!.wrapT = RepeatWrapping;
const flatMaterial = detail(new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), 'floor');
const furnitureMaterial = detail(new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }), 'furniture');
const wallMaterial = detail(new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), 'wall');
const glassMaterial = new MeshStandardMaterial({ color: '#cfe8ff', emissive: '#a8d4ff', emissiveIntensity: 0.9, roughness: 0.2, side: DoubleSide });
const frameMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 });
const railMaterial = new MeshStandardMaterial({ color: '#c9cdd8', roughness: 0.5, metalness: 0.3 });
const ceilingMap = ceilingTexture();
ceilingMap.repeat.set(6.5, 6.5);
const ceilingMaterial = new MeshStandardMaterial({ map: ceilingMap, roughness: 0.95, side: BackSide, color: '#cdbfae', emissive: '#fff0d8', emissiveIntensity: 0.22 });
const slabMaterial = new MeshStandardMaterial({ color: '#cdbfa9', roughness: 0.95 });
const fixtureMaterial = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
// A pendant: a dark cross beam on the ceiling, a cord, a brass drum shade and the glowing disc inside it.
const fixtureGeometry = merge([
  box(1.7, 0.12, 0.2, 0, 0.1, 0, '#3a2c22'),
  cyl(0.012, 0.012, 0.55, 0, -0.25, 0, '#2b2e38', 4),
  cyl(0.08, 0.25, 0.22, 0, -0.62, 0, '#b08a4e', 14),
  cyl(0.23, 0.23, 0.03, 0, -0.74, 0, '#ffe6b0', 14),
]);
const poolMaterial = new MeshBasicMaterial({ map: poolTexture(), color: '#ffc982', transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.3, fog: false, polygonOffset: true, polygonOffsetFactor: -3 });
const poolGeometry = new PlaneGeometry(4.6, 4.6).rotateX(-Math.PI / 2);
const blobMaterial = new MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -2 });
const blobGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const aoMaterial = new MeshBasicMaterial({ map: wallAoTexture(), transparent: true, depthWrite: false, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -1 });
const aoGeometry = new PlaneGeometry(1, 1.1).rotateX(-Math.PI / 2);
const NO_BLOB: ReadonlySet<string> = new Set(['rug', 'rail', 'stairs']);
const CEILING_Y = STORY_H - 0.3;
const screenMaterial = new MeshBasicMaterial({ map: codeTexture(), toneMapped: false });

function Instances({
  geometry,
  material,
  count,
  fill,
  onClick,
  castShadow = true,
  receiveShadow = true,
}: {
  geometry: BufferGeometry;
  material: MeshStandardMaterial | MeshBasicMaterial;
  count: number;
  fill: (mesh: InstancedMesh) => void;
  onClick?: (e: ThreeEvent<MouseEvent>) => void;
  castShadow?: boolean;
  receiveShadow?: boolean;
}) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    fill(m);
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [fill]);
  if (count === 0) return null;
  return <instancedMesh ref={ref} args={[geometry, material, count]} frustumCulled={false} castShadow={castShadow} receiveShadow={receiveShadow} onClick={onClick} />;
}

const place = (m: Matrix4, x: number, y: number, z: number, yaw: number) => m.compose(p3.set(x, y, z), q.setFromAxisAngle(up, yaw), one);

// ---------------------------------------------------------------- floor

function Floor({ geom }: { geom: FloorGeometry }) {
  const geo = useMemo(() => floorGeometry(geom), [geom]);
  if (!geo) return null;
  return (
    <mesh
      geometry={geo}
      material={[woodMaterial, flatMaterial]}
      receiveShadow
      onClick={(e) => {
        if (e.delta >= 6 || get().camera !== 'iso') return;
        e.stopPropagation();
        walkTo({ kind: 'point', at: { x: e.point.x, z: e.point.z }, floor: geom.index });
      }}
    />
  );
}

// ---------------------------------------------------------------- walls

function Walls({ geom }: { geom: FloorGeometry }) {
  const records = useMemo(() => wallRecords(geom), [geom]);
  const refs = useRef<Partial<Record<Variant | 'curb' | 'glass' | 'frame', InstancedMesh | null>>>({});
  const seen = useRef(-2);
  const curbCount = records.solid.length + records.window.length;

  const apply = (cutYaw: number | null) => {
    const m = new Matrix4();
    let curbs = 0;
    for (const v of VARIANTS) {
      const mesh = refs.current[v];
      if (!mesh) continue;
      records[v].forEach((r, i) => {
        const cut = cutYaw !== null && facesCamera(r, cutYaw);
        if (cut && (v === 'solid' || v === 'window')) refs.current.curb?.setMatrixAt(curbs++, wallMatrix(r, m));
        mesh.setMatrixAt(i, cut ? ZERO : wallMatrix(r, m));
        if (v === 'window') {
          refs.current.glass?.setMatrixAt(i, cut ? ZERO : wallMatrix(r, m));
          refs.current.frame?.setMatrixAt(i, cut ? ZERO : wallMatrix(r, m));
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    const curb = refs.current.curb;
    if (curb) {
      curb.count = curbs;
      curb.instanceMatrix.needsUpdate = true;
    }
    const glass = refs.current.glass;
    if (glass) glass.instanceMatrix.needsUpdate = true;
    if (refs.current.frame) refs.current.frame.instanceMatrix.needsUpdate = true;
  };

  useLayoutEffect(() => {
    for (const v of VARIANTS) {
      const mesh = refs.current[v];
      records[v].forEach((r, i) => {
        mesh?.setColorAt(i, color.set(WALL_STYLES[r.style]?.color ?? WALL_STYLES[0].color));
      });
      if (mesh?.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    // The curb takes the color of the wall it replaces, so it is colored when the cutaway fills it.
    seen.current = -2;
  }, [records]);

  // The cutaway is decided per camera octant, never per frame. First person shows every wall at full height.
  useFrame(() => {
    const iso = runtime.view.blend < 0.5;
    const key = iso ? octantOf(runtime.view.yaw) : -1;
    if (key === seen.current) return;
    seen.current = key;
    apply(iso ? key * (Math.PI / 4) : null);
    colorCurbs(key);
  });

  const colorCurbs = (key: number) => {
    const curb = refs.current.curb;
    if (!curb) return;
    let n = 0;
    const yaw = key * (Math.PI / 4);
    for (const v of ['solid', 'window'] as const) {
      for (const r of records[v]) {
        if (key >= 0 && facesCamera(r, yaw)) curb.setColorAt(n++, color.set(WALL_STYLES[r.style]?.color ?? WALL_STYLES[0].color));
      }
    }
    if (curb.instanceColor) curb.instanceColor.needsUpdate = true;
  };

  // Where each wall meets the floor, a soft shade on both sides of it. One draw for the whole story.
  const shaded = useMemo(() => [...records.solid, ...records.window], [records]);
  const fillAo = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      shaded.forEach((r, i) => mesh.setMatrixAt(i, wallMatrix(r, m).setPosition(r.x, 0.016, r.z)));
    },
    [shaded],
  );

  const ref = (key: Variant | 'curb' | 'glass' | 'frame') => (m: InstancedMesh | null) => void (refs.current[key] = m);
  return (
    <>
      {VARIANTS.map((v) =>
        records[v].length ? <instancedMesh key={`${v}${records[v].length}`} userData={{ wall: v }} ref={ref(v)} args={[wallModel(v), wallMaterial, records[v].length]} frustumCulled={false} castShadow receiveShadow /> : null,
      )}
      {records.window.length > 0 && <instancedMesh key={`glass${records.window.length}`} ref={ref('glass')} args={[glassModel(), glassMaterial, records.window.length]} frustumCulled={false} />}
      {records.window.length > 0 && <instancedMesh key={`frame${records.window.length}`} ref={ref('frame')} args={[frameModel(), frameMaterial, records.window.length]} frustumCulled={false} castShadow receiveShadow />}
      <Instances geometry={aoGeometry} material={aoMaterial} count={shaded.length} fill={fillAo} castShadow={false} receiveShadow={false} />
      {curbCount > 0 && <instancedMesh key={`curb${curbCount}`} userData={{ wall: 'curb' }} ref={ref('curb')} args={[curbModel(), wallMaterial, curbCount]} frustumCulled={false} receiveShadow />}
    </>
  );
}

// ---------------------------------------------------------------- items

const shade = (hex: string, amount: number) => color.set(hex).multiplyScalar(amount);

function Furniture({ geom }: { geom: FloorGeometry }) {
  const blocks = useStore((s) => s.company?.blocks);
  const hue = useMemo(() => new Map((blocks ?? []).map((b) => [b.id as string, b.color])), [blocks]);
  const defs = useMemo(() => [...geom.render.items].filter(([def]) => !DYNAMIC.has(def)), [geom]);
  const desks = useMemo(() => geom.story.items.filter((i) => ITEM_DEFS[i.def]?.seat), [geom]);

  const pick = (ids: readonly ItemId[]) => (e: ThreeEvent<MouseEvent>) => {
    if (e.delta >= 6 || e.instanceId === undefined) return;
    set({ pickedItem: ids[e.instanceId] ?? null });
    if (get().camera !== 'iso') return;
    e.stopPropagation();
    walkTo({ kind: 'point', at: { x: e.point.x, z: e.point.z }, floor: geom.index });
  };

  return (
    <>
      {defs.map(([def, data]) => (
        <ModelInstances key={def} def={def} matrices={data.matrices} ids={data.ids} onClick={pick(data.ids)} />
      ))}
      <Instances
        geometry={chairModel()}
        material={furnitureMaterial}
        count={desks.length}
        onClick={pick(desks.map((d) => d.id))}
        fill={useMemo(
          () => (mesh: InstancedMesh) => {
            const m = new Matrix4();
            desks.forEach((d, i) => {
              const c = chairOf(d)!;
              mesh.setMatrixAt(i, place(m, c.x, 0, c.z, YAW[d.rot] + (ITEM_DEFS[d.def].seat?.yaw ?? 0)));
              const base = d.blockId ? hue.get(d.blockId) : undefined;
              mesh.setColorAt(i, base ? shade(base, 0.75) : color.set('#2f3a5f'));
            });
          },
          [desks, hue],
        )}
      />
      <ContactShadows geom={geom} />
      <Screens geom={geom} />
    </>
  );
}

function ModelInstances({ def, matrices, ids, onClick }: { def: string; matrices: Float32Array; ids: readonly ItemId[]; onClick: (e: ThreeEvent<MouseEvent>) => void }) {
  const fill = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      for (let i = 0; i < ids.length; i++) {
        mesh.setMatrixAt(i, place(m, matrices[i * 5], matrices[i * 5 + 1], matrices[i * 5 + 2], matrices[i * 5 + 3]));
        const tint = matrices[i * 5 + 4];
        mesh.setColorAt(i, tint >= 0 ? color.setHex(tint) : color.setHex(DEFAULT_TINT[def] ?? 0xffffff));
      }
    },
    [def, matrices, ids],
  );
  return <Instances geometry={modelOf(def)} material={furnitureMaterial} count={ids.length} fill={fill} onClick={onClick} />;
}

// A soft dark patch under each piece of furniture, one draw for the whole story. It grounds the objects the way ambient occlusion would.
function ContactShadows({ geom }: { geom: FloorGeometry }) {
  const spots = useMemo(() => {
    const out: { x: number; z: number; yaw: number; w: number; d: number }[] = [];
    for (const [def, data] of geom.render.items) {
      const dims = ITEM_DEFS[def];
      if (!dims || NO_BLOB.has(def)) continue;
      for (let i = 0; i < data.ids.length; i++) {
        out.push({ x: data.matrices[i * 5], z: data.matrices[i * 5 + 2], yaw: data.matrices[i * 5 + 3], w: dims.w / 2 + 0.55, d: dims.d / 2 + 0.55 });
      }
    }
    for (const d of geom.story.items) {
      if (!ITEM_DEFS[d.def]?.seat) continue;
      const c = chairOf(d);
      if (c) out.push({ x: c.x, z: c.z, yaw: 0, w: 1.0, d: 1.0 });
    }
    return out;
  }, [geom]);
  const fill = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      spots.forEach((sp, i) => {
        q.setFromAxisAngle(up, sp.yaw);
        mesh.setMatrixAt(i, m.compose(p3.set(sp.x, 0.012, sp.z), q, s3.set(sp.w, 1, sp.d)));
      });
    },
    [spots],
  );
  return <Instances geometry={blobGeometry} material={blobMaterial} count={spots.length} fill={fill} castShadow={false} receiveShadow={false} />;
}

// A desk's screen shows what its sitter is doing. One mesh draws them all, and each frame sets each one's brightness.
function Screens({ geom }: { geom: FloorGeometry }) {
  const mesh = useRef<InstancedMesh>(null);
  const desks = useMemo(() => geom.story.items.filter((i) => i.def === 'bench_desk' || i.def === 'po_desk'), [geom]);
  const sitters = useRef<{ company: unknown; bySeat: Map<string, Employee> }>({ company: null, bySeat: new Map() });
  const geo = useMemo(() => screenGeometry(), []);
  const fill = useMemo(
    () => (m: InstancedMesh) => {
      const mat = new Matrix4();
      desks.forEach((d, i) => {
        const def = ITEM_DEFS[d.def];
        const f = d.rot % 2 === 0 ? { w: def.w, d: def.d } : { w: def.d, d: def.w };
        m.setMatrixAt(i, place(mat, (d.x + f.w / 2) / 2, 0, (d.z + f.d / 2) / 2, YAW[d.rot]));
        m.setColorAt(i, color.setRGB(0.05, 0.05, 0.06));
      });
    },
    [desks],
  );

  useFrame((state, dt) => {
    const m = mesh.current;
    if (!m) return;
    const { company } = get();
    if (sitters.current.company !== company) {
      sitters.current = { company, bySeat: new Map((company?.employees ?? []).flatMap((e) => (e.seat ? [[e.seat as string, e] as const] : []))) };
    }
    const t = state.clock.elapsedTime;
    codeTexture().offset.y -= dt * 0.1;
    desks.forEach((d, i) => {
      const e = sitters.current.bySeat.get(d.id);
      const kind = e?.status.kind ?? 'none';
      if (kind === 'working') {
        color.set(PROVIDERS[e!.provider].color).lerp(new Color('#ffffff'), 0.3).multiplyScalar(0.9 + Math.sin(t * 3 + i) * 0.15);
      } else if (kind === 'blocked_on_owner') {
        color.set('#ffb340').multiplyScalar(0.55 + (Math.sin(t * 6) + 1) * 0.3);
      } else if (kind === 'error') {
        color.set('#ff4d4d');
      } else if (kind === 'idle') {
        color.set('#6a7898').multiplyScalar(0.3);
      } else {
        color.setRGB(0.04, 0.04, 0.05);
      }
      m.setColorAt(i, color);
    });
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return <Instances geometry={geo} material={screenMaterial} count={desks.length} fill={fill} castShadow={false} receiveShadow={false} />;
}

function Rails({ geom }: { geom: FloorGeometry }) {
  const rails = geom.render.rails;
  const fill = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      for (let i = 0; i < rails.length / 5; i++) {
        place(m, rails[i * 5], 0, rails[i * 5 + 1], rails[i * 5 + 2]);
        mesh.setMatrixAt(i, m);
      }
    },
    [rails],
  );
  return <Instances geometry={modelOf('rail')} material={railMaterial} count={rails.length / 5} fill={fill} />;
}

// ---------------------------------------------------------------- ceiling and slab

// A story's ceiling, drawn only in first person. In the overview it would hide the rooms from above.
function Ceiling({ geom }: { geom: FloorGeometry }) {
  const group = useRef<Group>(null);
  const geo = useMemo(() => {
    const floor = floorGeometry(geom);
    if (!floor) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', floor.getAttribute('position'));
    g.setAttribute('normal', floor.getAttribute('normal'));
    g.setAttribute('uv', floor.getAttribute('uv'));
    g.setIndex(floor.getIndex());
    g.computeBoundingSphere();
    return g;
  }, [geom]);
  const lamps = useMemo(() => {
    const out: [number, number][] = [];
    const { lot, story } = geom;
    for (let tz = lot.z0; tz < lot.z0 + lot.h; tz++) {
      for (let tx = lot.x0; tx < lot.x0 + lot.w; tx++) {
        if (((tx % 4) + 4) % 4 !== 1 || ((tz % 4) + 4) % 4 !== 1) continue;
        const i = tileIndex(lot, tx, tz);
        if (hasFloorAt(story, i) && !geom.hole[i]) out.push([tx + 0.5, tz + 0.5]);
      }
    }
    return out;
  }, [geom]);
  const fill = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      lamps.forEach(([x, z], i) => mesh.setMatrixAt(i, place(m, x, CEILING_Y - 0.03, z, 0)));
    },
    [lamps],
  );
  const fillPools = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      lamps.forEach(([x, z], i) => mesh.setMatrixAt(i, place(m, x, 0.03, z, 0)));
    },
    [lamps],
  );
  useFrame(() => {
    const g = group.current;
    if (g) g.visible = runtime.view.blend > 0.5;
  });
  if (!geo) return null;
  return (
    <group ref={group} visible={false}>
      <mesh geometry={geo} material={ceilingMaterial} position-y={CEILING_Y} />
      <Instances geometry={fixtureGeometry} material={fixtureMaterial} count={lamps.length} fill={fill} castShadow={false} receiveShadow={false} />
      <Instances geometry={poolGeometry} material={poolMaterial} count={lamps.length} fill={fillPools} castShadow={false} receiveShadow={false} />
    </group>
  );
}

// Upper stories rest on a slab. Its edge is what the overview sees, so it is a thick plaster band under the floor.
function Slab({ geom }: { geom: FloorGeometry }) {
  const box = useMemo(() => {
    const p = geom.render.floor.position;
    if (!p.length) return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
      z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]);
    }
    return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0 + 0.2, d: z1 - z0 + 0.2 };
  }, [geom]);
  if (!box) return null;
  return (
    <mesh position={[box.x, -0.15, box.z]} material={slabMaterial} receiveShadow castShadow>
      <boxGeometry args={[box.w, 0.28, box.d]} />
    </mesh>
  );
}

// ---------------------------------------------------------------- story

/** One story of the building. Stories above the one the owner is on are not drawn. */
export const StoryView = memo(function StoryView({ geom }: { geom: FloorGeometry }) {
  const visible = useStore((s) => geom.index <= s.story);
  if (!visible) return null;
  const { lot } = geom;
  return (
    <group position-y={geom.index * STORY_H}>
      {geom.index === 0 && (
        <mesh position={[lot.x0 + lot.w / 2, -0.32, lot.z0 + lot.h / 2]} receiveShadow>
          <boxGeometry args={[lot.w + 0.6, 0.6, lot.h + 0.6]} />
          <meshStandardMaterial color="#6d4c37" roughness={1} />
        </mesh>
      )}
      {geom.index > 0 && <Slab geom={geom} />}
      <Floor geom={geom} />
      <Ceiling geom={geom} />
      <Walls geom={geom} />
      <Furniture geom={geom} />
      <Rails geom={geom} />
    </group>
  );
});
