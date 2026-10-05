import { useFrame } from '@react-three/fiber';
import { useRef, useState } from 'react';
import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Sphere,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { crowd, type CrowdEntry, type Joints, type Look } from './crowd.ts';

type Tint = 'body' | 'skin' | 'hair' | 'trim' | `#${string}`;
type Slot = { joint: keyof Joints; offset: Matrix4; tint: Tint };
type Kind = { geometry: BufferGeometry; roughness: number; shadow: boolean; slots: Slot[] };

const at = (x: number, y: number, z: number, rx = 0) =>
  new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(rx, 0, 0)), new Vector3(1, 1, 1));

// One InstancedMesh per body part, so the whole crowd costs one draw call per part instead of one per mesh.
// Each slot is one instance per person: where the part sits on its joint, and which look colour tints it.
const KINDS: Kind[] = [
  { geometry: new CapsuleGeometry(0.28, 0.5, 6, 14), roughness: 0.75, shadow: true, slots: [{ joint: 'body', offset: at(0, 0.78, 0), tint: 'body' }] },
  { geometry: new BoxGeometry(0.1, 0.34, 0.05), roughness: 0.6, shadow: false, slots: [{ joint: 'body', offset: at(0, 1.02, 0.26), tint: 'trim' }] },
  { geometry: new SphereGeometry(0.22, 20, 16), roughness: 0.8, shadow: true, slots: [{ joint: 'head', offset: at(0, 0, 0), tint: 'skin' }] },
  {
    geometry: new SphereGeometry(0.235, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.52),
    roughness: 0.9,
    shadow: false,
    slots: [{ joint: 'head', offset: at(0, 0.03, -0.02, -0.25), tint: 'hair' }],
  },
  {
    geometry: new SphereGeometry(0.028, 8, 8),
    roughness: 0.4,
    shadow: false,
    slots: [-0.085, 0.085].map((x) => ({ joint: 'head' as const, offset: at(x, 0, 0.2), tint: '#1d1d26' as const })),
  },
  {
    geometry: new CapsuleGeometry(0.07, 0.24, 4, 8),
    roughness: 0.75,
    shadow: true,
    slots: (['armL', 'armR'] as const).map((joint) => ({ joint, offset: at(0, -0.2, 0), tint: 'body' as const })),
  },
  {
    geometry: new SphereGeometry(0.075, 8, 8),
    roughness: 0.8,
    shadow: false,
    slots: (['armL', 'armR'] as const).map((joint) => ({ joint, offset: at(0, -0.42, 0), tint: 'skin' as const })),
  },
  {
    geometry: new CapsuleGeometry(0.075, 0.16, 4, 8),
    roughness: 0.8,
    shadow: true,
    slots: (['legL', 'legR'] as const).map((joint) => ({ joint, offset: at(0, -0.14, 0), tint: '#2c2f3d' as const })),
  },
  {
    geometry: new BoxGeometry(0.13, 0.06, 0.22),
    roughness: 0.6,
    shadow: false,
    slots: (['legL', 'legR'] as const).map((joint) => ({ joint, offset: at(0, -0.27, 0.05), tint: '#20222c' as const })),
  },
];
const MATERIALS = KINDS.map((k) => new MeshStandardMaterial({ roughness: k.roughness }));

const HIT = new CylinderGeometry(0.5, 0.5, 1.9, 8);
const HIT_MATERIAL = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const HIT_OFFSET = at(0, 0.95, 0);
// Instances move every frame, so the culling and raycast bounds must cover the whole world.
const EVERYWHERE = new Sphere(new Vector3(), 1e5);

const scratch = new Matrix4();
const tint = new Color();
const hex = (look: Look, t: Tint) => (t === 'body' ? look.body : t === 'skin' ? look.skin : t === 'hair' ? look.hair : t === 'trim' ? (look.trim ?? look.body) : t);
const lookKey = (l: Look) => `${l.body}${l.skin}${l.hair}${l.trim}`;
const HIDDEN_MATRIX = new Matrix4().makeScale(0, 0, 0);


export function CrowdMeshes() {
  const [capacity, setCapacity] = useState(32);
  const meshes = useRef<(InstancedMesh | null)[]>([]);
  const hit = useRef<InstancedMesh>(null);
  const pickable = useRef<CrowdEntry[]>([]);
  // Colours are rewritten only when a person's look changes or they move to another instance index.
  const painted = useRef(new WeakMap<CrowdEntry, { index: number; key: string }>());

  useFrame((state, dt) => {
    const visible: CrowdEntry[] = [];
    for (const e of crowd) {
      e.update(state.clock.elapsedTime, dt);
      if (!e.hidden) visible.push(e);
    }
    if (visible.length > capacity) {
      painted.current = new WeakMap();
      setCapacity(Math.max(capacity * 2, visible.length));
      return;
    }
    for (const e of visible) e.joints.root.updateWorldMatrix(true, true);

    KINDS.forEach((kind, k) => {
      const mesh = meshes.current[k];
      if (!mesh) return;
      const per = kind.slots.length;
      mesh.count = visible.length * per;
      visible.forEach((e, p) => {
        const painter = painted.current.get(e);
        const key = lookKey(e.look);
        const repaint = !painter || painter.index !== p || painter.key !== key;
        kind.slots.forEach((slot, s) => {
          const i = p * per + s;
          if (slot.tint === 'trim' && !e.look.trim) mesh.setMatrixAt(i, HIDDEN_MATRIX);
          else mesh.setMatrixAt(i, scratch.multiplyMatrices(e.joints[slot.joint].matrixWorld, slot.offset));
          if (repaint) mesh.setColorAt(i, tint.set(hex(e.look, slot.tint)));
        });
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    visible.forEach((e, p) => painted.current.set(e, { index: p, key: lookKey(e.look) }));

    const picks = visible.filter((e) => e.onPick);
    pickable.current = picks;
    if (hit.current) {
      hit.current.count = picks.length;
      picks.forEach((e, i) => hit.current!.setMatrixAt(i, scratch.multiplyMatrices(e.joints.root.matrixWorld, HIT_OFFSET)));
      hit.current.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <>
      {KINDS.map((kind, k) => (
        <instancedMesh
          key={`${k}-${capacity}`}
          ref={(m: InstancedMesh | null) => {
            meshes.current[k] = m;
            if (m) {
              m.boundingSphere = EVERYWHERE;
              m.frustumCulled = false;
              m.instanceColor ??= new InstancedBufferAttribute(new Float32Array(capacity * kind.slots.length * 3), 3);
              m.count = 0;
            }
          }}
          args={[kind.geometry, MATERIALS[k], capacity * kind.slots.length]}
          castShadow={kind.shadow}
        />
      ))}
      <instancedMesh
        key={`hit-${capacity}`}
        ref={(m: InstancedMesh | null) => {
          hit.current = m;
          if (m) {
            m.boundingSphere = EVERYWHERE;
            m.frustumCulled = false;
            m.count = 0;
          }
        }}
        args={[HIT, HIT_MATERIAL, capacity]}
        onClick={(e) => {
          const who = e.instanceId === undefined ? undefined : pickable.current[e.instanceId];
          if (!who) return;
          e.stopPropagation();
          if (e.delta < 6) who.onPick?.({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
        }}
        onPointerOver={() => void (document.body.style.cursor = 'pointer')}
        onPointerOut={() => void (document.body.style.cursor = '')}
      />
    </>
  );
}
