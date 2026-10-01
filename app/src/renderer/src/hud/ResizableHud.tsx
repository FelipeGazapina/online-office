import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

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
type DragState = { pointerId: number; startX: number; startY: number; startScale: number; currentScale: number };
type HandleRect = { left: number; top: number };

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

export function ResizableHud({ itemKey, children }: { itemKey: HudItemKey; children: ReactNode }) {
  const [scale, setScale] = useState(() => readScales()[itemKey] ?? DEFAULT_SCALE);
  const [handle, setHandle] = useState<HandleRect | null>(null);
  const drag = useRef<DragState | null>(null);
  const target = useRef<HTMLElement | null>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const label = labelFor(itemKey);
  const projected = itemKey === 'owner-label' || itemKey.startsWith('employee-label-');

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
      setHandle((previous) => previous && nextHandle && Math.abs(previous.left - nextHandle.left) < 0.5 && Math.abs(previous.top - nextHandle.top) < 0.5 ? previous : nextHandle);
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
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const next = clampScale(active.startScale + ((event.clientX - active.startX) + (event.clientY - active.startY)) / 360);
      active.currentScale = next;
      setScale(next);
      applyScale(target.current, next);
    };
    const cancel = () => {
      const active = drag.current;
      if (!active) return;
      setScale(active.startScale);
      applyScale(target.current, active.startScale);
      drag.current = null;
      document.body.classList.remove('hud-resizing');
    };
    const finish = (event: PointerEvent) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      writeScale(itemKey, active.currentScale);
      drag.current = null;
      document.body.classList.remove('hud-resizing');
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
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

  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startScale: scale, currentScale: scale };
    document.body.classList.add('hud-resizing');
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const adjust = (delta: number, event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const next = clampScale(scale + delta);
    setScale(next);
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
          style={handle}
          aria-label={`Resize ${label}`}
          title={`Drag to resize ${label}`}
          aria-valuemin={MIN_SCALE}
          aria-valuemax={MAX_SCALE}
          aria-valuenow={scale}
          onPointerDown={start}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') adjust(event.shiftKey ? 0.1 : 0.02, event);
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') adjust(event.shiftKey ? -0.1 : -0.02, event);
            if (event.key === 'Home') adjust(1 - scale, event);
          }}
          onClick={(event) => event.stopPropagation()}
        />
      )}
    </div>
  );
}
