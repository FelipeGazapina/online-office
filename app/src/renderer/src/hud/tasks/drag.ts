// Dragging a card between columns with pointer events. Native drag and drop would not start from the synthetic mouse input
// the end-to-end driver sends, and a pointer drag also lets the ghost, the dimmed source and the drop outline follow the
// design. The ghost's position is written straight to the element so a move does not re-render the board.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { STAGES, type Task, type TaskStage } from '../../../../shared/tasks.ts';

// A press that moves less than this is a click.
const THRESHOLD_PX = 5;

export type Drag = { task: Task; from: TaskStage; over: TaskStage | null; width: number; height: number; grabX: number; grabY: number; x: number; y: number };

const isStage = (v: string | null | undefined): v is TaskStage => !!v && (STAGES as readonly string[]).includes(v);

export function useCardDrag(onDrop: (task: Task, to: TaskStage) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const live = useRef<{ drag: Drag | null; armed: { task: Task; from: TaskStage; x: number; y: number; rect: DOMRect } | null; ghost: HTMLElement | null }>({ drag: null, armed: null, ghost: null });
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  // The click that follows a drag's release must not open the card.
  const dragged = useRef(false);

  const stop = useCallback(() => {
    live.current.armed = null;
    live.current.drag = null;
    document.body.style.cursor = '';
    setDrag(null);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const s = live.current;
      if (s.armed && !s.drag) {
        if (Math.hypot(e.clientX - s.armed.x, e.clientY - s.armed.y) < THRESHOLD_PX) return;
        const { rect, task, from } = s.armed;
        s.drag = { task, from, over: from, width: rect.width, height: rect.height, grabX: s.armed.x - rect.left, grabY: s.armed.y - rect.top, x: e.clientX, y: e.clientY };
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
      if (over !== d.over) {
        d.over = over;
        setDrag({ ...d });
      }
    };
    const up = () => {
      const d = live.current.drag;
      if (d) {
        dragged.current = true;
        setTimeout(() => (dragged.current = false), 0);
        if (d.over && d.over !== d.from) dropRef.current(d.task, d.over);
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
