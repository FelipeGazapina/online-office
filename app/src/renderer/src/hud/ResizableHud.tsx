import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

const SCALE_KEY = 'online-office.hud-scales';
const OFFSET_KEY = 'online-office.hud-offsets';
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.6;
const DEFAULT_SCALE = 1;
// A moved panel keeps this much air to every window edge, so its grip stays reachable.
const EDGE_MARGIN = 8;
const MAX_OFFSET = 20000;
const NUDGE = 8;
const NUDGE_FAR = 32;
const GRIP_WIDTH = 24;
const GRIP_HEIGHT = 28;
// Air between the panel edge and its grip; a transparent bridge fills it so the pointer never falls through.
const GRIP_GAP = 6;
const VIEWPORT_PAD = 4;
// How long the grip waits before hiding once the pointer has left, so an overshoot does not lose it.
const HIDE_GRACE_MS = 150;
// A lifted panel grows by at most this many pixels in total, so it never pokes past the edge margin mid-drag.
const LIFT_PX = 12;
const LIFT_MAX = 0.05;
// A press that travels less than this is a tap, not a drag: nothing lifts, shifts or is saved.
const DRAG_THRESHOLD_PX = 4;
const SETTLE_MS = 200;
// Elements stacked above the dialog scrim (z-index 200) need their grips above it too.
const SCRIM_GRIP_Z = 260;
// Panels keep this much air between each other once dropped, so none can end up hidden under another.
const PANEL_GAP = 8;

const HUD_ITEMS = {
  clock: 'World clock',
  'waiting-meter': 'Waiting meter',
  'update-chip': 'Update notice',
  'bottom-talk': 'Conversation bar',
  toasts: 'Notifications',
  'computer-prompt': 'Computer prompt',
  drawer: 'Employee drawer',
  'employee-menu': 'Employee menu',
  'help-overlay': 'Help dialog',
  'computer-menu': 'Computer menu',
  'owner-label': 'Your name tag',
} as const;

export type HudItemId = keyof typeof HUD_ITEMS;
export type HudItemKey = HudItemId | `employee-label-${string}` | `modal-${string}`;
type Offset = { x: number; y: number };
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
type Anchor = { left: number; top: number; right: number; bottom: number; scrim: boolean; others: Box[] };
type GripSide = 'left' | 'top' | 'right' | 'bottom' | 'inside';
type GripPlace = { left: number; top: number; side: GripSide };
type Box = { left: number; top: number; right: number; bottom: number };
// Everything a drag needs, measured once at pointerdown so each pointermove is arithmetic and style writes only.
type MoveDrag = { pointerId: number; startX: number; startY: number; startOffset: Offset; bounds: Bounds; liftedBounds: Bounds; lift: number; live: Offset; spot: Offset; home: Box; others: Box[]; ghost: HTMLElement; origin: HTMLElement; snapping: boolean; started: boolean };
// `panel` and `grip` are tracked apart: the grip sits over the panel's corner, so entering it also leaves the panel,
// and the two events can arrive in either order.
type Over = { panel: boolean; grip: boolean };
type Pose = { scale: number; offset: Offset } & Over;
type HudState = Pose &
  (
    | { kind: 'idle' | 'hover' | 'focus' }
    | { kind: 'active-drag'; pointerId: number; startX: number; startY: number; startScale: number; startOffset: Offset }
    | { kind: 'moving'; startOffset: Offset }
  );
type HudEvent =
  | { type: 'pointer-enter' }
  | { type: 'pointer-leave' }
  | { type: 'focus' }
  | { type: 'blur' }
  | { type: 'hover'; part: keyof Over; on: boolean }
  | { type: 'drag-start'; pointerId: number; startX: number; startY: number }
  | { type: 'drag-move'; clientX: number; clientY: number }
  | { type: 'drag-end' }
  | { type: 'move-start' }
  | ({ type: 'move-end'; offset: Offset } & Over)
  | ({ type: 'cancel' } & Over)
  | { type: 'set-offset'; offset: Offset }
  | { type: 'keyboard-adjust'; delta: number };

const ZERO: Offset = { x: 0, y: 0 };

// Every mounted panel's placement routine. After a load or a window resize they run in two passes: first every panel
// goes to its clamped saved place, then each in turn steps off any neighbour it landed on. Doing it in one pass would
// let a panel resolve against neighbours that have not been placed yet.
const syncers = new Set<(resolve?: boolean) => void>();
let settleTimer = 0;
function scheduleSettle() {
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    for (const run of syncers) run(false);
    for (const run of syncers) run(true);
  }, 0);
}

function readScales(): Partial<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SCALE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= MIN_SCALE && value <= MAX_SCALE));
  } catch {
    return {};
  }
}

function isOffset(value: unknown): value is Offset {
  if (!value || typeof value !== 'object') return false;
  const { x, y } = value as Record<string, unknown>;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= MAX_OFFSET && Math.abs(y) <= MAX_OFFSET;
}

function readOffsets(): Partial<Record<string, Offset>> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OFFSET_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isOffset(value)));
  } catch {
    return {};
  }
}

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function isMoved(offset: Offset) {
  return offset.x !== 0 || offset.y !== 0;
}

function sameOffset(a: Offset, b: Offset) {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

function labelFor(itemKey: HudItemKey) {
  return HUD_ITEMS[itemKey as HudItemId] ?? (itemKey.startsWith('employee-label-') ? 'Employee label' : itemKey.startsWith('modal-') ? 'Dialog' : 'HUD item');
}

function targetFor(itemKey: HudItemKey) {
  return document.querySelector<HTMLElement>(`[data-hud-resize-target="${CSS.escape(itemKey)}"]`);
}

function writeScale(itemKey: HudItemKey, scale: number) {
  localStorage.setItem(SCALE_KEY, JSON.stringify({ ...readScales(), [itemKey]: scale }));
}

const HINT_KEY = 'online-office.hud-move-hinted';
const HINT_MS = 5000;
let hintShown = false;

// First launch only: every grip shows faintly for a few seconds, so a new user sees that panels can be moved without
// having to hover one first. Automated runs skip it so grips stay hidden until hovered.
function showFirstRunHint() {
  if (hintShown || new URLSearchParams(window.location.search).has('test')) return;
  hintShown = true;
  try {
    if (localStorage.getItem(HINT_KEY)) return;
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    return;
  }
  document.body.classList.add('hud-hint');
  window.setTimeout(() => document.body.classList.remove('hud-hint'), HINT_MS);
}

const RESET_EVENT = 'online-office:hud-reset';

// Puts every panel back at its home place and default size. The saved layout is cleared; open panels follow at once.
export function resetHudLayout() {
  localStorage.removeItem(SCALE_KEY);
  localStorage.removeItem(OFFSET_KEY);
  window.dispatchEvent(new Event(RESET_EVENT));
}

function writeOffset(itemKey: HudItemKey, offset: Offset) {
  const { [itemKey]: _previous, ...rest } = readOffsets();
  localStorage.setItem(OFFSET_KEY, JSON.stringify(isMoved(offset) ? { ...rest, [itemKey]: offset } : rest));
}

function applyScale(target: HTMLElement | null, scale: number) {
  target?.style.setProperty('--hud-scale', String(scale));
}

function applyOffset(target: HTMLElement | null, offset: Offset) {
  target?.style.setProperty('--hud-x', `${offset.x}px`);
  target?.style.setProperty('--hud-y', `${offset.y}px`);
}

// How far the panel may travel from its home position and still sit inside the window. `offset` is what the
// rectangle was measured with, so the home rectangle is the measured one minus it.
function boundsFor(target: HTMLElement, offset: Offset): Bounds {
  const rect = target.getBoundingClientRect();
  return {
    minX: EDGE_MARGIN - (rect.left - offset.x),
    maxX: window.innerWidth - EDGE_MARGIN - (rect.right - offset.x),
    minY: EDGE_MARGIN - (rect.top - offset.y),
    maxY: window.innerHeight - EDGE_MARGIN - (rect.bottom - offset.y),
  };
}

// A panel wider than the window pins its top-left corner, where the grip lives.
function clampAxis(value: number, min: number, max: number) {
  return max < min ? min : Math.min(max, Math.max(min, value));
}

function clampOffset(offset: Offset, bounds: Bounds): Offset {
  return { x: clampAxis(offset.x, bounds.minX, bounds.maxX), y: clampAxis(offset.y, bounds.minY, bounds.maxY) };
}


// The panels a drop must not cover: every other fixed panel on screen. Dialogs sit above everything and the
// projected labels and cursor menu follow something else, so they neither collide nor count.
function obstaclesFor(self: HTMLElement): Box[] {
  const boxes: Box[] = [];
  if (self.closest('.scrim')) return boxes;
  for (const element of document.querySelectorAll<HTMLElement>('[data-hud-resize-target]')) {
    const key = element.dataset.hudResizeTarget ?? '';
    if (element === self || element.closest('.scrim') || key === 'owner-label' || key === 'employee-menu' || key.startsWith('employee-label-')) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1) boxes.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }
  return boxes;
}

function overlapArea(box: Box, other: Box) {
  const w = Math.min(box.right, other.right + PANEL_GAP) - Math.max(box.left, other.left - PANEL_GAP);
  const h = Math.min(box.bottom, other.bottom + PANEL_GAP) - Math.max(box.top, other.top - PANEL_GAP);
  return w > 0.5 && h > 0.5 ? w * h : 0;
}

// The offset closest to `want` where the panel, kept inside `bounds`, covers no other panel. `home` is the panel's
// box at offset zero. Candidates line the panel up against each neighbour's edges; with no free spot at all, the
// least overlapping one wins, so the panel is never worse placed than where it was dropped.
function freeSpot(want: Offset, home: Box, bounds: Bounds, others: Box[]): Offset {
  if (!others.length) return want;
  const w = home.right - home.left;
  const h = home.bottom - home.top;
  const xs = [want.x];
  const ys = [want.y];
  for (const o of others) {
    xs.push(o.left - PANEL_GAP - w - home.left, o.right + PANEL_GAP - home.left);
    ys.push(o.top - PANEL_GAP - h - home.top, o.bottom + PANEL_GAP - home.top);
  }
  let best = want;
  let bestArea = Infinity;
  let bestDistance = Infinity;
  for (const cx of xs) {
    for (const cy of ys) {
      const x = clampAxis(cx, bounds.minX, bounds.maxX);
      const y = clampAxis(cy, bounds.minY, bounds.maxY);
      const box = { left: home.left + x, top: home.top + y, right: home.right + x, bottom: home.bottom + y };
      let area = 0;
      for (const o of others) area += overlapArea(box, o);
      const distance = (x - want.x) ** 2 + (y - want.y) ** 2;
      if (area < bestArea - 0.5 || (area < bestArea + 0.5 && distance < bestDistance)) {
        best = { x, y };
        bestArea = area;
        bestDistance = distance;
      }
    }
  }
  return best;
}

// Where a panel of this size sits at offset zero, given the box it fills at `at`.
function homeBox(box: Box, at: Offset): Box {
  return { left: box.left - at.x, top: box.top - at.y, right: box.right - at.x, bottom: box.bottom - at.y };
}

function boundsOf(box: Box, at: Offset): Bounds {
  return {
    minX: EDGE_MARGIN - (box.left - at.x),
    maxX: window.innerWidth - EDGE_MARGIN - (box.right - at.x),
    minY: EDGE_MARGIN - (box.top - at.y),
    maxY: window.innerHeight - EDGE_MARGIN - (box.bottom - at.y),
  };
}

// A lifted panel is drawn a little larger, and a panel with its own transform (the conversation bar centres itself)
// also slides by the same amount; the drag stays this far inside the margin so the drawn box never passes it.
function liftFor(box: Box) {
  const size = Math.max(box.right - box.left, box.bottom - box.top, 1);
  const lift = 1 + Math.min(LIFT_MAX, LIFT_PX / size);
  return { lift, growth: size * (lift - 1) };
}

function insetBounds(bounds: Bounds, by: number): Bounds {
  return { minX: bounds.minX + by, maxX: bounds.maxX - by, minY: bounds.minY + by, maxY: bounds.maxY - by };
}

// A resting panel moved to `want` (or, for a resize, kept where it is) lands on the nearest spot that hides nothing.
// The panel's own box is rebuilt from its centre, which neither the scale nor the lift moves.
function settleOffset(target: HTMLElement, at: Offset, want: Offset, scale?: number): Offset {
  const rect = target.getBoundingClientRect();
  const w = scale === undefined ? rect.width : target.offsetWidth * scale;
  const h = scale === undefined ? rect.height : target.offsetHeight * scale;
  const cx = (rect.left + rect.right) / 2;
  const cy = (rect.top + rect.bottom) / 2;
  const box = { left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2 };
  return freeSpot(clampOffset(want, boundsOf(box, at)), homeBox(box, at), boundsOf(box, at), obstaclesFor(target));
}

// The scale a panel may really use: its own, capped so the whole panel fits the window. Natural size ignores transforms.
function fitScale(target: HTMLElement, scale: number) {
  const width = target.offsetWidth;
  const height = target.offsetHeight;
  if (width < 1 || height < 1) return scale;
  return Math.min(scale, (window.innerWidth - 2 * EDGE_MARGIN) / width, (window.innerHeight - 2 * EDGE_MARGIN) / height);
}

// The grip lives entirely outside the panel: left gutter first, then right, above, below. Only a panel that fills
// the window leaves no gutter, and then it sits just inside the corner.
// The grip plus the 8px hover bridge that links it to the panel.
function gripFootprint(a: Anchor, place: GripPlace): Box {
  const box = { left: place.left, top: place.top, right: place.left + GRIP_WIDTH, bottom: place.top + GRIP_HEIGHT };
  if (place.side === 'left') box.right = a.left;
  else if (place.side === 'right') box.left = a.right;
  else if (place.side === 'top') box.bottom = a.top;
  else if (place.side === 'bottom') box.top = a.bottom;
  return box;
}

function placeGrip(a: Anchor, prefer: GripSide | null): GripPlace {
  const maxLeft = window.innerWidth - GRIP_WIDTH - VIEWPORT_PAD;
  const maxTop = window.innerHeight - GRIP_HEIGHT - VIEWPORT_PAD;
  const x = (value: number) => Math.max(VIEWPORT_PAD, Math.min(maxLeft, value));
  const y = (value: number) => Math.max(VIEWPORT_PAD, Math.min(maxTop, value));
  const needX = GRIP_WIDTH + GRIP_GAP + VIEWPORT_PAD;
  const needY = GRIP_HEIGHT + GRIP_GAP + VIEWPORT_PAD;
  const fits: Record<Exclude<GripSide, 'inside'>, GripPlace | null> = {
    left: a.left >= needX ? { side: 'left', left: a.left - GRIP_GAP - GRIP_WIDTH, top: y(a.top) } : null,
    top: a.top >= needY ? { side: 'top', left: x(a.left), top: a.top - GRIP_GAP - GRIP_HEIGHT } : null,
    right: window.innerWidth - a.right >= needX ? { side: 'right', left: a.right + GRIP_GAP, top: y(a.top) } : null,
    bottom: window.innerHeight - a.bottom >= needY ? { side: 'bottom', left: x(a.left), top: a.bottom + GRIP_GAP } : null,
  };
  // A grip only works if the pointer can walk from the panel to it, so its footprint, and the gap back to the panel,
  // must not touch a neighbour. A neighbour that sits on the grip would take the hover and leave it inert.
  const free = (place: GripPlace) => {
    const box = gripFootprint(a, place);
    return !a.others.some((o) => box.left < o.right && box.right > o.left && box.top < o.bottom && box.bottom > o.top);
  };
  // The side it already had wins while it still fits, so a drop never flips the grip out from under the pointer.
  const order = (prefer && prefer !== 'inside' ? [prefer] : []).concat(['left', 'right', 'top', 'bottom']);
  const sides = order.map((side) => fits[side as keyof typeof fits]).filter((place): place is GripPlace => !!place);
  const open = sides.find(free);
  if (open) return open;
  // Packed in on every side: sit just inside the panel's own corner, which no neighbour can cover.
  return { side: 'inside', left: x(a.left + GRIP_GAP), top: y(a.top + GRIP_GAP) };
}

function sameBoxes(a: Box[], b: Box[]) {
  return a.length === b.length && a.every((box, i) => Math.abs(box.left - b[i].left) < 0.5 && Math.abs(box.top - b[i].top) < 0.5 && Math.abs(box.right - b[i].right) < 0.5 && Math.abs(box.bottom - b[i].bottom) < 0.5);
}

function sameAnchor(a: Anchor | null, b: Anchor | null) {
  if (!a || !b) return a === b;
  return a.scrim === b.scrim && sameBoxes(a.others, b.others) && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.right - b.right) < 0.5 && Math.abs(a.bottom - b.bottom) < 0.5;
}

function resting(state: HudState, kind: 'idle' | 'hover' | 'focus', patch: Partial<Pose> = {}): HudState {
  return { kind, scale: state.scale, offset: state.offset, panel: state.panel, grip: state.grip, ...patch };
}

function setAffordance(state: HudState, kind: 'hover' | 'focus'): HudState {
  return state.kind === 'active-drag' || state.kind === 'moving' ? state : resting(state, kind);
}

function reduceHud(state: HudState, event: HudEvent): HudState {
  switch (event.type) {
    case 'pointer-enter':
      return state.kind === 'hover' ? state : setAffordance(state, 'hover');
    case 'pointer-leave':
      return state.kind === 'hover' ? resting(state, 'idle') : state;
    case 'focus':
      return setAffordance(state, 'focus');
    case 'blur':
      return state.kind === 'focus' ? resting(state, 'idle') : state;
    case 'hover':
      return state.kind === 'moving' || state[event.part] === event.on ? state : { ...state, [event.part]: event.on };
    case 'drag-start':
      return state.kind === 'active-drag' || state.kind === 'moving'
        ? state
        : { kind: 'active-drag', pointerId: event.pointerId, startX: event.startX, startY: event.startY, startScale: state.scale, startOffset: state.offset, scale: state.scale, offset: state.offset, panel: state.panel, grip: state.grip };
    case 'drag-move':
      return state.kind === 'active-drag'
        ? { ...state, scale: clampScale(state.startScale + ((event.clientX - state.startX) + (event.clientY - state.startY)) / 360) }
        : state;
    case 'drag-end':
      return state.kind === 'active-drag' ? resting(state, 'idle') : state;
    case 'move-start':
      return state.kind === 'active-drag' || state.kind === 'moving' ? state : { kind: 'moving', startOffset: state.offset, scale: state.scale, offset: state.offset, panel: true, grip: true };
    case 'move-end':
      return state.kind === 'moving' ? resting(state, 'idle', { offset: event.offset, panel: event.panel, grip: event.grip }) : state;
    case 'cancel':
      if (state.kind === 'active-drag') return resting(state, 'idle', { scale: state.startScale, offset: state.startOffset });
      return state.kind === 'moving' ? resting(state, 'idle', { offset: state.startOffset, panel: event.panel, grip: event.grip }) : state;
    case 'set-offset':
      return state.kind === 'moving' || sameOffset(state.offset, event.offset) ? state : { ...state, offset: event.offset };
    case 'keyboard-adjust':
      return state.kind === 'active-drag' || state.kind === 'moving' ? state : { ...state, scale: clampScale(state.scale + event.delta) };
  }
}

function initialState(itemKey: HudItemKey): HudState {
  return { kind: 'idle', scale: readScales()[itemKey] ?? DEFAULT_SCALE, offset: readOffsets()[itemKey] ?? ZERO, panel: false, grip: false };
}

export function ResizableHud({ itemKey, children }: { itemKey: HudItemKey; children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceHud, itemKey, initialState);
  const [handle, setHandle] = useReducer((previous: Anchor | null, next: Anchor | null) => (sameAnchor(previous, next) ? previous : next), null);
  const stateRef = useRef(state);
  const target = useRef<HTMLElement | null>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const moveDrag = useRef<MoveDrag | null>(null);
  // Keyboard pick-up: Space or Enter grabs the panel, arrows carry it, Space or Enter drops it, Escape puts it back.
  const [grabbed, setGrabbed] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const keyStart = useRef<Offset | null>(null);
  // Where the panel really sits: the saved intent, pulled inside the window. The intent itself stays in `state`.
  const applied = useRef<Offset>(state.offset);
  const gripSide = useRef<GripSide | null>(null);
  const syncNow = useRef<() => void>(() => {});
  const leaveTimers = useRef<Partial<Record<keyof Over, number>>>({});
  const hover = useCallback((part: keyof Over, on: boolean) => {
    window.clearTimeout(leaveTimers.current[part]);
    if (on) dispatch({ type: 'hover', part, on });
    else leaveTimers.current[part] = window.setTimeout(() => dispatch({ type: 'hover', part, on }), HIDE_GRACE_MS);
  }, []);
  const label = labelFor(itemKey);
  // Labels follow a character in the world and the menu follows the cursor, so only they stay put.
  const projected = itemKey === 'owner-label' || itemKey.startsWith('employee-label-');
  const movable = !projected && itemKey !== 'employee-menu';
  const { scale, offset } = state;
  stateRef.current = state;

  useLayoutEffect(() => {
    // One observer for the life of the effect. Re-creating it inside sync made every sync schedule the next.
    const resizeObserver = new ResizeObserver(() => sync());
    let observed: HTMLElement | null = null;
    const peek = () => hover('panel', true);
    const unpeek = () => hover('panel', false);
    const release = (element: HTMLElement | null) => {
      element?.classList.remove('hud-resize-target');
      element?.removeEventListener('pointerenter', peek);
      element?.removeEventListener('pointerleave', unpeek);
    };
    const sync = (resolve = true) => {
      const next = targetFor(itemKey);
      if (target.current !== next) {
        release(target.current);
        target.current = next;
        if (movable) {
          next?.addEventListener('pointerenter', peek);
          next?.addEventListener('pointerleave', unpeek);
        }
      }
      if (next && !next.classList.contains('hud-resize-target')) next.classList.add('hud-resize-target');
      const intent = stateRef.current.offset;
      // A panel nobody has moved or scaled keeps the layout its CSS gave it; any other panel always fits the window.
      const adjusted = movable && (isMoved(intent) || scale !== DEFAULT_SCALE);
      applyScale(target.current, target.current && adjusted ? fitScale(target.current, scale) : scale);
      // While a drag owns the position, the live offset is the truth and nothing here may fight it.
      // A lifted or settling panel is drawn larger than it is; measuring it now would clamp it too tight.
      const lifted = target.current?.classList.contains('hud-moving-target') || target.current?.classList.contains('hud-settling-target');
      if (target.current && movable && !moveDrag.current && lifted) applyOffset(target.current, applied.current);
      if (target.current && movable && !moveDrag.current && !lifted) {
        let placed = intent;
        applyOffset(target.current, placed);
        if (adjusted) {
          // The clamp only shapes what is shown. The saved intent is kept, so a window that grows back restores it.
          placed = clampOffset(placed, boundsFor(target.current, placed));
          applyOffset(target.current, placed);
          // The clamp is only geometry, so it can drop a panel onto a neighbour. A window that shrank, or an app that
          // restarted smaller, gets the same nearest-free-spot a drop gets. Shown only; the saved intent stays.
          if (resolve) {
            const rect = target.current.getBoundingClientRect();
            const free = freeSpot(placed, homeBox(rect, placed), boundsOf(rect, placed), obstaclesFor(target.current));
            if (!sameOffset(free, placed)) {
              placed = free;
              applyOffset(target.current, placed);
            }
          }
        }
        applied.current = placed;
      }
      if (!moveDrag.current) {
        const rect = target.current?.getBoundingClientRect();
        setHandle(rect && rect.width > 1 && rect.height > 1 ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, scrim: !!target.current?.closest('.scrim'), others: movable && target.current ? obstaclesFor(target.current) : [] } : null);
      }
      if (observed !== target.current) {
        resizeObserver.disconnect();
        observed = target.current;
        if (observed) resizeObserver.observe(observed);
      }
    };
    syncNow.current = sync;
    // Panels mount one after another, so each is first placed on its own, and only then are they settled together.
    sync(false);
    syncers.add(sync);
    scheduleSettle();
    const onResize = () => {
      sync(false);
      scheduleSettle();
    };
    let frame = 0;
    if (projected) {
      const refresh = () => {
        sync();
        frame = requestAnimationFrame(refresh);
      };
      frame = requestAnimationFrame(refresh);
    }
    // Anything appearing or going can change what a panel may cover, so a still panel settles with the rest, which keeps
    // a live window and a fresh start in agreement. A projected label has no place to keep and just follows its target.
    const observer = new MutationObserver(() => (projected ? sync() : scheduleSettle()));
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', onResize);
    return () => {
      syncers.delete(sync);
      observer.disconnect();
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', onResize);
      release(target.current);
      target.current?.style.removeProperty('--hud-scale');
      target.current?.style.removeProperty('--hud-x');
      target.current?.style.removeProperty('--hud-y');
      target.current = null;
    };
  }, [itemKey, projected, movable, scale, offset.x, offset.y, hover]);

  useEffect(() => () => { for (const timer of Object.values(leaveTimers.current)) window.clearTimeout(timer); }, []);

  useEffect(() => {
    if (!grabbed) return;
    const lifted = target.current;
    lifted?.classList.add('hud-grabbed-target');
    return () => lifted?.classList.remove('hud-grabbed-target');
  }, [grabbed]);

  useEffect(() => {
    if (movable) showFirstRunHint();
  }, [movable]);

  // "Reset layout": the saved places are already cleared, so this only brings the live panel home at default size.
  useEffect(() => {
    const reset = () => {
      applied.current = ZERO;
      keyStart.current = null;
      setGrabbed(false);
      dispatch({ type: 'keyboard-adjust', delta: DEFAULT_SCALE - stateRef.current.scale });
      dispatch({ type: 'set-offset', offset: ZERO });
    };
    window.addEventListener(RESET_EVENT, reset);
    return () => window.removeEventListener(RESET_EVENT, reset);
  }, []);

  // The grips follow the panel by transform while a drag runs; once React has placed them for real, drop it.
  useLayoutEffect(() => {
    if (moveDrag.current) return;
    handleRef.current?.style.removeProperty('translate');
    moveRef.current?.style.removeProperty('translate');
  }, [handle, state]);

  const resizeAt = handle && { left: handle.right - 24, top: handle.bottom - 24, ...(handle.scrim && { zIndex: SCRIM_GRIP_Z }) };
  const gripPlace = handle && placeGrip(handle, gripSide.current);
  gripSide.current = gripPlace?.side ?? null;
  const moveAt = handle && gripPlace && {
    left: gripPlace.left,
    top: gripPlace.top,
    ...(handle.scrim && { zIndex: SCRIM_GRIP_Z + 1 }),
  };

  useLayoutEffect(() => {
    if (!projected || !resizeAt || !handleRef.current) return;
    const current = handleRef.current.getBoundingClientRect();
    const left = Number.parseFloat(handleRef.current.style.left || '0') + resizeAt.left - current.left;
    const top = Number.parseFloat(handleRef.current.style.top || '0') + resizeAt.top - current.top;
    handleRef.current.style.left = `${left}px`;
    handleRef.current.style.top = `${top}px`;
  }, [handle, projected]);

  useEffect(() => {
    const over = (): Over => ({ panel: !!target.current?.matches(':hover'), grip: !!moveRef.current?.matches(':hover') });
    const paintMove = (live: Offset, startOffset: Offset) => {
      applyOffset(target.current, live);
      for (const grip of [handleRef.current, moveRef.current]) grip?.style.setProperty('translate', `${live.x - startOffset.x}px ${live.y - startOffset.y}px`);
    };
    const endMove = (commit: boolean, pointerId: number) => {
      const drag = moveDrag.current;
      if (!drag) return;
      moveDrag.current = null;
      if (moveRef.current?.hasPointerCapture(pointerId)) moveRef.current.releasePointerCapture(pointerId);
      drag.ghost.remove();
      drag.origin.remove();
      // Never crossed the threshold: it was a tap, so nothing was lifted and nothing is saved.
      if (!drag.started) return;
      const offset = commit ? drag.spot : drag.startOffset;
      // The drop glides to its spot (or home after Escape) instead of jumping.
      target.current?.classList.add('hud-settling-target');
      applied.current = offset;
      applyOffset(target.current, offset);
      if (commit && !sameOffset(offset, drag.startOffset)) writeOffset(itemKey, offset);
      dispatch(commit ? { type: 'move-end', offset, ...over() } : { type: 'cancel', ...over() });
    };
    const move = (event: PointerEvent) => {
      const drag = moveDrag.current;
      if (drag?.pointerId === event.pointerId) {
        event.preventDefault();
        event.stopPropagation();
        if (!drag.started) {
          if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
          drag.started = true;
          document.body.append(drag.origin);
          dispatch({ type: 'move-start' });
        }
        const raw = { x: drag.startOffset.x + event.clientX - drag.startX, y: drag.startOffset.y + event.clientY - drag.startY };
        // The lifted panel is drawn inside the margin; where it would rest is the true clamp, then the nearest free spot.
        drag.live = clampOffset(raw, drag.liftedBounds);
        paintMove(drag.live, drag.startOffset);
        const wanted = clampOffset(raw, drag.bounds);
        drag.spot = freeSpot(wanted, drag.home, drag.bounds, drag.others);
        // The ghost shows where the drop will land, but only when another panel pushed it off the pointer's spot.
        const snaps = !sameOffset(drag.spot, wanted);
        if (snaps !== drag.snapping) {
          drag.snapping = snaps;
          drag.ghost.style.opacity = snaps ? '1' : '0';
        }
        if (snaps) drag.ghost.style.translate = `${drag.home.left + drag.spot.x}px ${drag.home.top + drag.spot.y}px`;
        return;
      }
      const active = stateRef.current;
      if (active.kind !== 'active-drag' || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: 'drag-move', clientX: event.clientX, clientY: event.clientY });
    };
    const cancel = () => {
      if (moveDrag.current) {
        endMove(false, moveDrag.current.pointerId);
        return;
      }
      const active = stateRef.current;
      if (active.kind !== 'active-drag') return;
      if (handleRef.current?.hasPointerCapture(active.pointerId)) handleRef.current.releasePointerCapture(active.pointerId);
      dispatch({ type: 'cancel', ...over() });
    };
    const finish = (event: PointerEvent) => {
      const drag = moveDrag.current;
      if (drag?.pointerId === event.pointerId) {
        event.preventDefault();
        event.stopPropagation();
        endMove(true, event.pointerId);
        return;
      }
      const active = stateRef.current;
      if (active.kind !== 'active-drag' || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      writeScale(itemKey, active.scale);
      let offset = active.offset;
      // A panel that grew over a neighbour moves off it, the same way a dropped one does.
      if (target.current && movable) {
        const from = applied.current;
        const next = settleOffset(target.current, from, from, fitScale(target.current, active.scale));
        if (!sameOffset(next, from)) {
          offset = next;
          applied.current = next;
          applyOffset(target.current, next);
        }
      }
      if (!sameOffset(offset, active.startOffset)) writeOffset(itemKey, offset);
      dispatch({ type: 'drag-end' });
      if (!sameOffset(offset, active.offset)) dispatch({ type: 'set-offset', offset });
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (moveDrag.current || stateRef.current.kind === 'active-drag')) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('pointermove', move, { capture: true });
    window.addEventListener('pointerup', finish, { capture: true });
    window.addEventListener('pointercancel', cancel, { capture: true });
    window.addEventListener('keydown', keydown, true);
    return () => {
      moveDrag.current?.ghost.remove();
      moveDrag.current?.origin.remove();
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', keydown, true);
    };
  }, [itemKey, movable]);

  useEffect(() => {
    if (state.kind !== 'active-drag') return;
    document.body.classList.add('hud-resizing');
    return () => document.body.classList.remove('hud-resizing');
  }, [state.kind]);

  useLayoutEffect(() => {
    if (state.kind !== 'moving') return;
    const lifted = target.current;
    document.body.classList.add('hud-moving');
    if (lifted) {
      lifted.style.setProperty('--hud-lift', String(moveDrag.current?.lift ?? 1 + LIFT_MAX));
      lifted.classList.remove('hud-settling-target');
      lifted.classList.add('hud-moving-target');
    }
    return () => {
      document.body.classList.remove('hud-moving');
      if (!lifted) return;
      // Dropping is the lift played backwards: shadow, scale and, after Escape, the way home all ease out.
      lifted.classList.add('hud-settling-target');
      lifted.classList.remove('hud-moving-target');
      window.setTimeout(() => {
        lifted.classList.remove('hud-settling-target');
        lifted.style.removeProperty('--hud-lift');
        // The grip was placed while the panel was drawn larger; place it again now that it is back to size.
        syncNow.current();
        // Neighbours judged this panel while it was drawn larger; let them look again at its real size.
        scheduleSettle();
      }, SETTLE_MS);
    };
  }, [state.kind]);

  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: 'drag-start', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const startMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !target.current) return;
    event.preventDefault();
    event.stopPropagation();
    const startOffset = applied.current;
    // Measured once; every pointermove after this is arithmetic and style writes, never a layout read.
    const rect = target.current.getBoundingClientRect();
    const { lift, growth } = liftFor(rect);
    const bounds = boundsOf(rect, startOffset);
    const ghost = document.createElement('div');
    ghost.className = 'hud-drop-ghost';
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.borderRadius = getComputedStyle(target.current).borderRadius;
    document.body.append(ghost);
    // Marks the slot the panel came from while it is carried away, like Notion dimming the original block.
    const origin = document.createElement('div');
    origin.className = 'hud-origin-slot';
    origin.style.width = `${rect.width}px`;
    origin.style.height = `${rect.height}px`;
    origin.style.borderRadius = ghost.style.borderRadius;
    origin.style.translate = `${rect.left}px ${rect.top}px`;
    moveDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset,
      bounds,
      liftedBounds: insetBounds(bounds, growth),
      lift,
      live: startOffset,
      spot: startOffset,
      home: homeBox(rect, startOffset),
      others: obstaclesFor(target.current),
      ghost,
      origin,
      snapping: false,
      started: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const adjust = (delta: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const next = clampScale(scale + delta);
    dispatch({ type: 'keyboard-adjust', delta });
    applyScale(target.current, next);
    writeScale(itemKey, next);
    if (!target.current || !movable) return;
    // Growing over a neighbour moves the panel clear, as it does for a mouse resize.
    const from = applied.current;
    const spot = settleOffset(target.current, from, from, fitScale(target.current, next));
    if (!sameOffset(spot, from)) place(spot);
  };

  const place = (next: Offset, persist = true) => {
    applied.current = next;
    applyOffset(target.current, next);
    if (persist) writeOffset(itemKey, next);
    dispatch({ type: 'set-offset', offset: next });
  };

  const say = (what: string) => {
    const rect = target.current?.getBoundingClientRect();
    setAnnouncement(`${what}${rect ? ` ${Math.round(rect.left)} pixels from the left, ${Math.round(rect.top)} from the top` : ''}`);
  };
  // Next frame, once the new place has been measured by the layout effect.
  const sayLater = (what: string) => requestAnimationFrame(() => say(what));

  const nudge = (dx: number, dy: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!target.current) return;
    const from = applied.current;
    keyStart.current ??= from;
    // A picked-up panel is only previewed; it is saved when dropped. Without a pick-up an arrow saves at once.
    place(settleOffset(target.current, from, { x: from.x + dx, y: from.y + dy }), !grabbed);
    sayLater(`${label} moved to`);
  };

  const leaveGrab = (restore: boolean) => {
    const start = keyStart.current;
    keyStart.current = null;
    if (grabbed) setGrabbed(false);
    if (restore && start && !sameOffset(start, applied.current)) place(start);
    else if (!restore && grabbed && start && !sameOffset(start, applied.current)) writeOffset(itemKey, applied.current);
  };

  const moveKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? NUDGE_FAR : NUDGE;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (grabbed) {
        leaveGrab(false);
        sayLater(`Dropped ${label} at`);
      } else {
        keyStart.current = applied.current;
        setGrabbed(true);
        setAnnouncement(`Picked up ${label}. Arrow keys move it, Shift for bigger steps. Space or Enter drops it, Escape cancels.`);
      }
      return;
    }
    if (event.key === 'Escape' && (grabbed || keyStart.current)) {
      event.preventDefault();
      event.stopPropagation();
      leaveGrab(true);
      sayLater(`Cancelled. ${label} is back at`);
      return;
    }
    if (event.key === 'ArrowLeft') nudge(-step, 0, event);
    if (event.key === 'ArrowRight') nudge(step, 0, event);
    if (event.key === 'ArrowUp') nudge(0, -step, event);
    if (event.key === 'ArrowDown') nudge(0, step, event);
    if (event.key === 'Home') {
      event.preventDefault();
      keyStart.current = null;
      setGrabbed(false);
      place(ZERO);
      sayLater(`${label} reset to`);
    }
  };

  // The tooltip sits beside the grip; flip it up near the bottom edge and start it at the grip near the left edge.
  const tipUp = !!moveAt && moveAt.top + GRIP_HEIGHT + 40 > window.innerHeight;
  const tipStart = !!moveAt && gripPlace?.side === 'left' && moveAt.left < 300;
  const moveState = state.kind === 'moving' ? 'moving' : state.panel || state.grip ? 'peek' : 'idle';

  return (
    <div className="hud-resizable">
      {children}
      {movable && moveAt && (
        <button
          type="button"
          ref={moveRef}
          className="hud-move-handle"
          data-move-state={moveState}
          style={moveAt}
          data-side={gripPlace?.side}
          data-tip-up={tipUp || undefined}
          data-tip-start={tipStart || undefined}
          data-grabbed={grabbed || undefined}
          data-tip={grabbed ? 'Arrow keys move · Space drops · Esc cancels' : 'Drag to move · double-click to reset'}
          aria-label={`Move ${label}`}
          aria-roledescription="drag handle"
          onPointerEnter={() => hover('grip', true)}
          onPointerMove={() => hover('grip', true)}
          onPointerLeave={() => hover('grip', false)}
          onPointerDown={startMove}
          onDoubleClick={() => place(ZERO)}
          onKeyDown={moveKey}
          onBlur={() => keyStart.current && leaveGrab(grabbed)}
          onClick={(event) => event.stopPropagation()}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            {[6, 12, 18].flatMap((cy) => [9, 15].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2" />))}
          </svg>
        </button>
      )}
      {movable && <span className="sr-only" role="status" aria-live="polite">{announcement}</span>}
      {resizeAt && (
        <button
          type="button"
          ref={handleRef}
          className="hud-resize-handle oo:transition-[opacity,box-shadow,color] oo:duration-0 oo:ease-out oo:focus-visible:outline-2 oo:focus-visible:outline-brand oo:focus-visible:outline-offset-2"
          data-resize-state={state.kind === 'moving' ? 'idle' : state.kind}
          style={resizeAt}
          aria-label={`Resize ${label}`}
          title={`Drag to resize ${label}`}
          aria-valuemin={MIN_SCALE}
          aria-valuemax={MAX_SCALE}
          aria-valuenow={scale}
          onPointerEnter={() => { dispatch({ type: 'pointer-enter' }); hover('panel', true); }}
          onPointerMove={() => { dispatch({ type: 'pointer-enter' }); hover('panel', true); }}
          onPointerLeave={() => { dispatch({ type: 'pointer-leave' }); hover('panel', false); }}
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
