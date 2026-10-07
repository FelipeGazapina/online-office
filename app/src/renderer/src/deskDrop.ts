// Where a task card held over the office would land. Pure: no three, no React, no store, so verify/desk-drop-check.ts
// runs it in Node. The scene turns the pointer into a ray, `deskUnder` finds the desk it points at, and `verdictFor` says
// what dropping there would do. The same verdict drives the highlight, the label and the drop.
import { headcountCap, type BlockId, type Company, type EmployeeId, type EmployeeRole } from '../../shared/protocol.ts';
import { ITEM_DEFS, STORY_H, rotateLocal, type Building, type FloorItem, type ItemId } from '../../shared/space/index.ts';
import { floorItems, itemRect } from '../../shared/space/geom.ts';

type Vec3 = readonly [number, number, number];
export type Ray = { o: Vec3; d: Vec3 };

// A desktop counts as under the pointer a little beyond its edge, and so does the chair and the person in it.
const REACH = 0.18;
const SEAT_REACH = 0.5;

const isDesk = (def: string | undefined) => def !== undefined && (ITEM_DEFS[def]?.kind === 'bench_desk' || ITEM_DEFS[def]?.kind === 'po_desk');

export type DeskHit = { story: number; item: FloorItem };

// The desk a ray from the camera points at, on the stories up to `top` (the ones drawn). The ray is cut by the plane of each
// desktop. The highest story with a desk at that point answers, since it is the one in front, and within a story the desk the
// point is closest to, so two desks that touch share their edge fairly.
export function deskUnder(b: Building, top: number, ray: Ray): DeskHit | null {
  const [ox, oy, oz] = ray.o;
  const [dx, dy, dz] = ray.d;
  if (Math.abs(dy) < 1e-6) return null;
  for (let story = Math.min(top, b.stories.length - 1); story >= 0; story--) {
    let best: { item: FloorItem; away: number } | null = null;
    for (const item of floorItems(b.stories[story]!)) {
      if (!isDesk(item.def)) continue;
      const def = ITEM_DEFS[item.def]!;
      const t = (story * STORY_H + def.height - oy) / dy;
      if (t <= 0) continue;
      const x = ox + dx * t;
      const z = oz + dz * t;
      const r = itemRect(item, def);
      const fromTop = Math.hypot(Math.max(r.x0 / 2 - x, 0, x - r.x1 / 2), Math.max(r.z0 / 2 - z, 0, z - r.z1 / 2));
      const chair = def.seat ? rotateLocal(def, item.rot, def.seat.chair) : null;
      const fromChair = chair ? Math.hypot(x - (item.x + chair.x) / 2, z - (item.z + chair.z) / 2) : Infinity;
      if (fromTop > REACH && fromChair > SEAT_REACH) continue;
      const away = Math.min(fromTop, fromChair);
      if (!best || away < best.away) best = { item, away };
    }
    if (best) return { story, item: best.item };
  }
  return null;
}

export type Occupant = { id: EmployeeId; name: string; po: boolean };

export type Verdict =
  // The task goes to whoever sits here. `already` is when they are running it now.
  | { kind: 'assign'; to: Occupant; already: boolean }
  // Nobody sits here: the owner hires someone into this desk, and they start the task.
  | { kind: 'hire'; blockId: BlockId; role: EmployeeRole }
  | { kind: 'refuse'; message: string };

export type Aim = { deskId: ItemId; story: number; verdict: Verdict };

// What dropping a task of `taskBlock` on `desk` does. `running` is who is working on the task right now.
export function verdictFor(desk: FloorItem, taskBlock: BlockId, company: Company, running: ReadonlySet<EmployeeId>): Verdict {
  const nameOf = (id: string | undefined) => company.blocks.find((x) => x.id === id)?.name ?? 'another block';
  if (desk.blockId !== taskBlock) return { kind: 'refuse', message: `That desk belongs to ${nameOf(desk.blockId)}. A task goes to a desk in its own block, ${nameOf(taskBlock)}.` };
  const sitter = company.employees.find((e) => e.seat === desk.id);
  if (sitter) return { kind: 'assign', to: { id: sitter.id, name: sitter.name, po: sitter.role === 'orchestrator' }, already: running.has(sitter.id) };
  const cap = headcountCap(company.level);
  if (company.employees.length >= cap) return { kind: 'refuse', message: `Headcount cap reached (${cap} at level ${company.level}). Earn XP to grow the company.` };
  return { kind: 'hire', blockId: taskBlock, role: ITEM_DEFS[desk.def]?.kind === 'po_desk' ? 'orchestrator' : 'employee' };
}

// The words on the desk and on the card in hand.
export function labelOf(v: Verdict): string {
  switch (v.kind) {
    case 'assign':
      return v.already ? `${v.to.name} is already on it` : `${v.to.name}${v.to.po ? ' · PO' : ''}`;
    case 'hire':
      return v.role === 'orchestrator' ? 'Empty PO desk: hire' : 'Empty desk: hire';
    case 'refuse':
      return v.message;
  }
}

// How the highlight is drawn: green when dropping would do something, red when it is refused, amber when nothing would change.
export type Tone = 'go' | 'stop' | 'same';
export const toneOf = (v: Verdict): Tone => (v.kind === 'refuse' ? 'stop' : v.kind === 'assign' && v.already ? 'same' : 'go');
