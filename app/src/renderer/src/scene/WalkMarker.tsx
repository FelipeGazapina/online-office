import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group } from 'three';
import { STORY_H } from '../../../shared/space/index.ts';
import { runtime } from '../runtime.ts';
import { tripEnd } from '../sim.ts';

// Marks where a click walk ends, until the owner gets there.
export function WalkMarker() {
  const marker = useRef<Group>(null);

  useFrame((state) => {
    const m = marker.current;
    if (!m) return;
    const { intent } = runtime.owner;
    m.visible = intent.kind === 'walk';
    if (intent.kind !== 'walk') return;
    const end = tripEnd(intent.trip);
    m.position.set(end.at.x, end.floor * STORY_H + 0.03, end.at.z);
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
