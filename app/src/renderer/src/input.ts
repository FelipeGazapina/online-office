import { get, set, setSetting, toggleCamera } from './store.ts';
import { KEYS_INTENT, runtime, STEER_KEYS } from './runtime.ts';
import { setPtt } from './talk.ts';
import { toggleMeetingDoor } from './meeting.ts';
import { enterComputer, enterProjectComputer, leaveComputer } from './computer.ts';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE']);

export function installInput() {
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const s = get();

    if (s.portalMode && (e.code === 'Escape' || e.code === 'KeyF') && !s.modal && !s.selectedId) {
      leaveComputer();
      return;
    }

    if (s.portalMode && e.code !== 'Escape') return;

    if (!e.repeat && e.code === 'KeyF') {
      if (s.computerState === 'seated') leaveComputer();
      else if (s.nearProjectComputer) enterProjectComputer(s.nearProjectComputer);
      else if (s.nearComputer) enterComputer();
      else if (!s.modal && s.nearTaskBoard) set({ modal: { kind: 'task_board', blockId: s.nearTaskBoard } });
      return;
    }

    switch (e.code) {
      case 'Tab':
        e.preventDefault();
        if (!e.repeat && !s.modal) {
          toggleCamera();
          if (get().camera === 'first') window.dispatchEvent(new Event('office:lock-pointer'));
        }
        return;
      case 'KeyC':
        if (s.camera === 'first') {
          e.preventDefault();
          if (!e.repeat) window.dispatchEvent(new Event('office:toggle-pointer-lock'));
          return;
        }
        break;
      case 'Digit2':
        return setSetting('camera', 'iso');
      case 'KeyH':
        return set({ helpOpen: !s.helpOpen });
      case 'Enter':
        e.preventDefault();
        return (document.getElementById('chat-input') ?? document.getElementById('card-input'))?.focus();
      case 'KeyE':
        // E remains the camera turn key everywhere else. Near the meeting-room door it is the physical toggle.
        if (!e.repeat && toggleMeetingDoor(true)) {
          e.preventDefault();
          return;
        }
        break;
      case 'KeyV':
        if (!e.repeat) setPtt(true);
        return;
      case 'Escape':
        if (s.menu) return set({ menu: null });
        if (s.helpOpen) return set({ helpOpen: false });
        if (s.modal) return set({ modal: null });
        return set({ selectedId: null });
    }

    if (s.modal) return;
    if (MOVE_KEYS.has(e.code)) {
      e.preventDefault();
      if (!e.repeat && s.camera === 'iso' && (e.code === 'KeyQ' || e.code === 'KeyE')) {
        runtime.view.isoYawTarget += e.code === 'KeyQ' ? Math.PI / 2 : -Math.PI / 2;
      }
      // A key wins over a click walk. A tap can end before the next frame, so the sim alone would not see it.
      if (STEER_KEYS.includes(e.code)) runtime.owner.intent = KEYS_INTENT;
      runtime.keys.add(e.code);
    }
  });

  window.addEventListener('keyup', (e) => {
    runtime.keys.delete(e.code);
    if (e.code === 'KeyV') setPtt(false);
  });

  window.addEventListener('blur', () => {
    runtime.keys.clear();
    setPtt(false);
  });
}
