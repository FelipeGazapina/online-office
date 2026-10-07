import { create } from 'zustand';
import { employeeById, get, send, set } from './store.ts';
import type { BlockId, EmployeeId } from '../../shared/protocol.ts';

// The terminal on an employee's monitor. `near` is the employee whose desk the owner stands at, `open` the one whose monitor the camera
// is zoomed into and whose terminal is open.
export const useMonitor = create<{ near: EmployeeId | null; open: EmployeeId | null }>(() => ({ near: null, open: null }));
// For the tests.
(window as unknown as { __officeMonitor: unknown }).__officeMonitor = useMonitor;

export function enterMonitor(employeeId: EmployeeId) {
  const s = get();
  if (s.computerState === 'seated' || s.build) return;
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
  if (get().nearProjectComputer !== blockId) return;
  set({ projectComputerId: blockId, computerState: 'seated', computerView: 'office', portalMode: true, computerMenu: false, selectedId: null });
}

export function enterComputer() {
  if (!get().nearComputer && get().computerState !== 'seated') return;
  set({ computerState: 'seated', computerView: 'office', portalMode: true, computerMenu: false });
}

export function openMirror() {
  const s = get();
  if (s.projectComputerId || s.computerState !== 'seated' || s.computerView !== 'office') return;
  window.office.portal.enter();
  set({ computerView: 'mirror' });
}

export function leaveComputer() {
  const s = get();
  if (!s.projectComputerId && s.computerView === 'mirror') window.office.portal.leave();
  set({ projectComputerId: null, computerState: 'away', computerView: 'office', portalMode: false, computerMenu: false });
}
