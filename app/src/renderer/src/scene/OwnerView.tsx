import { _roots, useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useState } from 'react';
import { Matrix4, Raycaster, Vector3, type Object3D } from 'three';
import { laptopAnim, laptopOut } from '../computer.ts';
import { runtime } from '../runtime.ts';
import { ResizableHud } from '../hud/ResizableHud.tsx';
import { labelLayer } from './labelLayer.ts';
import { laptopHands, lidMatrix, ownerMatrix, phases, SCREEN } from './laptopPose.ts';
import { crowd } from './people/crowd.ts';
import { Person, type Reach } from './Person.tsx';

const LOOK = { body: '#2f3a5f', skin: '#e9b98f', hair: '#3a2a20', trim: '#f2b84b' };
const hands: Reach = { w: 0, left: new Vector3(), right: new Vector3() };

// While the laptop is out both hands hold it, wherever it is on its way up or down.
function holdLaptop(): Reach | null {
  const s = laptopAnim.s;
  if (s <= 0) return null;
  hands.w = phases(s).arms;
  laptopHands(s, hands.left, hands.right);
  return hands;
}

// For the tests: where the laptop's screen is, how far each hand the crowd draws is from where it holds the laptop, and what stands
// between the camera and the screen.
const probe = { owner: new Matrix4(), lid: new Matrix4(), at: new Vector3(), grip: { w: 0, left: new Vector3(), right: new Vector3() } as Reach };
// Where CrowdMeshes draws a hand on its elbow joint.
const HAND = new Vector3(0, -0.285, 0.005);
(window as unknown as { __officeLaptopProbe: unknown }).__officeLaptopProbe = {
  corners() {
    const m = lidMatrix(ownerMatrix(runtime.owner.pos, runtime.owner.yaw, probe.owner), laptopAnim.s, probe.lid);
    return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => probe.at.set((x * SCREEN.w) / 2, SCREEN.y + (y * SCREEN.h) / 2, -SCREEN.out).applyMatrix4(m).toArray());
  },
  grip() {
    const { pos, yaw } = runtime.owner;
    const me = [...crowd].find((e) => e.joints && Math.hypot(e.joints.root.position.x - pos.x, e.joints.root.position.z - pos.z) < 0.05);
    if (!me || laptopAnim.s <= 0) return null;
    laptopHands(laptopAnim.s, probe.grip.left, probe.grip.right);
    const owner = ownerMatrix(pos, yaw, probe.owner);
    const off = (joint: 'elbowL' | 'elbowR', grip: Vector3) => probe.at.copy(HAND).applyMatrix4(me.joints[joint].matrixWorld).distanceTo(grip.applyMatrix4(owner));
    return { left: off('elbowL', probe.grip.left), right: off('elbowR', probe.grip.right) };
  },
  // The first solid thing the camera's line to the middle of the screen meets, or null when it meets nothing. People, the laptop and
  // what writes no depth (the lobby's haze, glass) do not count, since none of them hides the screen.
  blocked() {
    const root = _roots.values().next().value;
    if (!root) return 'no canvas';
    const { camera, scene } = root.store.getState();
    const m = lidMatrix(ownerMatrix(runtime.owner.pos, runtime.owner.yaw, probe.owner), laptopAnim.s, probe.lid);
    const way = new Vector3(0, SCREEN.y, -SCREEN.out).applyMatrix4(m).sub(camera.position);
    const far = way.length();
    const ray = new Raycaster(camera.position.clone(), way.normalize(), 0, far - 0.02);
    const counts = (o: Object3D) => {
      if ((o as { material?: { depthWrite?: boolean } }).material?.depthWrite === false) return false;
      for (let n: Object3D | null = o; n; n = n.parent) if (!n.visible || n.userData.laptop || n.userData.crowd) return false;
      return true;
    };
    const hit = ray.intersectObject(scene, true).find((h) => counts(h.object));
    if (!hit) return null;
    const { x, y, z } = hit.point;
    const look = (hit.object as { material?: { type?: string; transparent?: boolean; opacity?: number } }).material;
    return `${hit.object.name || hit.object.type} (${look?.type}${look?.transparent ? `, ${look.opacity} opaque` : ''}) at ${[x, y, z].map((v) => v.toFixed(2))}, ${hit.distance.toFixed(2)} m along a ${far.toFixed(2)} m line`;
  },
};

export function OwnerView() {
  // The avatar vanishes once the camera is nearly at its eyes, so the flight in does not show it popping out. Taking the laptop out
  // brings it back while the camera watches from the shoulder, until the camera is well on its way into the screen.
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  useFrame(() => {
    const out = laptopOut();
    const h = out ? phases(laptopAnim.s).zoom > 0.6 : runtime.view.blend > 0.9;
    if (h !== hidden) setHidden(h);
    if (out !== busy) setBusy(out);
  });
  return (
    <Person
      look={LOOK}
      hidden={hidden}
      read={() => ({ pos: runtime.owner.pos, yaw: runtime.owner.yaw, speed: runtime.owner.speed, seated: false })}
      reach={holdLaptop}
    >
      {!hidden && !busy && <Html position={[0, 1.85, 0]} portal={labelLayer} pointerEvents="auto">
        <ResizableHud itemKey="owner-label"><div className="emp-label" data-hud-resize-target="owner-label">
          <div className="tag you">
            <b>You</b>
            <span className="prov">Owner</span>
          </div>
        </div></ResizableHud>
      </Html>}
    </Person>
  );
}
