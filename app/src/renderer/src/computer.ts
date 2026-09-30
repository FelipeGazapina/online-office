import { get, set } from './store.ts';

export function enterComputer() {
  if (!get().nearComputer && get().computerState !== 'seated') return;
  window.office.portal.enter();
  set({ computerState: 'seated', portalMode: true, computerMenu: false });
}

export function leaveComputer() {
  window.office.portal.leave();
  set({ computerState: 'away', portalMode: false, computerMenu: false });
}
