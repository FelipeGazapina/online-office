import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { memo, useRef, type RefObject } from 'react';
import { Vector3, type Mesh } from 'three';
import { PROVIDERS, type Employee } from '../../../shared/protocol.ts';
import { fmtWait, useNow } from '../hud/hooks.ts';
import { hash } from '../util.ts';
import { runtime } from '../runtime.ts';
import { get, set, useStore } from '../store.ts';
import { ResizableHud } from '../hud/ResizableHud.tsx';
import { labelLayer } from './labelLayer.ts';
import { useLabelGate } from './labelGate.ts';
import { Person, type Look } from './Person.tsx';

const SKIN = ['#f2c9a0', '#e0a878', '#c68b5f', '#a26b45', '#7a4a2f', '#f5d5b8'];
const HAIR = ['#2b1d16', '#5a3825', '#b5772f', '#d9b45a', '#1a1a1f', '#8a3a2a', '#c9c9d2'];

export function lookFor(e: Employee): Look {
  return {
    body: PROVIDERS[e.provider].color,
    skin: SKIN[hash(e.id, 3) % SKIN.length],
    hair: HAIR[hash(e.id, 4) % HAIR.length],
  };
}

// Whether a tag shows is decided by the line of sight to the person's head, 1.5 m up at the model's 1.2 scale.
const TAG_HEIGHT = 1.5 * 1.2;

export const EmployeeView = memo(function EmployeeView({ employee }: { employee: Employee }) {
  const talking = useStore((s) => s.talkingTo === employee.id);
  const meetingDoor = useStore((s) => s.meetingDoor);
  const selected = useStore((s) => s.selectedId === employee.id);
  // People on a story above the one the owner is on are not drawn, like the story itself.
  const upstairs = useStore((s) => (s.avatarFloors[employee.id] ?? 0) > s.story);
  const ring = useRef<Mesh>(null);
  const gate = useRef<HTMLDivElement>(null);
  const tagAt = useRef(new Vector3());
  useLabelGate(
    gate,
    () => {
      const a = runtime.avatars.get(employee.id);
      return a ? tagAt.current.copy(a.pos).setY(a.pos.y + TAG_HEIGHT) : null;
    },
    () => get().avatarFloors[employee.id] ?? 0,
  );

  useFrame((state) => {
    if (!ring.current) return;
    const pulse = 1 + Math.sin(state.clock.elapsedTime * 5) * 0.06;
    ring.current.scale.setScalar(talking ? pulse : 1);
  });

  return (
    <Person
      look={lookFor(employee)}
      hidden={upstairs}
      read={() => runtime.avatars.get(employee.id) ?? null}
      typing={employee.status.kind === 'working'}
      onPick={({ x, y }) => set({ menu: { employeeId: employee.id, x, y } })}
    >
      {(talking || selected) && (
        <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.62, 0.74, 40]} />
          <meshBasicMaterial color={talking ? '#8ff0b8' : '#ffffff'} transparent opacity={talking ? 0.95 : 0.6} />
        </mesh>
      )}
      <Html position={[0, 1.85, 0]} portal={labelLayer} pointerEvents="auto" zIndexRange={[20, 0]}>
        <ResizableHud itemKey={`employee-label-${employee.id}`}><Label employee={employee} meetingDoor={meetingDoor} gate={gate} /></ResizableHud>
      </Html>
    </Person>
  );
});

function Label({ employee: e, meetingDoor, gate }: { employee: Employee; meetingDoor: 'open' | 'closed'; gate: RefObject<HTMLDivElement | null> }) {
  const now = useNow(1000);
  const bubble = useStore((s) => s.bubbles[e.id]);
  const p = PROVIDERS[e.provider];
  const said = bubble && bubble.until > now ? bubble.text : null;
  const s = e.status;

  let bubbleEl;
  if (said) {
    bubbleEl = <div className="bub said">{said}</div>;
  } else if (s.kind === 'blocked_on_owner' && meetingDoor === 'open') {
    bubbleEl = (
      <div className="bub ask">
        <span className="q">?</span>
        <span className="wait">{fmtWait(now - s.question.askedAt)}</span>
      </div>
    );
  } else if (s.kind === 'working') {
    bubbleEl = (
      <div className="bub work">
        <span className="progress-ring" aria-label="Working" />
        <span className="act">{e.activity}</span>
      </div>
    );
  } else if (s.kind === 'error') {
    bubbleEl = <div className="bub err">! {s.message}</div>;
  } else if (e.completedAt) {
    bubbleEl = <div className="bub done" title="Task complete"><span className="done-circle">✓</span></div>;
  } else {
    bubbleEl = <div className="bub idle">{hash(e.id) % 2 ? '☕' : 'zzz'}</div>;
  }

  return (
    <div className="emp-label" ref={gate} data-hud-resize-target={`employee-label-${e.id}`}>
      {bubbleEl}
      <button className="tag" onClick={(ev) => set({ menu: { employeeId: e.id, x: ev.clientX, y: ev.clientY } })}>
        <i className="pdot" style={{ background: p.color }} />
        <b>{e.name}</b>
        <span className="prov">{p.label}</span>
      </button>
    </div>
  );
}
