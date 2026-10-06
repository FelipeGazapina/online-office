import { useMemo } from 'react';
import type { Employee, ProjectBlock } from '../../../shared/protocol.ts';
import type { TaskStage } from '../../../shared/tasks.ts';
import { boardFor, boardsOf, columnsOf, fmtAgo, isRunning, originOf } from '../boardView.ts';
import { avatarColor } from '../hud/chat/model.ts';
import { openBoard } from '../hud/tasks/actions.ts';
import { useStore } from '../store.ts';
import { FONT_BODY, FONT_DISPLAY, roundRect, useCanvasTexture } from './textures.ts';

const W = 1536;
const H = 840;
const STAGE_COLOR: Record<TaskStage, string> = { todo: '#9b9db3', doing: '#e8920f', review: '#5457e0', done: '#2f9e6e' };
const ORIGIN_COLOR = { manual: ['#eceaf3', '#6c6f88'], linear: ['#ece6ff', '#6944b1'], cronospark: ['#dcf7ed', '#12744b'] } as const;
const PER_LANE = 3;

type Card = { ref: string; title: string; origin: keyof typeof ORIGIN_COLOR; who: { initial: string; color: string }[]; running: boolean };
type Lane = { stage: TaskStage; label: string; total: number; cards: Card[] };
type Wall = { board: string; others: string[]; sub: string; lanes: Lane[] };

// Two lines at most, cut on a space where it can.
function wrap(g: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width <= width || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
    if (lines.length === 2) break;
  }
  if (lines.length < 2 && line) lines.push(line);
  const cut = lines.slice(0, 2);
  if (words.join(' ').length > cut.join(' ').length + 1) {
    let last = cut[cut.length - 1]!;
    while (last && g.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    cut[cut.length - 1] = `${last}…`;
  }
  return cut;
}

// Sized for a wall seen from across the room: fewer cards, bigger text.
function paint(g: CanvasRenderingContext2D, wall: Wall) {
  g.fillStyle = '#fbfbf8';
  g.fillRect(0, 0, W, H);
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#2b2e44';
  g.font = `800 70px ${FONT_DISPLAY}`;
  g.fillText(wall.board.length > 22 ? `${wall.board.slice(0, 21)}…` : wall.board, 44, 100);
  g.font = `500 30px ${FONT_BODY}`;
  g.fillStyle = '#7b7e93';
  g.fillText(wall.sub, 46, 150);
  // The other boards of the block, as tabs, so the wall says there is more than one.
  let x = 880;
  g.font = `600 26px ${FONT_BODY}`;
  for (const name of wall.others.slice(0, 3)) {
    const label = name.length > 14 ? `${name.slice(0, 13)}…` : name;
    const w = g.measureText(label).width + 36;
    if (x + w > W - 40) break;
    g.fillStyle = '#eeeef2';
    roundRect(g, x, 56, w, 46, 23);
    g.fill();
    g.fillStyle = '#6c6f88';
    g.fillText(label, x + 18, 89);
    x += w + 12;
  }
  const laneW = (W - 88 - 3 * 16) / 4;
  const CARD_H = 170;
  const STRIDE = 180;
  wall.lanes.forEach((lane, i) => {
    const lx = 44 + i * (laneW + 16);
    g.fillStyle = '#eeeef2';
    roundRect(g, lx, 184, laneW, 640, 22);
    g.fill();
    g.fillStyle = STAGE_COLOR[lane.stage];
    g.beginPath();
    g.arc(lx + 32, 228, 13, 0, Math.PI * 2);
    if (lane.stage === 'done') g.fill();
    else {
      g.lineWidth = 4;
      g.strokeStyle = STAGE_COLOR[lane.stage];
      g.stroke();
      if (lane.stage !== 'todo') {
        g.beginPath();
        g.moveTo(lx + 32, 228);
        g.arc(lx + 32, 228, 13, -Math.PI / 2, lane.stage === 'doing' ? Math.PI / 2 : Math.PI);
        g.closePath();
        g.fill();
      }
    }
    g.fillStyle = '#2b2e44';
    g.font = `700 36px ${FONT_DISPLAY}`;
    g.fillText(lane.label, lx + 58, 241);
    g.fillStyle = '#9a9bb0';
    g.font = `700 32px ${FONT_BODY}`;
    g.textAlign = 'right';
    g.fillText(String(lane.total), lx + laneW - 24, 240);
    g.textAlign = 'left';
    lane.cards.forEach((card, j) => {
      const y = 268 + j * STRIDE;
      g.fillStyle = '#ffffff';
      roundRect(g, lx + 12, y, laneW - 24, CARD_H, 18);
      g.fill();
      if (card.running) {
        g.fillStyle = '#2f9e6e';
        roundRect(g, lx + 12, y + 18, 8, CARD_H - 36, 4);
        g.fill();
      }
      const [bg, fg] = ORIGIN_COLOR[card.origin];
      g.fillStyle = bg;
      roundRect(g, lx + 32, y + 16, 34, 34, 9);
      g.fill();
      g.fillStyle = fg;
      g.font = `800 20px ${FONT_BODY}`;
      g.textAlign = 'center';
      g.fillText(card.origin === 'linear' ? 'L' : card.origin === 'cronospark' ? 'C' : 'M', lx + 49, y + 41);
      g.textAlign = 'left';
      g.fillStyle = '#6c6f88';
      g.font = `700 28px ${FONT_BODY}`;
      g.fillText(card.ref.slice(0, 12), lx + 78, y + 42);
      card.who.slice(0, 3).forEach((p, k) => {
        const cx = lx + laneW - 24 - 22 - k * 26;
        g.fillStyle = p.color;
        g.beginPath();
        g.arc(cx, y + 33, 19, 0, Math.PI * 2);
        g.fill();
        g.lineWidth = 4;
        g.strokeStyle = '#fff';
        g.stroke();
        g.fillStyle = '#fff';
        g.font = `700 20px ${FONT_DISPLAY}`;
        g.textAlign = 'center';
        g.fillText(p.initial, cx, y + 40);
        g.textAlign = 'left';
      });
      g.fillStyle = '#2b2e44';
      g.font = `650 30px ${FONT_BODY}`;
      wrap(g, card.title, laneW - 24 - 40).forEach((line, k) => g.fillText(line, lx + 32, y + 98 + k * 38));
    });
    const more = lane.total - lane.cards.length;
    if (more > 0) {
      g.fillStyle = '#7b7e93';
      g.font = `700 24px ${FONT_BODY}`;
      g.fillText(`+ ${more} more`, lx + 34, 816);
    }
  });
}

// The wall board of a block that has tasks. It draws the board the owner picked and changes only when what it shows
// changes, never on the second-by-second timers.
export function TaskBoardWhiteboard({ block, employees }: { block: ProjectBlock; employees: Employee[] }) {
  const boards = useStore((s) => s.boards);
  const tasks = useStore((s) => s.tasks);
  const times = useStore((s) => s.taskTime);
  const sync = useStore((s) => s.boardSync);
  const pick = useStore((s) => s.boardPick);
  const board = boardFor(boards, block.id, pick);
  const wall = useMemo<Wall | undefined>(() => {
    if (!board) return undefined;
    const mine = tasks.filter((t) => t.boardId === board.id);
    const byId = new Map(employees.map((e) => [e.id, e]));
    const running = mine.filter((t) => isRunning(times[t.id])).length;
    const state = sync[board.id];
    const sub =
      state?.kind === 'error' ? `Sync failed: ${state.message}`.slice(0, 70) : `${mine.length} ${mine.length === 1 ? 'task' : 'tasks'}${running ? ` · ${running} running` : ''}${state?.kind === 'ready' && board.kind !== 'quick' ? ` · synced ${fmtAgo(Date.now() - state.lastFetchedAt)}` : ''} · press F or click to open`;
    return {
      board: board.name,
      others: boardsOf(boards, block.id).filter((b) => b.id !== board.id).map((b) => b.name),
      sub,
      lanes: columnsOf(mine).map((c) => ({
        stage: c.stage,
        label: c.label,
        total: c.tasks.length,
        cards: c.tasks.slice(0, PER_LANE).map((t) => {
          const o = originOf(t);
          return { ref: o.ref, title: t.title, origin: o.kind, running: isRunning(times[t.id]), who: t.assignees.map((id) => ({ initial: byId.get(id)?.name[0] ?? '?', color: avatarColor(id) })) };
        }),
      })),
    };
  }, [board, boards, block.id, tasks, times, sync, employees]);
  const signature = JSON.stringify(wall);
  const tex = useCanvasTexture(W, H, (g) => wall && paint(g, wall), [signature]);
  return (
    <group onClick={(e) => { e.stopPropagation(); if (e.delta < 6) openBoard(block.id); }} onPointerOver={() => void (document.body.style.cursor = 'pointer')} onPointerOut={() => void (document.body.style.cursor = '')}>
      <mesh castShadow position={[0, 1.85, 0]}><boxGeometry args={[4.4, 2.4, 0.1]} /><meshStandardMaterial color="#c9cdd8" metalness={0.3} roughness={0.5} /></mesh>
      <mesh position={[0, 1.85, 0.056]}><planeGeometry args={[4.24, 2.32]} /><meshStandardMaterial map={tex} roughness={0.35} emissive="#fff" emissiveMap={tex} emissiveIntensity={0.3} /></mesh>
    </group>
  );
}
