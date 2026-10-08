import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AdditiveBlending, Color, DoubleSide, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry } from 'three';
import type { Employee, ProjectBlock } from '../../../shared/protocol.ts';
import { blocksWithTasks } from '../boardView.ts';
import { BLOCK_D, BLOCK_W, STORY_H, YAW, floorItems, type Building, type FloorItem } from '../../../shared/space/index.ts';
import { enterProjectComputer } from '../computer.ts';
import { set, useStore } from '../store.ts';
import { itemCenter } from '../world.ts';
import { DYNAMIC } from './building/models.ts';
import { rugOf, trimOf } from './building/pod.ts';
import { TaskBoardWhiteboard } from './TaskBoardWall.tsx';
import { RoundedPlane } from './Furniture.tsx';
import { fitText, FONT_BODY, FONT_DISPLAY, ownerComputerTexture, poolTexture, roundRect, useCanvasTexture } from './textures.ts';
import { carpetSurface } from './surfaceTextures.ts';
import { useDiagram } from './whiteboard.ts';

// Everything a block shows is an item of the building with the block's id, drawn where that item stands. The pieces below
// carry a texture or a material of their own, so React draws them one by one; the rest of the pod is instanced with the
// other furniture (building/StoryView.tsx).

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
    <group scale={0.46}>
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

// The round table of the team's daily, on a mat in the team's trim color. Its chairs and its sign are items of their own.
function HuddleTable({ color }: { color: string }) {
  return (
    <group position={[0.05, 0, -0.25]}>
      <mesh receiveShadow position={[0, 0.035, 0]}><cylinderGeometry args={[1.25, 1.25, 0.06, 56]} /><meshStandardMaterial color={color} roughness={0.9} /></mesh>
      <mesh castShadow position={[0, 0.7, 0]}><cylinderGeometry args={[0.8, 0.8, 0.05, 56]} /><meshStandardMaterial color="#eadfc9" roughness={0.45} /></mesh>
      <mesh castShadow position={[0, 0.665, 0]}><cylinderGeometry args={[0.76, 0.76, 0.03, 56]} /><meshStandardMaterial color="#8c6a4a" roughness={0.6} /></mesh>
      <mesh castShadow position={[0, 0.35, 0]}><cylinderGeometry args={[0.07, 0.1, 0.65, 16]} /><meshStandardMaterial color="#3a3f4e" roughness={0.5} /></mesh>
      <mesh castShadow position={[0, 0.03, 0]}><cylinderGeometry args={[0.38, 0.4, 0.04, 40]} /><meshStandardMaterial color="#3a3f4e" roughness={0.5} /></mesh>
    </group>
  );
}

function DailySign() {
  const tex = useCanvasTexture(420, 180, (g) => {
    g.fillStyle = '#fffdf7'; roundRect(g, 0, 0, 420, 180, 22); g.fill();
    g.fillStyle = '#344256'; g.font = `800 58px ${FONT_DISPLAY}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('DAILY', 210, 76);
    g.font = `500 25px ${FONT_BODY}`; g.fillStyle = '#7c8794'; g.fillText('team sync', 210, 132);
  }, []);
  return <mesh position={[0.05, 1.05, -0.07]}><planeGeometry args={[1.5, 0.64]} /><meshBasicMaterial map={tex} transparent /></mesh>;
}

// The pod's front edge: a pane of clear glass between a thin sill and a thin top rail, so the team's desks read through it.
const railMaterial = new MeshStandardMaterial({ color: '#c9ced4', roughness: 0.4, metalness: 0.5 });
const paneMaterial = new MeshStandardMaterial({ color: '#dcefff', roughness: 0.06, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide });
function GlassRail({ w }: { w: number }) {
  return (
    <group position={[0, 0, -0.03]}>
      <mesh receiveShadow material={railMaterial} position={[0, 0.02, 0]}><boxGeometry args={[w, 0.04, 0.06]} /></mesh>
      <mesh material={railMaterial} position={[0, 0.76, 0]}><boxGeometry args={[w, 0.03, 0.05]} /></mesh>
      {[-w / 2, w / 2].map((px) => <mesh key={px} material={railMaterial} position={[px, 0.39, 0]}><boxGeometry args={[0.04, 0.78, 0.05]} /></mesh>)}
      <mesh material={paneMaterial} position={[0, 0.4, 0]}><planeGeometry args={[w, 0.72]} /></mesh>
    </group>
  );
}

// A team's rug, and the two pools of lamplight that lie on it: they belong to the rug, so they go where it goes.
const poolGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const poolMaterial = (color: string) =>
  new MeshBasicMaterial({ map: poolTexture(), color, transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.24, fog: false, polygonOffset: true, polygonOffsetFactor: -3 });
const POOLS = [
  { x: 0, z: 0.4, r: 7.8, material: poolMaterial('#ffe0a8') },
  { x: 3, z: -1.5, r: 4, material: poolMaterial('#ffc27a') },
];
function Rug({ color }: { color: string }) {
  const carpet = useMemo(() => carpetSurface(), []);
  const rug = useMemo(() => rugOf(color).getStyle(), [color]);
  return (
    <>
      <RoundedPlane w={RUG_W + 0.5} d={RUG_D + 0.5} r={0.5} color="#d9c9a8" y={0.008} surface={carpet} />
      <RoundedPlane w={RUG_W} d={RUG_D} r={0.35} color={rug} y={0.014} surface={carpet} />
      {POOLS.map((p) => <mesh key={p.x} geometry={poolGeometry} material={p.material} position={[p.x, 0.025, p.z]} scale={[p.r * 2, 1, p.r * 2]} renderOrder={4} />)}
    </>
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

type Placed = { item: FloorItem; story: number };
/** Every piece of the block that React draws, wherever on the building it stands now. */
function piecesOf(b: Building | null, blockId: string): Placed[] {
  if (!b) return [];
  return b.stories.flatMap((s, story) => floorItems(s).filter((i) => i.blockId === blockId && DYNAMIC.has(i.def)).map((item) => ({ item, story })));
}

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
  const hasTasks = useStore((s) => blocksWithTasks(s.boards, s.tasks).has(block.id));
  const pieces = useMemo(() => piecesOf(building, block.id), [building, block.id]);
  const trim = useMemo(() => trimOf(block.color).getStyle(), [block.color]);
  const author = block.whiteboard ? employees.find((e) => e.id === block.whiteboard!.by)?.name : undefined;

  const view = (def: string): ReactNode => {
    switch (def) {
      case 'team_sign':
        return <Sign name={block.name} cwd={block.cwd} color={block.color} />;
      case 'whiteboard':
        return block.linearBoardUrl ? <LinearBoardWhiteboard block={block} /> : hasTasks ? <TaskBoardWhiteboard block={block} employees={employees} /> : block.githubRepo ? <GithubWhiteboard block={block} /> : <Whiteboard block={block} authorName={author} />;
      case 'board_terminal':
        return <Terminal blockId={block.id} />;
      case 'pod_rug':
        return <Rug color={block.color} />;
      case 'pod_glass_rail':
        return <GlassRail w={3.1} />;
      case 'pod_huddle_table':
        return <HuddleTable color={trim} />;
      case 'pod_daily_sign':
        return <DailySign />;
      default:
        return null;
    }
  };

  return (
    <group>
      {pieces.map((at) => (
        <AtItem key={at.item.id} at={at}>
          {view(at.item.def)}
        </AtItem>
      ))}
    </group>
  );
});
