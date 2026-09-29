import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group } from 'three';
import { runtime } from '../runtime.ts';

// Marks where a click walk ends, until the owner gets there.
export function WalkMarker() {
  const marker = useRef<Group>(null);

  useFrame((state) => {
    const m = marker.current;
    if (!m) return;
    const { intent } = runtime.owner;
    m.visible = intent.kind === 'walk';
    if (intent.kind !== 'walk') return;
    const end = intent.path[intent.path.length - 1];
    m.position.set(end.x, 0.03, end.z);
    m.scale.setScalar(1 + Math.sin(state.clock.elapsedTime * 5) * 0.08);
  });

  return (
    <group ref={marker} visible={false}>
      <mesh rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.34, 0.47, 32]} />
        <meshBasicMaterial color="#fbf7ef" transparent depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.47, 0.56, 32]} />
        <meshBasicMaterial color="#2f3a5f" transparent depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2}>
        <circleGeometry args={[0.13, 24]} />
        <meshBasicMaterial color="#f2b84b" transparent depthWrite={false} />
      </mesh>
    </group>
  );
}
