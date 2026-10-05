import { useRef } from 'react';
import { footprint, PLACE_AREA } from '../../../shared/placement.ts';
import { arrangeProblem, moveArranging, type Arranging } from '../arrange.ts';
import { useStore } from '../store.ts';

// The floor under the block being moved, green where it can go and red where it cannot, and an invisible sheet over
// the whole floor that turns a drag anywhere into a move. A drag keeps the grip it started with, so the block never jumps.
export function ArrangeOverlay({ arranging }: { arranging: Arranging }) {
  const company = useStore((s) => s.company);
  const grip = useRef<{ dx: number; dz: number } | null>(null);
  const f = footprint(arranging.place);
  const blocked = arrangeProblem(arranging, company) !== null;
  const a = PLACE_AREA;
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position={[(f.x0 + f.x1) / 2, 0.02, (f.z0 + f.z1) / 2]}>
        <planeGeometry args={[f.x1 - f.x0, f.z1 - f.z0]} />
        <meshBasicMaterial color={blocked ? '#e5484d' : '#30a46c'} transparent opacity={0.28} depthWrite={false} />
      </mesh>
      <mesh
        rotation-x={-Math.PI / 2}
        position={[(a.x0 + a.x1) / 2, 0.03, (a.z0 + a.z1 + 20) / 2]}
        onPointerDown={(e) => {
          e.stopPropagation();
          (e.target as Element).setPointerCapture(e.pointerId);
          const { place } = useStore.getState().arranging ?? arranging;
          grip.current = { dx: place.x - e.point.x, dz: place.z - e.point.z };
          document.body.style.cursor = 'grabbing';
        }}
        onPointerMove={(e) => {
          const g = grip.current;
          const current = useStore.getState().arranging;
          if (!g || !current) return;
          e.stopPropagation();
          moveArranging({ ...current.place, x: e.point.x + g.dx, z: e.point.z + g.dz });
        }}
        onPointerUp={(e) => {
          (e.target as Element).releasePointerCapture(e.pointerId);
          grip.current = null;
          document.body.style.cursor = '';
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <planeGeometry args={[a.x1 - a.x0 + 40, a.z1 - a.z0 + 40]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </>
  );
}
