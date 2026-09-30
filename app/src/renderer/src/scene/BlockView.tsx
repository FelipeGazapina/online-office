import { memo, useEffect, useMemo, useState } from 'react';
import { Color } from 'three';
import { PROVIDERS, type Employee, type ProjectBlock } from '../../../shared/protocol.ts';
import { BENCH, blockCenter, deskPose, projectComputerPose, RUG_D, RUG_W, signPose, whiteboardPose, type DeskPose } from '../layout.ts';
import { enterProjectComputer } from '../computer.ts';
import { set, useStore } from '../store.ts';
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

type GithubBoardItem = { title: string; state: 'open' | 'closed'; pull_request?: unknown };

function GithubWhiteboard({ block }: { block: ProjectBlock }) {
  const [items, setItems] = useState<GithubBoardItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    if (!block.githubRepo) return;
    try {
      const url = new URL(block.githubRepo);
      const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
      if (url.hostname !== 'github.com' || path.split('/').length !== 2) throw new Error('invalid repository');
      fetch(`https://api.github.com/repos/${path}/issues?state=all&per_page=100`, { headers: { Accept: 'application/vnd.github+json' } })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error('GitHub request failed'))))
        .then((next: GithubBoardItem[]) => { setItems(next); setStatus('ready'); })
        .catch(() => setStatus('error'));
    } catch {
      setStatus('error');
    }
  }, [block.githubRepo]);

  const tex = useCanvasTexture(1536, 840, (g) => {
    g.fillStyle = '#fbfbf8';
    g.fillRect(0, 0, 1536, 840);
    g.fillStyle = '#2b2e44';
    g.font = `700 60px ${FONT_DISPLAY}`;
    g.fillText('GitHub board', 70, 100);
    g.font = `400 32px ${FONT_BODY}`;
    g.fillStyle = '#7b7e93';
    g.fillText(status === 'loading' ? 'Loading pull requests and issues…' : status === 'error' ? 'Could not load GitHub data' : block.githubRepo ?? '', 72, 150);
    const columns = [
      { title: 'Open', items: items.filter((item) => item.state === 'open') },
      { title: 'Closed', items: items.filter((item) => item.state === 'closed') },
    ];
    columns.forEach((column, i) => {
      const x = 60 + i * 710;
      g.fillStyle = '#eeeef2';
      roundRect(g, x, 200, 650, 570, 24);
      g.fill();
      g.fillStyle = '#2b2e44';
      g.font = `700 40px ${FONT_DISPLAY}`;
      g.fillText(`${column.title} · ${column.items.length}`, x + 28, 255);
      g.font = `500 27px ${FONT_BODY}`;
      column.items.slice(0, 4).forEach((item, j) => {
        const y = 300 + j * 105;
        g.fillStyle = '#ffffff';
        roundRect(g, x + 22, y, 606, 82, 14);
        g.fill();
        g.fillStyle = '#2b2e44';
        g.fillText(`${item.pull_request ? 'PR' : 'Issue'} · ${item.title.slice(0, 34)}`, x + 42, y + 48);
      });
    });
  }, [block.githubRepo, items, status]);

  return (
    <group
      onClick={(e) => { e.stopPropagation(); if (e.delta < 6) set({ modal: { kind: 'github', blockId: block.id } }); }}
      onPointerOver={() => void (document.body.style.cursor = 'pointer')}
      onPointerOut={() => void (document.body.style.cursor = '')}
    >
      <mesh castShadow position={[0, 1.85, 0]}><boxGeometry args={[4.4, 2.4, 0.1]} /><meshStandardMaterial color="#c9cdd8" metalness={0.3} roughness={0.5} /></mesh>
      <mesh position={[0, 1.85, 0.056]}><planeGeometry args={[4.24, 2.32]} /><meshStandardMaterial map={tex} roughness={0.35} emissive="#ffffff" emissiveMap={tex} emissiveIntensity={0.3} /></mesh>
    </group>
  );
}

function TaskBoardWhiteboard({ block }: { block: ProjectBlock }) {
  const board = useStore((s) => s.taskBoards[block.id]);
  const cards = board?.cards ?? [];
  const tex = useCanvasTexture(1536, 840, (g) => {
    g.fillStyle = '#fbfbf8'; g.fillRect(0, 0, 1536, 840);
    g.fillStyle = '#2b2e44'; g.font = `700 60px ${FONT_DISPLAY}`; g.fillText('Task board', 70, 100);
    g.font = `400 32px ${FONT_BODY}`; g.fillStyle = '#7b7e93';
    g.fillText(board?.kind === 'loading' ? 'Refreshing incoming tickets…' : board?.kind === 'error' ? board.message : `${cards.length} incoming tickets · click to assign work`, 72, 150);
    ['Open', 'In progress', 'Done'].forEach((column, i) => {
      const x = 48 + i * 490; g.fillStyle = '#eeeef2'; roundRect(g, x, 200, 450, 570, 24); g.fill();
      g.fillStyle = '#2b2e44'; g.font = `700 36px ${FONT_DISPLAY}`; g.fillText(column, x + 24, 250);
      const matches = cards.filter((card) => column === 'Done' ? /done|complete|closed|canceled/i.test(card.status) : column === 'In progress' ? /progress|approval|started/i.test(card.status) : !/done|complete|closed|canceled|progress|approval|started/i.test(card.status));
      matches.slice(0, 4).forEach((card, j) => { const y = 285 + j * 115; g.fillStyle = '#fff'; roundRect(g, x + 18, y, 414, 92, 14); g.fill(); g.fillStyle = '#2b2e44'; g.font = `700 25px ${FONT_BODY}`; g.fillText(card.identifier, x + 35, y + 32); g.font = `500 24px ${FONT_BODY}`; g.fillText(card.title.slice(0, 25), x + 35, y + 65); });
    });
  }, [block.id, board?.kind, board?.cards, board?.kind === 'error' ? board.message : undefined]);
  return <group onClick={(e) => { e.stopPropagation(); if (e.delta < 6) set({ modal: { kind: 'task_board', blockId: block.id } }); }} onPointerOver={() => void (document.body.style.cursor = 'pointer')} onPointerOut={() => void (document.body.style.cursor = '')}><mesh castShadow position={[0, 1.85, 0]}><boxGeometry args={[4.4, 2.4, 0.1]} /><meshStandardMaterial color="#c9cdd8" metalness={0.3} roughness={0.5} /></mesh><mesh position={[0, 1.85, 0.056]}><planeGeometry args={[4.24, 2.32]} /><meshStandardMaterial map={tex} roughness={0.35} emissive="#fff" emissiveMap={tex} emissiveIntensity={0.3} /></mesh></group>;
}

// The Desk and Chair models have the chair on their +z side, so their rotationY is the seat's yaw turned half a turn.
function Workstation({ pose, employee, chairColor, plate, blockId }: { pose: DeskPose; employee?: Employee; chairColor: string; plate?: string; blockId?: ProjectBlock['id'] }) {
  const rotationY = pose.yaw - Math.PI;
  return (
    <group onClick={plate === 'PO' && blockId ? (e) => { e.stopPropagation(); if (e.delta < 6) enterProjectComputer(blockId); } : undefined} onPointerOver={plate === 'PO' ? () => void (document.body.style.cursor = 'pointer') : undefined} onPointerOut={plate === 'PO' ? () => void (document.body.style.cursor = '') : undefined}>
      <Desk
        position={[pose.desk.x, 0, pose.desk.z]}
        rotationY={rotationY}
        screen={employee ? employee.status.kind : 'none'}
        color={employee ? PROVIDERS[employee.provider].color : '#888'}
        plate={plate}
      />
      <Chair position={[pose.chair.x, 0, pose.chair.z]} rotationY={rotationY} color={chairColor} />
    </group>
  );
}

export const BlockView = memo(function BlockView({ block, employees }: { block: ProjectBlock; employees: Employee[] }) {
  const c = blockCenter(block.slot);
  const s = signPose(block.slot);
  const w = whiteboardPose(block.slot);
  const rug = useMemo(() => new Color(block.color).lerp(FLOOR, 0.12).getStyle(), [block.color]);
  const chairColor = useMemo(() => shade(block.color, 0.75), [block.color]);
  const trim = useMemo(() => new Color(block.color).multiplyScalar(0.8).getStyle(), [block.color]);
  const author = block.whiteboard ? employees.find((e) => e.id === block.whiteboard!.by)?.name : undefined;

  return (
    <group>
      <group position={[c.x, 0, c.z]}>
        <RoundedPlane w={RUG_W + 0.5} d={RUG_D + 0.5} r={0.5} color={trim} y={0.008} />
        <RoundedPlane w={RUG_W} d={RUG_D} r={0.35} color={rug} y={0.014} />
      </group>
      {BENCH.map((_, i) => (
        <Workstation key={i} pose={deskPose(block.slot, i)} employee={employees.find((e) => e.desk === i)} chairColor={chairColor} />
      ))}
      <Workstation pose={projectComputerPose(block.slot)} chairColor={chairColor} plate="PO" blockId={block.id} />
      {employees.filter((employee) => employee.desk >= BENCH.length).map((employee) => (
        <Workstation key={employee.id} pose={deskPose(block.slot, employee.desk)} employee={employee} chairColor={chairColor} />
      ))}
      <group position={[s.x, 0, s.z]}>
        <Sign name={block.name} cwd={block.cwd} color={block.color} />
      </group>
      <group position={[w.x, 0, w.z]}>
        {block.taskBoard?.sources.length ? <TaskBoardWhiteboard block={block} /> : block.githubRepo ? <GithubWhiteboard block={block} /> : <Whiteboard block={block} authorName={author} />}
      </group>
    </group>
  );
});
