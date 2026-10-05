// Move mode: the owner drags, nudges and turns one block as a preview, then places it or puts it back.
import type { BlockId, BlockPlace, Company, Turns } from '../../shared/protocol.ts';
import { PLACE_STEP, placeProblem, placementOf, snapPlace } from '../../shared/placement.ts';
import { runtime } from './runtime.ts';
import { get, send, set } from './store.ts';

export type Arranging = { blockId: BlockId; place: BlockPlace };

export function startArranging(blockId: BlockId) {
  const block = get().company?.blocks.find((b) => b.id === blockId);
  if (!block) return;
  set({ arranging: { blockId, place: placementOf(block) }, modal: null, menu: null, selectedId: null });
}

export function arrangeProblem(a: Arranging, company: Company | null): string | null {
  return placeProblem(a.place, company?.blocks.filter((b) => b.id !== a.blockId) ?? []);
}

export function moveArranging(place: BlockPlace) {
  const a = get().arranging;
  if (a) set({ arranging: { ...a, place: snapPlace(place) } });
}

// One grid step the way the arrow points on screen, along whichever room axis is closest to it.
export function nudgeArranging(up: number, right: number) {
  const a = get().arranging;
  if (!a) return;
  const { yaw } = runtime.view;
  const dx = Math.sin(yaw) * up - Math.cos(yaw) * right;
  const dz = Math.cos(yaw) * up + Math.sin(yaw) * right;
  const alongX = Math.abs(dx) >= Math.abs(dz);
  moveArranging({ ...a.place, x: a.place.x + (alongX ? Math.sign(dx) * PLACE_STEP : 0), z: a.place.z + (alongX ? 0 : Math.sign(dz) * PLACE_STEP) });
}

export function turnArranging(by: 1 | -1) {
  const a = get().arranging;
  if (a) set({ arranging: { ...a, place: { ...a.place, turns: (((a.place.turns + by) % 4) + 4) % 4 as Turns } } });
}

export function placeArranging() {
  const { arranging: a, company } = get();
  if (!a || arrangeProblem(a, company)) return;
  const block = company?.blocks.find((b) => b.id === a.blockId);
  const was = block && placementOf(block);
  if (was && (was.x !== a.place.x || was.z !== a.place.z || was.turns !== a.place.turns)) send({ type: 'update_block', blockId: a.blockId, place: a.place });
  set({ arranging: null });
}

export const cancelArranging = () => set({ arranging: null });
