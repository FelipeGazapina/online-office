import { useLayoutEffect, useMemo, useRef } from 'react';
import { BackSide, Color, ConeGeometry, CylinderGeometry, Fog, IcosahedronGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector3, type BufferGeometry } from 'three';
import { useThree } from '@react-three/fiber';
import { DOOR_X } from '../../../shared/space/index.ts';
import { grassTexture, paverTexture, skyTexture, blobShadowTexture } from './textures.ts';

export type Bounds = { x0: number; x1: number; z0: number; z1: number };

export const GROUND_Y = -0.62;
const HORIZON = '#d6e8f2';

// A small deterministic generator, so every launch grows the same garden.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Placement = { x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number; color: string };

const up = new Vector3(0, 1, 0);
const q = new Quaternion();
const m4 = new Matrix4();
const c4 = new Color();
const p3 = new Vector3();
const s3 = new Vector3();

function Scatter({ geometry, material, items, castShadow = false }: { geometry: BufferGeometry; material: MeshStandardMaterial | MeshBasicMaterial; items: Placement[]; castShadow?: boolean }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    items.forEach((it, i) => {
      q.setFromAxisAngle(up, it.yaw);
      mesh.setMatrixAt(i, m4.compose(p3.set(it.x, it.y, it.z), q, s3.set(it.sx, it.sy, it.sz)));
      mesh.setColorAt(i, c4.set(it.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [items]);
  if (!items.length) return null;
  return <instancedMesh key={items.length} ref={ref} args={[geometry, material, items.length]} frustumCulled={false} castShadow={castShadow} />;
}

const trunkGeo = new CylinderGeometry(0.16, 0.24, 1, 6).translate(0, 0.5, 0);
const crownGeo = new IcosahedronGeometry(1, 1);
const pineGeo = new ConeGeometry(1, 2.2, 7).translate(0, 1.1, 0);
const bushGeo = new IcosahedronGeometry(1, 1);
const flowerGeo = new IcosahedronGeometry(1, 0);
const blobGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const trunkMat = new MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true });
const leafMat = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, flatShading: true });
const flowerMat = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.7, flatShading: true });
const blobMat = new MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, opacity: 0.5, fog: false });

const LEAF = ['#4f9a4a', '#5fae52', '#3f8844', '#6cbb5a', '#79b94d'];
const PINE = ['#2f6b46', '#3a7a4e', '#285d3d'];
const FLOWER = ['#f06292', '#ffd54f', '#ffffff', '#ba68c8', '#ff8a65', '#7fb2ff'];

function garden(b: Bounds) {
  const rand = rng(90210);
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const hx = (b.x1 - b.x0) / 2;
  const hz = (b.z1 - b.z0) / 2;
  const trunks: Placement[] = [];
  const crowns: Placement[] = [];
  const pines: Placement[] = [];
  const blobs: Placement[] = [];
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  let guard = 0;
  while (trunks.length + pines.length < 90 && guard++ < 2000) {
    const a = rand() * Math.PI * 2;
    const reach = 9 + Math.pow(rand(), 0.7) * 85;
    const x = cx + Math.cos(a) * (hx + reach) * (0.9 + rand() * 0.2);
    const z = cz + Math.sin(a) * (hz + reach) * (0.9 + rand() * 0.2);
    if (x > b.x0 - 7 && x < b.x1 + 7 && z > b.z0 - 7 && z < b.z1 + 8) continue;
    if (Math.abs(x - DOOR_X) < 4 && z > b.z1) continue;
    const near = Math.max(0, 1 - reach / 60);
    const h = 3.2 + rand() * 3 + near * 0.8;
    const pine = rand() < 0.38;
    const yaw = rand() * 6.28;
    if (pine) {
      const r = 1.3 + rand() * 0.9;
      trunks.push({ x, y: GROUND_Y, z, sx: 1, sy: h * 0.35, sz: 1, yaw, color: '#5b4330' });
      pines.push({ x, y: GROUND_Y + h * 0.3, z, sx: r, sy: h * 0.62, sz: r, yaw, color: pick(PINE) });
      blobs.push({ x, y: GROUND_Y + 0.02, z, sx: r * 3.2, sy: 1, sz: r * 3.2, yaw: 0, color: '#000' });
    } else {
      const r = 1.6 + rand() * 1.4;
      trunks.push({ x, y: GROUND_Y, z, sx: 1.2, sy: h * 0.55, sz: 1.2, yaw, color: '#6b4d36' });
      crowns.push({ x, y: GROUND_Y + h * 0.7, z, sx: r, sy: r * 0.85, sz: r, yaw, color: pick(LEAF) });
      crowns.push({ x: x + (rand() - 0.5) * r, y: GROUND_Y + h * 0.7 + r * 0.55, z: z + (rand() - 0.5) * r, sx: r * 0.7, sy: r * 0.62, sz: r * 0.7, yaw, color: pick(LEAF) });
      blobs.push({ x, y: GROUND_Y + 0.02, z, sx: r * 3.4, sy: 1, sz: r * 3.4, yaw: 0, color: '#000' });
    }
  }
  // Hedges along the sides and a flower bed on each side of the front path.
  const bushes: Placement[] = [];
  const flowers: Placement[] = [];
  const bush = (x: number, z: number, r: number) => {
    bushes.push({ x, y: GROUND_Y + r * 0.45, z, sx: r, sy: r * 0.8, sz: r, yaw: rand() * 6, color: pick(LEAF) });
    blobs.push({ x, y: GROUND_Y + 0.02, z, sx: r * 2.6, sy: 1, sz: r * 2.6, yaw: 0, color: '#000' });
  };
  for (let x = b.x0 - 0.5; x <= b.x1 + 0.5; x += 3.2 + rand()) {
    if (Math.abs(x - DOOR_X) > 3.4) bush(x, b.z1 + 1.5, 0.55 + rand() * 0.3);
    bush(x, b.z0 - 1.4, 0.7 + rand() * 0.4);
  }
  for (let z = b.z0; z <= b.z1; z += 3.4 + rand()) {
    bush(b.x0 - 1.4, z, 0.6 + rand() * 0.4);
    bush(b.x1 + 1.4, z, 0.6 + rand() * 0.4);
  }
  for (let i = 0; i < 70; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const x = DOOR_X + side * (3.4 + rand() * 4.2);
    const z = b.z1 + 1.1 + rand() * 1.4;
    const r = 0.09 + rand() * 0.07;
    flowers.push({ x, y: GROUND_Y + 0.28 + rand() * 0.2, z, sx: r, sy: r, sz: r, yaw: 0, color: pick(FLOWER) });
    if (i % 5 === 0) bush(x, z + 0.3, 0.38);
  }
  return { trunks, crowns, pines, bushes, flowers, blobs };
}

function Sky() {
  const tex = useMemo(() => skyTexture(HORIZON), []);
  return (
    <mesh renderOrder={-10}>
      <sphereGeometry args={[190, 24, 16]} />
      <meshBasicMaterial map={tex} side={BackSide} depthWrite={false} fog={false} toneMapped={false} />
    </mesh>
  );
}

export function Environment({ b }: { b: Bounds }) {
  const scene = useThree((s) => s.scene);
  useLayoutEffect(() => {
    scene.fog = new Fog(HORIZON, 70, 185);
    return () => void (scene.fog = null);
  }, [scene]);
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const grass = useMemo(() => grassTexture(), []);
  const pavers = useMemo(() => paverTexture(), []);
  const g = useMemo(() => garden(b), [b.x0, b.x1, b.z0, b.z1]);
  const grassMat = useMemo(() => new MeshStandardMaterial({ map: grass, roughness: 1 }), [grass]);
  const apron = useMemo(() => {
    const t = pavers.clone();
    t.repeat.set((w + 8) / 3, (d + 8) / 3);
    t.needsUpdate = true;
    return new MeshStandardMaterial({ map: t, roughness: 0.95 });
  }, [pavers, w, d]);
  const path = useMemo(() => {
    const t = pavers.clone();
    t.repeat.set(1.6, 12);
    t.needsUpdate = true;
    return new MeshStandardMaterial({ map: t, roughness: 0.95 });
  }, [pavers]);
  return (
    <>
      <Sky />
      <mesh rotation-x={-Math.PI / 2} position={[cx, GROUND_Y, cz]} receiveShadow material={grassMat}>
        <circleGeometry args={[230, 48]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[cx, GROUND_Y + 0.012, cz]} receiveShadow material={apron}>
        <planeGeometry args={[w + 8, d + 8]} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[DOOR_X, GROUND_Y + 0.02, b.z1 + 4.5 + 22]} receiveShadow material={path}>
        <planeGeometry args={[4.8, 54]} />
      </mesh>
      <Scatter geometry={trunkGeo} material={trunkMat} items={g.trunks} />
      <Scatter geometry={crownGeo} material={leafMat} items={g.crowns} />
      <Scatter geometry={pineGeo} material={leafMat} items={g.pines} />
      <Scatter geometry={bushGeo} material={leafMat} items={g.bushes} />
      <Scatter geometry={flowerGeo} material={flowerMat} items={g.flowers} />
      <Scatter geometry={blobGeo} material={blobMat} items={g.blobs} />
    </>
  );
}
