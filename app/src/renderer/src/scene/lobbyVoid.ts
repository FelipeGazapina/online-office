import type { Building } from '../../../shared/space/index.ts';
import { LOBBY_Z0 } from '../../../shared/space/kit.ts';

/** The ceiling of the lobby lifts to this height inside the void. The rest of the building keeps its 2.9 m ceiling. */
export const VOID_TOP = 6.4;

export type VoidRect = { x0: number; x1: number; z0: number; z1: number };

/**
 * The lobby is a double-height hall: from the glass partition south to the front wall, west wall to east wall. Only a
 * one-story building has it; a second story would sit in the void.
 */
export function lobbyVoid(b: Building | null): VoidRect | null {
  if (!b || b.bare || b.stories.length !== 1 || b.lot.w < 24) return null;
  return { x0: b.lot.x0, x1: b.lot.x0 + b.lot.w, z0: LOBBY_Z0 + 3, z1: b.lot.z0 + b.lot.h };
}

export const inVoid = (r: VoidRect | null, x: number, z: number): boolean => !!r && x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
