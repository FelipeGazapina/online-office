import { useLayoutEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, Color, InstancedMesh, Matrix4, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { blockCenter, DOOR_X } from '../../../shared/space/index.ts';
import type { Bounds } from './Environment.tsx';
import { poolTexture } from './textures.ts';

// Pools of lamplight lie on the floor under every zone's lights: one additive decal each, all drawn together. They
// are the cheap half of the room lighting; a couple of real point lights give the lobby its glow.
const poolMaterial = new MeshBasicMaterial({ map: poolTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.34, fog: false, polygonOffset: true, polygonOffsetFactor: -3 });
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
