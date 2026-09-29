import { memo, useMemo } from 'react';
import { Color } from 'three';
import { PROVIDERS, type Employee, type ProjectBlock } from '../../../shared/protocol.ts';
import { BLOCK_D, BLOCK_W, blockCenter, deskPose, signPose, whiteboardPose } from '../layout.ts';
import { set } from '../store.ts';
import { Chair, Desk, RoundedPlane } from './Furniture.tsx';
import { fitText, FONT_BODY, FONT_DISPLAY, roundRect, useCanvasTexture } from './textures.ts';
import { useDiagram } from './whiteboard.ts';

const FLOOR = new Color('#d9b48a');

function shade(hex: string, amount: number) {
  return `#${new Color(hex).multiplyScalar(amount).getHexString()}`;
}

function Sign({ name, cwd, color }: { name: string; cwd: string; color: string }) {
  const tex = useCanvasTexture(1024, 320, (g) => {
    g.fillStyle = color;
    roundRect(g, 0, 0, 1024, 320, 44);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.92)';
    const s = fitText(g, name, 900, 168, 800);
    g.textBaseline = 'middle';
    g.fillText(name, 62, 128);
    g.font = `500 ${Math.min(52, s * 0.42)}px ${FONT_BODY}`;
    g.fillStyle = 'rgba(255,255,255,0.72)';
    g.fillText(cwd.length > 42 ? `…${cwd.slice(-41)}` : cwd, 66, 258);
  }, [name, cwd, color]);
  return (
    <group>
      <mesh castShadow position={[0, 0.35, -0.05]}>
        <boxGeometry args={[0.12, 0.7, 0.12]} />
        <meshStandardMaterial color="#3a3f4e" />
      </mesh>
      <mesh castShadow position={[0, 1.25, 0]}>
        <boxGeometry args={[3.5, 1.12, 0.12]} />
        <meshStandardMaterial color={shade(color, 0.7)} roughness={0.7} />
      </mesh>
      <mesh position={[0, 1.25, 0.065]}>
        <planeGeometry args={[3.4, 1.06]} />
        <meshStandardMaterial map={tex} transparent roughness={0.6} emissive="#ffffff" emissiveMap={tex} emissiveIntensity={0.25} />
      </mesh>
    </group>
  );
}

function Whiteboard({ block, authorName }: { block: ProjectBlock; authorName: string | undefined }) {
  const wb = block.whiteboard;
  const diagram = useDiagram(wb?.mermaid, true);
  const W = 1536;
  const H = 840;
  const tex = useCanvasTexture(W, H, (g) => {
    g.fillStyle = '#fbfbf8';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#2b2e44';
    g.textBaseline = 'alphabetic';
    if (!wb) {
      g.font = `700 64px ${FONT_DISPLAY}`;
      g.fillStyle = '#9a9caf';
      g.fillText('Whiteboard', 80, 130);
      g.font = `400 40px ${FONT_BODY}`;
      g.fillText('Agents draw their diagrams here.', 80, 200);
      return;
    }
    g.font = `700 60px ${FONT_DISPLAY}`;
    g.fillText(wb.title, 70, 108);
    g.font = `400 34px ${FONT_BODY}`;
    g.fillStyle = '#7b7e93';
    g.fillText(authorName ? `drawn by ${authorName}` : 'drawn by an employee', 72, 158);
    const box = { x: 60, y: 190, w: W - 120, h: H - 240 };
    if (diagram.state === 'ok' && diagram.image) {
      const k = Math.min(box.w / diagram.width, box.h / diagram.height, 1.6);
      const w = diagram.width * k;
      const h = diagram.height * k;
      g.drawImage(diagram.image, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
    } else {
      g.fillStyle = diagram.state === 'error' ? '#c0392b' : '#9a9caf';
      g.font = `500 44px ${FONT_BODY}`;
      g.fillText(
        diagram.state === 'error' ? 'This diagram has a syntax error.' : diagram.state === 'loading' ? 'Drawing…' : 'Click to open the diagram.',
        box.x + 10,
        box.y + 80,
      );
      if (diagram.state === 'error') {
        g.font = `400 32px ${FONT_BODY}`;
        g.fillText('Click the board to see the source.', box.x + 10, box.y + 140);
      }
    }
  }, [wb?.title, wb?.at, authorName, diagram.state, diagram.state === 'ok' ? diagram.image : null]);

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        if (e.delta < 6) set({ modal: { kind: 'whiteboard', blockId: block.id } });
      }}
      onPointerOver={() => void (document.body.style.cursor = 'pointer')}
      onPointerOut={() => void (document.body.style.cursor = '')}
    >
      {[-1.8, 1.8].map((x) => (
        <mesh key={x} castShadow position={[x, 0.7, -0.12]}>
          <boxGeometry args={[0.08, 1.4, 0.08]} />
          <meshStandardMaterial color="#9aa0ae" metalness={0.4} roughness={0.5} />
        </mesh>
      ))}
      <mesh castShadow position={[0, 1.85, 0]}>
        <boxGeometry args={[4.4, 2.4, 0.1]} />
        <meshStandardMaterial color="#c9cdd8" metalness={0.3} roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.85, 0.056]}>
        <planeGeometry args={[4.24, 2.32]} />
        <meshStandardMaterial map={tex} roughness={0.35} emissive="#ffffff" emissiveMap={tex} emissiveIntensity={0.3} />
      </mesh>
      <mesh position={[0, 0.62, 0.12]}>
        <boxGeometry args={[3.2, 0.05, 0.16]} />
        <meshStandardMaterial color="#c9cdd8" metalness={0.3} roughness={0.5} />
      </mesh>
    </group>
  );
}

export const BlockView = memo(function BlockView({ block, employees }: { block: ProjectBlock; employees: Employee[] }) {
  const c = blockCenter(block.slot);
  const s = signPose(block.slot);
  const w = whiteboardPose(block.slot);
  const rug = useMemo(() => new Color(block.color).lerp(FLOOR, 0.12).getStyle(), [block.color]);
  const trim = useMemo(() => new Color(block.color).multiplyScalar(0.8).getStyle(), [block.color]);
  const author = block.whiteboard ? employees.find((e) => e.id === block.whiteboard!.by)?.name : undefined;

  return (
    <group>
      <group position={[c.x, 0, c.z]}>
        <RoundedPlane w={BLOCK_W - 0.5} d={BLOCK_D - 0.5} r={0.5} color={trim} y={0.008} />
        <RoundedPlane w={BLOCK_W - 1.0} d={BLOCK_D - 1.0} r={0.35} color={rug} y={0.014} />
      </group>
      {[0, 1, 2, 3, 4].map((i) => {
        const p = deskPose(block.slot, i);
        const e = employees.find((x) => x.desk === i);
        return (
          <group key={i}>
            <Desk position={[p.desk.x, 0, p.desk.z]} screen={e ? e.status.kind : 'none'} color={e ? PROVIDERS[e.provider].color : '#888'} />
            <Chair position={[p.chair.x, 0, p.chair.z]} color={shade(block.color, 0.75)} />
          </group>
        );
      })}
      <group position={[s.x, 0, s.z]}>
        <Sign name={block.name} cwd={block.cwd} color={block.color} />
      </group>
      <group position={[w.x, 0, w.z]}>
        <Whiteboard block={block} authorName={author} />
      </group>
    </group>
  );
});
