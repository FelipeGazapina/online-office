// A desk that moves takes its sitter along. The sim keeps a seated person where they are, so after the building changes
// (a move, an undo, a block turned) every seated employee is put on the chair of the desk they are assigned to.
import { runtime } from '../../runtime.ts';
import { seatFor } from '../../sim.ts';
import { get } from '../../store.ts';
import { floorBase, worldFor } from '../../world.ts';

const SAME_SPOT = 0.05;

export function reseatSeated() {
  const { company, building, meetingDoor } = get();
  const world = worldFor(building, meetingDoor);
  if (!company || !world) return;
  for (const e of company.employees) {
    const av = runtime.avatars.get(e.id);
    if (!av?.seated) continue;
    const { chair, floor } = seatFor(e, world);
    if (av.floor === floor && Math.hypot(av.pos.x - chair.x, av.pos.z - chair.z) < SAME_SPOT) continue;
    av.floor = floor;
    av.climb = null;
    av.route = null;
    av.pos.set(chair.x, floorBase(floor), chair.z);
  }
}
