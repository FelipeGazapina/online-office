import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, BackSide, BoxGeometry, BufferGeometry, Color, DoubleSide, Group, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector2, Vector3 } from 'three';
import { ITEM_DEFS, STORY_H, TOP_UNIT, WALL_STYLES, YAW, floorItems, layerOf, placementOf, setupsOf, type FloorGeometry, type ItemId } from '../../../../shared/space/index.ts';
import { hasFloorAt, tileIndex } from '../../../../shared/space/geom.ts';
import { runtime } from '../../runtime.ts';
import { buildView, draft } from '../../hud/build/state.ts';
import { get, set, useStore } from '../../store.ts';
import { walkTo } from '../../sim.ts';
import { chairOf } from '../../world.ts';
import { blobShadowTexture, ceilingTexture, poolTexture, wallAoTexture } from '../textures.ts';
import { carpetSurface, concreteSurface, PLASTER_MEAN, PLASTER_METRES, plasterSurface, tileSurface, woodSurface, type Surface } from '../surfaceTextures.ts';
import { detail, showAo } from '../shading.ts';
import { reflective } from '../Lighting.tsx';
import { floorGeometry } from './floor.ts';
import { inVoid, lobbyVoid } from '../lobbyVoid.ts';
import { propOf } from '../props.ts';
import { box, computerOf, cyl, merge, DEFAULT_TINT, DYNAMIC, modelOf, onTopOf, PROP_DEFS } from './models.ts';
import { shadowMaterial, shadowMesh, shapeOf, throwOf, type Spot } from './shadows.ts';
import { Dressing, wornOn } from './Dressing.tsx';
import { Screens } from './MonitorScreens.tsx';
import { trimOf, TRIMMED } from './pod.ts';
import { crossesView, curbModel, facesCamera, frameModel, glassModel, occludes, octantOf, VARIANTS, wallMatrix, wallModel, wallRecords, ZERO, type Variant, type WallRecord } from './walls.ts';

const up = new Vector3(0, 1, 0);
const q = new Quaternion();
const p3 = new Vector3();
const one = new Vector3(1, 1, 1);
const s3 = new Vector3();
const color = new Color();

// `gain` lifts a texture whose real photographed albedo is darker than the stylised light the scene is lit for.
const floorMaterial = (surface: Surface, roughness: number, normalScale: number, gain: number, extra: Partial<ConstructorParameters<typeof MeshStandardMaterial>[0]> = {}) =>
  showAo(detail(new MeshStandardMaterial({ map: surface.map, normalMap: surface.normalMap, roughnessMap: surface.armMap, aoMap: surface.armMap, normalScale: new Vector2(normalScale, normalScale), vertexColors: true, color: new Color(gain, gain, gain), roughness, ...extra }), 'floor'), 0.8);
// In the order of FLOOR_FAMILIES.
const floorMaterials = [
  floorMaterial(woodSurface(), 0.6, 0.9, 1.45),
  floorMaterial(carpetSurface(), 1, 0.7, 1.1),
  floorMaterial(tileSurface(), 0.4, 0.8, 1.9),
  floorMaterial(concreteSurface(), 1, 0.8, 1.8),
];
reflective.set(floorMaterials[0], 0.3);
reflective.set(floorMaterials[2], 1.2);
const chairMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
const furnitureMaterial = detail(new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }), 'furniture');
// The low boundary around a team's rug: tinted slate, a little see-through so the desks read across it.
const boundaryMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, transparent: true, opacity: 0.82 });
const BOUNDARY: ReadonlySet<string> = new Set(['pod_rail_back', 'pod_rail_side']);
const plaster = plasterSurface();
const wallMaterial = detail(new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), 'wall', { ...plaster, mean: PLASTER_MEAN, metresPerRepeat: PLASTER_METRES });
// Clear glass: the sky, the lawn and the trees show through it, with a faint cool tint and a sheen of the room on it.
const glassMaterial = new MeshStandardMaterial({ color: '#dcefff', emissive: '#a8d4ff', emissiveIntensity: 0.06, roughness: 0.06, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide });
reflective.set(glassMaterial, 0.35);
const frameMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 });
const railMaterial = new MeshStandardMaterial({ color: '#c9cdd8', roughness: 0.5, metalness: 0.3 });
const ceilingMap = ceilingTexture();
ceilingMap.repeat.set(6.5, 6.5);
const ceilingMaterial = new MeshStandardMaterial({ map: ceilingMap, roughness: 0.95, side: BackSide, color: '#f0e6d6', emissive: '#fff0d8', emissiveIntensity: 0.2 });
const slabMaterial = new MeshStandardMaterial({ color: '#cdbfa9', roughness: 0.95 });
const fixtureMaterial = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
// The pendant's glowing disc, set in the underside of the baked lamp's shade. The shade itself is the `lamp` prop.
const fixtureGeometry = merge([cyl(0.14, 0.14, 0.03, 0, -0.5, 0, '#ffd08a', 14)]);
const LAMP_DROP = 0.04;

const poolMaterial = new MeshBasicMaterial({ map: poolTexture(), color: '#ffb865', transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.14, fog: false, polygonOffset: true, polygonOffsetFactor: -3 });
const poolGeometry = new PlaneGeometry(4.6, 4.6).rotateX(-Math.PI / 2);
const blobMaterial = new MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, opacity: 0.95, polygonOffset: true, polygonOffsetFactor: -4 });
const blobGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const aoMaterial = new MeshBasicMaterial({ map: wallAoTexture(), transparent: true, depthWrite: false, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -1 });
const aoGeometry = new PlaneGeometry(1, 1.1).rotateX(-Math.PI / 2);
// A lit candle and a desk lamp warm the top they stand on: a soft pool of light round each, in meters across and how strong.
const WARM: Readonly<Record<string, readonly [number, number]>> = { candle: [0.34, 0.5], lamp_desk: [0.7, 0.75] };
const warmMaterial = new MeshBasicMaterial({ map: poolTexture(), color: '#ffb865', transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -5, fog: false });
// No blob under these: the stairs make their own shade and the daily sign hangs in the air. Floor items are skipped by their layer.
const NO_BLOB: ReadonlySet<string> = new Set(['rail', 'stairs', 'pod_daily_sign']);
const CEILING_Y = STORY_H - 0.3;
// Walnut beams on the pendants' 4 m grid divide the ceiling into coffers, each lamp in the middle of one.
const beamGeometry = new BoxGeometry(1.04, 0.16, 0.12).translate(0, -0.08, 0);
const beamMaterial = new MeshStandardMaterial({ color: '#c19a70', roughness: 0.6, emissive: '#6b4a2c', emissiveIntensity: 0.25 });

function Instances({
  geometry,
  material,
  count,
  fill,
  onClick,
  castShadow = true,
  receiveShadow = true,
  probe,
}: {
  geometry: BufferGeometry;
  material: MeshStandardMaterial | MeshBasicMaterial;
  count: number;
  fill: (mesh: InstancedMesh) => void;
  onClick?: (e: ThreeEvent<MouseEvent>) => void;
  castShadow?: boolean;
  receiveShadow?: boolean;
  probe?: Record<string, unknown> & { at?: number[][] };
}) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    fill(m);
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    // For the tests: where this mesh really draws each of its instances, read back from the matrices it was given.
    if (probe) probe.at = Array.from({ length: count }, (_, i) => placeOf(m, i));
  }, [fill, probe, count]);
  if (count === 0) return null;
  return <instancedMesh ref={ref} args={[geometry, material, count]} frustumCulled={false} castShadow={castShadow} receiveShadow={receiveShadow} onClick={onClick} userData={probe} />;
}

const readBack = new Matrix4();
const placeOf = (mesh: InstancedMesh, i: number): number[] => {
  mesh.updateWorldMatrix(true, false);
  mesh.getMatrixAt(i, readBack);
  readBack.premultiply(mesh.matrixWorld);
  const e = readBack.elements;
  return [e[12], e[13], e[14], Math.atan2(e[8], e[0])].map((n) => Math.round(n * 1000) / 1000);
};
const place = (m: Matrix4, x: number, y: number, z: number, yaw: number) => m.compose(p3.set(x, y, z), q.setFromAxisAngle(up, yaw), one);

// ---------------------------------------------------------------- floor

function Floor({ geom }: { geom: FloorGeometry }) {
  const geo = useMemo(() => floorGeometry(geom), [geom]);
  if (!geo) return null;
  return (
    <mesh
      geometry={geo}
      material={floorMaterials}
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

const ALL_DOWN = -3;

function Walls({ geom }: { geom: FloorGeometry }) {
  const records = useMemo(() => wallRecords(geom), [geom]);
  const refs = useRef<Partial<Record<Variant | 'curb' | 'glass' | 'frame', InstancedMesh | null>>>({});
  const seen = useRef('');
  const curbCount = records.solid.length + records.window.length;

  const apply = (isCut: (r: WallRecord) => boolean) => {
    const m = new Matrix4();
    let curbs = 0;
    for (const v of VARIANTS) {
      const mesh = refs.current[v];
      if (!mesh) continue;
      records[v].forEach((r, i) => {
        const cut = isCut(r);
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
    seen.current = '';
  }, [records]);

  // The cutaway is decided per camera octant, never per frame. First person shows every wall at full height. While
  // building, the owner picks walls up (everything standing), down (everything a curb) or the cutaway.
  useFrame(() => {
    const iso = runtime.view.blend < 0.5;
    const mode = get().build?.wallsMode ?? 'cutaway';
    const key = !iso || mode === 'up' ? -1 : mode === 'down' ? ALL_DOWN : octantOf(runtime.view.yaw);
    // While furniture is being placed on this floor, the walls between the camera and it step out of the way too.
    const f = iso && mode !== 'down' && draft.focus?.level === geom.index ? draft.focus : null;
    const yaw = runtime.view.yaw;
    // Interior walls step down by where the owner stands, so the stamp carries the owner's tile too.
    const at = get().build ? buildView : runtime.owner.pos;
    const fx = Math.round(at.x), fz = Math.round(at.z);
    const stamp = `${key}|${key >= 0 ? `${fx},${fz}` : ''}|${f ? `${Math.round(f.x * 2)},${Math.round(f.z * 2)},${octantOf(yaw)}` : ''}`;
    if (stamp === seen.current) return;
    seen.current = stamp;
    const cutYaw = key * (Math.PI / 4);
    const isCut = (r: WallRecord) => key === ALL_DOWN || (key >= 0 && (facesCamera(r, cutYaw) || crossesView(r, cutYaw, { x: fx, z: fz }))) || (!!f && occludes(r, yaw, f));
    apply(isCut);
    colorCurbs(isCut);
  });

  const colorCurbs = (isCut: (r: WallRecord) => boolean) => {
    const curb = refs.current.curb;
    if (!curb) return;
    let n = 0;
    for (const v of ['solid', 'window'] as const) {
      for (const r of records[v]) {
        if (isCut(r)) curb.setColorAt(n++, color.set(WALL_STYLES[r.style]?.color ?? WALL_STYLES[0].color));
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
  // A trimmed piece of a team wears the team's trim color, so it follows the block's color and not the item.
  const teamOf = useMemo(() => new Map(geom.story.items.flatMap((i) => (i.blockId ? [[i.id, i.blockId] as const] : []))), [geom]);
  const trim = useMemo(() => new Map([...hue].map(([id, c]) => [id, trimOf(c)])), [hue]);
  const trimTint = useMemo(() => (id: ItemId) => trim.get(teamOf.get(id) ?? '') ?? null, [trim, teamOf]);
  const defs = useMemo(() => [...geom.render.items].filter(([def]) => !DYNAMIC.has(def)), [geom]);
  const desks = useMemo(() => floorItems(geom.story).filter((i) => ITEM_DEFS[i.def]?.seat), [geom]);
  const setups = useMemo(() => setupsOf(geom.story), [geom]);

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
        <ModelInstances key={def} def={def} matrices={data.matrices} ids={data.ids} pick={pick} setups={setups} tintOf={TRIMMED.has(def) ? trimTint : undefined} />
      ))}
      <Instances
        geometry={propOf('chair').geometry}
        material={chairMaterial}
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
      <Dressing geom={geom} material={furnitureMaterial} />
      <ContactShadows geom={geom} />
      <WarmPools geom={geom} />
      <Screens geom={geom} />
    </>
  );
}

// A def drawn in a look other than its first is keyed `def#look` in the render list: one draw call per look, however many there are.
function ModelInstances({ def: key, matrices, ids, pick, tintOf, setups }: { def: string; matrices: Float32Array; ids: readonly ItemId[]; pick: (ids: readonly ItemId[]) => (e: ThreeEvent<MouseEvent>) => void; tintOf?: (id: ItemId) => Color | null; setups: ReadonlyMap<ItemId, number> }) {
  const [def, lookText] = key.split('#');
  const look = Number(lookText ?? 0);
  const onClick = useMemo(() => pick(ids), [pick, ids]);
  const fill = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      for (let i = 0; i < ids.length; i++) {
        mesh.setMatrixAt(i, place(m, matrices[i * 5], matrices[i * 5 + 1], matrices[i * 5 + 2], matrices[i * 5 + 3]));
        const tint = matrices[i * 5 + 4];
        mesh.setColorAt(i, tint >= 0 ? color.setHex(tint) : (tintOf?.(ids[i]) ?? color.setHex(DEFAULT_TINT[def] ?? 0xffffff)));
      }
    },
    [def, matrices, ids, tintOf],
  );
  const probe = useMemo(() => ({ probe: 'model', def, look, count: ids.length, at: [] as number[][] }), [def, look, ids, matrices]);
  const baked = PROP_DEFS[def];
  // Small things that can stand on a top are too small to throw a shadow worth its passes; their contact patch grounds them.
  const cast = placementOf(ITEM_DEFS[def]) === 'floor';
  if (BOUNDARY.has(def)) return <Instances geometry={modelOf(def)} material={boundaryMaterial} count={ids.length} fill={fill} onClick={onClick} castShadow={false} />;
  if (!baked) return <Instances geometry={modelOf(def, look)} material={furnitureMaterial} count={ids.length} fill={fill} onClick={onClick} castShadow={cast} probe={probe} />;
  const { geometry, material } = propOf(baked.prop);
  return (
    <>
      <Instances geometry={geometry} material={material} count={ids.length} fill={fill} onClick={onClick} castShadow={cast} />
      {baked.onTop && <OnTop def={def} matrices={matrices} ids={ids} setups={setups} pick={pick} />}
    </>
  );
}

// What stands on a baked prop and differs from one prop to the next: a desk's computer, in the setup its desk wears. One draw call per setup in use.
function OnTop({ def, matrices, ids, setups, pick }: { def: string; matrices: Float32Array; ids: readonly ItemId[]; setups: ReadonlyMap<ItemId, number>; pick: (ids: readonly ItemId[]) => (e: ThreeEvent<MouseEvent>) => void }) {
  const groups = useMemo(() => {
    const by = new Map<number, number[]>();
    ids.forEach((id, i) => {
      const setup = ITEM_DEFS[def].setups ? (setups.get(id) ?? 0) : 0;
      (by.get(setup) ?? by.set(setup, []).get(setup)!).push(i);
    });
    return [...by].sort(([a], [b]) => a - b);
  }, [def, ids, setups]);
  return (
    <>
      {groups.map(([setup, at]) => (
        <SetupInstances key={setup} def={def} setup={setup} at={at} matrices={matrices} ids={ids} pick={pick} />
      ))}
    </>
  );
}

function SetupInstances({ def, setup, at, matrices, ids, pick }: { def: string; setup: number; at: readonly number[]; matrices: Float32Array; ids: readonly ItemId[]; pick: (ids: readonly ItemId[]) => (e: ThreeEvent<MouseEvent>) => void }) {
  const mine = useMemo(() => at.map((i) => ids[i]), [at, ids]);
  const fill = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      at.forEach((i, n) => {
        mesh.setMatrixAt(n, place(m, matrices[i * 5], matrices[i * 5 + 1], matrices[i * 5 + 2], matrices[i * 5 + 3]));
        mesh.setColorAt(n, color.setHex(0xffffff));
      });
    },
    [at, matrices],
  );
  const onClick = useMemo(() => pick(mine), [pick, mine]);
  return <Instances geometry={onTopOf(def, setup)!} material={furnitureMaterial} count={at.length} fill={fill} onClick={onClick} />;
}

// A soft dark patch under each piece of furniture, one draw for the whole story. It grounds the objects the way ambient occlusion would.
// What stands on a desk or a table gets one that has its own shape (`shadows.ts`), cast a little away from the sun by its height.
function ContactShadows({ geom }: { geom: FloorGeometry }) {
  const { spots, shaped } = useMemo(() => {
    const out: { x: number; y: number; z: number; yaw: number; w: number; d: number }[] = [];
    const cast: Spot[] = [];
    const setups = setupsOf(geom.story);
    for (const [key, data] of geom.render.items) {
      const def = key.split('#')[0];
      const dims = ITEM_DEFS[def];
      if (!dims || NO_BLOB.has(def) || layerOf(dims) === 'floor') continue;
      for (let i = 0; i < data.ids.length; i++) {
        const [x, y, z, yaw] = [data.matrices[i * 5], data.matrices[i * 5 + 1], data.matrices[i * 5 + 2], data.matrices[i * 5 + 3]];
        const shape = y > 0 && dims.top ? shapeOf(def, () => ({ geometry: modelOf(def), height: dims.height })) : null;
        if (shape) {
          const to = throwOf(dims.height);
          cast.push({ x: x + to.x, y: y + 0.006, z: z + to.z, yaw, shape });
          continue;
        }
        // Where a desk's computer stands on it, it throws its own: the keys, the mouse and the foot of the screen.
        if (dims.setups && dims.surface) {
          const setup = setups.get(data.ids[i]) ?? 0;
          const computer = shapeOf(`computer:${def}:${setup}`, () => ({ geometry: computerOf(def === 'po_desk', setup), height: 0.12 }));
          if (computer) cast.push({ x, y: dims.surface.height + 0.004, z, yaw, shape: computer });
        }
        out.push({ x, y: y + 0.02, z, yaw, w: dims.w / 2 + 0.3, d: dims.d / 2 + 0.3 });
      }
    }
    for (const d of floorItems(geom.story)) {
      if (!ITEM_DEFS[d.def]?.seat) continue;
      const c = chairOf(d);
      if (c) out.push({ x: c.x, y: 0.02, z: c.z, yaw: 0, w: 0.7, d: 0.7 });
    }
    // What the desks wear throws the same shaped shadows as what the owner puts there.
    for (const { item, def, pose } of wornOn(geom)) {
      const shape = shapeOf(item.def, () => ({ geometry: modelOf(item.def), height: def.height }));
      if (!shape) continue;
      const to = throwOf(def.height);
      cast.push({ x: pose.x + to.x, y: pose.y + 0.006, z: pose.z + to.z, yaw: pose.yaw, shape });
    }
    return { spots: out, shaped: cast };
  }, [geom]);
  const fill = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      spots.forEach((sp, i) => {
        q.setFromAxisAngle(up, sp.yaw);
        mesh.setMatrixAt(i, m.compose(p3.set(sp.x, sp.y, sp.z), q, s3.set(sp.w, 1, sp.d)));
      });
    },
    [spots],
  );
  const cut = useMemo(() => shadowMesh(shaped.length), [shaped]);
  const cutMaterial = useMemo(() => shadowMaterial(), []);
  useEffect(() => () => cut.dispose(), [cut]);
  useEffect(() => () => cutMaterial.dispose(), [cutMaterial]);
  const fillShaped = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      const rect = mesh.geometry.getAttribute('uvRect');
      shaped.forEach((sp, i) => {
        q.setFromAxisAngle(up, sp.yaw);
        mesh.setMatrixAt(i, m.compose(p3.set(sp.x, sp.y, sp.z), q, s3.set(sp.shape.half * 2, 1, sp.shape.half * 2)));
        rect.setXYZW(i, ...sp.shape.rect);
      });
      rect.needsUpdate = true;
    },
    [shaped],
  );
  return (
    <>
      <Instances geometry={blobGeometry} material={blobMaterial} count={spots.length} fill={fill} castShadow={false} receiveShadow={false} />
      <Instances geometry={cut} material={cutMaterial} count={shaped.length} fill={fillShaped} castShadow={false} receiveShadow={false} />
    </>
  );
}

// The warm pools under lit candles and lamps standing on a top, one draw for the story.
function WarmPools({ geom }: { geom: FloorGeometry }) {
  const pools = useMemo(() => {
    const out: { x: number; y: number; z: number; size: number; power: number }[] = [];
    for (const [key, data] of geom.render.items) {
      const warm = WARM[key.split('#')[0]];
      if (!warm) continue;
      for (let i = 0; i < data.ids.length; i++) {
        const y = data.matrices[i * 5 + 1];
        if (y > 0) out.push({ x: data.matrices[i * 5], y: y + 0.004, z: data.matrices[i * 5 + 2], size: warm[0], power: warm[1] });
      }
    }
    for (const { item, pose } of wornOn(geom)) {
      const warm = WARM[item.def];
      if (warm) out.push({ x: pose.x, y: pose.y + 0.004, z: pose.z, size: warm[0], power: warm[1] });
    }
    return out;
  }, [geom]);
  const fill = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      pools.forEach((p, i) => {
        mesh.setMatrixAt(i, m.compose(p3.set(p.x, p.y, p.z), q.identity(), s3.set(p.size, 1, p.size)));
        mesh.setColorAt(i, color.setScalar(p.power));
      });
    },
    [pools],
  );
  return <Instances geometry={blobGeometry} material={warmMaterial} count={pools.length} fill={fill} castShadow={false} receiveShadow={false} />;
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
  const building = useStore((s) => s.building);
  // The lobby's double-height void has its own, higher ceiling: this story's ceiling, beams and lamps skip it.
  const lift = useMemo(() => (geom.index === 0 ? lobbyVoid(building) : null), [geom.index, building]);
  const geo = useMemo(() => {
    const floor = floorGeometry(geom);
    if (!floor) return null;
    const g = new BufferGeometry();
    const position = floor.getAttribute('position');
    g.setAttribute('position', position);
    g.setAttribute('normal', floor.getAttribute('normal'));
    g.setAttribute('uv', floor.getAttribute('uv'));
    const index = floor.getIndex();
    if (index && lift) {
      const kept: number[] = [];
      for (let t = 0; t < index.count; t += 3) {
        const a = index.getX(t);
        const b = index.getX(t + 1);
        const c = index.getX(t + 2);
        const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
        const z = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
        if (!inVoid(lift, x, z)) kept.push(a, b, c);
      }
      g.setIndex(kept);
    } else g.setIndex(index);
    g.computeBoundingSphere();
    return g;
  }, [geom, lift]);
  const lamps = useMemo(() => {
    const out: [number, number][] = [];
    const { lot, story } = geom;
    for (let tz = lot.z0; tz < lot.z0 + lot.h; tz++) {
      for (let tx = lot.x0; tx < lot.x0 + lot.w; tx++) {
        if (((tx % 4) + 4) % 4 !== 1 || ((tz % 4) + 4) % 4 !== 1) continue;
        const i = tileIndex(lot, tx, tz);
        if (hasFloorAt(story, i) && !geom.hole[i] && !inVoid(lift, tx + 0.5, tz + 0.5)) out.push([tx + 0.5, tz + 0.5]);
      }
    }
    return out;
  }, [geom, lift]);
  const fill = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      lamps.forEach(([x, z], i) => mesh.setMatrixAt(i, place(m, x, CEILING_Y + LAMP_DROP, z, 0)));
    },
    [lamps],
  );
  const beams = useMemo(() => {
    const out: [number, number, number][] = [];
    const { lot, story } = geom;
    const floored = (tx: number, tz: number) => {
      if (tx < lot.x0 || tz < lot.z0 || tx >= lot.x0 + lot.w || tz >= lot.z0 + lot.h) return false;
      const i = tileIndex(lot, tx, tz);
      return hasFloorAt(story, i) && !geom.hole[i] && !inVoid(lift, tx + 0.5, tz + 0.5);
    };
    const mod4 = (v: number) => ((v % 4) + 4) % 4;
    for (let tz = lot.z0; tz < lot.z0 + lot.h; tz++) {
      for (let tx = lot.x0; tx < lot.x0 + lot.w; tx++) {
        if (!floored(tx, tz)) continue;
        if (mod4(tz) === 3) out.push([tx + 0.5, tz + 0.5, 0]);
        if (mod4(tx) === 3) out.push([tx + 0.5, tz + 0.5, Math.PI / 2]);
      }
    }
    return out;
  }, [geom, lift]);
  const fillBeams = useMemo(
    () => (mesh: InstancedMesh) => {
      const m = new Matrix4();
      beams.forEach(([x, z, yaw], i) => mesh.setMatrixAt(i, place(m, x, CEILING_Y, z, yaw)));
    },
    [beams],
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
      <Instances geometry={beamGeometry} material={beamMaterial} count={beams.length} fill={fillBeams} castShadow={false} receiveShadow={false} />
      <Instances geometry={fixtureGeometry} material={fixtureMaterial} count={lamps.length} fill={fill} castShadow={false} receiveShadow={false} />
      <Instances geometry={propOf('lamp').geometry} material={propOf('lamp').material} count={lamps.length} fill={fill} castShadow={false} receiveShadow={false} />
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
