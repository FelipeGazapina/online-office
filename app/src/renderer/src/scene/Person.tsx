import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Group, Vector3 } from 'three';
import { crowd, type CrowdEntry, type Look } from './people/crowd.ts';

export type { Look };
export type Pose = { pos: Vector3; yaw: number; speed: number; seated: boolean };

// One capsule person. Both the owner and every employee are posed with this; the sim owns where they are.
// The group tree below holds only the joints the animation moves and the children that follow the person (labels, rings).
// CrowdMeshes draws every person's body parts together as instanced meshes.
export function Person({
  look,
  read,
  typing = false,
  hidden = false,
  onPick,
  children,
}: {
  look: Look;
  read: () => Pose | null;
  typing?: boolean;
  hidden?: boolean;
  onPick?: (at: { x: number; y: number }) => void;
  children?: ReactNode;
}) {
  const root = useRef<Group>(null);
  const body = useRef<Group>(null);
  const head = useRef<Group>(null);
  const legL = useRef<Group>(null);
  const legR = useRef<Group>(null);
  const armL = useRef<Group>(null);
  const armR = useRef<Group>(null);
  const typingRef = useRef(typing);
  typingRef.current = typing;
  const readRef = useRef(read);
  readRef.current = read;
  const anim = useRef({ phase: Math.random() * 6, seat: 0, walk: 0 });

  const update = (t: number, dt: number) => {
    const p = readRef.current();
    const g = root.current;
    if (!p || !g) return;
    const a = anim.current;
    const k = 1 - Math.exp(-dt * 10);
    a.seat += ((p.seated ? 1 : 0) - a.seat) * k;
    a.walk += (Math.min(1, p.speed / 1.3) - a.walk) * k;
    a.phase += dt * (5 + p.speed * 2.2);

    g.position.set(p.pos.x, p.pos.y + 0.09 * a.seat, p.pos.z);
    g.rotation.y = p.yaw;
    const swing = Math.sin(a.phase) * 0.75 * a.walk * (1 - a.seat);
    body.current!.position.y = Math.abs(Math.sin(a.phase)) * 0.07 * a.walk;
    body.current!.rotation.z = Math.sin(a.phase) * 0.05 * a.walk;
    legL.current!.rotation.x = swing - 1.4 * a.seat;
    legR.current!.rotation.x = -swing - 1.4 * a.seat;
    const typingAmt = typingRef.current ? a.seat : 0;
    armL.current!.rotation.x = -swing * 0.9 - 1.0 * a.seat + Math.sin(t * 15) * 0.07 * typingAmt;
    armR.current!.rotation.x = swing * 0.9 - 1.0 * a.seat + Math.sin(t * 12 + 1) * 0.07 * typingAmt;
    head.current!.rotation.x = Math.sin(t * 1.6) * 0.04 + 0.06 * typingAmt;
  };

  const [entry] = useState<CrowdEntry>(() => ({ joints: null as never, look, hidden, update: () => {}, onPick }));
  entry.look = look;
  entry.hidden = hidden;
  entry.onPick = onPick;
  entry.update = update;
  useEffect(() => {
    entry.joints = {
      root: root.current!,
      body: body.current!,
      head: head.current!,
      legL: legL.current!,
      legR: legR.current!,
      armL: armL.current!,
      armR: armR.current!,
    };
    crowd.add(entry);
    return () => void crowd.delete(entry);
  }, [entry]);

  return (
    <group ref={root} visible={!hidden}>
      <group ref={body}>
        <group ref={head} position={[0, 1.52, 0]} />
        <group ref={armL} position={[-0.36, 1.1, 0]} />
        <group ref={armR} position={[0.36, 1.1, 0]} />
      </group>
      <group ref={legL} position={[-0.13, 0.3, 0]} />
      <group ref={legR} position={[0.13, 0.3, 0]} />
      {children}
    </group>
  );
}
