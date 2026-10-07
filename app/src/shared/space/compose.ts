// A vignette put down on a host: its members as ordinary top items. After this the group is gone; each piece is picked, turned, moved and
// deleted on its own like any other small thing.
import { ITEM_DEFS } from './catalog.ts';
import { topSize } from './surface.ts';
import type { ItemDef, ItemId, Rot, TopItem } from './types.ts';

// One quarter turn inside a w by d box, the map `rotateLocal` applies to a point, for the corners of a member's rect.
function turnPoint(rot: Rot, x: number, z: number, w: number, d: number): [number, number] {
  switch (rot) {
    case 0:
      return [x, z];
    case 1:
      return [d - z, x];
    case 2:
      return [w - x, d - z];
    case 3:
      return [z, w - x];
  }
}

/**
 * The items a vignette `def` becomes on `host`, turned `rot` quarter turns relative to the host with the corner of its turned footprint at
 * (u, v), in the look `look` (each member takes its own look that many on). `idOf` makes a fresh id for each.
 */
export function composeVignette(def: ItemDef, host: ItemId, spot: { rot: Rot; u: number; v: number }, look: number, idOf: (member: string, n: number) => ItemId): TopItem[] {
  const group = def.group;
  if (!group || !def.top) return [];
  const { w, d } = def.top;
  const out: TopItem[] = [];
  group.forEach((m, n) => {
    const member = ITEM_DEFS[m.def];
    if (!member) return;
    const rot0 = (m.rot ?? 0) as Rot;
    const size = topSize(member, rot0);
    const a = turnPoint(spot.rot, m.u, m.v, w, d);
    const b = turnPoint(spot.rot, m.u + size.w, m.v + size.d, w, d);
    const looks = member.looks ?? 1;
    const shown = looks > 1 ? ((m.look ?? 0) + look) % looks : 0;
    const item: TopItem = { id: idOf(m.def, n), def: m.def, on: host, rot: ((rot0 + spot.rot) % 4) as Rot, u: spot.u + Math.min(a[0], b[0]), v: spot.v + Math.min(a[1], b[1]) };
    if (shown) item.look = shown;
    if (m.ang) item.ang = m.ang;
    if (m.lvl) item.lvl = m.lvl;
    out.push(item);
  });
  return out.sort((p, q) => (p.lvl ?? 0) - (q.lvl ?? 0));
}
