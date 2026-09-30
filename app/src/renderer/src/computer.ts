import { get, set } from './store.ts';
import type { BlockId } from '../../shared/protocol.ts';

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
