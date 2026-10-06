import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, DirectionalLight, HemisphereLight, Color, CubeCamera, HalfFloatType, Texture, WebGLCubeRenderTarget, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, PMREMGenerator, Quaternion, Scene, Vector3 } from 'three';
import { blockCenter, DOOR_X } from '../../../shared/space/index.ts';
import type { Bounds } from './Environment.tsx';
import { runtime } from '../runtime.ts';
import { poolTexture } from './textures.ts';
import { compileScene } from './warmup.ts';

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
// Both steps are arranged so no draw waits for the GPU to link a program. Until the capture the materials carry the map of an
// empty room, which adds no light but gives them the program they will use with the real one, so it links with the rest of the
// office. Drawing into the cube needs programs of its own (a target is linear and not tone mapped), so the capture waits for
// the GPU to link them while the office keeps drawing.
const CAPTURE_SIZE = 256;

function useRoomReflections(at: Vector3) {
  const { gl, scene, camera } = useThree();
  const room = useRef<{ texture: Texture; dispose: () => void } | null>(null);
  const cube = useRef<WebGLCubeRenderTarget | null>(null);
  const phase = useRef<'settling' | 'linking' | 'linked' | 'taken'>('settling');
  const frames = useRef(0);
  const apply = (texture: Texture | null) => {
    for (const [material, strength] of reflective) {
      material.envMap = texture;
      material.envMapIntensity = strength;
      material.needsUpdate = true;
    }
  };
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    room.current = pmrem.fromScene(new Scene(), 0, 0.1, 220, { size: CAPTURE_SIZE });
    pmrem.dispose();
    apply(room.current.texture);
    return () => {
      apply(null);
      cube.current?.dispose();
      room.current?.dispose();
      room.current = null;
    };
  }, []);
  useFrame(() => {
    if (phase.current === 'settling' && ++frames.current >= 90) {
      phase.current = 'linking';
      cube.current = new WebGLCubeRenderTarget(CAPTURE_SIZE, { type: HalfFloatType });
      void compileScene(gl, scene, camera, cube.current).then(() => (phase.current = 'linked'));
    }
    if (phase.current !== 'linked' || !cube.current) return;
    phase.current = 'taken';
    const cam = new CubeCamera(0.1, 220, cube.current);
    cam.position.copy(at);
    // The sun's shadow map is the same from every face, and the last frame drew it, so the six faces reuse it instead of
    // drawing every caster six more times.
    const { autoUpdate } = gl.shadowMap;
    gl.shadowMap.autoUpdate = false;
    cam.update(gl, scene);
    gl.shadowMap.autoUpdate = autoUpdate;
    const pmrem = new PMREMGenerator(gl);
    const filtered = pmrem.fromCubemap(cube.current.texture);
    pmrem.dispose();
    cube.current.dispose();
    cube.current = null;
    room.current?.dispose();
    room.current = filtered;
    apply(filtered.texture);
  });
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
  const sun = useRef<DirectionalLight>(null);
  const sky = useRef<HemisphereLight>(null);
  // From above the rooms the sun stands higher and its shadows are lighter, so a streak of shade never hides a desk; at eye
  // height it is the low, dramatic light through the windows.
  useFrame(() => {
    const t = 1 - Math.min(1, runtime.view.blend * 4);
    if (sun.current) {
      sun.current.position.set(cx + 38, 12 + 12 * t, cz + 14);
      sun.current.shadow.intensity = 1 - 0.38 * t;
      sun.current.intensity = 4.6 - 0.8 * t;
    }
    if (sky.current) sky.current.intensity = 0.62 + 0.22 * t;
  });
  return (
    <>
      <hemisphereLight ref={sky} args={['#b9cdf2', '#caa27a', 0.62]} />
      <directionalLight
        ref={sun}
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
      {/* The bounce off the lawn and the far walls: a cool-warm fill from the shaded side, so walls that face away from the sun keep their paint colour. */}
      <directionalLight color="#ffe2c4" intensity={2} position={[cx - 30, 14, cz - 22]} />
      <LightPools pools={pools} />
      <primitive object={target} />
    </>
  );
}
