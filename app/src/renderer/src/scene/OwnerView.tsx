import { Html } from '@react-three/drei';
import { runtime } from '../runtime.ts';
import { ResizableHud } from '../hud/ResizableHud.tsx';
import { labelLayer } from './labelLayer.ts';
import { Person } from './Person.tsx';

const LOOK = { body: '#2f3a5f', skin: '#e9b98f', hair: '#3a2a20', trim: '#f2b84b' };

export function OwnerView() {
  return (
    <Person
      look={LOOK}
      read={() => ({ pos: runtime.owner.pos, yaw: runtime.owner.yaw, speed: runtime.owner.speed, seated: false })}
    >
      <Html position={[0, 2.0, 0]} portal={labelLayer} pointerEvents="auto">
        <ResizableHud itemKey="owner-label"><div className="emp-label" data-hud-resize-target="owner-label">
          <div className="tag you">
            <b>You</b>
            <span className="prov">Owner</span>
          </div>
        </div></ResizableHud>
      </Html>
    </Person>
  );
}
