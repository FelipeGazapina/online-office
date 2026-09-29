import { useFrame } from '@react-three/fiber';
import { useRef, type ReactNode, type RefObject } from 'react';
import type { Group, Vector3 } from 'three';

export type Look = { body: string; skin: string; hair: string; trim?: string };
export type Pose = { pos: Vector3; yaw: number; speed: number; seated: boolean };

// One capsule person. Both the owner and every employee are drawn with this; the sim owns where they are.
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
  const anim = useRef({ phase: Math.random() * 6, seat: 0, walk: 0 });

  useFrame((state, dt) => {
    const p = read();
    const g = root.current;
    if (!p || !g) return;
    const a = anim.current;
    const k = 1 - Math.exp(-dt * 10);
    a.seat += ((p.seated ? 1 : 0) - a.seat) * k;
    a.walk += (Math.min(1, p.speed / 1.3) - a.walk) * k;
    a.phase += dt * (5 + p.speed * 2.2);
    const t = state.clock.elapsedTime;

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
  });

  return (
    <group
      ref={root}
      visible={!hidden}
      onClick={
        onPick
          ? (e) => {
              e.stopPropagation();
              if (e.delta < 6) onPick({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
            }
          : undefined
      }
      onPointerOver={onPick ? () => void (document.body.style.cursor = 'pointer') : undefined}
      onPointerOut={onPick ? () => void (document.body.style.cursor = '') : undefined}
    >
      <group ref={body}>
        <mesh castShadow position={[0, 0.78, 0]}>
          <capsuleGeometry args={[0.28, 0.5, 6, 14]} />
          <meshStandardMaterial color={look.body} roughness={0.75} />
        </mesh>
        {look.trim && (
          <mesh position={[0, 1.02, 0.26]}>
            <boxGeometry args={[0.1, 0.34, 0.05]} />
            <meshStandardMaterial color={look.trim} roughness={0.6} />
          </mesh>
        )}
        <group ref={head} position={[0, 1.52, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.22, 20, 16]} />
            <meshStandardMaterial color={look.skin} roughness={0.8} />
          </mesh>
          <mesh position={[0, 0.03, -0.02]} rotation={[-0.25, 0, 0]}>
            <sphereGeometry args={[0.235, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.52]} />
            <meshStandardMaterial color={look.hair} roughness={0.9} />
          </mesh>
          {[-0.085, 0.085].map((x) => (
            <mesh key={x} position={[x, 0.0, 0.2]}>
              <sphereGeometry args={[0.028, 8, 8]} />
              <meshStandardMaterial color="#1d1d26" roughness={0.4} />
            </mesh>
          ))}
        </group>
        {[
          [armL, -1],
          [armR, 1],
        ].map(([ref, side]) => (
          <group key={side as number} ref={ref as RefObject<Group>} position={[(side as number) * 0.36, 1.1, 0]}>
            <mesh castShadow position={[0, -0.2, 0]}>
              <capsuleGeometry args={[0.07, 0.24, 4, 8]} />
              <meshStandardMaterial color={look.body} roughness={0.75} />
            </mesh>
            <mesh position={[0, -0.42, 0]}>
              <sphereGeometry args={[0.075, 8, 8]} />
              <meshStandardMaterial color={look.skin} roughness={0.8} />
            </mesh>
          </group>
        ))}
      </group>
      {[
        [legL, -1],
        [legR, 1],
      ].map(([ref, side]) => (
        <group key={side as number} ref={ref as RefObject<Group>} position={[(side as number) * 0.13, 0.3, 0]}>
          <mesh castShadow position={[0, -0.14, 0]}>
            <capsuleGeometry args={[0.075, 0.16, 4, 8]} />
            <meshStandardMaterial color="#2c2f3d" roughness={0.8} />
          </mesh>
          <mesh position={[0, -0.27, 0.05]}>
            <boxGeometry args={[0.13, 0.06, 0.22]} />
            <meshStandardMaterial color="#20222c" roughness={0.6} />
          </mesh>
        </group>
      ))}
      {onPick && (
        <mesh position={[0, 0.95, 0]}>
          <cylinderGeometry args={[0.5, 0.5, 1.9, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      {children}
    </group>
  );
}
