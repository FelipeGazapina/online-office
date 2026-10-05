import { removeItemOp } from '../../../../shared/space/buildersGesture.ts';
import { runtime } from '../../runtime.ts';
import { get } from '../../store.ts';
import { enterBuild, exitBuild, redo, rotate, sendOps, setLevel, setTool, undo } from './actions.ts';
import { buildView } from './state.ts';

export const PAN_KEYS: readonly string[] = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/** Build mode's keys. Returns whether the key was taken, so the live-mode keys do not also see it. */
export function buildKey(e: KeyboardEvent): boolean {
  const s = get();
  const build = s.build;
  if (!build) {
    if (e.code === 'KeyB' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !s.modal && !s.portalMode) {
      enterBuild();
      return true;
    }
    return false;
  }
  if (e.metaKey || e.ctrlKey) {
    if (e.code === 'KeyZ') (e.shiftKey ? redo : undo)();
    else if (e.code === 'KeyY') redo();
    else return false;
    e.preventDefault();
    return true;
  }
  if (e.altKey || s.modal) return false;
  const level = build.level;
  const taken = () => {
    e.preventDefault();
    return true;
  };
  if (PAN_KEYS.includes(e.code)) {
    buildView.keys.add(e.code);
    return taken();
  }
  switch (e.code) {
    case 'KeyB':
      if (!e.repeat) exitBuild();
      return taken();
    case 'Escape':
      if (s.helpOpen || s.menu) return false;
      if (build.tool.kind !== 'select') setTool({ kind: 'select' });
      else exitBuild();
      return taken();
    case 'PageUp':
      setLevel(level + 1);
      return taken();
    case 'PageDown':
      setLevel(level - 1);
      return taken();
    case 'Comma':
      rotate(-1);
      return taken();
    case 'Period':
      rotate(1);
      return taken();
    case 'KeyQ':
    case 'KeyR':
      if (!e.repeat) runtime.view.isoYawTarget += e.code === 'KeyQ' ? Math.PI / 2 : -Math.PI / 2;
      return taken();
    case 'Delete':
    case 'Backspace': {
      const id = build.tool.kind === 'item' ? build.tool.carry : s.buildCursor.hover;
      if (id) {
        sendOps([removeItemOp(level, id)]);
        if (build.tool.kind === 'item') setTool({ kind: 'select' });
      }
      return taken();
    }
    case 'KeyE': {
      const item = s.buildCursor.hover && s.building?.stories[level]?.items.find((i) => i.id === s.buildCursor.hover);
      if (item) setTool({ kind: 'item', def: item.def, rot: item.rot, carry: null, blockId: item.blockId ?? null });
      return taken();
    }
    case 'Tab':
      return taken();
  }
  return false;
}
