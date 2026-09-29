// Verification hooks: the render loop can be throttled in background tabs, so tests advance the sim by hand.
import { _roots } from '@react-three/fiber';
import { Vector3 } from 'three';
import { applyServerMessage } from './office.ts';
import { KEYS_INTENT, runtime } from './runtime.ts';
import { stepSim } from './sim.ts';
import { get, set, setSetting, useStore } from './store.ts';

const intentState = () => {
  const i = runtime.owner.intent;
  return i.kind === 'walk' ? { kind: i.kind, goal: i.goal, dest: i.path[i.path.length - 1], left: i.path.length } : { kind: i.kind };
};

export function installDebug() {
  (window as unknown as { __office: unknown }).__office = {
    step(seconds: number, fps = 30) {
      for (let i = 0; i < seconds * fps; i++) stepSim(1 / fps);
    },
    teleport(x: number, z: number, yaw = runtime.owner.yaw) {
      runtime.owner.pos.set(x, 0, z);
      runtime.owner.yaw = yaw;
      runtime.owner.intent = KEYS_INTENT;
      runtime.queueYaw = yaw;
      runtime.view.yaw = yaw;
    },
    hold(code: string, on = true) {
      if (on) runtime.keys.add(code);
      else runtime.keys.delete(code);
    },
    state: () => ({
      owner: { x: runtime.owner.pos.x, z: runtime.owner.pos.z, yaw: runtime.owner.yaw },
      avatars: [...runtime.avatars.values()].map((a) => ({ id: a.id, x: +a.pos.x.toFixed(2), z: +a.pos.z.toFixed(2), seated: a.seated, speed: +a.speed.toFixed(2) })),
      talkingTo: get().talkingTo,
      askerId: get().askerId,
      intent: intentState(),
      camera: get().camera,
      view: { yaw: runtime.view.yaw, isoYawTarget: runtime.view.isoYawTarget },
    }),
    // Where a point of the office lands on screen, in viewport pixels, through the camera as it is right now. That is
    // the camera a real click is raycast through, so a mouse event sent there hits that point.
    project(x: number, y: number, z: number) {
      const root = _roots.values().next().value;
      if (!root) return null;
      const { camera, size } = root.store.getState();
      const p = new Vector3(x, y, z).project(camera);
      return { x: size.left + ((p.x + 1) / 2) * size.width, y: size.top + ((1 - p.y) / 2) * size.height };
    },
    setCamera: (c: 'follow' | 'iso' | 'first') => setSetting('camera', c),
    apply: applyServerMessage,
    store: useStore,
    set,
  };
}
