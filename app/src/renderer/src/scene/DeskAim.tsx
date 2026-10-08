// The desk a task card in hand is over, lit the way a placement is in a builder: green when dropping would do something, red
// when it would be refused, amber when nothing would change. A glass volume with a bright rim around the desk, a plate on the
// desktop, a pad on the floor under the desk and the chair, and the words (the sitter's name, or "Empty desk: hire") above it.
import { Edges, Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { DoubleSide, type MeshBasicMaterial } from 'three';
import { ITEM_DEFS, STORY_H, rotateLocal, type FloorItem } from '../../../shared/space/index.ts';
import { floorItems, itemRect } from '../../../shared/space/geom.ts';
import { labelOf, toneOf, type Aim, type Tone } from '../deskDrop.ts';
import { useStore } from '../store.ts';

const COLOR: Record<Tone, string> = { go: '#2fe06a', stop: '#ff4d4d', same: '#ffb340' };
const MARGIN = 0.14;

export function DeskAim() {
  const aim = useStore((s) => s.aim);
  const building = useStore((s) => s.building);
  const item = aim && building?.stories[aim.story] && floorItems(building.stories[aim.story]!).find((i) => i.id === aim.deskId);
  return aim && item ? <Lit aim={aim} item={item} /> : null;
}

function Lit({ aim, item }: { aim: Aim; item: FloorItem }) {
  const plate = useRef<MeshBasicMaterial>(null);
  useFrame((state) => {
    if (plate.current) plate.current.opacity = 0.42 + Math.sin(state.clock.elapsedTime * 6) * 0.1;
  });
  const def = ITEM_DEFS[item.def]!;
  const r = itemRect(item, def);
  const w = (r.x1 - r.x0) / 2 + MARGIN;
  const d = (r.z1 - r.z0) / 2 + MARGIN;
  const x = (r.x0 + r.x1) / 4;
  const z = (r.z0 + r.z1) / 4;
  const chair = def.seat ? rotateLocal(def, item.rot, def.seat.chair) : null;
  // The floor pad spans the desk and the chair in front of it.
  const c = chair ? { x: (item.x + chair.x) / 2, z: (item.z + chair.z) / 2 } : { x, z };
  const pad = { x0: Math.min(r.x0 / 2, c.x - 0.5) - 0.12, x1: Math.max(r.x1 / 2, c.x + 0.5) + 0.12, z0: Math.min(r.z0 / 2, c.z - 0.5) - 0.12, z1: Math.max(r.z1 / 2, c.z + 0.5) + 0.12 };
  const tone = toneOf(aim.verdict);
  const color = COLOR[tone];
  return (
    <group position-y={aim.story * STORY_H} userData={{ probe: 'desk-aim', desk: aim.deskId, tone, label: labelOf(aim.verdict) }}>
      <mesh position={[x, def.height / 2, z]} renderOrder={7}>
        <boxGeometry args={[w, def.height + 0.04, d]} />
        <meshBasicMaterial color={color} transparent opacity={0.26} depthWrite={false} side={DoubleSide} />
        <Edges color={color} lineWidth={3} depthTest={false} />
      </mesh>
      <mesh position={[x, def.height + 0.03, z]} rotation-x={-Math.PI / 2} renderOrder={8}>
        <planeGeometry args={[w, d]} />
        <meshBasicMaterial ref={plate} color={color} transparent opacity={0.45} depthWrite={false} side={DoubleSide} />
      </mesh>
      <mesh position={[(pad.x0 + pad.x1) / 2, 0.04, (pad.z0 + pad.z1) / 2]} rotation-x={-Math.PI / 2} renderOrder={6}>
        <planeGeometry args={[pad.x1 - pad.x0, pad.z1 - pad.z0]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} depthWrite={false} side={DoubleSide} />
      </mesh>
      <Html position={[x, def.height + 0.6, z]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div className={`desk-aim ${tone}`} data-testid="desk-aim">
          <i />
          {labelOf(aim.verdict)}
        </div>
      </Html>
    </group>
  );
}
