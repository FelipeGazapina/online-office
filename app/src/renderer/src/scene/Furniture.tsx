import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Color, Shape, ShapeGeometry, type MeshStandardMaterial } from 'three';
import type { Employee } from '../../../shared/protocol.ts';
import { codeTexture, FONT_DISPLAY, fitText, ownerComputerTexture, roundRect, useCanvasTexture } from './textures.ts';

export type ScreenKind = Employee['status']['kind'] | 'none';

const WHITE = new Color('#ffffff');

function Screen({ kind, color, owner = false }: { kind: ScreenKind; color: string; owner?: boolean }) {
  const tex = useMemo(() => {
    const t = codeTexture().clone();
    t.needsUpdate = true;
    t.offset.y = Math.random();
    return t;
  }, []);
  const mat = useRef<MeshStandardMaterial>(null);
  const ownerTex = ownerComputerTexture();
  const seed = useMemo(() => Math.random() * 6, []);
  useEffect(() => {
    const m = mat.current;
    if (!m || kind === 'working' || kind === 'blocked_on_owner') return;
    m.emissive.set(kind === 'error' ? '#ff4d4d' : '#6a7898');
    m.emissiveIntensity = kind === 'error' ? 1.4 : kind === 'idle' ? 0.14 : 0;
  }, [kind, color]);
  useFrame((state, dt) => {
    const m = mat.current;
    if (!m) return;
    const t = state.clock.elapsedTime;
    if (kind === 'working') {
      tex.offset.y -= dt * 0.1;
      m.emissive.set(color).lerp(WHITE, 0.3);
      m.emissiveIntensity = 1.7 + Math.sin(t * 3 + seed) * 0.25;
    } else if (kind === 'blocked_on_owner') {
      m.emissive.set('#ffb340');
      m.emissiveIntensity = 1.1 + Math.sin(t * 6) * 0.9;
    }
  });
  return (
    <mesh position={[0, 0, 0.022]}>
      <planeGeometry args={[owner ? 0.78 : 0.64, owner ? 0.44 : 0.36]} />
      <meshStandardMaterial ref={mat} color={owner ? '#ffffff' : '#0d0f14'} map={owner ? ownerTex : undefined} emissiveMap={owner ? ownerTex : tex} emissive="#ffffff" emissiveIntensity={owner ? 0.42 : 0} roughness={0.3} />
    </mesh>
  );
}

// A nameplate on the desktop, turned away from the person at the desk so it reads to whoever looks at the desk.
function Nameplate({ text, flat = false }: { text: string; flat?: boolean }) {
  const tex = useCanvasTexture(256, 96, (g) => {
    g.fillStyle = '#20263a';
    roundRect(g, 0, 0, 256, 96, 16);
    g.fill();
    g.fillStyle = '#f3e7c9';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitText(g, text, 220, 72, 800, FONT_DISPLAY);
    g.fillText(text, 128, 52);
  }, [text]);
  if (flat) {
    return (
      <group position={[0, 0.785, 0.2]}>
        <mesh castShadow>
          <boxGeometry args={[0.44, 0.025, 0.18]} />
          <meshStandardMaterial color="#20263a" roughness={0.52} />
        </mesh>
        <mesh position={[0, 0.014, 0]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[0.4, 0.14]} />
          <meshStandardMaterial map={tex} transparent roughness={0.5} />
        </mesh>
      </group>
    );
  }
  return (
    <group position={[0, 0.755, -0.3]} rotation-y={Math.PI}>
      <mesh castShadow position={[0, 0.07, 0]}>
        <boxGeometry args={[0.4, 0.14, 0.02]} />
        <meshStandardMaterial color="#20263a" roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.07, 0.0105]}>
        <planeGeometry args={[0.4, 0.14]} />
        <meshStandardMaterial map={tex} transparent roughness={0.5} />
      </mesh>
    </group>
  );
}

export function Desk({
  position,
  rotationY = 0,
  screen,
  color = '#6f7cff',
  tall = false,
  plate,
  flatPlate = false,
  owner = false,
  onScreenClick,
}: {
  position: [number, number, number];
  rotationY?: number;
  screen: ScreenKind;
  color?: string;
  tall?: boolean;
  plate?: string;
  flatPlate?: boolean;
  owner?: boolean;
  onScreenClick?: () => void;
}) {
  const topW = owner ? 1.8 : 1.6;
  const topD = owner ? 0.9 : 0.8;
  return (
    <group position={position} rotation-y={rotationY}>
      <mesh castShadow receiveShadow position={[0, 0.72, 0]}>
        <boxGeometry args={[topW, owner ? 0.085 : 0.06, topD]} />
        <meshStandardMaterial color={owner ? '#ead8ba' : '#efe0c6'} roughness={owner ? 0.58 : 0.7} />
      </mesh>
      {owner && (
        <mesh castShadow receiveShadow position={[0, 0.675, 0]}>
          <boxGeometry args={[topW - 0.05, 0.035, topD - 0.05]} />
          <meshStandardMaterial color="#b7834d" roughness={0.5} metalness={0.12} />
        </mesh>
      )}
      {[
        [-(topW / 2 - 0.06), -(topD / 2 - 0.06)],
        [topW / 2 - 0.06, -(topD / 2 - 0.06)],
        [-(topW / 2 - 0.06), topD / 2 - 0.06],
        [topW / 2 - 0.06, topD / 2 - 0.06],
      ].map(([x, z]) => (
        <mesh key={`${x}${z}`} castShadow position={[x, 0.35, z]}>
          <boxGeometry args={[0.06, 0.7, 0.06]} />
          <meshStandardMaterial color={owner ? '#262a38' : '#3a3f4e'} roughness={0.6} />
        </mesh>
      ))}
      <mesh castShadow position={[0, 0.5, -0.36]}>
        <boxGeometry args={[1.4, 0.4, 0.03]} />
        <meshStandardMaterial color={owner ? '#d4b98f' : '#e2d1b3'} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.755, 0.2]}>
        <boxGeometry args={[owner ? 0.58 : 0.5, 0.025, owner ? 0.18 : 0.16]} />
        <meshStandardMaterial color={owner ? '#22283a' : '#2b2e38'} roughness={0.5} />
      </mesh>
      <mesh castShadow position={[owner ? 0.64 : 0.62, 0.8, 0.12]}>
        <cylinderGeometry args={[0.05, 0.045, 0.1, 12]} />
        <meshStandardMaterial color={owner ? '#f7c766' : '#fbf6ec'} roughness={0.5} />
      </mesh>
      <group
        position={[0, tall ? 1.14 : owner ? 1.16 : 1.1, owner ? -0.2 : -0.18]}
        onClick={onScreenClick ? (e) => { e.stopPropagation(); if (e.delta < 6) onScreenClick(); } : undefined}
        onPointerOver={onScreenClick ? () => void (document.body.style.cursor = 'pointer') : undefined}
        onPointerOut={onScreenClick ? () => void (document.body.style.cursor = '') : undefined}
      >
        <mesh castShadow position={[0, -0.24, 0]}>
          <boxGeometry args={[0.06, 0.1, 0.06]} />
          <meshStandardMaterial color={owner ? '#252b3b' : '#2b2e38'} />
        </mesh>
        <mesh castShadow>
          <boxGeometry args={[owner ? 0.88 : 0.72, owner ? 0.52 : 0.44, 0.04]} />
          <meshStandardMaterial color={owner ? '#111a2a' : '#1c1f27'} roughness={0.5} />
        </mesh>
        <Screen kind={screen} color={color} owner={owner} />
        {owner && (
          <mesh castShadow position={[0, -0.29, 0.02]}>
            <boxGeometry args={[0.34, 0.035, 0.24]} />
            <meshStandardMaterial color="#161c2b" roughness={0.45} />
          </mesh>
        )}
      </group>
      {plate && <Nameplate text={plate} flat={flatPlate} />}
    </group>
  );
}

export function Chair({ position, color, rotationY = 0 }: { position: [number, number, number]; color: string; rotationY?: number }) {
  return (
    <group position={position} rotation-y={rotationY}>
      <mesh castShadow position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.26, 0.26, 0.04, 16]} />
        <meshStandardMaterial color="#2b2e38" roughness={0.6} />
      </mesh>
      <mesh castShadow position={[0, 0.2, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 0.32, 8]} />
        <meshStandardMaterial color="#2b2e38" roughness={0.6} />
      </mesh>
      <mesh castShadow receiveShadow position={[0, 0.38, 0]}>
        <boxGeometry args={[0.5, 0.09, 0.5]} />
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
      <mesh castShadow position={[0, 0.72, 0.25]}>
        <boxGeometry args={[0.5, 0.56, 0.07]} />
        <meshStandardMaterial color={color} roughness={0.85} />
      </mesh>
    </group>
  );
}

const LEAVES = ['#5f9f6c', '#78b97a', '#4d8a5d', '#8ccb84'];
export function Plant({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh castShadow receiveShadow position={[0, 0.25, 0]}>
        <cylinderGeometry args={[0.3, 0.22, 0.5, 14]} />
        <meshStandardMaterial color="#f1ebe0" roughness={0.6} />
      </mesh>
      {[
        [0, 0.85, 0, 0.36],
        [0.22, 1.05, 0.1, 0.28],
        [-0.2, 1.1, -0.08, 0.3],
        [0.05, 1.35, -0.05, 0.26],
        [-0.1, 0.75, 0.2, 0.24],
      ].map(([x, y, z, r], i) => (
        <mesh key={i} castShadow position={[x, y, z]}>
          <icosahedronGeometry args={[r, 0]} />
          <meshStandardMaterial color={LEAVES[i % LEAVES.length]} roughness={0.8} flatShading />
        </mesh>
      ))}
    </group>
  );
}

export function RoundedPlane({ w, d, r, color, y, opacity = 1 }: { w: number; d: number; r: number; color: string; y: number; opacity?: number }) {
  const geo = useMemo(() => {
    const s = new Shape();
    const x = -w / 2;
    const z = -d / 2;
    s.moveTo(x + r, z);
    s.lineTo(x + w - r, z);
    s.quadraticCurveTo(x + w, z, x + w, z + r);
    s.lineTo(x + w, z + d - r);
    s.quadraticCurveTo(x + w, z + d, x + w - r, z + d);
    s.lineTo(x + r, z + d);
    s.quadraticCurveTo(x, z + d, x, z + d - r);
    s.lineTo(x, z + r);
    s.quadraticCurveTo(x, z, x + r, z);
    return new ShapeGeometry(s, 6);
  }, [w, d, r]);
  return (
    <mesh geometry={geo} rotation-x={-Math.PI / 2} position={[0, y, 0]} receiveShadow>
      <meshStandardMaterial color={color} roughness={1} transparent={opacity < 1} opacity={opacity} />
    </mesh>
  );
}
