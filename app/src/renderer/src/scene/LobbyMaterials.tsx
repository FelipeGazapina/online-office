import { useMemo } from 'react';
import { MeshStandardMaterial, RepeatWrapping } from 'three';
import { LOBBY_Z0 } from '../../../shared/space/kit.ts';
import type { Bounds } from './Environment.tsx';
import { reflective } from './Lighting.tsx';
import { useCanvasTexture } from './textures.ts';

// Surfaces that give the lobby its material contrast: a brick feature wall at the end of the hall, a dark polished terrazzo
// under the reception counter and a patterned rug under the lounge. Each is one textured plane, so three draws in all.

const rand = (i: number) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Running-bond brick: 1024 x 512 covers 3.4 x 1.7 m. Mortar is light, brick tones run from oxblood to ochre. */
function drawBrick(g: CanvasRenderingContext2D) {
  g.fillStyle = '#cfc4b2';
  g.fillRect(0, 0, 1024, 512);
  const bw = 64;
  const bh = 20;
  const gap = 3;
  const tones = ['#9c4f3a', '#a85a42', '#8e4533', '#b4663f', '#a14c3c', '#7f3f30', '#bd7447'];
  for (let r = 0; r < 26; r++) {
    for (let c = -1; c < 17; c++) {
      const x = c * bw + (r % 2) * (bw / 2);
      const y = r * bh;
      g.fillStyle = tones[Math.floor(rand(r * 31 + c) * tones.length)];
      g.fillRect(x + gap / 2, y + gap / 2, bw - gap, bh - gap);
      g.fillStyle = `rgba(0,0,0,${0.06 + rand(r * 17 + c * 3) * 0.12})`;
      g.fillRect(x + gap / 2, y + bh - gap - 3, bw - gap, 3);
      g.fillStyle = 'rgba(255,230,190,0.12)';
      g.fillRect(x + gap / 2, y + gap / 2, bw - gap, 2);
    }
  }
}

/** Black terrazzo: a dark ground flecked with warm white, grey and ochre chips, framed by a thin brass inlay. */
function drawTerrazzo(g: CanvasRenderingContext2D) {
  g.fillStyle = '#1b1b1f';
  g.fillRect(0, 0, 1024, 512);
  const chips = ['#cfc6b4', '#7d776f', '#a8864f', '#4a4845', '#b9ad98'];
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = chips[Math.floor(rand(i) * chips.length)];
    const s = 2 + rand(i + 9000) * 5;
    g.save();
    g.translate(rand(i + 1) * 1024, rand(i + 2) * 512);
    g.rotate(rand(i + 3) * 6.28);
    g.fillRect(-s / 2, -s / 3, s, s * 0.66);
    g.restore();
  }
  g.strokeStyle = '#c9a25b';
  g.lineWidth = 6;
  g.strokeRect(22, 22, 1024 - 44, 512 - 44);
}

/** A flat-weave rug: an ochre field, a teal and rust diamond lattice and a stepped border. */
function drawRug(g: CanvasRenderingContext2D) {
  g.fillStyle = '#e4d3b2';
  g.fillRect(0, 0, 1024, 640);
  g.fillStyle = '#7d2f2b';
  g.fillRect(28, 28, 968, 584);
  g.fillStyle = '#e4d3b2';
  g.fillRect(44, 44, 936, 552);
  g.fillStyle = '#c9822f';
  g.fillRect(70, 70, 884, 500);
  const step = 110;
  for (let ix = 0; ix < 9; ix++) {
    for (let iy = 0; iy < 5; iy++) {
      const cx = 125 + ix * step;
      const cy = 125 + iy * step;
      const diamond = (r: number, color: string) => {
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(cx, cy - r);
        g.lineTo(cx + r, cy);
        g.lineTo(cx, cy + r);
        g.lineTo(cx - r, cy);
        g.closePath();
        g.fill();
      };
      diamond(52, (ix + iy) % 2 ? '#1f5f66' : '#7d2f2b');
      diamond(32, '#e4d3b2');
      diamond(14, (ix + iy) % 2 ? '#7d2f2b' : '#1f5f66');
    }
  }
}

const dim = (w: number, h: number) => ({ w, h });

export function BrickWall({ b }: { b: Bounds }) {
  const z0 = LOBBY_Z0 + 0.2;
  const z1 = b.z1 - 0.2;
  const len = z1 - z0;
  const tex = useCanvasTexture(1024, 512, drawBrick, []);
  const material = useMemo(() => {
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.repeat.set(len / 3.4, 2.7 / 1.7);
    return new MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 2.2, roughness: 0.88 });
  }, [tex, len]);
  return (
    <mesh position={[b.x1 - 0.1, 1.35, (z0 + z1) / 2]} rotation-y={-Math.PI / 2} material={material} receiveShadow>
      <planeGeometry args={[len, 2.7]} />
    </mesh>
  );
}

export function Terrazzo({ x, z, w, d }: { x: number; z: number; w: number; d: number }) {
  const tex = useCanvasTexture(1024, 512, drawTerrazzo, []);
  const material = useMemo(() => {
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.repeat.set(w / 2.8, d / 1.5);
    const m = new MeshStandardMaterial({ map: tex, roughness: 0.28, polygonOffset: true, polygonOffsetFactor: -2 });
    reflective.set(m, 1.4);
    return m;
  }, [tex, w, d]);
  return (
    <mesh position={[x, 0.02, z]} rotation-x={-Math.PI / 2} material={material} receiveShadow>
      <planeGeometry args={[w, d]} />
    </mesh>
  );
}

export function PatternRug({ x, z, w, d }: { x: number; z: number; w: number; d: number }) {
  const tex = useCanvasTexture(1024, 640, drawRug, []);
  const size = dim(w, d);
  return (
    <mesh position={[x, 0.03, z]} rotation-x={-Math.PI / 2} receiveShadow renderOrder={2}>
      <planeGeometry args={[size.w, size.h]} />
      <meshStandardMaterial map={tex} roughness={0.95} polygonOffset polygonOffsetFactor={-3} />
    </mesh>
  );
}
