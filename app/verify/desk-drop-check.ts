// No model, no Electron, no three. Where a task card held over the office lands: the desk a camera ray points at, and what
// dropping there would do (assign, hire, refuse). Run from app/: node verify/desk-drop-check.ts   Exits 1 on any failed check.
import type { BlockId, Company, Employee, EmployeeId, ModelId } from '../src/shared/protocol.ts';
import { ITEM_DEFS, STORY_H, legacyBuilding, seatPose, type Building, type ItemId } from '../src/shared/space/index.ts';
import { deskUnder, labelOf, toneOf, verdictFor, type Ray } from '../src/renderer/src/deskDrop.ts';
import { check, finish } from './check.ts';

const B1 = 'block-1' as BlockId;
const B2 = 'block-2' as BlockId;
const id = (s: string) => s as ItemId;

const blocks = [{ id: B1, slot: 0 }, { id: B2, slot: 1 }];
const people = [
  { id: 'pia' as EmployeeId, blockId: B1, desk: -1, orchestrator: true },
  { id: 'ana' as EmployeeId, blockId: B1, desk: 0, orchestrator: false },
  { id: 'bruno' as EmployeeId, blockId: B2, desk: 0, orchestrator: false },
];
const { building, seats } = legacyBuilding(blocks, people);

const employee = (e: (typeof people)[number], name: string): Employee => ({
  id: e.id,
  name,
  provider: 'claude-code',
  ...(e.orchestrator ? { role: 'orchestrator' as const } : {}),
  blockId: e.blockId,
  seat: seats.get(e.id) ?? null,
  status: { kind: 'idle' },
  activity: '',
  model: 'm' as ModelId,
  permissions: { mode: 'ask', alwaysAllow: [] },
  subagents: [],
  hiredAt: 0,
});
const company = (level = 5): Company => ({
  name: 'Acme',
  level,
  xp: 0,
  settings: { seats: { total: 10, perBlock: 6 }, defaultModels: {}, defaultPermissions: 'ask' },
  blocks: [
    { id: B1, name: 'Checkout', cwd: '/a', color: '#fff', slot: 0 },
    { id: B2, name: 'Billing', cwd: '/b', color: '#000', slot: 1 },
  ],
  employees: [employee(people[0]!, 'Pia'), employee(people[1]!, 'Ana'), employee(people[2]!, 'Bruno')],
});

const bench = (blockId: string, n: number) => id(`${blockId}:bench_desk:${String(n).padStart(2, '0')}`);
const po = (blockId: string) => id(`${blockId}:po_desk:00`);
const deskPose = (desk: ItemId) => seatPose(building, desk);

// A camera 8 m up and 6 m back, looking at the point: the shape of the overview camera.
const ray = (x: number, y: number, z: number): Ray => {
  const o = [x - 5, 8, z + 6] as const;
  const to = [x, y, z] as const;
  const len = Math.hypot(to[0] - o[0], to[1] - o[1], to[2] - o[2]);
  return { o, d: [(to[0] - o[0]) / len, (to[1] - o[1]) / len, (to[2] - o[2]) / len] };
};
const overDesk = (desk: ItemId) => {
  const p = deskPose(desk).desk;
  return ray(p.x, ITEM_DEFS.bench_desk!.height, p.z);
};

console.log('# the desk under a ray');
{
  check(seats.get('ana' as EmployeeId) === bench(B1, 0) && seats.get('pia' as EmployeeId) === po(B1) && seats.get('bruno' as EmployeeId) === bench(B2, 0), 'the fixture seats Ana at block 1 bench 0, Pia at its PO desk, Bruno in block 2');
  for (const desk of [bench(B1, 0), bench(B1, 3), po(B1), bench(B2, 0), bench(B2, 5)]) {
    const hit = deskUnder(building, 0, overDesk(desk));
    check(hit?.item.id === desk && hit.story === 0, `a ray at the top of ${desk} finds that desk`, JSON.stringify(hit));
  }
  const down: Ray = { o: [deskPose(bench(B1, 1)).desk.x, 6, deskPose(bench(B1, 1)).desk.z], d: [0, -1, 0] };
  check(deskUnder(building, 0, down)?.item.id === bench(B1, 1), 'straight down works too');
  const aisle = { x: deskPose(bench(B1, 0)).desk.x + 6, z: deskPose(bench(B1, 0)).desk.z + 6 };
  check(deskUnder(building, 0, ray(aisle.x, 0, aisle.z)) === null, 'a ray at open floor finds no desk');
  const chair = deskPose(bench(B1, 0)).chair;
  check(deskUnder(building, 0, ray(chair.x, 0.75, chair.z))?.item.id === bench(B1, 0), 'the chair and the person in it count as the desk');
  // Two desks that touch: a point just inside either one belongs to that one, though each reaches a little into the other.
  const benches = building.stories[0]!.items.filter((i) => i.def === 'bench_desk' && i.blockId === B1);
  const edge = (i: (typeof benches)[number]) => {
    const d = ITEM_DEFS.bench_desk!;
    const w = i.rot % 2 === 0 ? d.w : d.d;
    const h = i.rot % 2 === 0 ? d.d : d.w;
    return { x0: i.x / 2, x1: (i.x + w) / 2, z0: i.z / 2, z1: (i.z + h) / 2 };
  };
  const pair = benches.flatMap((a) => benches.filter((c) => c !== a && edge(a).x1 === edge(c).x0 && edge(a).z0 === edge(c).z0).map((c) => [a, c] as const))[0];
  if (pair) {
    const [a, c] = [edge(pair[0]), edge(pair[1])];
    const zMid = (a.z0 + a.z1) / 2;
    check(deskUnder(building, 0, ray(a.x1 - 0.05, 0.75, zMid))?.item.id === pair[0].id && deskUnder(building, 0, ray(c.x0 + 0.05, 0.75, zMid))?.item.id === pair[1].id, 'two desks that touch each get the points just inside their own edge');
  } else check(false, 'the fixture has two bench desks side by side');
  const wb = building.stories[0]!.items.find((i) => i.def === 'whiteboard' && i.blockId === B1)!;
  check(deskUnder(building, 0, ray((wb.x + 4) / 2, 1, (wb.z + 0.5) / 2)) === null, 'furniture that is not a desk is not a target');
  check(deskUnder(building, 0, { o: [0, 8, 0], d: [0, 1, 0] }) === null, 'a ray pointing up finds nothing');
  check(deskUnder(building, 0, { o: [0, 8, 0], d: [1, 0, 0] }) === null, 'a level ray finds nothing');
  const ownerDesk = building.stories[0]!.items.find((i) => i.def === 'owner_desk')!;
  check(deskUnder(building, 0, ray(ownerDesk.x / 2 + 0.7, 0.75, ownerDesk.z / 2 + 0.5))?.item.def !== 'owner_desk', 'the owner\'s own desk is not a target');
}

console.log('\n# a second story');
{
  const base = building.stories[0]!;
  const upstairs: Building = {
    ...building,
    stories: [base, { ...base, items: base.items.filter((i) => i.def === 'bench_desk' && i.blockId === B1).map((i) => ({ ...i, id: id(`up:${i.id}`) })) }],
  };
  const p = deskPose(bench(B1, 0)).desk;
  const above: Ray = { o: [p.x, 3 * STORY_H, p.z], d: [0, -1, 0] };
  check(deskUnder(upstairs, 1, above)?.story === 1, 'with the upper story drawn, the desk upstairs answers first');
  check(deskUnder(upstairs, 0, above)?.story === 0, 'with only the ground floor drawn, the desk upstairs is not there');
}

console.log('\n# what a drop does');
{
  const c = company();
  const none = new Set<EmployeeId>();
  const desk = (d: ItemId) => building.stories[0]!.items.find((i) => i.id === d)!;

  const onAna = verdictFor(desk(bench(B1, 0)), B1, c, none);
  check(onAna.kind === 'assign' && onAna.to.name === 'Ana' && !onAna.to.po && !onAna.already && labelOf(onAna) === 'Ana' && toneOf(onAna) === 'go', 'an employee\'s desk assigns to them, labelled with their name, lit green', JSON.stringify(onAna));
  const onPia = verdictFor(desk(po(B1)), B1, c, none);
  check(onPia.kind === 'assign' && onPia.to.po && labelOf(onPia) === 'Pia · PO', 'the PO desk assigns to the PO', labelOf(onPia));
  const again = verdictFor(desk(bench(B1, 0)), B1, c, new Set(['ana' as EmployeeId]));
  check(again.kind === 'assign' && again.already && toneOf(again) === 'same' && /already/.test(labelOf(again)), 'someone already running the task is said so, and nothing would change');

  const empty = verdictFor(desk(bench(B1, 4)), B1, c, none);
  check(empty.kind === 'hire' && empty.blockId === B1 && empty.role === 'employee' && labelOf(empty) === 'Empty desk: hire' && toneOf(empty) === 'go', 'an empty bench desk hires an employee', JSON.stringify(empty));
  const noPo = { ...c, employees: c.employees.filter((e) => e.role !== 'orchestrator') };
  const emptyPo = verdictFor(desk(po(B1)), B1, noPo, none);
  check(emptyPo.kind === 'hire' && emptyPo.role === 'orchestrator' && labelOf(emptyPo) === 'Empty PO desk: hire', 'an empty PO desk hires a PO', JSON.stringify(emptyPo));

  const other = verdictFor(desk(bench(B2, 0)), B1, c, none);
  check(other.kind === 'refuse' && toneOf(other) === 'stop' && /Billing/.test(labelOf(other)) && /Checkout/.test(labelOf(other)), 'a desk of another block is refused and the message names both blocks', labelOf(other));
  const otherEmpty = verdictFor(desk(bench(B2, 4)), B1, c, none);
  check(otherEmpty.kind === 'refuse', 'an empty desk of another block is refused too: no hire across blocks');

  const full = verdictFor(desk(bench(B1, 4)), B1, company(2), none);
  check(full.kind === 'refuse' && /Headcount cap reached \(2 at level 2\)/.test(labelOf(full)), 'a company at its headcount cap cannot hire into an empty desk', labelOf(full));
  check(verdictFor(desk(bench(B1, 0)), B1, company(2), none).kind === 'assign', 'but the cap does not stop an assignment');
}

finish();
