// Verification hooks: the render loop can be throttled in background tabs, so tests advance the sim by hand.
import { applyServerMessage } from './office.ts';
import { runtime } from './runtime.ts';
import { stepSim } from './sim.ts';
import { get, set, setSetting, useStore } from './store.ts';

export function installDebug() {
  (window as unknown as { __office: unknown }).__office = {
    step(seconds: number, fps = 30) {
      for (let i = 0; i < seconds * fps; i++) stepSim(1 / fps);
    },
    teleport(x: number, z: number, yaw = runtime.owner.yaw) {
      runtime.owner.pos.set(x, 0, z);
      runtime.owner.yaw = yaw;
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
    }),
    setCamera: (c: 'follow' | 'iso' | 'first') => setSetting('camera', c),
    apply: applyServerMessage,
    store: useStore,
    set,
  };
}
