// Dragging a card with pointer events. Native drag and drop would not start from the synthetic mouse input the end-to-end
// driver sends, and a pointer drag also lets the ghost, the dimmed source and the drop outline follow the design. The ghost's
// position is written straight to the element so a move does not re-render the board.
//
// A card moves between the board's columns, or leaves them. Once it is outside the columns it is `away`: the board folds out
// of the way, the office shows, and the desk the pointer is over is the drop target (`aim`, kept in the store for the scene).
// The stage chips of the tray stay drop targets too, so a card taken out can still go to a column. While it is away the card
// hangs off the pointer wherever it covers no name tag (`hang.ts`).
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { BlockId } from '../../../../shared/protocol.ts';
import { STAGES, type Task, type TaskStage } from '../../../../shared/tasks.ts';
import type { Aim } from '../../deskDrop.ts';
import { get } from '../../store.ts';
import type { Point } from '../../carry.ts';
import { aimAt, setAim } from './aim.ts';
import { hang } from './hang.ts';

// A press that moves less than this is a click.
const THRESHOLD_PX = 5;

export type Drag = { task: Task; from: TaskStage; over: TaskStage | null; away: boolean; width: number; grabX: number; grabY: number; x: number; y: number };

export type Drops = {
  // The block the task belongs to: a desk of any other block refuses it.
  blockId: BlockId;
  // What the board's columns fill. A card still over it is being moved between columns.
  home: () => Element | null | undefined;
  onStage: (task: Task, to: TaskStage) => void;
  onDesk: (task: Task, aim: Aim) => void;
};

const isStage = (v: string | null | undefined): v is TaskStage => !!v && (STAGES as readonly string[]).includes(v);

const within = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

export function useCardDrag(drops: Drops) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const live = useRef<{ drag: Drag | null; armed: { task: Task; from: TaskStage; x: number; y: number; rect: DOMRect } | null; ghost: HTMLElement | null }>({ drag: null, armed: null, ghost: null });
  const dropRef = useRef(drops);
  dropRef.current = drops;
  // The click that follows a drag's release must not open the card.
  const dragged = useRef(false);

  // Out in the office the tags can move under a still pointer (people walk, a label fades in), so this runs every frame.
  const away = !!drag?.away;
  useEffect(() => {
    if (!away) return;
    let raf = 0;
    let hung: Point | null = null;
    const tick = () => {
      const { ghost, drag: d } = live.current;
      if (ghost && d) hung = hang(ghost, { x: d.x, y: d.y }, hung);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [away]);

  const stop = useCallback(() => {
    live.current.armed = null;
    live.current.drag = null;
    document.body.style.cursor = '';
    setAim(null);
    setDrag(null);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const s = live.current;
      if (s.armed && !s.drag) {
        if (Math.hypot(e.clientX - s.armed.x, e.clientY - s.armed.y) < THRESHOLD_PX) return;
        const { rect, task, from } = s.armed;
        s.drag = { task, from, over: from, away: false, width: rect.width, grabX: s.armed.x - rect.left, grabY: s.armed.y - rect.top, x: e.clientX, y: e.clientY };
        document.body.style.cursor = 'grabbing';
        setDrag(s.drag);
      }
      const d = s.drag;
      if (!d) return;
      d.x = e.clientX;
      d.y = e.clientY;
      if (s.ghost) s.ghost.style.transform = `translate(${d.x - d.grabX}px, ${d.y - d.grabY}px) rotate(1.6deg)`;
      const stage = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-stage]')?.getAttribute('data-stage');
      const over = isStage(stage) ? stage : null;
      // Leaving the columns is how a card is taken out of the board. It does not go back in: the board is out of the way.
      const home = dropRef.current.home()?.getBoundingClientRect();
      const away = d.away || (!!home && !within(home, e.clientX, e.clientY));
      setAim(away && !over ? aimAt(e.clientX, e.clientY, d.task, dropRef.current.blockId) : null);
      if (over !== d.over || away !== d.away) {
        d.over = over;
        d.away = away;
        setDrag({ ...d });
      }
    };
    const up = () => {
      const d = live.current.drag;
      if (d) {
        dragged.current = true;
        setTimeout(() => (dragged.current = false), 0);
        const aim = d.away ? get().aim : null;
        if (d.over && d.over !== d.from) dropRef.current.onStage(d.task, d.over);
        else if (aim) dropRef.current.onDesk(d.task, aim);
      }
      stop();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && live.current.drag) {
        e.stopPropagation();
        dragged.current = true;
        setTimeout(() => (dragged.current = false), 0);
        stop();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('keydown', key, true);
    return () => {
      setAim(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('keydown', key, true);
    };
  }, [stop]);

  const press = useCallback((task: Task, from: TaskStage, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('a, input, textarea, select')) return;
    live.current.armed = { task, from, x: e.clientX, y: e.clientY, rect: e.currentTarget.getBoundingClientRect() };
  }, []);

  const ghostRef = useCallback((el: HTMLElement | null) => {
    live.current.ghost = el;
    const d = live.current.drag;
    if (el && d) el.style.transform = `translate(${d.x - d.grabX}px, ${d.y - d.grabY}px) rotate(1.6deg)`;
  }, []);

  return { drag, press, ghostRef, wasDragged: () => dragged.current };
}
