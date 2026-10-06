import { Html } from '@react-three/drei';
import { useEffect, useMemo } from 'react';
import { MeshStandardMaterial, Object3D, type BufferGeometry } from 'three';
import { box, cyl, merge } from './building/models.ts';
import { detail } from './shading.ts';
import type { Company } from '../../../shared/protocol.ts';
import { BLOCK_D, BLOCK_W, blockCenter, DOOR_X } from '../../../shared/space/index.ts';
import { enterComputer } from '../computer.ts';
import { toggleMeetingDoor } from '../meeting.ts';
import { set, useStore } from '../store.ts';
import { ownerSeat, worldFor, type World } from '../world.ts';
import { LobbyDecor } from './Decor.tsx';
import { Environment } from './Environment.tsx';
import { Exterior } from './Exterior.tsx';
import { LightPools, usePools } from './Lighting.tsx';
import { Chair, Desk, RoundedPlane } from './Furniture.tsx';
import { fitText, FONT_BODY, FONT_DISPLAY, roundRect, useCanvasTexture } from './textures.ts';

type Bounds = { x0: number; x1: number; z0: number; z1: number };

const siteMaterial = detail(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 'furniture');

// The empty slot is a construction site: staked bare earth, hazard tape on posts, cones, a scaffold frame and a board
// that says what the site is for. Everything solid is one merged mesh; clicking any of it opens the add-a-project dialog.
function siteGeometry(w: number, d: number) {
  const hx = w / 2;
  const hz = d / 2;
  const parts: BufferGeometry[] = [];
  const yellow = '#f2c230';
  const black = '#22232a';
  const post = (x: number, z: number) => parts.push(box(0.09, 0.9, 0.09, x, 0.45, z, '#8c6a4a'), box(0.12, 0.05, 0.12, x, 0.92, z, yellow));
  const tape = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.round(len / 0.35);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const along = x1 !== x0;
      const seg = len / n;
      parts.push(box(along ? seg : 0.012, 0.09, along ? 0.012 : seg, x0 + (x1 - x0) * t, 0.62, z0 + (z1 - z0) * t, i % 2 ? black : yellow));
    }
  };
  const corners: [number, number][] = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  corners.forEach(([x, z]) => post(x, z));
  for (let i = 1; i < 4; i++) {
    const n = Math.round((i === 1 || i === 3 ? d : w) / 3.2);
    for (let k = 1; k < n; k++) {
      const [ax, az] = corners[i - 1];
      const [bx, bz] = corners[i];
      post(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
    }
  }
  tape(-hx, -hz, hx, -hz);
  tape(hx, -hz, hx, hz);
  tape(hx, hz, -hx, hz);
  tape(-hx, hz, -hx, -hz);
  const cone = (x: number, z: number) => parts.push(cyl(0.03, 0.2, 0.55, x, 0.275, z, '#f26a1b', 10), cyl(0.1, 0.12, 0.08, x, 0.3, z, '#f6f3ea', 10), box(0.5, 0.04, 0.5, x, 0.02, z, '#2b2e38'));
  [[-hx + 1.2, hz + 0.7], [-hx + 4.2, hz + 0.7], [hx - 1.2, hz + 0.7], [hx + 0.7, -hz + 1.5]].forEach(([x, z]) => cone(x, z));
  // A scaffold frame: four poles, ledgers and a plank deck, with a pile of boards and a barrel beside it.
  const sx = hx - 2.6;
  const sz = -hz + 2.2;
  for (const ox of [-1.1, 1.1]) for (const oz of [-0.6, 0.6]) parts.push(cyl(0.04, 0.04, 2.4, sx + ox, 1.2, sz + oz, '#9aa3ad', 6));
  for (const y of [0.8, 1.6, 2.4]) parts.push(box(2.3, 0.05, 0.05, sx, y, sz - 0.6, '#9aa3ad'), box(2.3, 0.05, 0.05, sx, y, sz + 0.6, '#9aa3ad'));
  parts.push(box(2.4, 0.06, 1.3, sx, 1.62, sz, '#c59e73'), box(0.05, 1.7, 0.05, sx + 1.1, 1.0, sz - 0.6, '#9aa3ad'));
  for (let i = 0; i < 4; i++) parts.push(box(1.8, 0.07, 0.2, -hx + 2.2, 0.04 + i * 0.075, -hz + 1.2 + (i % 2) * 0.05, '#d1b080'));
  parts.push(cyl(0.3, 0.3, 0.75, -hx + 4.1, 0.38, -hz + 1.2, '#3b6f9a', 12), cyl(0.31, 0.31, 0.05, -hx + 4.1, 0.55, -hz + 1.2, '#2b4a66', 12));
  // Survey stakes with pink flags, scattered inside the line.
  [[-2, 0.4], [1.5, -0.8], [-0.5, 1.6], [3, 1.2]].forEach(([x, z]) => parts.push(box(0.04, 0.5, 0.04, x, 0.25, z, '#c9a77c'), box(0.16, 0.1, 0.01, x + 0.08, 0.45, z, '#f0509a')));
  // The placard: two legs and a board facing the camera side of the slot.
  parts.push(box(0.1, 1.1, 0.1, -0.9, 0.55, hz - 0.1, '#6a4d34'), box(0.1, 1.1, 0.1, 0.9, 0.55, hz - 0.1, '#6a4d34'), box(2.3, 0.9, 0.08, 0, 1.15, hz - 0.1, '#f2c230'));
  return merge(parts);
}

function GhostSlot({ slot }: { slot: number }) {
  const c = blockCenter(slot);
  const w = BLOCK_W - 0.6;
  const d = BLOCK_D - 0.6;
  const geo = useMemo(() => siteGeometry(w, d), [w, d]);
  const dirt = useCanvasTexture(512, 400, (g) => {
    g.fillStyle = '#9a7650';
    g.fillRect(0, 0, 512, 400);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = i % 3 ? 'rgba(70,45,25,0.18)' : 'rgba(200,170,120,0.2)';
      g.fillRect((i * 97) % 512, (i * 61) % 400, 3 + (i % 5), 2 + (i % 4));
    }
    g.strokeStyle = 'rgba(60,40,25,0.35)';
    g.lineWidth = 14;
    for (const y of [150, 210]) { g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(150, y - 30, 330, y + 40, 512, y); g.stroke(); }
  }, []);
  const board = useCanvasTexture(512, 200, (g) => {
    g.fillStyle = '#f2c230';
    g.fillRect(0, 0, 512, 200);
    g.fillStyle = '#22232a';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 82px ${FONT_DISPLAY}`;
    g.fillText('EXPAND', 256, 72);
    g.font = `600 38px ${FONT_BODY}`;
    g.fillText('Click to add a project', 256, 150);
  }, []);
  return (
    <group
      position={[c.x, 0, c.z]}
      onClick={(e) => {
        e.stopPropagation();
        if (e.delta < 6) set({ modal: { kind: 'block' } });
      }}
      onPointerOver={() => void (document.body.style.cursor = 'pointer')}
      onPointerOut={() => void (document.body.style.cursor = '')}
    >
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial map={dirt} roughness={1} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
      <mesh geometry={geo} material={siteMaterial} castShadow receiveShadow />
      <mesh position={[0, 1.15, d / 2 - 0.05]}>
        <planeGeometry args={[2.2, 0.86]} />
        <meshBasicMaterial map={board} />
      </mesh>
    </group>
  );
}

// A zone label lies on the floor at the zone's edge, like the EXPAND decal, so it names the place without hiding what stands in it.
function FacilitySign({ text, sub = '', color = '#344256', width = 4.4, z = 0 }: { text: string; sub?: string; color?: string; width?: number; z?: number }) {
  const tex = useCanvasTexture(900, 220, (g) => {
    g.fillStyle = color; roundRect(g, 0, 0, 900, 220, 28); g.fill();
    g.fillStyle = '#fffdf7'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `800 ${text.length > 12 ? 54 : 66}px ${FONT_DISPLAY}`; g.fillText(text, 450, sub ? 82 : 110);
    if (sub) { g.font = `500 28px ${FONT_BODY}`; g.fillStyle = 'rgba(255,255,255,0.68)'; g.fillText(sub, 450, 156); }
  }, [text, sub, color]);
  const w = width * 0.8;
  return <mesh rotation-x={-Math.PI / 2} position={[0, 0.04, z]}><planeGeometry args={[w, w * 0.244]} /><meshBasicMaterial map={tex} transparent opacity={0.92} /></mesh>;
}

function SharedMeetingRoom({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <RoundedPlane w={8.2} d={3.2} r={0.35} color="#cbd7e0" y={0.018} />
    <RoundedPlane w={7.7} d={2.7} r={0.25} color="#edf0f1" y={0.025} />
    <mesh position={[0, 1.55, -1.36]}><boxGeometry args={[5.8, 1.55, 0.08]} /><meshStandardMaterial color="#aeb9c2" roughness={0.8} /></mesh>
    <FacilitySign text="MEETING ROOM" sub="shared space" width={5.1} z={1.15} />
  </group>;
}

function Reception({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <RoundedPlane w={6.3} d={1.8} r={0.3} color="#e7ddd0" y={0.018} />
    <mesh castShadow position={[0, 0.62, 0]}><boxGeometry args={[4.2, 1.05, 0.6]} /><meshStandardMaterial color="#b8865e" roughness={0.8} /></mesh>
    <FacilitySign text="RECEPTION" sub="welcome" color="#52687a" width={4.2} z={0.62} />
  </group>;
}

function Kitchen({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <RoundedPlane w={6.2} d={2.1} r={0.3} color="#e5ded3" y={0.018} />
    <mesh castShadow position={[0, 0.64, 0]}><boxGeometry args={[4.5, 1.05, 0.65]} /><meshStandardMaterial color="#b6a487" roughness={0.82} /></mesh>
    {[-1.4, 0, 1.4].map((x0) => <Chair key={x0} position={[x0, 0, 0.75]} color="#78909d" />)}
    <FacilitySign text="KITCHEN" sub="coffee + snacks" color="#7d8d78" width={3.8} z={-0.78} />
  </group>;
}

function Lounge({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}>
    <RoundedPlane w={6.2} d={2.5} r={0.35} color="#dce2de" y={0.018} />
    <mesh castShadow position={[-1.5, 0.52, 0]}><boxGeometry args={[2.5, 0.68, 0.85]} /><meshStandardMaterial color="#7c9c92" roughness={0.9} /></mesh>
    <mesh castShadow position={[1.25, 0.32, 0]}><cylinderGeometry args={[0.6, 0.6, 0.08, 16]} /><meshStandardMaterial color="#c59e73" roughness={0.8} /></mesh>
    <FacilitySign text="LOUNGE" sub="breakout" color="#6b8d86" width={3.5} z={0.95} />
  </group>;
}

function BossBadge({ world }: { world: World }) {
  const r = world.ownerRoom?.bbox;
  if (!r) return null;
  return <group position={[r.x0 + r.w / 2, 0, r.z0 + r.h + 0.12]}>
    <RoundedPlane w={r.w - 0.5} d={r.h - 0.5} r={0.35} color="#d9d5cc" y={0.02} opacity={0.22} />
    <FacilitySign text="BOSS" sub="leadership suite" color="#4f5e75" width={3.6} z={0.5} />
  </group>;
}

function SharedFacilities({ b, world }: { b: Bounds; world: World }) {
  const cx = (b.x0 + b.x1) / 2;
  const right = b.x1 - 4;
  return <>
    <SharedMeetingRoom x={cx} z={-0.45} />
    <Reception x={cx} z={b.z1 - 1.25} />
    <Kitchen x={right} z={b.z1 - 4.15} />
    <Lounge x={right} z={b.z1 - 1.75} />
    <BossBadge world={world} />
  </>;
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

function OwnerCorner({ world }: { world: World }) {
  const seated = useStore((s) => s.computerState === 'seated');
  const seat = ownerSeat(world);
  if (!seat) return null;
  const rotationY = seat.yaw - Math.PI;
  return (
    <group position-y={seat.floor * 3.2}>
      <Desk
        position={[seat.desk.x, 0, seat.desk.z]}
        rotationY={rotationY}
        screen={seated ? 'working' : 'idle'}
        color="#5f9fdf"
        owner
        plate="Owner"
        flatPlate
        onScreenClick={enterComputer}
      />
    </group>
  );
}

// The owner room's door: a leaf that is green and see-through when open and red when closed, with its label.
function MeetingRoom({ world }: { world: World }) {
  const state = useStore((s) => s.meetingDoor);
  const room = world.ownerRoom;
  if (!room?.doorAt || !room.doors.length) return null;
  const doorOpen = state === 'open';
  const along = room.doors[0].d === 's' ? 'z' : 'x';
  const span = room.doors.length * 0.9;
  const { doorAt } = room;
  return (
    <group position-y={room.floor * 3.2}>
      <mesh
        position={[doorAt.x, 1.35, doorAt.z]}
        onClick={(e) => {
          e.stopPropagation();
          toggleMeetingDoor(true);
        }}
        onPointerOver={() => void (document.body.style.cursor = 'pointer')}
        onPointerOut={() => void (document.body.style.cursor = '')}
      >
        <boxGeometry args={along === 'z' ? [0.12, 2.5, span * 2] : [span * 2, 2.5, 0.12]} />
        <meshStandardMaterial color={doorOpen ? '#63b996' : '#d95d63'} roughness={0.72} transparent opacity={doorOpen ? 0.42 : 0.92} />
      </mesh>
      <Html position={[doorAt.x - (along === 'z' ? 0.2 : 0), 2.75, doorAt.z]} rotation-y={along === 'z' ? Math.PI / 2 : 0} transform pointerEvents="none">
        <div className={`meeting-door-label ${doorOpen ? 'open' : 'closed'}`}>
          <b>Meeting room</b>
          <span>{doorOpen ? 'OPEN · E to close' : 'CLOSED · E to open'}</span>
        </div>
      </Html>
    </group>
  );
}

function Lights({ b, slots }: { b: Bounds; slots: readonly number[] }) {
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const ext = Math.max(b.x1 - b.x0, b.z1 - b.z0) * 0.66;
  const target = useMemo(() => new Object3D(), []);
  useEffect(() => {
    target.position.set(cx, 0, cz);
    target.updateMatrixWorld();
  }, [target, cx, cz]);
  const pools = usePools(b, slots);
  return (
    <>
      <hemisphereLight args={['#cfdcff', '#c79f78', 0.95]} />
      <directionalLight
        target={target}
        castShadow
        color="#ffd7a1"
        intensity={2.7}
        position={[cx + 34, 17, cz + 9]}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-radius={3}
        shadow-camera-left={-ext}
        shadow-camera-right={ext}
        shadow-camera-top={ext}
        shadow-camera-bottom={-ext}
        shadow-camera-near={1}
        shadow-camera-far={90}
      />
      <pointLight position={[cx, 2.6, b.z1 - 3.5]} color="#ffb870" intensity={14} distance={16} decay={1.6} />
      <pointLight position={[b.x1 - 4, 2.4, b.z1 - 3]} color="#ff9f5a" intensity={9} distance={11} decay={1.6} />
      <pointLight position={[-14.5, 2.4, 5]} color="#ffb070" intensity={8} distance={10} decay={1.6} />
      <LightPools pools={pools} />
      <primitive object={target} />
    </>
  );
}

export function Office({ company }: { company: Company | null }) {
  const building = useStore((s) => s.building);
  const door = useStore((s) => s.meetingDoor);
  const world = worldFor(building, door);
  const ghostSlot = useMemo(() => {
    const maxSlot = (company?.blocks ?? []).reduce((m, bl) => Math.max(m, bl.slot), -1);
    return maxSlot + 1 < 6 ? maxSlot + 1 : null;
  }, [company?.blocks]);
  if (!world) return null;
  const { lot } = world.building;
  const b: Bounds = { x0: lot.x0, x1: lot.x0 + lot.w, z0: lot.z0, z1: lot.z0 + lot.h };
  return (
    <>
      <Lights b={b} slots={(company?.blocks ?? []).map((bl) => bl.slot)} />
      <Environment b={b} />
      <Exterior b={b} />
      <CompanySign name={company?.name ?? 'Online Office'} b={b} />
      <SharedFacilities b={b} world={world} />
      <LobbyDecor cx={(b.x0 + b.x1) / 2} z1={b.z1} right={b.x1 - 4} doorX={DOOR_X} />
      <MeetingRoom world={world} />
      <OwnerCorner world={world} />
      <group position={[DOOR_X, 0, b.z1 - 1.1]}>
        <RoundedPlane w={2.6} d={1.5} r={0.3} color="#6f9a90" y={0.01} />
      </group>
      {ghostSlot !== null && <GhostSlot slot={ghostSlot} />}
    </>
  );
}
