// What a task card in hand is over in the office at a pixel, as an `Aim`. The only part of the drag that needs the 3D scene.
import type { BlockId } from '../../../../shared/protocol.ts';
import type { Task } from '../../../../shared/tasks.ts';
import { deskUnder, verdictFor, type Aim } from '../../deskDrop.ts';
import { rayAt } from '../../scene/pickView.ts';
import { get, set } from '../../store.ts';

// Only the office answers. A toast, the tray or any other piece of HUD under the pointer means the card is not over a desk,
// even when a desk is drawn behind it.
const onOffice = (x: number, y: number) => !!document.elementFromPoint(x, y)?.closest('.stage');

export function aimAt(x: number, y: number, task: Task, blockId: BlockId): Aim | null {
  const { building, company, story, taskTime } = get();
  if (!building || !company || !onOffice(x, y)) return null;
  const ray = rayAt(x, y);
  const hit = ray && deskUnder(building, story, ray);
  if (!hit) return null;
  const running = new Set(taskTime[task.id]?.running.map((r) => r.employeeId));
  return { deskId: hit.item.id, story: hit.story, verdict: verdictFor(hit.item, blockId, company, running) };
}

// The store hears about it only when the card moves to another desk or the verdict changes, not on every pointer move.
export function setAim(next: Aim | null) {
  const now = get().aim;
  if (now === next || (now && next && now.deskId === next.deskId && JSON.stringify(now.verdict) === JSON.stringify(next.verdict))) return;
  set({ aim: next });
}
