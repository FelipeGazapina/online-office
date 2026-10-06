// No model, no Electron, no three. Where a task card held over the office lands: the desk a camera ray points at, and what
// dropping there would do (assign, hire, refuse). Run from app/: node verify/desk-drop-check.ts   Exits 1 on any failed check.
import type { BlockId, Company, Employee, EmployeeId, ModelId } from '../src/shared/protocol.ts';
import { ITEM_DEFS, STORY_H, legacyBuilding, seatPose, type Building, type ItemId } from '../src/shared/space/index.ts';
import { barOf, hangCard, type Box } from '../src/renderer/src/carry.ts';
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

console.log('\n# the words on the bar and on the card in hand');
{
  const c = company();
  const none = new Set<EmployeeId>();
  const desk = (d: ItemId) => building.stories[0]!.items.find((i) => i.id === d)!;
  const aim = (d: ItemId, running = none) => ({ deskId: d, story: 0, verdict: verdictFor(desk(d), B1, c, running) });
  const ana = barOf(aim(bench(B1, 0)), null, 'todo');
  check(ana.tone === 'go' && ana.chip === 'Give it to Ana' && /give it to Ana/.test(ana.text) && /starts at once/.test(ana.text), 'over Ana: the card says "Give it to Ana" and the bar says she starts at once', JSON.stringify(ana));
  const pia = barOf(aim(po(B1)), null, 'todo');
  check(pia.tone === 'go' && /Pia, the PO/.test(pia.text), 'over the PO: the bar names the PO', pia.text);
  const again = barOf(aim(bench(B1, 0), new Set(['ana' as EmployeeId])), null, 'todo');
  check(again.tone === 'same' && again.chip === 'Already on it' && /already on it/.test(again.text) && /changes nothing/.test(again.text), 'over someone already on it: it says nothing changes', again.text);
  const hire = barOf(aim(bench(B1, 4)), null, 'todo');
  check(hire.tone === 'go' && hire.chip === 'Hire for this desk' && /Empty desk/.test(hire.text) && /hire/.test(hire.text) && !/give it to/.test(hire.text), 'over an empty desk: it talks about hiring and never about the person there', hire.text);
  const refuse = barOf(aim(bench(B2, 0)), null, 'todo');
  check(refuse.tone === 'stop' && refuse.text === labelOf(aim(bench(B2, 0)).verdict) && /Billing/.test(refuse.text) && refuse.chip === 'Not there', 'over another block\'s desk: the bar gives the reason', refuse.text);
  const stage = barOf(null, 'doing', 'todo');
  check(stage.tone === 'go' && stage.chip === 'Move to In Progress' && /move it to In Progress/.test(stage.text), 'over a stage chip: it says move to that stage', stage.text);
  const here = barOf(null, 'todo', 'todo');
  check(here.tone === 'same' && /already in Todo/.test(here.text), 'over the stage it came from: it says it is already there', here.text);
  const idle = barOf(null, null, 'todo');
  check(idle.tone === 'idle' && idle.chip === 'Hold it over a desk' && /over a desk/.test(idle.text), 'over nothing: it says how to start', idle.text);
  check(barOf(aim(bench(B1, 0)), 'doing', 'todo').chip === 'Give it to Ana', 'a desk answers before a stage');
  const texts = [ana, pia, again, hire, refuse, stage, here, idle].map((b) => b.text);
  check(new Set(texts).size === texts.length && !texts.some((t) => /the person there/.test(t) && t !== idle.text), 'every target has its own wording, and "the person there" is only the hint for nothing');
}

console.log('\n# where the card in hand hangs');
{
  const screen: Box = { left: 0, top: 0, right: 1440, bottom: 900 };
  const size = { w: 190, h: 76 };
  const at = (b: Box, p: { x: number; y: number }, s = size): Box => ({ left: b.left + p.x, top: b.top + p.y, right: b.left + p.x + s.w, bottom: b.top + p.y + s.h });
  const hits = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const pointer = { x: 700, y: 400 };
  const origin: Box = { left: pointer.x, top: pointer.y, right: pointer.x, bottom: pointer.y };
  const open = hangCard(pointer, size, [], screen, null);
  check(open.x > 0 && open.y > 0 && open.x < 40 && open.y < 40, 'with nothing in the way it hangs below and to the right, close to the pointer', JSON.stringify(open));
  const tag: Box = { left: 700, top: 430, right: 820, bottom: 470 };
  const moved = hangCard(pointer, size, [tag], screen, null);
  check(!hits(at(origin, moved), tag), 'a tag where it would hang moves it off the tag', JSON.stringify(moved));
  check(!hits(at({ ...origin }, moved), { ...tag, left: tag.left - 10, right: tag.right + 10, top: tag.top - 10, bottom: tag.bottom + 10 }), 'and keeps a margin from it');
  // A row of tags across the screen below the pointer and one above: the card finds the gap, or goes out to the side.
  const rows: Box[] = [{ left: 100, top: 440, right: 1340, bottom: 480 }, { left: 100, top: 330, right: 1340, bottom: 370 }];
  const squeezed = hangCard(pointer, size, rows, screen, null);
  check(rows.every((r) => !hits(at(origin, squeezed), r)), 'between two rows of tags it still covers none', JSON.stringify(squeezed));
  // Every spot around the pointer is a tag: the least covered one wins rather than throwing.
  const wall: Box[] = [{ left: 0, top: 0, right: 1440, bottom: 900 }];
  const lost = hangCard(pointer, size, wall, screen, null);
  check(Number.isFinite(lost.x) && Number.isFinite(lost.y), 'with no free spot it still answers');
  // The pointer at the bottom right corner: the card hangs up and to the left, inside the window.
  const corner = { x: 1430, y: 890 };
  const cornered = hangCard(corner, size, [], screen, null);
  const box = at({ left: corner.x, top: corner.y, right: corner.x, bottom: corner.y }, cornered);
  check(box.left >= 0 && box.top >= 0 && box.right <= 1440 && box.bottom <= 900 && cornered.x < 0 && cornered.y < 0, 'at the corner of the window it hangs inside it', JSON.stringify(cornered));
  // Stability: a slot that still fits is kept while a tag drifts by a pixel elsewhere, so the card does not hop.
  const first = hangCard(pointer, size, [tag], screen, null);
  const second = hangCard(pointer, size, [{ ...tag, left: tag.left + 1, right: tag.right + 1 }], screen, first);
  check(second.x === first.x && second.y === first.y, 'the card stays where it hangs while that spot stays free');
  const freed = hangCard(pointer, size, [], screen, first);
  check(freed.x === first.x && freed.y === first.y, 'and stays there once the tag is gone, as near as the free spot already is');
  const far = hangCard(pointer, size, [], screen, { x: 250, y: 250 });
  check(far.x < 40 && far.y < 40, 'but a spot far from the pointer is not kept when a near one is free', JSON.stringify(far));
  const onPointer = hangCard(pointer, size, [], screen, { x: -20, y: -20 });
  check(!(onPointer.x < 0 && onPointer.x + size.w > 0 && onPointer.y < 0 && onPointer.y + size.h > 0), 'a place that now sits on the pointer is never kept', JSON.stringify(onPointer));
  // Bigger card (the line under it grew): the answer is re-worked for the new size.
  const wide = hangCard(pointer, { w: 320, h: 76 }, [tag], screen, first);
  check(!hits(at(origin, wide, { w: 320, h: 76 }), tag), 'a wider card is placed clear of the tag too', JSON.stringify(wide));
}

finish();
