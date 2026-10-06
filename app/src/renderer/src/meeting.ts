import { runtime } from './runtime.ts';
import { get, send, toast } from './store.ts';
import { worldFor } from './world.ts';

const ownerRoom = () => {
  const room = worldFor(get().building, get().meetingDoor)?.ownerRoom;
  return room && room.floor === runtime.owner.floor && !runtime.owner.climb ? room : null;
};

export function ownerInsideMeetingRoom() {
  const room = ownerRoom();
  if (!room) return false;
  const p = runtime.owner.pos;
  const r = room.bbox;
  return p.x >= r.x0 + 0.45 && p.x <= r.x0 + r.w - 0.35 && p.z >= r.z0 + 0.45 && p.z <= r.z0 + r.h - 0.45;
}

export function nearMeetingDoor() {
  const door = ownerRoom()?.doorAt;
  if (!door) return false;
  const p = runtime.owner.pos;
  return Math.hypot(p.x - door.x, p.z - door.z) <= 1.8;
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
