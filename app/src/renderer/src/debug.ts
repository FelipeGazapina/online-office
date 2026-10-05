// Verification hooks: the render loop can be throttled in background tabs, so tests advance the sim by hand.
import { _roots } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { BlockId, Employee, EmployeeId, ModelId, ProjectBlock } from '../../shared/protocol.ts';
import { DESKS_PER_BLOCK } from '../../shared/protocol.ts';
import { applyServerMessage } from './office.ts';
import { loadMailFixture } from './hud/chat/fixture.ts';
import { renders } from './hud/chat/renders.ts';
import { KEYS_INTENT, runtime } from './runtime.ts';
import { stepSim } from './sim.ts';
import { get, sendTap, set, setSetting, useStore } from './store.ts';

const intentState = () => {
  const i = runtime.owner.intent;
  return i.kind === 'walk' ? { kind: i.kind, goal: i.goal, dest: i.path[i.path.length - 1], left: i.path.length } : { kind: i.kind };
};

// Test-only: replaces the company in the renderer store with `count` fake employees spread over as many blocks as they
// need, two thirds of them working so their avatars animate. Main never hears about them, so no snapshot may arrive after.
function injectFake(count: number) {
  const company = get().company;
  if (!company) throw new Error('no company yet');
  const colors = ['#e07a5f', '#3d85c6', '#81b29a', '#f2cc8f'];
  const blocks: ProjectBlock[] = Array.from({ length: Math.max(1, Math.ceil(count / DESKS_PER_BLOCK)) }, (_, slot) => ({
    id: `fake-block-${slot}` as BlockId,
    name: `Fake ${slot}`,
    cwd: `/tmp/fake-${slot}`,
    color: colors[slot % colors.length],
    slot,
  }));
  const employees: Employee[] = Array.from({ length: count }, (_, i) => ({
    id: `fake-emp-${i}` as EmployeeId,
    name: `Fake ${i}`,
    provider: 'claude-code',
    blockId: blocks[Math.floor(i / DESKS_PER_BLOCK)].id,
    desk: i % DESKS_PER_BLOCK,
    status: i % 3 === 2 ? { kind: 'idle' } : { kind: 'working', task: 'fake task', startedAt: Date.now() },
    activity: 'typing',
    model: 'fake' as ModelId,
    permissions: { mode: company.settings.defaultPermissions, alwaysAllow: [] },
    subagents: [],
    hiredAt: Date.now(),
  }));
  set({ company: { ...company, blocks, employees } });
}

// Test-only: real frame times over `ms` of requestAnimationFrame, plus the renderer's draw-call counters.
function measureFrames(ms: number) {
  const root = _roots.values().next().value;
  if (!root) throw new Error('no canvas');
  const info = root.store.getState().gl.info;
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let drawCalls = 0;
    let triangles = 0;
    let last = 0;
    let start = 0;
    const tick = (t: number) => {
      if (!start) start = t;
      if (last) deltas.push(t - last);
      last = t;
      drawCalls = Math.max(drawCalls, info.render.calls);
      triangles = Math.max(triangles, info.render.triangles);
      if (t - start < ms) requestAnimationFrame(tick);
      else resolve({ deltas, drawCalls, triangles });
    };
    requestAnimationFrame(tick);
  });
}

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
    injectFake,
    // Test-only: the chat with a whole conversation in it. Main never hears about these people.
    loadMailFixture() {
      const company = get().company;
      if (!company) throw new Error('no company yet');
      return loadMailFixture(company);
    },
    renders,
    // Test-only: hand every message the UI would send to `fn` instead of main.
    tapSend(fn: (m: unknown) => void) {
      sendTap.fn = fn;
    },
    measureFrames,
    setCamera: () => setSetting('camera', 'iso'),
    apply: applyServerMessage,
    store: useStore,
    set,
  };
}
