import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, Color, CubeCamera, HalfFloatType, Texture, WebGLCubeRenderTarget, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, PMREMGenerator, Quaternion, Vector3 } from 'three';
import { blockCenter, DOOR_X } from '../../../shared/space/index.ts';
import type { Bounds } from './Environment.tsx';
import { poolTexture } from './textures.ts';

// Pools of lamplight lie on the floor under every zone's lights: one additive decal each, all drawn together. They
// are the cheap half of the room lighting; a couple of real point lights give the lobby its glow.
const poolMaterial = new MeshBasicMaterial({ map: poolTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.24, fog: false, polygonOffset: true, polygonOffsetFactor: -3 });
const poolGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const q = new Quaternion();
const m = new Matrix4();
const one = new Vector3();

type Pool = { x: number; z: number; r: number; color: string };

export function poolsFor(b: Bounds, slots: readonly number[]): Pool[] {
  const cx = (b.x0 + b.x1) / 2;
  const right = b.x1 - 4;
  const warm = '#ffb766';
  const pools: Pool[] = [
    { x: cx, z: b.z1 - 3.4, r: 9, color: warm },
    { x: cx, z: -0.45, r: 6.5, color: '#ffd9a0' },
    { x: right, z: b.z1 - 4, r: 5, color: '#ffe3b0' },
    { x: right, z: b.z1 - 1.8, r: 5, color: '#ffa45c' },
    { x: -14.5, z: 5, r: 6, color: '#ffb166' },
    { x: DOOR_X, z: b.z1 - 1.6, r: 5.5, color: '#ffd391' },
  ];
  for (const s of slots) {
    const c = blockCenter(s);
    pools.push({ x: c.x, z: c.z + 0.4, r: 7.8, color: '#ffe0a8' }, { x: c.x + 3, z: c.z - 1.5, r: 4, color: '#ffc27a' });
  }
  return pools;
}

export function LightPools({ pools }: { pools: Pool[] }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const c = new Color();
    pools.forEach((p, i) => {
      mesh.setMatrixAt(i, m.compose(new Vector3(p.x, 0.025, p.z), q, one.set(p.r * 2, 1, p.r * 2)));
      mesh.setColorAt(i, c.set(p.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [pools]);
  return <instancedMesh key={pools.length} ref={ref} args={[poolGeometry, poolMaterial, pools.length]} frustumCulled={false} renderOrder={4} />;
}

export function usePools(b: Bounds, slots: readonly number[]) {
  const key = slots.join(',');
  return useMemo(() => poolsFor(b, slots), [b.x0, b.x1, b.z0, b.z1, key]);
}

// Materials that take the room reflection, and how strongly. Only polished floors do: lit through the whole scene it would
// also act as ambient light and flatten the sun, but on a glossy floor it reads as a faint sheen of the room above it.
export const reflective = new Map<MeshStandardMaterial, number>();

// The polished floors and the glass reflect the real room: one cube capture from the middle of the office, taken a few
// frames after load once the scene is built, filtered into an environment map. Taken once, so it costs a single extra render.
function useRoomReflections(at: Vector3) {
  const { gl, scene } = useThree();
  const target = useRef<{ texture: Texture; dispose: () => void } | null>(null);
  const frames = useRef(0);
  const apply = (texture: Texture | null) => {
    for (const [material, strength] of reflective) {
      material.envMap = texture;
      material.envMapIntensity = strength;
      material.needsUpdate = true;
    }
  };
  useFrame(() => {
    if (target.current || ++frames.current < 90) return;
    const cube = new WebGLCubeRenderTarget(256, { type: HalfFloatType });
    const cam = new CubeCamera(0.1, 220, cube);
    cam.position.copy(at);
    apply(null);
    cam.update(gl, scene);
    const pmrem = new PMREMGenerator(gl);
    const filtered = pmrem.fromCubemap(cube.texture);
    pmrem.dispose();
    cube.dispose();
    target.current = filtered;
    apply(filtered.texture);
  });
  useEffect(
    () => () => {
      apply(null);
      target.current?.dispose();
      target.current = null;
    },
    [],
  );
}

// Late afternoon sun through the windows. Its shadows are wide and soft, and the sky and bounce fill is strong enough that
// the rooms read inside a streak of shade, so a close look at a desk shows the desk and not a black bar across it.
export function Lights({ b, slots }: { b: Bounds; slots: readonly number[] }) {
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const ext = Math.max(b.x1 - b.x0, b.z1 - b.z0) * 0.66;
  const target = useMemo(() => new Object3D(), []);
  useEffect(() => {
    target.position.set(cx, 0, cz);
    target.updateMatrixWorld();
  }, [target, cx, cz]);
  useRoomReflections(useMemo(() => new Vector3(cx, 1.5, cz), [cx, cz]));
  const pools = usePools(b, slots);
  return (
    <>
      <hemisphereLight args={['#b9cdf2', '#caa27a', 0.62]} />
      <directionalLight
        target={target}
        castShadow
        color="#ffc98c"
        intensity={4.6}
        position={[cx + 38, 12, cz + 14]}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-radius={2.5}
        shadow-camera-left={-ext}
        shadow-camera-right={ext}
        shadow-camera-top={ext}
        shadow-camera-bottom={-ext}
        shadow-camera-near={1}
        shadow-camera-far={110}
      />
      <LightPools pools={pools} />
      <primitive object={target} />
    </>
  );
}
