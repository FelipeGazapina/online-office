import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Group, Vector3 } from 'three';
import { crowd, type CrowdEntry, type Look } from './people/crowd.ts';

export type { Look };
export type Pose = { pos: Vector3; yaw: number; speed: number; seated: boolean };

// The model stands 1.7 m; a touch over so a person reads next to a desk and a nameplate.
const PERSON_SCALE = 1.1;
const HIP = 0.86;
// Where the hips sit in world metres while seated, which is the height of the chair seat.
const SEAT_HIP = 0.47;
const sm = (x: number) => x * x * (3 - 2 * x);

// One person. Both the owner and every employee are posed with this; the sim owns where they are.
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
  const kneeL = useRef<Group>(null);
  const kneeR = useRef<Group>(null);
  const armL = useRef<Group>(null);
  const armR = useRef<Group>(null);
  const elbowL = useRef<Group>(null);
  const elbowR = useRef<Group>(null);
  const typingRef = useRef(typing);
  typingRef.current = typing;
  const readRef = useRef(read);
  readRef.current = read;
  const anim = useRef({ phase: Math.random() * 6, seat: 0, walk: 0, type: 0, talk: Math.random() * 40 });

  const update = (t: number, dt: number) => {
    const p = readRef.current();
    const g = root.current;
    if (!p || !g) return;
    const a = anim.current;
    const k = 1 - Math.exp(-dt * 10);
    a.seat += ((p.seated ? 1 : 0) - a.seat) * k;
    a.walk += (Math.min(1, p.speed / 1.3) - a.walk) * k;
    a.type += ((typingRef.current && p.seated ? 1 : 0) - a.type) * k;
    a.phase += dt * (5 + p.speed * 2.2);
    const { seat, walk, type } = a;
    const stand = (1 - seat) * (1 - walk);
    const swing = Math.sin(a.phase) * 0.7 * walk * (1 - seat);
    // Short bursts of talking with the hands while standing still: a slow wave that is mostly quiet.
    const talk = sm(Math.min(1, Math.max(0, Math.sin(t * 0.45 + a.talk) * 2.2 - 0.6))) * stand;
    const gesture = Math.sin(t * 3.1 + a.talk);
    const lazy = Math.sin(t * 0.7 + a.talk) * (1 - type);

    g.position.set(p.pos.x, p.pos.y + (SEAT_HIP - HIP * PERSON_SCALE) * seat + Math.abs(Math.sin(a.phase)) * 0.035 * walk, p.pos.z);
    g.rotation.y = p.yaw;

    body.current!.rotation.x = 0.1 * type - 0.1 * seat * (1 - type) + 0.06 * walk + Math.sin(t * 0.9 + a.talk) * 0.012;
    body.current!.rotation.z = Math.sin(a.phase) * 0.04 * walk;
    body.current!.rotation.y = -Math.sin(a.phase) * 0.12 * walk + gesture * 0.05 * talk;
    head.current!.rotation.x = 0.16 * type + Math.sin(t * 1.6) * 0.03 - 0.05 * walk;
    head.current!.rotation.y = lazy * 0.18 * seat + gesture * 0.08 * talk;

    const thigh = swing - 1.5 * seat;
    legL.current!.rotation.x = thigh;
    legR.current!.rotation.x = -swing - 1.5 * seat;
    const flex = (s: number) => 0.12 * walk + Math.max(0, -s) * 0.9 * walk * (1 - seat);
    kneeL.current!.rotation.x = flex(Math.cos(a.phase)) + 1.5 * seat;
    kneeR.current!.rotation.x = flex(-Math.cos(a.phase)) + 1.5 * seat;
    legL.current!.rotation.z = -0.05 * seat;
    legR.current!.rotation.z = 0.05 * seat;

    // Seated and typing: elbows in, forearms out over the keys. Seated and waiting: hands rest in the lap.
    const rest = seat * (1 - type);
    const wig = (f: number, ph: number) => Math.sin(t * f + ph) * 0.07 * type;
    armL.current!.rotation.x = -swing * 1.1 - 0.5 * type - 0.25 * rest + wig(15, 0);
    armR.current!.rotation.x = swing * 1.1 - 0.55 * type - 0.3 * rest + wig(12, 1);
    elbowL.current!.rotation.x = -0.2 - 0.4 * walk - 0.95 * type - 0.75 * rest - 0.2 * Math.abs(swing) + wig(17, 2);
    elbowR.current!.rotation.x = -0.2 - 0.4 * walk - 1.0 * type - 0.8 * rest + 0.2 * Math.abs(swing) + wig(13, 3);
    armL.current!.rotation.z = 0.06 + 0.06 * rest;
    armR.current!.rotation.z = -0.06 - 0.06 * rest;
    // The talking hand lifts, bends at the elbow and waves; the other stays near the hip.
    armR.current!.rotation.x += -0.9 * talk + gesture * 0.2 * talk;
    elbowR.current!.rotation.x += -0.7 * talk - Math.sin(t * 4.4 + a.talk) * 0.25 * talk;
    armR.current!.rotation.z -= 0.25 * talk;
    armL.current!.rotation.x += -0.25 * talk;
    elbowL.current!.rotation.x += -0.5 * talk;
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
      kneeL: kneeL.current!,
      kneeR: kneeR.current!,
      armL: armL.current!,
      armR: armR.current!,
      elbowL: elbowL.current!,
      elbowR: elbowR.current!,
    };
    crowd.add(entry);
    return () => void crowd.delete(entry);
  }, [entry]);

  return (
    <group ref={root} visible={!hidden} scale={PERSON_SCALE}>
      <group ref={body} position={[0, HIP, 0]}>
        <group ref={head} position={[0, 0.52, 0]} />
        <group ref={armL} position={[-0.215, 0.46, 0]}>
          <group ref={elbowL} position={[0, -0.27, 0]} />
        </group>
        <group ref={armR} position={[0.215, 0.46, 0]}>
          <group ref={elbowR} position={[0, -0.27, 0]} />
        </group>
      </group>
      <group ref={legL} position={[-0.09, HIP, 0]}>
        <group ref={kneeL} position={[0, -0.43, 0]} />
      </group>
      <group ref={legR} position={[0.09, HIP, 0]}>
        <group ref={kneeR} position={[0, -0.43, 0]} />
      </group>
      {children}
    </group>
  );
}
