import { get, set } from './store.ts';
import type { BlockId } from '../../shared/protocol.ts';

export function enterProjectComputer(blockId: BlockId) {
  if (get().nearProjectComputer !== blockId) return;
  set({ projectComputerId: blockId, computerState: 'seated', portalMode: true, computerMenu: false, selectedId: null });
}

export function enterComputer() {
  if (!get().nearComputer && get().computerState !== 'seated') return;
  window.office.portal.enter();
  set({ computerState: 'seated', portalMode: true, computerMenu: false });
}

export function leaveComputer() {
  if (!get().projectComputerId) window.office.portal.leave();
  set({ projectComputerId: null, computerState: 'away', portalMode: false, computerMenu: false });
}
