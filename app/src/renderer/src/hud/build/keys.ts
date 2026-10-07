import { removeItemOp } from '../../../../shared/space/buildersGesture.ts';
import { worldRotOf } from '../../../../shared/space/index.ts';
import { runtime } from '../../runtime.ts';
import { get } from '../../store.ts';
import { enterBuild, exitBuild, redo, rotate, sendOps, setLevel, setTool, stepBack, undo } from './actions.ts';
import { removal, askToRemove, keepBlock, removeBlock } from './removal.ts';
import { buildView, hand, modifiers } from './state.ts';

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
  if (e.metaKey || e.ctrlKey || modifiers.ctrl) {
    if (e.code === 'KeyZ') (e.shiftKey || modifiers.shift ? redo : undo)();
    else if (e.code === 'KeyY') redo();
    else return false;
    e.preventDefault();
    return true;
  }
  if (e.altKey || s.modal) return false;
  // A question about a whole block takes the keyboard until it is answered.
  if (removal.getState().blockId) {
    if (e.code === 'Enter') removeBlock();
    else if (e.code === 'Escape') keepBlock();
    e.preventDefault();
    return true;
  }
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
      stepBack();
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
      // A block in hand is only deleted after a question that names the people it would fire: one slip would take the team with it.
      if (build.tool.kind === 'block') {
        if (build.tool.carry) askToRemove(build.tool.carry.blockId);
        return taken();
      }
      const id = build.tool.kind === 'item' ? build.tool.carry : s.buildCursor.hover;
      if (id) {
        sendOps([removeItemOp(level, id)]);
        if (build.tool.kind === 'item') setTool({ kind: 'select' });
      }
      return taken();
    }
    case 'KeyE': {
      const story = s.building?.stories[level];
      const item = s.buildCursor.hover && story?.items.find((i) => i.id === s.buildCursor.hover);
      if (item && story) {
        setTool({ kind: 'item', def: item.def, rot: worldRotOf(story, item), carry: null, blockId: item.blockId ?? null });
        // A copy of a small thing looks like it and stands as it stands.
        if (item.on !== undefined) {
          hand.look = item.look ?? 0;
          hand.ang = item.ang ?? 0;
        }
      }
      return taken();
    }
    case 'Tab':
      return taken();
  }
  return false;
}
