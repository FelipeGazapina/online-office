import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Color } from 'three';
import { taskBoardColumns, type Employee, type ProjectBlock } from '../../../shared/protocol.ts';
import { BLOCK_D, BLOCK_W, STORY_H, YAW, blockCenter, type Building, type Item } from '../../../shared/space/index.ts';
import { enterProjectComputer } from '../computer.ts';
import { set, useStore } from '../store.ts';
import { itemCenter } from '../world.ts';
import { PodDecor } from './Decor.tsx';
import { Chair, RoundedPlane } from './Furniture.tsx';
import { fitText, FONT_BODY, FONT_DISPLAY, ownerComputerTexture, roundRect, useCanvasTexture } from './textures.ts';
import { useDiagram } from './whiteboard.ts';

// The block presentation is intentionally a light prototype: neutral pods, a visible PO desk, and a small DAILY huddle spot.

function shade(hex: string, amount: number) {
  return `#${new Color(hex).multiplyScalar(amount).getHexString()}`;
}

function Sign({ name, cwd, color }: { name: string; cwd: string; color: string }) {
  const tex = useCanvasTexture(1024, 320, (g) => {
    g.fillStyle = '#344256';
    roundRect(g, 0, 0, 1024, 320, 44);
    g.fill();
    g.fillStyle = color;
    roundRect(g, 30, 28, 150, 92, 24);
    g.fill();
    g.fillStyle = '#172235';
    g.font = `800 68px ${FONT_DISPLAY}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('PO', 105, 74);
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255,255,255,0.95)';
    const s = fitText(g, name, 760, 132, 800);
    g.textBaseline = 'middle';
    g.fillText(name, 210, 82);
    g.font = `500 ${Math.min(52, s * 0.42)}px ${FONT_BODY}`;
    g.fillStyle = 'rgba(255,255,255,0.62)';
    g.fillText('Project lead · ' + (cwd.length > 32 ? `…${cwd.slice(-31)}` : cwd), 214, 236);
  }, [name, cwd, color]);
  return (
    <group scale={0.68}>
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

function DailyHuddle({ color }: { color: string }) {
  const tex = useCanvasTexture(420, 180, (g) => {
    g.fillStyle = '#fffdf7'; roundRect(g, 0, 0, 420, 180, 22); g.fill();
    g.fillStyle = '#344256'; g.font = `800 58px ${FONT_DISPLAY}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('DAILY', 210, 76);
    g.font = `500 25px ${FONT_BODY}`; g.fillStyle = '#7c8794'; g.fillText('team sync', 210, 132);
  }, []);
  return (
    <group>
      <mesh receiveShadow position={[0, 0.035, 0]}><cylinderGeometry args={[1.25, 1.25, 0.06, 20]} /><meshStandardMaterial color={color} roughness={0.9} /></mesh>
      <mesh castShadow position={[0, 0.62, 0]}><cylinderGeometry args={[0.75, 0.82, 0.1, 16]} /><meshStandardMaterial color="#eadfc9" roughness={0.75} /></mesh>
      {[-1, 1].map((x) => <Chair key={x} position={[x * 0.95, 0, 0]} color={color} rotationY={x < 0 ? -Math.PI / 2 : Math.PI / 2} />)}
      <mesh position={[0, 1.05, -0.82]}><planeGeometry args={[1.5, 0.64]} /><meshBasicMaterial map={tex} transparent /></mesh>
    </group>
  );
}

function PodBoundary({ color }: { color: string }) {
  const edge = '#d2d8dd';
  return (
    <group>
      {[[0, -3.72, 9.6, 0.08], [-4.72, 0, 0.08, 7.4], [4.72, 0, 0.08, 7.4]].map(([x, z, w, d], i) => (
        <mesh key={i} receiveShadow position={[x, 0.28, z]}><boxGeometry args={[w, 0.56, d]} /><meshStandardMaterial color={i === 0 ? color : edge} roughness={0.85} transparent opacity={0.82} /></mesh>
      ))}
      <mesh receiveShadow position={[0, 0.22, 3.72]}><boxGeometry args={[3.1, 0.44, 0.18]} /><meshStandardMaterial color={edge} roughness={0.9} /></mesh>
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
  const columns = taskBoardColumns(cards);
  const tex = useCanvasTexture(1536, 840, (g) => {
    g.fillStyle = '#fbfbf8'; g.fillRect(0, 0, 1536, 840);
    g.fillStyle = '#2b2e44'; g.font = `700 60px ${FONT_DISPLAY}`; g.fillText('Task board', 70, 100);
    g.font = `400 32px ${FONT_BODY}`; g.fillStyle = '#7b7e93';
    g.fillText(board?.kind === 'loading' ? 'Refreshing incoming tickets…' : board?.kind === 'error' ? board.message : `${cards.length} incoming tickets · press F or click to assign work`, 72, 150);
    columns.forEach((column, i) => {
      const x = 28 + i * 214;
      g.fillStyle = '#eeeef2'; roundRect(g, x, 200, 194, 570, 18); g.fill();
      g.fillStyle = '#2b2e44'; g.font = `700 23px ${FONT_DISPLAY}`; g.fillText(`${column.label} · ${column.cards.length}`, x + 14, 240);
      column.cards.slice(0, 4).forEach((card, j) => { const y = 270 + j * 116; g.fillStyle = '#fff'; roundRect(g, x + 10, y, 174, 94, 11); g.fill(); g.fillStyle = '#2b2e44'; g.font = `700 18px ${FONT_BODY}`; g.fillText(card.identifier, x + 20, y + 29); g.font = `500 17px ${FONT_BODY}`; g.fillText(card.title.slice(0, 17), x + 20, y + 59); g.fillStyle = '#7b7e93'; g.font = `500 14px ${FONT_BODY}`; g.fillText(card.sourceLabel.slice(0, 18), x + 20, y + 81); });
    });
  }, [board?.kind, board?.cards, board?.kind === 'error' ? board.message : undefined]);
  return <group onClick={(e) => { e.stopPropagation(); if (e.delta < 6) set({ modal: { kind: 'task_board', blockId: block.id } }); }} onPointerOver={() => void (document.body.style.cursor = 'pointer')} onPointerOut={() => void (document.body.style.cursor = '')}><mesh castShadow position={[0, 1.85, 0]}><boxGeometry args={[4.4, 2.4, 0.1]} /><meshStandardMaterial color="#c9cdd8" metalness={0.3} roughness={0.5} /></mesh><mesh position={[0, 1.85, 0.056]}><planeGeometry args={[4.24, 2.32]} /><meshStandardMaterial map={tex} roughness={0.35} emissive="#fff" emissiveMap={tex} emissiveIntensity={0.3} /></mesh></group>;
}

function LinearBoardWhiteboard({ block }: { block: ProjectBlock }) {
  const tex = useCanvasTexture(1536, 840, (g) => {
    g.fillStyle = '#fbfbf8'; g.fillRect(0, 0, 1536, 840);
    g.fillStyle = '#5b45c7'; g.font = `700 64px ${FONT_DISPLAY}`; g.fillText('Linear board', 70, 110);
    g.fillStyle = '#7b7e93'; g.font = `400 34px ${FONT_BODY}`; g.fillText('Open the live Linear board · click or press F', 72, 165);
    g.fillStyle = '#ece6ff'; roundRect(g, 70, 240, 1395, 420, 28); g.fill();
    g.fillStyle = '#4d3b9e'; g.font = `700 52px ${FONT_DISPLAY}`; g.fillText('Your Linear workspace', 120, 340);
    g.fillStyle = '#625d7b'; g.font = `400 34px ${FONT_BODY}`; g.fillText('This is a separate board for the full Linear view.', 120, 405);
  }, [block.linearBoardUrl]);
  return <group onClick={(e) => { e.stopPropagation(); if (e.delta < 6) set({ modal: { kind: 'linear_board', blockId: block.id } }); }} onPointerOver={() => void (document.body.style.cursor = 'pointer')} onPointerOut={() => void (document.body.style.cursor = '')}><mesh castShadow position={[0, 1.85, 0]}><boxGeometry args={[4.4, 2.4, 0.1]} /><meshStandardMaterial color="#d8d0f0" /></mesh><mesh position={[0, 1.85, 0.056]}><planeGeometry args={[4.24, 2.32]} /><meshStandardMaterial map={tex} emissive="#fff" emissiveMap={tex} emissiveIntensity={0.3} /></mesh></group>;
}

const RUG_W = BLOCK_W - 1;
const RUG_D = BLOCK_D - 1;

type Placed = { item: Item; story: number };
const find = (b: Building | null, def: string, blockId: string): Placed | undefined => {
  if (!b) return undefined;
  for (let story = 0; story < b.stories.length; story++) {
    const item = b.stories[story].items.find((i) => i.def === def && i.blockId === blockId);
    if (item) return { item, story };
  }
  return undefined;
};

// Items that are drawn one by one carry the story's height and the turn of their item.
function AtItem({ at, children }: { at: Placed; children: ReactNode }) {
  const shown = useStore((s) => at.story <= s.story);
  const c = itemCenter(at.item);
  if (!shown) return null;
  return (
    <group position={[c.x, at.story * STORY_H, c.z]} rotation-y={YAW[at.item.rot]}>
      {children}
    </group>
  );
}

// The block's project computer: a standing console beside the whiteboard. The owner uses it to configure the board.
function Terminal({ blockId }: { blockId: ProjectBlock['id'] }) {
  const tex = ownerComputerTexture();
  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        if (e.delta < 6) enterProjectComputer(blockId);
      }}
      onPointerOver={() => void (document.body.style.cursor = 'pointer')}
      onPointerOut={() => void (document.body.style.cursor = '')}
    >
      <mesh castShadow receiveShadow position={[0, 0.55, 0]}>
        <boxGeometry args={[0.96, 0.08, 0.46]} />
        <meshStandardMaterial color="#efe0c6" roughness={0.7} />
      </mesh>
      {[-0.42, 0.42].map((x) => (
        <mesh key={x} castShadow position={[x, 0.27, 0]}>
          <boxGeometry args={[0.06, 0.54, 0.4]} />
          <meshStandardMaterial color="#3a3f4e" roughness={0.6} />
        </mesh>
      ))}
      <mesh castShadow position={[0, 0.98, -0.1]}>
        <boxGeometry args={[0.8, 0.5, 0.04]} />
        <meshStandardMaterial color="#111a2a" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.98, -0.077]}>
        <planeGeometry args={[0.72, 0.42]} />
        <meshStandardMaterial map={tex} emissiveMap={tex} emissive="#ffffff" emissiveIntensity={0.4} />
      </mesh>
      <mesh castShadow position={[0, 0.7, -0.1]}>
        <boxGeometry args={[0.08, 0.28, 0.06]} />
        <meshStandardMaterial color="#2b2e38" />
      </mesh>
    </group>
  );
}

export const BlockView = memo(function BlockView({ block, employees }: { block: ProjectBlock; employees: Employee[] }) {
  const building = useStore((s) => s.building);
  const c = blockCenter(block.slot);
  const sign = useMemo(() => find(building, 'team_sign', block.id), [building, block.id]);
  const board = useMemo(() => find(building, 'whiteboard', block.id), [building, block.id]);
  const terminal = useMemo(() => find(building, 'board_terminal', block.id), [building, block.id]);
  const rug = useMemo(() => new Color(block.color).lerp(new Color('#d7dde2'), 0.62).getStyle(), [block.color]);
  const trim = useMemo(() => new Color(block.color).lerp(new Color('#738195'), 0.5).getStyle(), [block.color]);
  const author = block.whiteboard ? employees.find((e) => e.id === block.whiteboard!.by)?.name : undefined;

  return (
    <group>
      <group position={[c.x, 0, c.z]}>
        <RoundedPlane w={RUG_W + 0.5} d={RUG_D + 0.5} r={0.5} color="#d6dbe0" y={0.008} />
        <RoundedPlane w={RUG_W} d={RUG_D} r={0.35} color={rug} y={0.014} />
        <PodBoundary color={trim} />
        <PodDecor />
      </group>
      {sign && (
        <AtItem at={sign}>
          <Sign name={block.name} cwd={block.cwd} color={block.color} />
        </AtItem>
      )}
      {board && (
        <AtItem at={board}>
          {block.linearBoardUrl ? <LinearBoardWhiteboard block={block} /> : block.taskBoard?.sources.length ? <TaskBoardWhiteboard block={block} /> : block.githubRepo ? <GithubWhiteboard block={block} /> : <Whiteboard block={block} authorName={author} />}
        </AtItem>
      )}
      {terminal && (
        <AtItem at={terminal}>
          <Terminal blockId={block.id} />
        </AtItem>
      )}
      <group position={[c.x + 3.3, 0, c.z + 2.5]}><DailyHuddle color={trim} /></group>
    </group>
  );
});
