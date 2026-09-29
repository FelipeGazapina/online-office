import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Object3D, type Group } from 'three';
import type { Company } from '../../../shared/protocol.ts';
import {
  BLOCK_D,
  BLOCK_W,
  blockCenter,
  DOOR,
  getLayout,
  OWNER_DESK,
  MEETING_ROOM,
  WALL_H,
  type Bounds,
  type Layout,
} from '../layout.ts';
import { get, set, useStore } from '../store.ts';
import { toggleMeetingDoor } from '../meeting.ts';
import { walkTo } from '../sim.ts';
import { Chair, Desk, Plant, RoundedPlane } from './Furniture.tsx';
import { fitText, FONT_BODY, FONT_DISPLAY, plankTexture, roundRect, useCanvasTexture } from './textures.ts';

const T = 0.3;

// In the overview the near walls would hide the room, so any wall the camera stands outside of drops to a curb.
function Wall({
  center,
  size,
  normal,
  children,
  lintel = false,
}: {
  center: [number, number];
  size: [number, number];
  normal: [number, number];
  children?: ReactNode;
  lintel?: boolean;
}) {
  const g = useRef<Group>(null);
  useFrame((state, dt) => {
    const cam = state.camera.position;
    const outside = (cam.x - center[0]) * normal[0] + (cam.z - center[1]) * normal[1] > 0.5;
    // A lintel floats above the doorway, so it vanishes instead of shrinking to a curb.
    const target = outside ? (lintel ? 0.001 : 0.12) : 1;
    g.current!.scale.y += (target - g.current!.scale.y) * (1 - Math.exp(-dt * 9));
  });
  const h = lintel ? 0.7 : WALL_H;
  return (
    <group ref={g} position={[center[0], 0, center[1]]}>
      <mesh receiveShadow position={[0, WALL_H - h / 2, 0]}>
        <boxGeometry args={[size[0], h, size[1]]} />
        <meshStandardMaterial color="#f0e6d8" roughness={0.95} />
      </mesh>
      {!lintel && (
        <mesh receiveShadow position={[0, 0.55, 0]}>
          <boxGeometry args={[size[0] + 0.02, 1.1, size[1] + 0.02]} />
          <meshStandardMaterial color="#7fa69b" roughness={0.9} />
        </mesh>
      )}
      <mesh position={[0, WALL_H + 0.04, 0]}>
        <boxGeometry args={[size[0] + 0.04, 0.08, size[1] + 0.06]} />
        <meshStandardMaterial color="#fbf7ef" roughness={0.8} />
      </mesh>
      {children}
    </group>
  );
}

function Window({ position, rotationY = 0, w = 2.4 }: { position: [number, number, number]; rotationY?: number; w?: number }) {
  return (
    <group position={position} rotation-y={rotationY}>
      <mesh>
        <boxGeometry args={[w + 0.2, 1.5, 0.06]} />
        <meshStandardMaterial color="#fbf7ef" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0, 0.032]}>
        <planeGeometry args={[w, 1.3]} />
        <meshStandardMaterial color="#cfe8ff" emissive="#a8d4ff" emissiveIntensity={0.9} roughness={0.2} />
      </mesh>
      <mesh position={[0, 0, 0.04]}>
        <boxGeometry args={[0.05, 1.3, 0.02]} />
        <meshStandardMaterial color="#fbf7ef" />
      </mesh>
      <mesh position={[0, 0, 0.04]}>
        <boxGeometry args={[w, 0.05, 0.02]} />
        <meshStandardMaterial color="#fbf7ef" />
      </mesh>
    </group>
  );
}

function Walls({ b }: { b: Bounds }) {
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const doorHalf = 1.3;
  const northWindows = Array.from({ length: Math.floor(w / 6) }, (_, i) => b.x0 + 3.5 + i * 6);
  const westWindows = [b.z0 + 4.5, b.z0 + 14].filter((z) => z < -1.5 && z > b.z0 + 2);
  return (
    <>
      <Wall center={[cx, b.z0 - T / 2]} size={[w + T * 2, T]} normal={[0, -1]}>
        {northWindows.map((x) => (
          <Window key={x} position={[x - cx, 1.95, T / 2 + 0.03]} />
        ))}
      </Wall>
      <Wall center={[b.x0 - T / 2, cz]} size={[T, d]} normal={[-1, 0]}>
        {westWindows.map((z) => (
          <Window key={z} position={[T / 2 + 0.03, 1.95, z - cz]} rotationY={Math.PI / 2} />
        ))}
      </Wall>
      <Wall center={[b.x1 + T / 2, cz]} size={[T, d]} normal={[1, 0]} />
      {/* South wall with a doorway */}
      <Wall center={[(b.x0 + DOOR.x - doorHalf) / 2 - T / 2, b.z1 + T / 2]} size={[DOOR.x - doorHalf - b.x0 + T, T]} normal={[0, 1]} />
      <Wall center={[(b.x1 + DOOR.x + doorHalf) / 2 + T / 2, b.z1 + T / 2]} size={[b.x1 - DOOR.x - doorHalf + T, T]} normal={[0, 1]} />
      <Wall center={[DOOR.x, b.z1 + T / 2]} size={[doorHalf * 2, T]} normal={[0, 1]} lintel />
      <mesh position={[DOOR.x, 1.5, b.z1 + 2.2]} rotation-y={Math.PI}>
        <planeGeometry args={[4.4, 3.2]} />
        <meshBasicMaterial color="#d6e8fa" />
      </mesh>
    </>
  );
}

function Floor({ b }: { b: Bounds }) {
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const tex = useMemo(() => {
    const t = plankTexture().clone();
    t.needsUpdate = true;
    t.repeat.set(w / 4, d / 4);
    return t;
  }, [w, d]);
  return (
    <group position={[(b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2]}>
      <mesh position={[0, -0.32, 0]} receiveShadow>
        <boxGeometry args={[w + T * 2, 0.6, d + T * 2]} />
        <meshStandardMaterial color="#6d4c37" roughness={1} />
      </mesh>
      <mesh
        rotation-x={-Math.PI / 2}
        receiveShadow
        onClick={(e) => {
          if (e.delta < 6 && get().camera === 'iso') walkTo({ kind: 'point', at: { x: e.point.x, z: e.point.z } });
        }}
      >
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial map={tex} roughness={0.85} />
      </mesh>
    </group>
  );
}

function GhostSlot({ slot }: { slot: number }) {
  const c = blockCenter(slot);
  const tex = useCanvasTexture(512, 320, (g) => {
    g.setLineDash([26, 18]);
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(70,50,35,0.45)';
    roundRect(g, 10, 10, 492, 300, 44);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = 'rgba(70,50,35,0.55)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 48px ${FONT_DISPLAY}`;
    g.fillText('Free block slot', 256, 140);
    g.font = `500 30px ${FONT_BODY}`;
    g.fillText('Click to add a project block', 256, 196);
  }, []);
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[c.x, 0.012, c.z]}
      onClick={(e) => {
        e.stopPropagation();
        if (e.delta < 6) set({ modal: { kind: 'block' } });
      }}
      onPointerOver={() => void (document.body.style.cursor = 'pointer')}
      onPointerOut={() => void (document.body.style.cursor = '')}
    >
      <planeGeometry args={[BLOCK_W - 0.6, BLOCK_D - 0.6]} />
      <meshBasicMaterial map={tex} transparent depthWrite={false} />
    </mesh>
  );
}

function CompanySign({ name, b }: { name: string; b: Bounds }) {
  const tex = useCanvasTexture(1024, 256, (g) => {
    g.fillStyle = '#fbf7ef';
    g.textBaseline = 'middle';
    const s = fitText(g, name, 900, 150, 800);
    g.fillText(name, 60, 110);
    g.font = `500 ${Math.min(44, s * 0.4)}px ${FONT_BODY}`;
    g.fillStyle = 'rgba(251,247,239,0.7)';
    g.fillText('An office where the agents wait for you', 64, 208);
  }, [name]);
  return (
    <mesh position={[b.x0 + 0.02, 2.05, 3]} rotation-y={Math.PI / 2}>
      <planeGeometry args={[4.4, 1.1]} />
      <meshBasicMaterial map={tex} transparent />
    </mesh>
  );
}

function OwnerCorner() {
  const tex = useCanvasTexture(256, 96, (g) => {
    g.fillStyle = '#2f3a5f';
    roundRect(g, 0, 0, 256, 96, 16);
    g.fill();
    g.fillStyle = '#f2b84b';
    g.font = `700 52px ${FONT_DISPLAY}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('Owner', 128, 52);
  }, []);
  return (
    <group>
      <Desk position={[OWNER_DESK.x, 0, OWNER_DESK.z]} rotationY={Math.PI / 2} screen="idle" />
      <Chair position={[OWNER_DESK.x + 0.9, 0, OWNER_DESK.z]} rotationY={Math.PI / 2} color="#2f3a5f" />
      <group
        position={[OWNER_DESK.x + 0.15, 0.82, OWNER_DESK.z - 0.18]}
        onClick={(e) => {
          e.stopPropagation();
          if (e.delta < 6) set({ computerMenu: true });
        }}
        onPointerOver={() => void (document.body.style.cursor = 'pointer')}
        onPointerOut={() => void (document.body.style.cursor = '')}
      >
        <mesh castShadow>
          <boxGeometry args={[0.9, 0.52, 0.06]} />
          <meshStandardMaterial color="#161b2a" roughness={0.45} />
        </mesh>
        <mesh position={[0, -0.01, 0.035]}>
          <planeGeometry args={[0.78, 0.4]} />
          <meshBasicMaterial color="#3c72a8" />
        </mesh>
        <mesh position={[0, -0.36, 0.1]}>
          <boxGeometry args={[0.62, 0.03, 0.28]} />
          <meshStandardMaterial color="#d8d1c3" roughness={0.8} />
        </mesh>
      </group>
      <mesh position={[OWNER_DESK.x - 0.1, 0.83, OWNER_DESK.z + 0.55]} rotation={[-0.5, Math.PI / 2, 0]}>
        <planeGeometry args={[0.36, 0.14]} />
        <meshBasicMaterial map={tex} transparent />
      </mesh>
    </group>
  );
}

function MeetingRoom() {
  const state = useStore((s) => s.meetingDoor);
  const r = MEETING_ROOM;
  const wall = '#d8c4aa';
  const doorOpen = state === 'open';
  const doorX = r.x1 + 0.02;
  return (
    <group>
      <mesh position={[(r.x0 + r.x1) / 2, 1.35, r.z0]}>
        <boxGeometry args={[r.x1 - r.x0, 2.7, 0.22]} />
        <meshStandardMaterial color={wall} roughness={0.95} />
      </mesh>
      <mesh position={[(r.x0 + r.x1) / 2, 1.35, r.z1]}>
        <boxGeometry args={[r.x1 - r.x0, 2.7, 0.22]} />
        <meshStandardMaterial color={wall} roughness={0.95} />
      </mesh>
      <mesh position={[r.x1, 1.35, (r.z0 + r.doorZ - r.doorHalf) / 2]}>
        <boxGeometry args={[0.22, 2.7, r.doorZ - r.doorHalf - r.z0]} />
        <meshStandardMaterial color={wall} roughness={0.95} />
      </mesh>
      <mesh position={[r.x1, 1.35, (r.doorZ + r.doorHalf + r.z1) / 2]}>
        <boxGeometry args={[0.22, 2.7, r.z1 - r.doorZ - r.doorHalf]} />
        <meshStandardMaterial color={wall} roughness={0.95} />
      </mesh>
      <mesh
        position={[doorX, 1.35, r.doorZ]}
        onClick={(e) => {
          e.stopPropagation();
          toggleMeetingDoor(true);
        }}
        onPointerOver={() => void (document.body.style.cursor = 'pointer')}
        onPointerOut={() => void (document.body.style.cursor = '')}
      >
        <boxGeometry args={[0.12, 2.5, r.doorHalf * 2]} />
        <meshStandardMaterial color={doorOpen ? '#63b996' : '#d95d63'} roughness={0.72} transparent opacity={doorOpen ? 0.42 : 0.92} />
      </mesh>
      <Html position={[r.x1 - 0.2, 2.75, r.doorZ]} rotation-y={Math.PI / 2} transform pointerEvents="none">
        <div className={`meeting-door-label ${doorOpen ? 'open' : 'closed'}`}>
          <b>Meeting room</b>
          <span>{doorOpen ? 'OPEN · E to close' : 'CLOSED · E to open'}</span>
        </div>
      </Html>
    </group>
  );
}

function Lights({ b }: { b: Bounds }) {
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const ext = Math.max(b.x1 - b.x0, b.z1 - b.z0) * 0.62;
  const target = useMemo(() => new Object3D(), []);
  useEffect(() => {
    target.position.set(cx, 0, cz);
    target.updateMatrixWorld();
  }, [target, cx, cz]);
  return (
    <>
      <hemisphereLight args={['#fff3e2', '#c9a37c', 1.15]} />
      <directionalLight
        target={target}
        castShadow
        color="#fff0d6"
        intensity={2.1}
        position={[cx + 14, 26, cz + 12]}
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.03}
        shadow-camera-left={-ext}
        shadow-camera-right={ext}
        shadow-camera-top={ext}
        shadow-camera-bottom={-ext}
        shadow-camera-near={1}
        shadow-camera-far={80}
      />
      <primitive object={target} />
    </>
  );
}

export function Office({ company }: { company: Company | null }) {
  const layout: Layout = getLayout(company?.blocks ?? []);
  const b = layout.bounds;
  return (
    <>
      <Lights b={b} />
      <Floor b={b} />
      <Walls b={b} />
      <CompanySign name={company?.name ?? 'Online Office'} b={b} />
      <MeetingRoom />
      <OwnerCorner />
      <group position={[DOOR.x, 0, DOOR.z - 1.1]}>
        <RoundedPlane w={2.6} d={1.5} r={0.3} color="#6f9a90" y={0.01} />
      </group>
      {layout.plants.map((p, i) => (
        <Plant key={i} position={[p.x, 0, p.z]} scale={0.9 + (i % 3) * 0.15} />
      ))}
      {layout.ghostSlot !== null && <GhostSlot slot={layout.ghostSlot} />}
    </>
  );
}
