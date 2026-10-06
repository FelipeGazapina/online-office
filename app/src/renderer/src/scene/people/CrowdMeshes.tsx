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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { appearance, FACES, type Appearance } from './appearance.ts';
import { crowd, type CrowdEntry, type Joints } from './crowd.ts';
import { faceAtlas } from './faces.ts';

type Tint = keyof Appearance['colors'] | `#${string}`;
type Slot = { joint: keyof Joints; offset: Matrix4; tint: Tint };
type Kind = {
  geometry: BufferGeometry;
  roughness: number;
  shadow: boolean;
  slots: Slot[];
  // A part only some people have (a hairstyle, a hood): they take the first instances and the rest stay unused.
  only?: (a: Appearance) => boolean;
  face?: boolean;
};

const at = (x: number, y: number, z: number, rx = 0, sx = 1, sy = 1, sz = 1) =>
  new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(rx, 0, 0)), new Vector3(sx, sy, sz));
const both = (joints: [keyof Joints, keyof Joints], offset: (i: number) => Matrix4, tint: Tint): Slot[] =>
  joints.map((joint, i) => ({ joint, offset: offset(i), tint }));

const HEAD_R = 0.125;
const sphere = (r: number, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) =>
  new SphereGeometry(r, 18, 14).scale(sx, sy, sz).translate(x, y, z);
// A cap of hair, tilted back so the forehead and face stay clear.
const cap = (r: number, cover: number, tilt: number, y = 0, sy = 1.1) =>
  new SphereGeometry(r, 18, 12, 0, Math.PI * 2, 0, Math.PI * cover).rotateX(-tilt).scale(1, sy, 1).translate(0, y, 0);

const HAIR: BufferGeometry[] = [
  cap(HEAD_R * 1.1, 0.46, 0.3),
  mergeGeometries([cap(HEAD_R * 1.12, 0.5, 0.3), new CapsuleGeometry(0.1, 0.2, 4, 10).scale(1.05, 1, 0.65).translate(0, -0.1, -0.075)])!,
  mergeGeometries([cap(HEAD_R * 1.1, 0.46, 0.3), sphere(0.062, 0, 0.145, -0.07)])!,
  cap(HEAD_R * 1.04, 0.36, 0.3),
  mergeGeometries([cap(HEAD_R * 1.28, 0.55, 0.42, 0.015), sphere(0.07, -0.115, -0.01, -0.02), sphere(0.07, 0.115, -0.01, -0.02)])!,
];

// One InstancedMesh per body part, so the whole crowd costs one draw call per part instead of one per mesh.
// Each slot is one instance per person: where the part sits on its joint, and which colour of their outfit tints it.
const KINDS: Kind[] = [
  { geometry: new CapsuleGeometry(0.15, 0.24, 6, 14), roughness: 0.8, shadow: true, slots: [{ joint: 'body', offset: at(0, 0.27, 0, 0, 1.2, 1, 0.82), tint: 'body' }] },
  { geometry: new SphereGeometry(0.16, 14, 10), roughness: 0.8, shadow: true, slots: [{ joint: 'body', offset: at(0, -0.01, 0, 0, 1.12, 0.72, 0.82), tint: 'pants' }] },
  { geometry: new CylinderGeometry(0.045, 0.05, 0.12, 8), roughness: 0.8, shadow: false, slots: [{ joint: 'head', offset: at(0, 0.03, 0), tint: 'skin' }] },
  { geometry: new BoxGeometry(0.17, 0.3, 0.03), roughness: 0.7, shadow: false, slots: [{ joint: 'body', offset: at(0, 0.3, 0.123, -0.06), tint: 'trim' }], only: (a) => a.outfit === 'blazer' },
  { geometry: new SphereGeometry(0.1, 12, 10), roughness: 0.9, shadow: false, slots: [{ joint: 'body', offset: at(0, 0.54, -0.09, 0.3, 1.25, 0.75, 0.8), tint: 'body' }], only: (a) => a.outfit === 'hoodie' },
  { geometry: new SphereGeometry(HEAD_R, 24, 18), roughness: 0.75, shadow: true, slots: [{ joint: 'head', offset: at(0, 0.14, 0.005, 0, 1, 1.1, 1.03), tint: 'skin' }], face: true },
  ...HAIR.map((geometry, style): Kind => ({
    geometry,
    roughness: 0.85,
    shadow: false,
    slots: [{ joint: 'head', offset: at(0, 0.14, 0), tint: 'hair' }],
    only: (a) => a.hairStyle === style,
  })),
  { geometry: new CapsuleGeometry(0.05, 0.17, 4, 8), roughness: 0.8, shadow: true, slots: both(['armL', 'armR'], () => at(0, -0.135, 0), 'body') },
  { geometry: new CapsuleGeometry(0.043, 0.17, 4, 8), roughness: 0.8, shadow: true, slots: both(['elbowL', 'elbowR'], () => at(0, -0.13, 0), 'forearm') },
  { geometry: new SphereGeometry(0.052, 10, 8), roughness: 0.8, shadow: false, slots: both(['elbowL', 'elbowR'], () => at(0, -0.285, 0.005, 0, 1, 1.15, 0.8), 'skin') },
  { geometry: new CapsuleGeometry(0.072, 0.28, 4, 10), roughness: 0.85, shadow: true, slots: both(['legL', 'legR'], () => at(0, -0.22, 0), 'pants') },
  { geometry: new CapsuleGeometry(0.062, 0.26, 4, 10), roughness: 0.85, shadow: true, slots: both(['kneeL', 'kneeR'], () => at(0, -0.2, 0), 'pants') },
  { geometry: new BoxGeometry(0.11, 0.075, 0.25), roughness: 0.55, shadow: false, slots: both(['kneeL', 'kneeR'], () => at(0, -0.41, 0.05), 'shoe') },
];
const FACES_F = FACES.toFixed(1);
const MATERIALS = KINDS.map((k) => {
  const m = new MeshStandardMaterial({ roughness: k.roughness });
  if (k.face) faceMaterial(m);
  return m;
});

// The head samples one cell of the face atlas, chosen per person, on the front of the sphere only. The cell spans
// the front 70 degrees around and 63 degrees up and down; the rest of the head is bare skin colour.
function faceMaterial(m: MeshStandardMaterial) {
  m.map = faceAtlas();
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFace;\nvarying float vFace;\nvarying vec3 vFaceP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFace = aFace;\nvFaceP = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFace;\nvarying vec3 vFaceP;')
      .replace(
        '#include <map_fragment>',
        `float az = atan(vFaceP.x, vFaceP.z);
        float el = asin(clamp(vFaceP.y / length(vFaceP), -1.0, 1.0));
        vec2 fuv = vec2(0.5 + az / 1.2, 0.5 + el / 1.1);
        float onFace = step(0.0, fuv.x) * step(fuv.x, 1.0) * step(0.0, fuv.y) * step(fuv.y, 1.0) * step(0.0, vFaceP.z);
        vec4 faceTexel = texture2D(map, vec2((clamp(fuv.x, 0.0, 1.0) + vFace) / ${FACES_F}, clamp(fuv.y, 0.0, 1.0)));
        diffuseColor *= mix(vec4(1.0), faceTexel, onFace);`,
      );
  };
  m.customProgramCacheKey = () => 'crowd-face';
}

const HIT = new CylinderGeometry(0.42, 0.42, 1.8, 8);
const HIT_MATERIAL = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const HIT_OFFSET = at(0, 0.9, 0);
// Instances move every frame, so the culling and raycast bounds must cover the whole world.
const EVERYWHERE = new Sphere(new Vector3(), 1e5);

const scratch = new Matrix4();
const tint = new Color();
const hex = (a: Appearance, t: Tint) => (t.startsWith('#') ? t : a.colors[t as keyof Appearance['colors']]);

export function CrowdMeshes() {
  const [capacity, setCapacity] = useState(32);
  const meshes = useRef<(InstancedMesh | null)[]>([]);
  const hit = useRef<InstancedMesh>(null);
  const pickable = useRef<CrowdEntry[]>([]);

  useFrame((state, dt) => {
    const visible: CrowdEntry[] = [];
    for (const e of crowd) {
      e.update(state.clock.elapsedTime, dt);
      if (!e.hidden) visible.push(e);
    }
    if (visible.length > capacity) {
      setCapacity(Math.max(capacity * 2, visible.length));
      return;
    }
    for (const e of visible) e.joints.root.updateWorldMatrix(true, true);

    KINDS.forEach((kind, k) => {
      const mesh = meshes.current[k];
      if (!mesh) return;
      const per = kind.slots.length;
      let n = 0;
      for (const e of visible) {
        const ap = appearance(e.look);
        if (kind.only && !kind.only(ap)) continue;
        kind.slots.forEach((slot, s) => {
          const i = n * per + s;
          mesh.setMatrixAt(i, scratch.multiplyMatrices(e.joints[slot.joint].matrixWorld, slot.offset));
          mesh.setColorAt(i, tint.set(hex(ap, slot.tint)));
          if (kind.face) mesh.geometry.getAttribute('aFace').setX(i, ap.face);
        });
        n++;
      }
      mesh.count = n * per;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (kind.face) mesh.geometry.getAttribute('aFace').needsUpdate = true;
    });

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
              if (kind.face) m.geometry.setAttribute('aFace', new InstancedBufferAttribute(new Float32Array(capacity * kind.slots.length), 1));
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
