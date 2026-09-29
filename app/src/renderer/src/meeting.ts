import { MEETING_ROOM } from './layout.ts';
import { runtime } from './runtime.ts';
import { get, send, toast } from './store.ts';

export function ownerInsideMeetingRoom() {
  const p = runtime.owner.pos;
  const r = MEETING_ROOM;
  return p.x >= r.x0 + 0.45 && p.x <= r.x1 - 0.35 && p.z >= r.z0 + 0.45 && p.z <= r.z1 - 0.45;
}

export function nearMeetingDoor() {
  const p = runtime.owner.pos;
  const r = MEETING_ROOM;
  return Math.hypot(p.x - (r.x1 - 0.2), p.z - r.doorZ) <= 1.8;
}

/** Toggle only from the owner's body inside the room, so a stale or scripted renderer cannot operate remotely. */
export function toggleMeetingDoor(requireNearby = true) {
  if (!ownerInsideMeetingRoom()) {
    if (!requireNearby) toast('Walk into the meeting room before using its door.', 'warn');
    return false;
  }
  if (requireNearby && !nearMeetingDoor()) return false;
  const state = get();
  send({ type: 'meeting_door', state: state.meetingDoor === 'open' ? 'closed' : 'open' });
  return true;
}
