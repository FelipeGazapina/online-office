import { useEffect, useLayoutEffect, useReducer, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

const STORAGE_KEY = 'online-office.hud-scales';
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.6;
const DEFAULT_SCALE = 1;

const HUD_ITEMS = {
  clock: 'World clock',
  'waiting-meter': 'Waiting meter',
  'update-chip': 'Update notice',
  'bottom-talk': 'Conversation bar',
  toasts: 'Notifications',
  'computer-prompt': 'Computer prompt',
  drawer: 'Employee drawer',
  modals: 'Dialog',
  'employee-menu': 'Employee menu',
  'help-overlay': 'Help dialog',
  'computer-menu': 'Computer menu',
  'owner-label': 'Your name tag',
} as const;

export type HudItemId = keyof typeof HUD_ITEMS;
export type HudItemKey = HudItemId | `employee-label-${string}`;
type HudScaleState = Partial<Record<string, number>>;
type HandleRect = { left: number; top: number };
type ResizeState =
  | { kind: 'idle'; scale: number }
  | { kind: 'hover'; scale: number }
  | { kind: 'focus'; scale: number }
  | { kind: 'active-drag'; pointerId: number; startX: number; startY: number; startScale: number; currentScale: number };
type ResizeEvent =
  | { type: 'pointer-enter' }
  | { type: 'pointer-leave' }
  | { type: 'focus' }
  | { type: 'blur' }
  | { type: 'drag-start'; pointerId: number; startX: number; startY: number }
  | { type: 'drag-move'; clientX: number; clientY: number }
  | { type: 'drag-end' }
  | { type: 'cancel' }
  | { type: 'keyboard-adjust'; delta: number };

function readScales(): HudScaleState {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= MIN_SCALE && value <= MAX_SCALE));
  } catch {
    return {};
  }
}

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function labelFor(itemKey: HudItemKey) {
  return HUD_ITEMS[itemKey as HudItemId] ?? (itemKey.startsWith('employee-label-') ? 'Employee label' : 'HUD item');
}

function targetFor(itemKey: HudItemKey) {
  return document.querySelector<HTMLElement>(`[data-hud-resize-target="${CSS.escape(itemKey)}"]`);
}

function writeScale(itemKey: HudItemKey, scale: number) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readScales(), [itemKey]: scale }));
}

function applyScale(target: HTMLElement | null, scale: number) {
  target?.style.setProperty('--hud-scale', String(scale));
}

function stateScale(state: ResizeState) {
  return state.kind === 'active-drag' ? state.currentScale : state.scale;
}

function idle(scale: number): ResizeState {
  return { kind: 'idle', scale };
}

function setAffordance(state: ResizeState, kind: 'hover' | 'focus') {
  return state.kind === 'active-drag' ? state : { kind, scale: stateScale(state) };
}

function reduceResize(state: ResizeState, event: ResizeEvent): ResizeState {
  switch (event.type) {
    case 'pointer-enter':
      return setAffordance(state, 'hover');
    case 'pointer-leave':
      return state.kind === 'hover' ? idle(state.scale) : state;
    case 'focus':
      return setAffordance(state, 'focus');
    case 'blur':
      return state.kind === 'focus' ? idle(state.scale) : state;
    case 'drag-start':
      return state.kind === 'active-drag'
        ? state
        : { kind: 'active-drag', pointerId: event.pointerId, startX: event.startX, startY: event.startY, startScale: stateScale(state), currentScale: stateScale(state) };
    case 'drag-move':
      return state.kind === 'active-drag'
        ? { ...state, currentScale: clampScale(state.startScale + ((event.clientX - state.startX) + (event.clientY - state.startY)) / 360) }
        : state;
    case 'drag-end':
      return state.kind === 'active-drag' ? idle(state.currentScale) : state;
    case 'cancel':
      return state.kind === 'active-drag' ? idle(state.startScale) : state;
    case 'keyboard-adjust':
      return state.kind === 'active-drag' ? state : { kind: state.kind, scale: clampScale(stateScale(state) + event.delta) };
  }
}

export function ResizableHud({ itemKey, children }: { itemKey: HudItemKey; children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceResize, itemKey, (key) => idle(readScales()[key] ?? DEFAULT_SCALE));
  const [handle, setHandle] = useReducer((previous: HandleRect | null, next: HandleRect | null) => previous && next && Math.abs(previous.left - next.left) < 0.5 && Math.abs(previous.top - next.top) < 0.5 ? previous : next, null);
  const stateRef = useRef(state);
  const target = useRef<HTMLElement | null>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const label = labelFor(itemKey);
  const projected = itemKey === 'owner-label' || itemKey.startsWith('employee-label-');
  const scale = stateScale(state);
  stateRef.current = state;

  useEffect(() => {
    let resizeObserver: ResizeObserver | undefined;
    const sync = () => {
      const next = targetFor(itemKey);
      if (target.current !== next) {
        target.current?.classList.remove('hud-resize-target');
        target.current = next;
      }
      next?.classList.add('hud-resize-target');
      applyScale(target.current, scale);
      const rect = target.current?.getBoundingClientRect();
      const nextHandle = rect && rect.width > 1 && rect.height > 1 ? { left: rect.right - 24, top: rect.bottom - 24 } : null;
      setHandle(nextHandle);
      resizeObserver?.disconnect();
      if (target.current) {
        resizeObserver = new ResizeObserver(sync);
        resizeObserver.observe(target.current);
      }
    };
    sync();
    let frame = 0;
    if (projected) {
      const refresh = () => {
        sync();
        frame = requestAnimationFrame(refresh);
      };
      frame = requestAnimationFrame(refresh);
    }
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', sync);
      target.current?.classList.remove('hud-resize-target');
      target.current?.style.removeProperty('--hud-scale');
    };
  }, [itemKey, projected, scale]);

  useLayoutEffect(() => {
    if (!projected || !handle || !handleRef.current) return;
    const current = handleRef.current.getBoundingClientRect();
    const left = Number.parseFloat(handleRef.current.style.left || '0') + handle.left - current.left;
    const top = Number.parseFloat(handleRef.current.style.top || '0') + handle.top - current.top;
    handleRef.current.style.left = `${left}px`;
    handleRef.current.style.top = `${top}px`;
  }, [handle, projected]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = stateRef.current;
      if (active.kind !== 'active-drag' || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: 'drag-move', clientX: event.clientX, clientY: event.clientY });
    };
    const cancel = () => {
      const active = stateRef.current;
      if (active.kind !== 'active-drag') return;
      if (handleRef.current?.hasPointerCapture(active.pointerId)) handleRef.current.releasePointerCapture(active.pointerId);
      dispatch({ type: 'cancel' });
    };
    const finish = (event: PointerEvent) => {
      const active = stateRef.current;
      if (active.kind !== 'active-drag' || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      writeScale(itemKey, active.currentScale);
      dispatch({ type: 'drag-end' });
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && stateRef.current.kind === 'active-drag') {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener('pointermove', move, { capture: true });
    window.addEventListener('pointerup', finish, { capture: true });
    window.addEventListener('pointercancel', cancel, { capture: true });
    window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', keydown, true);
    };
  }, [itemKey]);

  useEffect(() => {
    if (state.kind !== 'active-drag') return;
    document.body.classList.add('hud-resizing');
    return () => document.body.classList.remove('hud-resizing');
  }, [state.kind]);

  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: 'drag-start', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const adjust = (delta: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const next = clampScale(scale + delta);
    dispatch({ type: 'keyboard-adjust', delta });
    applyScale(target.current, next);
    writeScale(itemKey, next);
  };

  return (
    <div className="hud-resizable">
      {children}
      {handle && (
        <button
          type="button"
          ref={handleRef}
          className="hud-resize-handle"
          data-resize-state={state.kind}
          style={handle}
          aria-label={`Resize ${label}`}
          title={`Drag to resize ${label}`}
          aria-valuemin={MIN_SCALE}
          aria-valuemax={MAX_SCALE}
          aria-valuenow={scale}
          onPointerEnter={() => dispatch({ type: 'pointer-enter' })}
          onPointerLeave={() => dispatch({ type: 'pointer-leave' })}
          onFocus={() => dispatch({ type: 'focus' })}
          onBlur={() => dispatch({ type: 'blur' })}
          onPointerDown={start}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') adjust(event.shiftKey ? 0.1 : 0.02, event);
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') adjust(event.shiftKey ? -0.1 : -0.02, event);
            if (event.key === 'Home') adjust(1 - scale, event);
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {state.kind === 'active-drag' && <span className="hud-resize-badge" aria-live="polite">{Math.round(scale * 100)}%</span>}
        </button>
      )}
    </div>
  );
}
