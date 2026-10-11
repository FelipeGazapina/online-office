import { create } from 'zustand';
import { employeeById, get, send, set } from './store.ts';
import { KEYS_INTENT, runtime } from './runtime.ts';
import { AWAY_SPEED, TOTAL } from './scene/laptopPose.ts';
import type { BlockId, EmployeeId } from '../../shared/protocol.ts';

// The terminal on an employee's monitor. `near` is the employee whose desk the owner stands at, `open` the one whose monitor the camera
// is zoomed into and whose terminal is open.
export const useMonitor = create<{ near: EmployeeId | null; open: EmployeeId | null }>(() => ({ near: null, open: null }));
// For the tests.
(window as unknown as { __officeMonitor: unknown }).__officeMonitor = useMonitor;

export function enterMonitor(employeeId: EmployeeId) {
  const s = get();
  if (s.computerState === 'seated' || s.build || laptopOut()) return;
  useMonitor.setState({ open: employeeId });
  set({ menu: null, selectedId: null, modal: null, helpOpen: false });
}

export function leaveMonitor() {
  useMonitor.setState({ open: null });
}

// Esc on the terminal does what it does in Claude Code: it stops what the employee is doing, and when they are doing nothing it leaves.
export function escapeMonitor() {
  const { open } = useMonitor.getState();
  if (!open) return;
  const kind = employeeById(open)?.status.kind;
  if (kind === 'working' || kind === 'blocked_on_owner') send({ type: 'interrupt', employeeId: open });
  else leaveMonitor();
}

export function enterProjectComputer(blockId: BlockId) {
  if (get().nearProjectComputer !== blockId || laptopOut()) return;
  set({ projectComputerId: blockId, computerState: 'seated', computerView: 'office', portalMode: true, computerMenu: false, selectedId: null });
}

export function enterComputer() {
  if ((!get().nearComputer && get().computerState !== 'seated') || laptopOut()) return;
  set({ computerState: 'seated', computerView: 'office', portalMode: true, computerMenu: false });
}

export function openMirror() {
  const s = get();
  if (s.projectComputerId || s.computerState !== 'seated' || s.computerView !== 'office') return;
  window.office.portal.enter();
  set({ computerView: 'mirror' });
}

// The live mirror of the Mac, from wherever the owner is: they sit down at it without walking there.
function mirrorFromAnywhere() {
  window.office.portal.enter();
  useMonitor.setState({ open: null });
  stowLaptop();
  set({ projectComputerId: null, computerState: 'seated', computerView: 'mirror', portalMode: true, computerMenu: false, modal: null, selectedId: null, menu: null });
}

// A link to GitHub, like a task's pull request, takes the owner to their Mac: they sit down at it, the live mirror opens,
// and the page opens in the Mac's browser underneath. From wherever they are, since a link is not a walk.
export function openOnComputer(url: string) {
  if (get().build) return;
  mirrorFromAnywhere();
  window.office.portal.openUrl(url);
}

// The laptop's own way to the live mirror: it goes back in the inventory and the Mac's desktop fills the window.
export function openMirrorFromLaptop() {
  if (get().build || !useLaptop.getState().open) return;
  mirrorFromAnywhere();
}

export function leaveComputer() {
  const s = get();
  if (!s.projectComputerId && s.computerView === 'mirror') window.office.portal.leave();
  set({ projectComputerId: null, computerState: 'away', computerView: 'office', portalMode: false, computerMenu: false });
}

// The laptop the owner always carries: the same desktop as the Mac at their desk, from wherever they stand. `open` is what the
// owner asked for, `ready` that the camera has reached the screen, so the desktop can show on it. `laptopAnim.s` is how many
// seconds into taking it out the scene is (scene/laptopPose.ts says what happens when), stepped by the camera rig every frame.
export const useLaptop = create<{ open: boolean; ready: boolean }>(() => ({ open: false, ready: false }));
export const laptopAnim = { s: 0 };

/** True from the moment the owner reaches for the laptop until it is back in the inventory: the hands are busy all that time. */
export const laptopOut = () => useLaptop.getState().open || laptopAnim.s > 0;

/** Esc with nothing else open, or the inventory slot: the owner stops where they stand, takes the laptop out and opens it. */
export function openLaptop() {
  const s = get();
  if (useLaptop.getState().open || s.build || s.portalMode || s.computerState === 'seated' || s.modal || !s.building || useMonitor.getState().open || runtime.owner.climb) return;
  runtime.keys.clear();
  runtime.owner.intent = KEYS_INTENT;
  runtime.owner.approach = null;
  runtime.owner.approachArrived = false;
  set({ menu: null, selectedId: null, helpOpen: false });
  useLaptop.setState({ open: true, ready: false });
}

/** The desktop goes dark at once; the camera backs out, the lid closes and the laptop goes away as the scene plays it backward. */
export function closeLaptop() {
  if (useLaptop.getState().open) useLaptop.setState({ open: false, ready: false });
}

/** Away at once, with no animation: for when something else takes the whole window. */
export function stowLaptop() {
  laptopAnim.s = 0;
  closeLaptop();
}

/** One frame of taking the laptop out or putting it away. */
export function stepLaptop(dt: number) {
  const { open, ready } = useLaptop.getState();
  laptopAnim.s = Math.max(0, Math.min(TOTAL, laptopAnim.s + (open ? dt : -dt * AWAY_SPEED)));
  const now = open && laptopAnim.s >= TOTAL;
  if (now !== ready) useLaptop.setState({ ready: now });
}

// For the tests.
(window as unknown as { __officeLaptop: unknown }).__officeLaptop = { store: useLaptop, anim: laptopAnim };
