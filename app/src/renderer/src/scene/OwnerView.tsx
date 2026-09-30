import { Html } from '@react-three/drei';
import { runtime } from '../runtime.ts';
import { labelLayer } from './labelLayer.ts';
import { Person } from './Person.tsx';

const LOOK = { body: '#2f3a5f', skin: '#e9b98f', hair: '#3a2a20', trim: '#f2b84b' };

export function OwnerView() {
  return (
    <Person
      look={LOOK}
      read={() => ({ pos: runtime.owner.pos, yaw: runtime.owner.yaw, speed: runtime.owner.speed, seated: false })}
    >
      <Html position={[0, 2.0, 0]} portal={labelLayer} pointerEvents="none" zIndexRange={[20, 0]}>
        <div className="emp-label">
          <div className="tag you">
            <b>You</b>
            <span className="prov">Owner</span>
          </div>
        </div>
      </Html>
    </Person>
  );
}
