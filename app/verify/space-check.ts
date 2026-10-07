// Proves the pure space module in plain Node. Run: node verify/space-check.ts
import { isDeepStrictEqual } from 'node:util';
import {
  BuildHistory,
  FLOOR_PAINTS,
  ITEM_DEFS,
  PAINT,
  WALL_STYLES,
  addShells,
  applyOps,
  blockAt,
  blockCenter,
  blockItems,
  blockPose,
  cellBounds,
  checkOps,
  closeDoor,
  deriveFloors,
  deskOf,
  drawRoom,
  emptyBuilding,
  encodeBuilding,
  floorItems,
  freeDesk,
  inferSlotPose,
  layerOf,
  legacyBuilding,
  moveBlockOps,
  navOf,
  openDoor,
  paintRect,
  parseBuilding,
  placeBlock,
  placeDesk,
  rotateLocal,
  route,
  seatPose,
  shellItems,
  surfaceAt,
  teamKit,
  drawKey,
  liftOf,
  pointAtHeight,
  restingOn,
  stackSpot,
  topItemAt,
  topOfStack,
  topPose,
  turnBlock,
  validate,
  wallName,
  type Applied,
  type Building,
  type BuildOp,
  type EmployeeId,
  type FloorItem,
  type Item,
  type ItemId,
  type PickRay,
  type ShellOutcome,
  type SpaceContext,
  type ViolationKind,
} from '../src/shared/space/index.ts';
import { coreItems } from '../src/shared/space/kit.ts';
import { check, finish } from './check.ts';

const id = (s: string) => s as ItemId;
const noCtx: SpaceContext = { blocks: new Set(), employees: new Map(), seats: new Map() };
const eq = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const must = (r: Applied): Building => {
  if (!r.ok) throw new Error(`rejected: ${JSON.stringify(r.violations)}`);
  return r.building;
};
const kinds = (r: Applied) => (r.ok ? [] : r.violations.map((v) => v.kind));
const item = (name: string, def: string, x: number, z: number, rot: 0 | 1 | 2 | 3 = 0, blockId?: string): Item =>
  blockId ? { id: id(name), def, x, z, rot, blockId } : { id: id(name), def, x, z, rot };
const put = (story: number, ...items: Item[]): BuildOp => ({ t: 'items', story, put: items, del: [] });

// ---------------------------------------------------------------- catalog
{
  const want = ['bench_desk', 'po_desk', 'owner_desk', 'board_terminal', 'whiteboard', 'team_sign', 'plant', 'sofa', 'coffee_machine', 'meeting_table', 'chair', 'rug', 'bookshelf', 'stairs'];
  check(want.every((d) => ITEM_DEFS[d]), 'catalog has every required item', want.filter((d) => !ITEM_DEFS[d]).join());
  check(FLOOR_PAINTS.length - 1 >= 8, `at least 8 floor paints (${FLOOR_PAINTS.length - 1})`);
  check(WALL_STYLES.length >= 4, `at least 4 wall styles (${WALL_STYLES.length})`);
}

// ---------------------------------------------------------------- inverse and idempotence for every op kind
const flat = (stories = 1, size = 20): Building => {
  const lot = { x0: 0, z0: 0, w: size, h: size };
  let b = emptyBuilding(lot, stories);
  for (let s = 0; s < stories; s++) b = must(applyOps(b, [paintRect(s, { x: 0, z: 0, w: size, h: size }, PAINT.woodLight)], noCtx));
  return b;
};
{
  let base = flat(2);
  base = must(applyOps(base, [...drawRoom(0, { x: 2, z: 2, w: 5, h: 4 }, { style: 1 }), put(0, item('d1', 'bench_desk', 20, 20), item('p1', 'plant', 30, 30))], noCtx));
  const cases: [string, BuildOp[]][] = [
    ['lot', [{ t: 'lot', lot: { x0: -2, z0: 0, w: 24, h: 22 } }]],
    ['stories', [{ t: 'stories', count: 3 }]],
    ['walls', [{ t: 'walls', story: 0, put: [{ x: 10, z: 10, d: 'e', style: 2, open: 'window' }, { x: 2, z: 2, d: 'e', style: 3 }], del: [{ x: 6, z: 2, d: 'e' }] }]],
    ['floor', [{ t: 'floor', story: 0, cells: [{ x: 15, z: 15, half: 0, paint: PAINT.tileDark }, { x: 15, z: 15, half: 0, paint: PAINT.tileWhite }] }]],
    ['floor half', [{ t: 'walls', story: 1, put: [{ x: 8, z: 8, d: 'sd', style: 0 }], del: [] }, { t: 'floor', story: 1, cells: [{ x: 8, z: 8, half: 1, paint: PAINT.carpetRed }] }]],
    ['items', [put(0, item('d1', 'bench_desk', 24, 20, 1), item('c1', 'chair', 36, 36)), { t: 'items', story: 0, put: [], del: [id('p1')] }]],
  ];
  for (const [name, ops] of cases) {
    const r = applyOps(base, ops, noCtx);
    if (!r.ok) {
      check(false, `${name} op applies`, JSON.stringify(r.violations));
      continue;
    }
    check(!eq(r.building, base), `${name} op changes the building`);
    const back = applyOps(r.building, r.inverse, noCtx);
    check(back.ok && eq(back.building, base), `${name} op: inverse restores the input exactly`, back.ok ? '' : JSON.stringify(back.violations));
    const again = applyOps(r.building, ops, noCtx);
    check(again.ok && eq(again.building, r.building), `${name} op: applying twice equals applying once`);
  }
  const all = cases.flatMap(([, ops]) => ops);
  const r = applyOps(base, all, noCtx);
  const back = r.ok && applyOps(r.building, r.inverse, noCtx);
  check(r.ok && back && back.ok && eq(back.building, base), 'all ops as one batch: inverse restores the input exactly', r.ok ? '' : JSON.stringify(r.violations));

  const history = new BuildHistory();
  if (r.ok) {
    history.push({ forward: r.forward, inverse: r.inverse, label: 'batch' });
    const undone = history.undo(r.building, noCtx);
    check(undone?.ok === true && eq(undone.building, base), 'BuildHistory.undo restores the input');
    const redone = undone?.ok ? history.redo(undone.building, noCtx) : null;
    check(redone?.ok === true && eq(redone.building, r.building), 'BuildHistory.redo reapplies');
    check(history.redo(base, noCtx) === null, 'redo with nothing to redo is null');
  }
}

// ---------------------------------------------------------------- rooms
{
  const base = flat(1);
  const roomsOf = (b: Building) => deriveFloors(b)[0].rooms;
  check(roomsOf(base).length === 1, 'an open floor is one room');
  const drawn = must(applyOps(base, drawRoom(0, { x: 5, z: 5, w: 4, h: 3 }), noCtx));
  const rooms = roomsOf(drawn);
  check(rooms.length === 2, `drawing a 4x3 room adds exactly one room (${rooms.length})`);
  const inner = rooms.find((r) => r.area === 12);
  check(!!inner && inner.bbox.w === 4 && inner.bbox.h === 3, 'the new room has area 12 and a 4x3 box');
  const withDoor = must(applyOps(drawn, [{ t: 'walls', story: 0, put: [{ x: 6, z: 5, d: 'e', style: 0, open: 'door' }], del: [] }], noCtx));
  const doored = roomsOf(withDoor);
  check(doored.length === 2 && doored.some((r) => r.area === 12 && r.doors.length === 1), 'a door segment keeps it one room and is listed on it');
  const merged = must(applyOps(withDoor, [{ t: 'walls', story: 0, put: [], del: [{ x: 6, z: 5, d: 'e' }] }], noCtx));
  check(roomsOf(merged).length === 1, 'removing a wall merges the rooms');
}

// ---------------------------------------------------------------- placement rules
{
  let b = flat(1);
  b = must(applyOps(b, [{ t: 'floor', story: 0, cells: Array.from({ length: 20 }, (_, z) => ({ x: 17, z, half: 0 as const, paint: PAINT.none })) }], noCtx));
  b = must(applyOps(b, [{ t: 'walls', story: 0, put: [{ x: 8, z: 8, d: 's', style: 0 }], del: [] }, put(0, item('a', 'bench_desk', 4, 4))], noCtx));
  const cases: [string, Item, ViolationKind][] = [
    ['overlapping another item', item('b', 'bench_desk', 5, 4), 'overlap'],
    ['outside the lot', item('b', 'bench_desk', -2, 4), 'out_of_lot'],
    ['past the far edge of the lot', item('b', 'bench_desk', 39, 4), 'out_of_lot'],
    ['on a tile with no floor', item('b', 'bench_desk', 35, 4), 'no_floor'],
    ['through a wall', item('b', 'bench_desk', 15, 16), 'wall_through_item'],
  ];
  for (const [name, it, kind] of cases) {
    const ops = [put(0, it)];
    const r = applyOps(b, ops, noCtx);
    const c = checkOps(b, ops, noCtx);
    check(!r.ok && kinds(r).includes(kind) && eq(c, r.ok ? [] : r.violations), `placing an item ${name} is rejected as ${kind}; checkOps agrees`, JSON.stringify(c));
  }
  const fine = applyOps(b, [put(0, item('b', 'bench_desk', 12, 4))], noCtx);
  check(fine.ok && checkOps(b, [put(0, item('b', 'bench_desk', 12, 4))], noCtx).length === 0, 'a legal placement is accepted');
  const moved = applyOps(b, [put(0, item('a', 'bench_desk', 5, 4))], noCtx);
  check(moved.ok, 'moving an item over its own old cells is not an overlap');
  const rug = applyOps(b, [put(0, item('r', 'rug', 4, 4))], noCtx);
  check(rug.ok, 'a rug may sit under a desk');
}

// ---------------------------------------------------------------- stairs and floors
{
  const noStairs = flat(2);
  const lacking = validate(noStairs, noCtx).filter((v) => v.kind === 'story_unreachable');
  check(lacking.length === 1 && lacking[0].story === 1, 'a floored story without stairs reports story_unreachable');
  const stairs = item('s1', 'stairs', 10, 10);
  const up = must(applyOps(noStairs, [put(0, stairs)], noCtx));
  const floors = deriveFloors(up);
  check(validate(up, noCtx).length === 0, 'with stairs the building validates clean');
  check(floors[1].hole[5 * 20 + 5] === 1 && floors[1].hole[7 * 20 + 5] === 1 && floors[1].hole[8 * 20 + 5] === 0, 'the first 3 stair tiles open a hole above, the landing does not');
  const legs = route(floors, { floor: 0, x: 2, z: 2 }, { floor: 1, x: 15, z: 15 });
  check(legs?.length === 2 && legs[0].floor === 0 && legs[1].floor === 1 && !!legs[0].via && legs[0].via.itemId === stairs.id, 'route crosses floors in 2 legs through the stairs');
  const via = legs?.[0].via;
  check(!!via && via.heightAt(via.to.at) === 3.2 && via.heightAt(via.from.at) === 0, 'stair height runs 0 to one story');
  const back = route(floors, { floor: 1, x: 15, z: 15 }, { floor: 0, x: 2, z: 2 });
  check(back?.length === 2 && back[0].floor === 1 && back[0].via?.to.floor === 0, 'route also goes down');
  check(route(floors, { floor: 0, x: 2, z: 2 }, { floor: 0, x: 15, z: 15 })?.length === 1, 'same-floor route is one leg');
  check(kinds(applyOps(up, [put(1, item('d', 'bench_desk', 10, 12))], noCtx)).includes('on_hole'), 'an item on the stairwell is rejected as on_hole');
  const gone = must(applyOps(up, [{ t: 'items', story: 0, put: [], del: [stairs.id] }], noCtx));
  check(route(deriveFloors(gone), { floor: 0, x: 2, z: 2 }, { floor: 1, x: 15, z: 15 }) === null, 'removing the stairs makes route null');
  check(validate(gone, noCtx).some((v) => v.kind === 'story_unreachable'), 'removing the stairs reports story_unreachable');
  check(kinds(applyOps(flat(1), [put(0, stairs)], noCtx)).includes('stairs_no_upper_story'), 'stairs need a story above');
  const noLanding = emptyBuilding({ x0: 0, z0: 0, w: 20, h: 20 }, 2);
  const nl = applyOps(noLanding, [paintRect(0, { x: 0, z: 0, w: 20, h: 20 }, PAINT.concrete), put(0, stairs)], noCtx);
  check(kinds(nl).includes('stairs_no_landing'), 'stairs need a floored landing above');
  check(kinds(applyOps(emptyBuilding({ x0: 0, z0: 0, w: 4, h: 4 }, 2), [paintRect(1, { x: 0, z: 0, w: 2, h: 2 }, 1)], noCtx)).includes('floor_unsupported'), 'paint above bare ground is floor_unsupported');
  const seated: SpaceContext = {
    blocks: new Set(['b']),
    employees: new Map([['e', { blockId: 'b', orchestrator: false }]]),
    seats: new Map([['e', id('b:bench_desk:00')]]),
  };
  const withDesk = must(applyOps(up, [put(1, item('b:bench_desk:00', 'bench_desk', 20, 20, 0, 'b'))], seated));
  const strand = applyOps(withDesk, [{ t: 'items', story: 0, put: [], del: [stairs.id] }], seated);
  check(kinds(strand).includes('would_strand_desks'), 'removing the stairs that serve a seated desk is would_strand_desks');
}

// ---------------------------------------------------------------- legacy migration
{
  const blocks = [{ id: 'b1', slot: 0 }, { id: 'b2', slot: 1 }];
  const employees = [
    { id: 'o1', blockId: 'b1', desk: 0, orchestrator: true },
    { id: 'e2', blockId: 'b1', desk: 1, orchestrator: false },
    { id: 'e3', blockId: 'b1', desk: 2, orchestrator: false },
    { id: 'e4', blockId: 'b1', desk: 5, orchestrator: false },
    { id: 'e5', blockId: 'b2', desk: 0, orchestrator: false },
    { id: 'e6', blockId: 'b2', desk: 1, orchestrator: false },
    { id: 'e7', blockId: 'b2', desk: 2, orchestrator: false },
    { id: 'e8', blockId: 'b2', desk: 3, orchestrator: false },
  ];
  const a = legacyBuilding(blocks, employees);
  const b = legacyBuilding(blocks, employees);
  check(eq(a, b), 'legacyBuilding is deterministic');
  const ctx: SpaceContext = {
    blocks: new Set(blocks.map((x) => x.id)),
    employees: new Map(employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.orchestrator }])),
    seats: a.seats,
  };
  const benchOk = employees.filter((e) => !e.orchestrator).every((e) => {
    const it = deskOf(a.building, a.seats, e.id);
    return it?.def === 'bench_desk' && it.blockId === e.blockId && it.id === `${e.blockId}:bench_desk:0${e.desk}`;
  });
  check(benchOk, 'every bench employee sits at the bench desk of its index in its block');
  const po = deskOf(a.building, a.seats, 'o1');
  check(po?.def === 'po_desk' && po.blockId === 'b1' && freeDesk(a.building, a.seats, 'b1', true) === null, 'the orchestrator sits at its block PO desk');
  check(new Set(a.seats.values()).size === a.seats.size, 'no two employees share a desk');
  const floors = deriveFloors(a.building);
  const door = { floor: 0, x: -10, z: 7.8 };
  const unreachable = [...a.seats].filter(([, desk]) => !route(floors, door, { floor: 0, ...seatPose(a.building, desk).exit }));
  check(unreachable.length === 0, 'every seat is reachable from the door', unreachable.map((u) => u[0]).join());
  const owner = deskOf(a.building, a.seats, 'owner');
  check(!!owner && !!route(floors, door, { floor: 0, ...seatPose(a.building, owner.id).exit }), 'the owner desk is reachable from the door');
  const problems = validate(a.building, ctx);
  check(problems.length === 0, 'the migrated building has no violations', JSON.stringify(problems.slice(0, 5)));
  check(a.building.lot.w === 36 && a.building.lot.h === 19 && a.building.lot.x0 === -18 && a.building.lot.z0 === -10, 'lot matches getLayout bounds for 2 blocks');
  const plants = a.building.stories[0].items.filter((i) => i.def === 'plant').length;
  const terminals = a.building.stories[0].items.filter((i) => i.def === 'board_terminal').length;
  check(plants === 7 + 2 * blocks.length && terminals === 2, `7 plants for the office, 2 more and a board terminal for each team (${plants}, ${terminals})`);

  const nav = navOf(floors[0]);
  const room = { floor: 0, ...seatPose(a.building, owner!.id).exit };
  const keys = [wallName({ x: -11, z: 4, d: 's' }), wallName({ x: -11, z: 5, d: 's' })];
  keys.forEach((k) => closeDoor(nav, k));
  check(route(floors, door, room) === null, 'closing the meeting room door cuts the owner off');
  keys.forEach((k) => openDoor(nav, k));
  check(route(floors, door, room) !== null, 'reopening the door restores the way in');

  const crowded = [...employees, { id: 'x1', blockId: 'b2', desk: 3, orchestrator: false }, { id: 'x2', blockId: 'b2', desk: 9, orchestrator: false }];
  const c = legacyBuilding(blocks, crowded);
  check(c.seats.size === crowded.length && new Set(c.seats.values()).size === c.seats.size, 'a clashing or overflow desk index still gets its own desk');

  // teamKit, freeDesk, placeDesk
  let grown = a.building;
  const kitOps = teamKit(grown, 'b3', 2);
  grown = must(applyOps(grown, kitOps, ctx));
  check(freeDesk(grown, new Map(), 'b3', true)?.def === 'po_desk', 'freeDesk(orchestrator) returns the block PO desk');
  check(freeDesk(grown, new Map(), 'b3', false)?.def === 'bench_desk', 'freeDesk returns a bench desk for anyone else');
  check(eq(must(applyOps(grown, kitOps, ctx)), grown), 'a repeated team kit changes nothing');
  const sixSeats = new Map<EmployeeId, ItemId>(Array.from({ length: 6 }, (_, n) => [`k${n}`, id(`b3:bench_desk:0${n}`)]));
  const kitCtx: SpaceContext = { blocks: new Set(['b3']), employees: new Map([...sixSeats.keys()].map((k) => [k, { blockId: 'b3', orchestrator: false }])), seats: sixSeats };
  check(freeDesk(grown, sixSeats, 'b3', false) === null, 'freeDesk is null once the benches are taken');
  const extra = placeDesk(grown, 'b3', false, kitCtx);
  const placed = extra && applyOps(grown, extra, kitCtx);
  check(!!placed?.ok, 'placeDesk finds a legal spot for a seventh desk', JSON.stringify(placed && !placed.ok ? placed.violations : ''));
  if (placed?.ok) check(freeDesk(placed.building, sixSeats, 'b3', false)?.id === 'b3:bench_desk:06', 'the new desk is the next bench desk');
  const swapped = validate(grown, { ...kitCtx, seats: new Map([['k0', id('b3:po_desk:00')]]) });
  check(swapped.some((v) => v.kind === 'desk_wrong_kind'), 'a bench employee at a PO desk is desk_wrong_kind');
  const other = applyOps(grown, [put(0, item('b3:bench_desk:00', 'bench_desk', (floorItems(grown.stories[0]).find((i) => i.id === 'b3:bench_desk:00')!).x, (floorItems(grown.stories[0]).find((i) => i.id === 'b3:bench_desk:00')!).z, 0, 'b1'))], kitCtx);
  check(kinds(other).includes('desk_wrong_block'), 'giving a seated desk to another team is desk_wrong_block');
  const dbl = validate(grown, { ...kitCtx, seats: new Map([['k0', id('b3:bench_desk:01')], ['k1', id('b3:bench_desk:01')]]) });
  check(dbl.some((v) => v.kind === 'desk_double_occupied'), 'two employees on one desk is desk_double_occupied');
  const stale = applyOps(grown, [put(0, item('zz', 'plant', 30, -30))], { ...kitCtx, seats: new Map([['k0', id('b3:po_desk:00')]]) });
  check(stale.ok, 'a seat that was already wrong does not block unrelated edits');
}

// ---------------------------------------------------------------- moving a whole block
{
  const blocks = [{ id: 'b1', slot: 0 }, { id: 'b2', slot: 1 }];
  const employees = [
    { id: 'o2', blockId: 'b2', desk: 0, orchestrator: true },
    { id: 'e1', blockId: 'b2', desk: 0, orchestrator: false },
    { id: 'e2', blockId: 'b2', desk: 3, orchestrator: false },
    { id: 'e3', blockId: 'b1', desk: 1, orchestrator: false },
  ];
  const a = legacyBuilding(blocks, employees);
  const ctx: SpaceContext = {
    blocks: new Set(blocks.map((x) => x.id)),
    employees: new Map(employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.orchestrator }])),
    seats: a.seats,
  };
  const story = a.building.stories[0];
  const items = blockItems(story, 'b2');
  const box = cellBounds(items)!;
  check(items.length === 10 + shellItems('b2', 1).length && items.every((i) => i.blockId === 'b2'), 'blockItems is every item of the block, pod included, and nothing else');

  const turned = (q: 0 | 1 | 2 | 3) => turnBlock(items, q);
  check(eq(turned(0), items), 'no turn leaves the block as it was');
  check(eq(turnBlock(turnBlock(turnBlock(turnBlock(items, 1), 1), 1), 1), items), 'four quarter turns come back to the same items');
  check(eq(turnBlock(turned(1), 1), turned(2)) && eq(turned(3), turnBlock(turned(2), 1)), 'turning by n is n single turns');
  const tb = cellBounds(turned(1))!;
  check(tb.x1 - tb.x0 === box.z1 - box.z0 && tb.z1 - tb.z0 === box.x1 - box.x0 && tb.x0 === box.x0 && tb.z0 === box.z0, 'a quarter turn swaps the bounding box sides and keeps its corner');
  const world = (it: FloorItem, p: { x: number; z: number }) => {
    const l = rotateLocal(ITEM_DEFS[it.def], it.rot, p);
    return { x: it.x + l.x, z: it.z + l.z };
  };
  const depth = box.z1 - box.z0;
  const turnedOk = items.every((old, n) => {
    const now = turned(1)[n];
    const chair = ITEM_DEFS[old.def].seat?.chair;
    if (!chair) return true;
    const was = world(old, chair);
    const want = { x: box.x0 + depth - (was.z - box.z0), z: box.z0 + (was.x - box.x0) };
    const got = world(now, chair);
    return now.rot === (old.rot + 1) % 4 && Math.abs(got.x - want.x) < 1e-9 && Math.abs(got.z - want.z) < 1e-9;
  });
  check(turnedOk, 'every desk chair lands where the whole block turned it');

  const shift = (dx: number, dz: number, quarter: 0 | 1 | 2 | 3 = 0) => moveBlockOps(story, 0, 'b2', { quarter, origin: { x: box.x0 + dx, z: box.z0 + dz } });
  check(shift(0, 0).length === 0, 'a pose that changes nothing makes no op');
  const [east] = shift(16, 0);
  const moved = applyOps(a.building, [east], ctx);
  check(moved.ok && east.t === 'items' && east.put.length === items.length && east.del.length === 0, 'moving a block is one items op over every piece, pod included', moved.ok ? '' : JSON.stringify(moved.violations));
  if (moved.ok) {
    const after = blockItems(moved.building.stories[0], 'b2');
    check(after.length === items.length && after.every((n, k) => n.id === items[k].id && n.x === items[k].x + 16 && n.z === items[k].z && n.rot === items[k].rot && n.blockId === 'b2'), 'every piece keeps its id, team and turn, and moves 8 m east together');
    check(eq(blockItems(moved.building.stories[0], 'b1'), blockItems(story, 'b1')), 'the other block did not move');
    const seatsHold = [...a.seats].every(([emp, desk]) => deskOf(moved.building, a.seats, emp)?.id === desk) && validate(moved.building, ctx).length === 0;
    check(seatsHold, 'every employee still sits at the same desk id and the building validates clean');
    const e1 = a.seats.get('e1' as EmployeeId)!;
    check(seatPose(moved.building, e1).chair.x === seatPose(a.building, e1).chair.x + 8, 'the seat of a moved desk is 8 m east of where it was');
    const back = applyOps(moved.building, moved.inverse, ctx);
    check(back.ok && eq(back.building, a.building), 'the inverse puts the block back exactly');
    const history = new BuildHistory();
    history.push({ forward: moved.forward, inverse: moved.inverse, label: 'build' });
    const undone = history.undo(moved.building, ctx);
    const redone = undone?.ok ? history.redo(undone.building, ctx) : null;
    check(undone?.ok === true && eq(undone.building, a.building) && redone?.ok === true && eq(redone.building, moved.building), 'undo and redo carry the whole block');
  }

  const bad: [string, BuildOp | undefined, ViolationKind][] = [
    ['onto the other block', shift(-24, 0)[0], 'overlap'],
    ['out of the lot', shift(60, 0)[0], 'out_of_lot'],
    ['over bare ground', shift(16, 0)[0], 'no_floor'],
  ];
  const holed = must(applyOps(a.building, [{ t: 'floor', story: 0, cells: [{ x: 8, z: -5, half: 0, paint: PAINT.none }] }], ctx));
  for (const [name, op, kind] of bad) {
    const on = kind === 'no_floor' ? holed : a.building;
    const r = op && applyOps(on, [op], ctx);
    check(!!op && !!r && !r.ok && kinds(r).includes(kind) && eq(checkOps(on, [op], ctx), r.ok ? [] : r.violations), `a block moved ${name} is rejected as ${kind}, and checkOps agrees`, r ? JSON.stringify(kinds(r)) : 'no op');
  }
  check(applyOps(a.building, shift(2, 0), ctx).ok, "a nudge that lands on the block's own old cells is not an overlap");

  const dropped = blockPose(items, 1, { x: 24, z: -20 });
  const turnedAt = placeBlock(items, dropped);
  const turnedBox = cellBounds(turnedAt)!;
  check(turnedBox.x1 - turnedBox.x0 === depth && Math.abs((turnedBox.x0 + turnedBox.x1) / 2 - 24) <= 0.5 && Math.abs((turnedBox.z0 + turnedBox.z1) / 2 + 20) <= 0.5, 'blockPose puts the turned block on the asked middle');
  const spun = applyOps(a.building, moveBlockOps(story, 0, 'b2', dropped), ctx);
  check(!spun.ok && kinds(spun).length > 0, 'a block turned where it does not fit is rejected', spun.ok ? 'accepted' : '');

  const desk = items.find((i) => i.def === 'bench_desk')!;
  check(blockAt(story, { x: (desk.x + 1) * 0.5, z: (desk.z + 0.5) * 0.5 }) === 'b2', 'a point on a desk picks its block');
  check(blockAt(story, { x: (box.x0 + box.x1) / 4, z: (box.z0 + box.z1) / 4 }) === 'b2', 'a point on the floor between the pieces picks the block whose bounding box holds it');
  check(blockAt(story, { x: 14, z: 7 }) === null, 'a point outside every block picks nothing');
  check(blockAt(story, { x: (box.x0 - 0.5) / 2, z: (box.z0 + box.z1) / 4 }) !== 'b2', 'a point just outside the block does not pick it');
}

// ---------------------------------------------------------------- the pod around a block
{
  const mismatch = Object.values(ITEM_DEFS).filter((d) => d.walkable !== (layerOf(d) === 'floor')).map((d) => d.id);
  check(mismatch.length === 0, 'a def is on the floor layer exactly when people can walk over it', mismatch.join());
  const floorDefs = Object.values(ITEM_DEFS).filter((d) => layerOf(d) === 'floor').map((d) => d.id);
  check(['rug', 'rug_small', 'rug_round', 'pod_rug', 'pod_rail_back', 'pod_rail_side', 'pod_glass_rail'].every((d) => floorDefs.includes(d)), 'the rugs and the pod boundary are floor items');

  const slots = [0, 1, 2, 3, 4, 5, 7];
  const blocks = slots.map((slot) => ({ id: `p${slot}`, slot }));
  const employees = blocks.flatMap((b) => [{ id: `${b.id}-po`, blockId: b.id, desk: 0, orchestrator: true }, { id: `${b.id}-e`, blockId: b.id, desk: 1, orchestrator: false }]);
  const legacy = legacyBuilding(blocks, employees);
  const ctx: SpaceContext = {
    blocks: new Set(blocks.map((b) => b.id)),
    employees: new Map(employees.map((e) => [e.id, { blockId: e.blockId, orchestrator: e.orchestrator }])),
    seats: legacy.seats,
  };
  const problems = validate(legacy.building, ctx);
  check(problems.length === 0 && legacy.building.shelled === 2, 'seven pods in two rows of slots validate clean: no overlap, nothing off the floor or the lot', JSON.stringify(problems.slice(0, 4)));
  const pod = shellItems('p0', 0);
  check(new Set(pod.map((i) => i.id)).size === pod.length && pod.every((i) => ITEM_DEFS[i.def] && i.blockId === 'p0'), 'a pod is a set of distinct known items of its team');
  check(['pod_rug', 'pod_rail_back', 'pod_glass_rail', 'pod_huddle_table', 'pod_daily_sign', 'chair', 'plant', 'lamp_floor', 'pod_slat_wall', 'pod_shelf'].every((d) => pod.some((i) => i.def === d)), 'the pod has its rug, boundary, huddle and decor');

  // The kit of every slot, one after the other on the office as it starts, goes through the rules.
  let kitted = legacyBuilding([], []).building;
  for (const b of blocks) {
    kitted = must(applyOps(kitted, teamKit(kitted, b.id, b.slot), noCtx));
    for (const piece of shellItems(b.id, b.slot)) kitted = must(applyOps(kitted, [put(0, piece)], noCtx));
  }
  check(blocks.every((b) => blockItems(kitted.stories[0], b.id).length === 10 + pod.length), 'a new team gets its desks and its whole pod from the kit, in every slot');

  // Floor items share nothing with each other, and objects stand on them.
  const rugged = must(applyOps(legacy.building, [put(0, item('r1', 'rug', 30, -50), item('d9', 'bench_desk', 30, -50))], ctx));
  check(rugged.stories[0].items.some((i) => i.id === 'd9'), 'a desk stands on a rug');
  const twoRugs = applyOps(rugged, [put(0, item('r2', 'rug_small', 32, -48))], ctx);
  check(!twoRugs.ok && kinds(twoRugs).includes('overlap'), 'a second rug on a rug is an overlap');
  const rugUnderPod = applyOps(legacy.building, [put(0, item('r3', 'rug', -22, -20))], ctx);
  check(!rugUnderPod.ok && kinds(rugUnderPod).includes('overlap'), "a rug cannot lie on the pod's own rug");
  check(eq(checkOps(legacy.building, [put(0, item('r3', 'rug', -22, -20))], ctx), kinds(rugUnderPod).length ? (rugUnderPod.ok ? [] : rugUnderPod.violations) : []), 'checkOps and applyOps agree on the floor layer');

  // The migration: the office before pods were items, with its carpet painted under the rug, comes back as the office with them.
  const strip = (b: Building): Building => {
    const gone = new Set(blocks.flatMap((x) => shellItems(x.id, x.slot).map((i) => i.id)));
    const story = b.stories[0];
    const items = story.items.filter((i) => !gone.has(i.id));
    const cells = blocks.flatMap((x) => {
      const c = blockCenter(x.slot);
      return Array.from({ length: 7 }, (_, dz) => Array.from({ length: 9 }, (_, dx) => ({ x: c.x - 5 + dx, z: c.z - 3 + dz, half: 0 as const, paint: PAINT.carpetBlue }))).flat();
    });
    const old = must(applyOps({ ...b, stories: [{ ...story, items }] }, [{ t: 'floor', story: 0, cells }], noCtx));
    return { v: 1, lot: old.lot, stories: old.stories };
  };
  const before = strip(legacy.building);
  check(before.shelled === undefined && blockItems(before.stories[0], 'p0').length === 10, 'the stripped office has the desks and none of the pod');
  const migrated = addShells(before, blocks);
  check(eq(migrated, legacy.building), 'migrating gives each block its pod where it was and clears the carpet painted under the rug');
  check(addShells(migrated, blocks) === migrated, 'migrating a migrated office changes nothing');
  const half = must(applyOps(before, [{ t: 'items', story: 0, put: [shellItems('p1', 1)[0]], del: [] }], noCtx));
  check(eq(addShells(half, blocks), legacy.building), 'a run that stopped half way finishes without doubling a piece');
  const rugId = shellItems('p0', 0)[0].id;
  const trimmed = must(applyOps(migrated, [{ t: 'items', story: 0, put: [], del: [rugId] }], ctx));
  check(addShells(trimmed, blocks) === trimmed && !trimmed.stories[0].items.some((i) => i.id === rugId), 'a piece the owner deleted stays deleted');
  const wire = parseBuilding(JSON.parse(JSON.stringify(encodeBuilding(trimmed))));
  check(wire.shelled === 2 && eq(wire, trimmed), 'the migrated flag survives the file');

  // A block leaves nothing behind, and goes to another floor and back.
  const story = legacy.building.stories[0];
  const mine = blockItems(story, 'p1');
  const box = cellBounds(mine)!;
  const away = applyOps(legacy.building, moveBlockOps(story, 0, 'p1', { quarter: 0, origin: { x: box.x0 - 24, z: box.z0 - 40 } }), ctx);
  if (!away.ok) check(false, 'the block moves to the free slot', JSON.stringify(away.violations.slice(0, 3)));
  else {
    const left = floorItems(away.building.stories[0]).filter((i) => i.blockId === 'p1' && i.x < box.x1 && i.x + 1 > box.x0 && i.z < box.z1 && i.z + 1 > box.z0);
    check(left.length === 0, 'after a move no item of the block is inside its old footprint');
    check(blockAt(away.building.stories[0], { x: (box.x0 + box.x1) / 4, z: (box.z0 + box.z1) / 4 }) !== 'p1', 'and the old middle no longer picks it');
    const rug = floorItems(away.building.stories[0]).find((i) => i.id === shellItems('p1', 1)[0].id)!;
    check(blockAt(away.building.stories[0], { x: rug.x / 2 + 2, z: rug.z / 2 + 2 }) === 'p1', 'a point on the bare rug picks the block');
  }

  const two = must(applyOps(legacy.building, [{ t: 'stories', count: 2 }, paintRect(1, { x: -18, z: -30, w: 36, h: 39 }, PAINT.woodLight)], ctx));
  const toFloor = (b: Building, pose: { quarter: 0 | 1 | 2 | 3; origin: { x: number; z: number } }, from: number, to: number) => moveBlockOps(b.stories[from], from, 'p1', pose, to);
  const same = { quarter: 0 as const, origin: { x: box.x0, z: box.z0 } };
  const strand = applyOps(two, toFloor(two, same, 0, 1), ctx);
  check(!strand.ok && kinds(strand).includes('would_strand_desks'), 'a block with people moves only to a floor they can reach: no stairs, no move');
  let stairsAt: Item | null = null;
  for (let tz = -9; tz < 6 && !stairsAt; tz++) {
    for (let tx = 6; tx < 16 && !stairsAt; tx++) {
      const s = item('st', 'stairs', tx * 2, tz * 2, 0);
      if (applyOps(two, [put(0, s)], ctx).ok) stairsAt = s;
    }
  }
  check(!!stairsAt, 'there is room for stairs in the lobby');
  if (stairsAt) {
    const climbed = must(applyOps(two, [put(0, stairsAt)], ctx));
    const up = applyOps(climbed, toFloor(climbed, same, 0, 1), ctx);
    check(up.ok, 'with stairs, the block moves to floor 2', up.ok ? '' : JSON.stringify(up.violations.slice(0, 3)));
    if (up.ok) {
      check(blockItems(up.building.stories[0], 'p1').length === 0 && blockItems(up.building.stories[1], 'p1').length === mine.length, 'every piece of the block, pod included, is on floor 2 and none is left on floor 1');
      const seat = [...legacy.seats].find(([e]) => e === 'p1-e')![1];
      check(seatPose(up.building, seat).floor === 1, 'its people sit on floor 2');
      const down = applyOps(up.building, toFloor(up.building, same, 1, 0), ctx);
      check(down.ok && eq(blockItems(down.building.stories[0], 'p1'), mine), 'and it comes back down to the same cells');
      const history = new BuildHistory();
      history.push({ forward: up.forward, inverse: up.inverse, label: 'build' });
      const undone = history.undo(up.building, ctx);
      check(undone?.ok === true && eq(undone.building, climbed), 'undo of the floor change puts the block back on floor 1');
    }
  }
}

// ---------------------------------------------------------------- the pod goes where the desks went
{
  const lot = { x0: -40, z0: -40, w: 80, h: 60 };
  const ground = must(applyOps(emptyBuilding(lot), [paintRect(0, { x: lot.x0, z: lot.z0, w: lot.w, h: lot.h }, PAINT.woodLight)], noCtx));
  const stage = (items: readonly Item[], shelled?: 1 | 2, from = ground): Building => ({ ...must(applyOps(from, [put(0, ...items)], noCtx)), ...(shelled && { shelled }) });
  const podOf = (blockId: string, slot: number) => shellItems(blockId, slot);
  const byId = <T extends Item>(list: readonly T[]) => [...list].sort((a, c) => (a.id < c.id ? -1 : 1));
  const shellNow = (b: Building, blockId: string, slot: number) => {
    const mine = new Set(podOf(blockId, slot).map((i) => i.id));
    return floorItems(b.stories[0]).filter((i) => mine.has(i.id));
  };
  const itemsOf = (b: Building) => floorItems(b.stories[0]);
  const A = { id: 'a', slot: 1 };
  const bare = stage(coreItems(A.id, A.slot));
  const move = (b: Building, id: string, quarter: 0 | 1 | 2 | 3, origin: { x: number; z: number }) => must(applyOps(b, moveBlockOps(b.stories[0], 0, id, { quarter, origin }), noCtx));
  // What moving the whole block, pod and all, to where its desks went would do to the pod: the app's own block move, apart from the migration.
  const reference = (moved: Building, blockId: string, slot: number, quarter: 0 | 1 | 2 | 3): FloorItem[] => {
    const cores = coreItems(blockId, slot);
    const probe = placeBlock([...cores, ...podOf(blockId, slot)], { quarter, origin: { x: 0, z: 0 } });
    const anchor = itemsOf(moved).find((i) => i.id === probe[0].id)!;
    const placed = probe.map((i) => ({ ...i, x: i.x + anchor.x - probe[0].x, z: i.z + anchor.z - probe[0].z }));
    const lands = cores.every((c) => eq(itemsOf(moved).find((i) => i.id === c.id), placed.find((i) => i.id === c.id)));
    if (!lands) throw new Error('the reference turn does not land on the desks');
    return byId(placed.slice(cores.length));
  };
  const run = (b: Building, blocks: { id: string; slot: number }[] = [A]) => {
    const seen: ShellOutcome[] = [];
    return { out: addShells(b, blocks, (o) => seen.push(o)), seen };
  };
  const whyOf = (o: ShellOutcome | undefined) => (o?.kind === 'fell_back' ? o.why : '');

  for (const quarter of [0, 1, 2, 3] as const) {
    const moved = move(bare, A.id, quarter, { x: 30 + quarter * 7, z: -50 + quarter * 3 });
    const { out, seen } = run(moved);
    const want = reference(moved, A.id, A.slot, quarter);
    const got = shellNow(out, A.id, A.slot);
    const turn = `${quarter * 90} degrees`;
    check(eq(got, want), `${turn}: the pod of a block moved by a block move lands where moving the whole block would put it`, `${got.length} of ${want.length} pieces; first miss ${JSON.stringify(got.find((g, i) => !eq(g, want[i])))}`);
    const [outcome] = seen;
    check(seen.length === 1 && outcome.kind === 'placed' && outcome.pose.quarter === quarter && outcome.agree === 10 && outcome.of === 10, `${turn}: all 10 core pieces give the same pose and the pod is placed`, JSON.stringify(seen));
    const left = podOf(A.id, A.slot).filter((p) => got.some((g) => g.id === p.id && g.x === p.x && g.z === p.z && g.rot === p.rot));
    check(out.shelled === 2 && left.length === 0, `${turn}: not one piece of the pod is left at the slot spot`, left.map((i) => i.id).join());
    const broken = validate(out, noCtx);
    check(broken.length === 0, `${turn}: the office with the pod in place breaks no rule`, JSON.stringify(broken.slice(0, 3)));
    check(addShells(out, [A]) === out && eq(addShells({ ...out, shelled: 1 }, [A]), out), `${turn}: running the migration again, even without its flag, changes nothing`);
  }

  // One desk moved alone and another turned alone are outvoted by the eight pieces that moved as a block.
  const turned = move(bare, A.id, 1, { x: 30, z: -50 });
  const strays: Record<string, Partial<FloorItem>> = { 'a:bench_desk:00': { x: 60 }, 'a:bench_desk:03': { z: -60, rot: 2 } };
  const scattered = stage(itemsOf(turned).map((i) => ({ ...i, ...strays[i.id] })));
  const scatteredRun = run(scattered);
  const reading = scatteredRun.seen[0];
  check(eq(shellNow(scatteredRun.out, A.id, A.slot), reference(turned, A.id, A.slot, 1)), 'a desk moved alone and one turned alone do not pull the pod: it follows the pieces that agree');
  check(reading.kind === 'placed' && reading.agree === 8 && reading.of === 10, 'the reading says 8 of 10', JSON.stringify(reading));

  // Pieces that cannot agree: half the block stayed and half moved. The pod stays where the static pod stood and says why.
  const half = stage(itemsOf(bare).map((i) => (/bench_desk:0[0-3]|whiteboard/.test(i.id) ? { ...i, x: i.x + 20 } : i)));
  const split = run(half);
  check(eq(shellNow(split.out, A.id, A.slot), byId(podOf(A.id, A.slot))) && split.out.shelled === 2, 'when the pieces split evenly the pod goes to the slot spot, as it always did');
  check(split.seen.length === 1 && /do not agree/.test(whyOf(split.seen[0])), 'and the block that fell back is reported with the reason', JSON.stringify(split.seen));
  const noCores = run(stage(podOf(A.id, A.slot)));
  check(/none of its desks/.test(whyOf(noCores.seen[0])) && eq(shellNow(noCores.out, A.id, A.slot), byId(podOf(A.id, A.slot))), 'a team with no desks, board or sign left gets its pod at the slot spot and a reason');

  // The rules turn a piece away: a plant where the huddle table would stand, and desks so near the lot edge that part of the pod would stick out.
  // That piece stays at its slot spot and the rest of the pod stands with the desks.
  const split2 = (b: Building, want: readonly Item[], left: readonly { id: string }[]) => {
    const gone = new Set(left.map((l) => l.id));
    const now = shellNow(b, A.id, A.slot);
    return eq(now.filter((i) => !gone.has(i.id)), want.filter((i) => !gone.has(i.id))) && eq(now.filter((i) => gone.has(i.id)), byId(podOf(A.id, A.slot).filter((i) => gone.has(i.id))));
  };
  const huddle = reference(turned, A.id, A.slot, 1).find((i) => i.def === 'pod_huddle_table')!;
  const blocked = run(stage([...itemsOf(turned), item('plant:in-the-way', 'plant', huddle.x, huddle.z)]));
  const blockedOutcome = blocked.seen[0];
  const blockedLeft = blockedOutcome.kind === 'placed' ? blockedOutcome.left : [];
  check(blockedLeft.length === 1 && blockedLeft[0].id === huddle.id && /overlap with plant:in-the-way/.test(blockedLeft[0].why), 'a plant where the huddle table would stand turns away that table alone: overlap', JSON.stringify(blocked.seen));
  check(split2(blocked.out, reference(turned, A.id, A.slot, 1), blockedLeft) && itemsOf(blocked.out).some((i) => i.id === 'plant:in-the-way'), 'the table stays at the slot spot, the other 19 pieces stand with the desks, and the plant stays where it was');
  const atEdge = move(bare, A.id, 0, { x: lot.x0 * 2, z: -50 });
  const edge = run(atEdge);
  const edgeLeft = edge.seen[0].kind === 'placed' ? edge.seen[0].left : [];
  check(edgeLeft.length > 0 && edgeLeft.every((l) => /out_of_lot/.test(l.why)), 'desks against the lot edge leave no room for part of the pod: those pieces are out_of_lot', JSON.stringify(edge.seen));
  check(split2(edge.out, reference(atEdge, A.id, A.slot, 0), edgeLeft) && edge.out.shelled === 2, 'only those pieces stay at the slot spot, the rest stand with the desks');
  check(addShells(edge.out, [A]) === edge.out && eq(addShells({ ...edge.out, shelled: 1 }, [A]), edge.out), 'a second run, flag or no flag, changes nothing: a piece refused once is refused again');

  // Carpet painted under the old rug is cleared at the slot spot, and none is painted where the pod goes.
  const carpeted = must(applyOps(bare, [paintRect(0, { x: -5, z: -8, w: 9, h: 7 }, PAINT.carpetBlue)], noCtx));
  const carpetRun = run(move(carpeted, A.id, 0, { x: 40, z: -50 }));
  const paintAt = (b: Building, x: number, z: number) => b.stories[0].paint[(z - b.lot.z0) * b.lot.w + (x - b.lot.x0)];
  check(paintAt(carpeted, 0, -5) === PAINT.carpetBlue && paintAt(carpetRun.out, 0, -5) === PAINT.woodLight && paintAt(carpetRun.out, 20, -25) === PAINT.woodLight, 'the carpet under the old rug is cleared and the new place is plain floor');

  // An office migrated by the build that put the pod at the slot spot whatever the desks did: fixed once, owner edits untouched.
  const movedA = turned;
  const staleItems = [...itemsOf(movedA), ...podOf(A.id, A.slot)];
  const credenza = podOf(A.id, A.slot).find((i) => i.def === 'pod_credenza')!;
  const rugId = podOf(A.id, A.slot).find((i) => i.def === 'pod_rug')!.id;
  const daily = podOf(A.id, A.slot).find((i) => i.def === 'pod_daily_sign')!;
  const wantPod = reference(movedA, A.id, A.slot, 1);
  const full = run(stage(staleItems, 1));
  check(eq(shellNow(full.out, A.id, A.slot), wantPod) && validate(full.out, noCtx).length === 0, 'an office migrated the old way gets its whole pod around its desks');
  const edited = stage(staleItems.filter((i) => i.id !== rugId).map((i) => (i.id === credenza.id ? { ...i, x: 60, z: 20 } : i.id === daily.id ? { ...i, tint: 3 } : i)), 1);
  const fixed = run(edited);
  const fixedPod = shellNow(fixed.out, A.id, A.slot);
  check(!fixedPod.some((i) => i.id === rugId), 'a piece the owner deleted stays deleted');
  check(eq(fixedPod.find((i) => i.id === credenza.id), { ...credenza, x: 60, z: 20 }), 'a piece the owner moved stays where the owner put it');
  const rest = (list: readonly Item[]) => list.filter((i) => ![credenza.id, daily.id, rugId].includes(i.id));
  check(eq(rest(fixedPod), rest(wantPod)), 'every other piece that sat at the slot spot is carried to the desks');
  check(eq(fixedPod.find((i) => i.id === daily.id), { ...wantPod.find((i) => i.id === daily.id)!, tint: 3 }), 'a carried piece keeps its tint');
  check(addShells(fixed.out, [A]) === fixed.out && eq(addShells({ ...fixed.out, shelled: 1 }, [A]), fixed.out), 'a second run, flag or no flag, changes nothing');

  // Two teams swapped places: each pod is about to leave the spot the other one's pod needs.
  const C = { id: 'c', slot: 2 };
  const swapped = run(stage([...coreItems(A.id, A.slot).map((i) => ({ ...i, x: i.x + 24 })), ...coreItems(C.id, C.slot).map((i) => ({ ...i, x: i.x - 24 })), ...podOf(A.id, A.slot), ...podOf(C.id, C.slot)], 1), [A, C]);
  const shifted = (blockId: string, slot: number, dx: number) => byId(podOf(blockId, slot).map((i) => ({ ...i, x: i.x + dx })));
  check(swapped.seen.length === 2 && swapped.seen.every((o) => o.kind === 'placed'), 'two teams that swapped slots are both placed', JSON.stringify(swapped.seen.map((o) => whyOf(o))));
  check(eq(shellNow(swapped.out, A.id, A.slot), shifted(A.id, A.slot, 24)) && eq(shellNow(swapped.out, C.id, C.slot), shifted(C.id, C.slot, -24)), 'and neither pod is turned away by the other one it is about to replace');

  // A team that never moved is not touched, and a building already at level 2 is returned as it is.
  const home = stage([...coreItems(A.id, A.slot), ...podOf(A.id, A.slot)], 1);
  const homeRun = run(home);
  check(eq({ ...homeRun.out, shelled: 1 }, home) && homeRun.seen.length === 1 && homeRun.seen[0].kind === 'placed', 'a team still at its slot reads as the identity pose and nothing moves');
  const oldFile = { ...(encodeBuilding(home) as object), shelled: true };
  check(parseBuilding(JSON.parse(JSON.stringify(oldFile))).shelled === 1 && parseBuilding(JSON.parse(JSON.stringify(encodeBuilding(homeRun.out)))).shelled === 2, 'the file says true for the old migration and 2 for this one');
}

// ---------------------------------------------------------------- persistence boundary
{
  const b0 = legacyBuilding([{ id: 'b1', slot: 0 }], [{ id: 'e', blockId: 'b1', desk: 0, orchestrator: false }]).building;
  const withHalf = must(applyOps(flat(2, 8), [{ t: 'walls', story: 1, put: [{ x: 2, z: 2, d: 'nd', style: 4 }], del: [] }, { t: 'floor', story: 1, cells: [{ x: 2, z: 2, half: 1, paint: PAINT.carpetGray }] }], noCtx));
  for (const [name, b] of [['legacy', b0], ['two stories with a diagonal', withHalf]] as const) {
    const wire = JSON.parse(JSON.stringify(encodeBuilding(b)));
    check(eq(parseBuilding(wire), b), `parseBuilding(encodeBuilding(b)) deep-equals the ${name} building`);
  }
  const bad = (name: string, raw: unknown) => {
    try {
      parseBuilding(raw, () => {});
      check(false, `parseBuilding rejects ${name}`);
    } catch (e) {
      check(e instanceof Error && e.message.startsWith('Invalid building:'), `parseBuilding rejects ${name} with a clear error`, String(e));
    }
  };
  const good = JSON.parse(JSON.stringify(encodeBuilding(withHalf)));
  bad('null', null);
  bad('a string', 'hello');
  bad('a wrong version', { ...good, v: 2 });
  bad('a short paint string', { ...good, stories: [{ ...good.stories[0], paint: '1x3' }] });
  bad('an unknown paint id', { ...good, stories: [{ ...good.stories[0], paint: '99x64' }] });
  bad('a bad wall direction', { ...good, stories: [{ ...good.stories[0], walls: [{ x: 0, z: 0, d: 'q', style: 0 }] }] });
  bad('a fractional item position', { ...good, stories: [{ ...good.stories[0], items: [{ id: 'a', def: 'plant', x: 0.5, z: 0, rot: 0 }] }] });
  const warned: string[] = [];
  const dropped = parseBuilding({ ...good, stories: [{ ...good.stories[0], items: [{ id: 'a', def: 'hovercraft', x: 0, z: 0, rot: 0 }] }] }, (m) => warned.push(m));
  check(dropped.stories[0].items.length === 0 && warned.length === 1, 'an unknown item def is dropped with a warning');
  const huge = parseBuilding({ v: 1, lot: { x0: 0, z0: 0, w: 100, h: 2 }, stories: [{ paint: `1x200`, halfB: {}, walls: [], items: [] }] }, () => {});
  check(huge.lot.w === 64 && huge.stories[0].paint.length === 128, 'a lot wider than MAX_LOT is clamped to 64');
}

// ---------------------------------------------------------------- memoization by identity
{
  const b = flat(3, 12);
  const before = deriveFloors(b);
  const top = must(applyOps(b, [put(2, item('t', 'plant', 4, 4))], noCtx));
  const after = deriveFloors(top);
  check(after[0] === before[0] && after[1] === before[1], 'editing the top story leaves the other stories geometry objects identical');
  check(after[2] !== before[2] && after[2].story.items.length === 1, 'the edited story gets new geometry');
  check(deriveFloors(top) === after, 'deriveFloors on the same building is a lookup');
  const ground = must(applyOps(b, [put(0, item('g', 'plant', 4, 4))], noCtx));
  const g2 = deriveFloors(ground);
  check(g2[1] === before[1] && g2[2] === before[2] && g2[0] !== before[0], 'editing the ground floor leaves floors above identical when there are no stairs');
  const r = before[0].render;
  check(r.floor.index.length === 12 * 12 * 6 && r.floor.position.length === 12 * 12 * 4 * 3, 'floor mesh is one merged quad per tile');
}

// ---------------------------------------------------------------- the surface layer: small items on desks, tables and shelves
{
  const top = (name: string, def: string, on: string, u: number, v: number, rot: 0 | 1 | 2 | 3 = 0): Item => ({ id: id(name), def, on: id(on), u, v, rot });
  const defsOnTop = Object.values(ITEM_DEFS).filter((d) => d.placement === 'surface' || d.placement === 'both');
  const hosts = Object.values(ITEM_DEFS).filter((d) => d.surface);
  check(defsOnTop.length >= 12 && defsOnTop.every((d) => d.top && d.top.w >= 1 && d.top.d >= 1), `${defsOnTop.length} defs can stand on a surface, each with a footprint on it`);
  check(hosts.length >= 12, `${hosts.length} defs have a top`);
  check(
    hosts.every((d) => {
      const r = d.surface!.rect;
      const inside = (q: { u0: number; v0: number; u1: number; v1: number }) => q.u0 >= 0 && q.v0 >= 0 && q.u1 <= d.w * 4 && q.v1 <= d.d * 4 && q.u0 < q.u1 && q.v0 < q.v1;
      return inside(r) && (d.surface!.blocked ?? []).every(inside);
    }),
    'every top, and every fixed thing on it, lies inside its host footprint',
  );
  check(defsOnTop.every((d) => d.placement !== 'surface' || (d.w === 1 && d.d === 1)), 'a def for a surface only has a one cell footprint on the floor');

  const base = must(applyOps(flat(2), [put(0, item('desk', 'bench_desk', 10, 10), item('table', 'meeting_table', 20, 20, 1), item('chair1', 'chair', 4, 4), item('shelf', 'shelf_low', 30, 4)), put(1, item('desk2', 'bench_desk', 10, 10))], noCtx));
  const valid = (b: Building) => validate(b, noCtx).filter((v) => v.kind !== 'story_unreachable').length === 0;
  const ok = (b: Building, ...ops: Item[]) => applyOps(b, [put(0, ...ops)], noCtx);

  // where it lands
  const mug = top('mug1', 'mug', 'desk', 0, 6);
  const withMug = must(ok(base, mug));
  const hostOf = (b: Building, hostId: string) => floorItems(b.stories[0]).find((i) => i.id === hostId)!;
  const poseOf = (b: Building, hostId: string, it: Item) => {
    const host = hostOf(b, hostId);
    return topPose(host, ITEM_DEFS[host.def], it as never, ITEM_DEFS[it.def]);
  };
  const p0 = poseOf(withMug, 'desk', mug);
  check(Math.abs(p0.y - ITEM_DEFS.bench_desk.surface!.height) < 1e-9 && p0.box.x0 >= 5 && p0.box.x1 <= 5 + 1.5 && p0.box.z0 >= 5 && p0.box.z1 <= 5 + 1, 'a mug on a desk stands at the height of the desk top, inside the desk footprint');

  // moving and turning the host: the top item needs no edit and stays on the top, at the same spot of the host
  for (const rot of [0, 1, 2, 3] as const) {
    const moved = must(ok(withMug, item('desk', 'bench_desk', 30, 24, rot)));
    const host = hostOf(moved, 'desk');
    const pose = poseOf(moved, 'desk', mug);
    const f = ITEM_DEFS.bench_desk;
    const w = rot % 2 ? f.d / 2 : f.w / 2;
    const d = rot % 2 ? f.w / 2 : f.d / 2;
    const inside = pose.box.x0 >= host.x! / 2 - 1e-9 && pose.box.x1 <= host.x! / 2 + w + 1e-9 && pose.box.z0 >= host.z! / 2 - 1e-9 && pose.box.z1 <= host.z! / 2 + d + 1e-9;
    check(inside && Math.abs(pose.box.x1 - pose.box.x0 - 0.125) < 1e-9 && valid(moved), `the host moved and turned ${rot} quarter(s): the mug rode along, on its top, and the building is valid`, JSON.stringify({ inside, pose: pose.box, host, v: validate(moved, noCtx) }));
  }
  // the same corner of the desk before and after a half turn is the opposite one in the world
  const half = must(ok(withMug, item('desk', 'bench_desk', 10, 10, 2)));
  const [pa, pb] = [p0, poseOf(half, 'desk', mug)];
  check(Math.abs(pa.x + pb.x - 2 * (5 + 0.75)) < 1e-9 && Math.abs(pa.z + pb.z - 2 * (5 + 0.5)) < 1e-9, 'a half turn of the host carries the mug to the opposite spot of the top');
  check(pb.rot === 2, 'and turns the mug with it');

  // rules
  const bad = (name: string, r: Applied, kind: ViolationKind) => check(kinds(r).includes(kind), name, JSON.stringify(kinds(r)));
  bad('off the edge of the desk is off_surface', ok(base, top('m', 'mug', 'desk', -1, 6)), 'off_surface');
  bad('past the far edge is off_surface', ok(base, top('m', 'mug', 'desk', 12, 6)), 'off_surface');
  bad('a laptop that sticks out by one unit is off_surface', ok(base, top('lap', 'laptop', 'desk', 10, 6)), 'off_surface');
  bad('where the monitor stands is refused', ok(base, top('m', 'mug', 'desk', 5, 5)), 'overlap');
  bad('on top of another top item is refused', ok(withMug, top('m2', 'mug', 'desk', 0, 6)), 'overlap');
  bad('half on top of another is refused', ok(withMug, top('b1', 'books', 'desk', 1, 5)), 'overlap');
  check(ok(withMug, top('m3', 'mug', 'desk', 1, 6)).ok, 'next to it is fine, down to one unit');
  check(ok(withMug, top('m4', 'mug', 'desk2', 0, 6)).ok === false, 'a top item names a host of its own story');
  check(applyOps(withMug, [{ t: 'items', story: 1, put: [top('m5', 'mug', 'desk2', 0, 6)], del: [] }], noCtx).ok, 'the same spot on another desk is free: overlap is checked on one top only');
  bad('a mug on a chair has nothing to stand on', ok(base, top('m', 'mug', 'chair1', 0, 0)), 'not_surface');
  bad('a mug on nothing has no host', ok(base, top('m', 'mug', 'ghost', 0, 0)), 'no_host');
  bad('a tall plant does not go on a desk', ok(base, top('pl', 'plant_large', 'desk', 0, 0)), 'floor_only');
  bad('a mug cannot stand on a mug', ok(withMug, top('m7', 'mug', 'mug1', 0, 0)), 'no_host');
  bad('a mug on the bare floor is refused', ok(base, item('m8', 'mug', 36, 36)), 'needs_surface');
  check(ok(base, item('lamp1', 'lamp_desk', 36, 36)).ok, 'a desk lamp may stand on the floor');
  check(ok(base, top('lamp2', 'lamp_desk', 'desk', 0, 5)).ok, 'and on a desk');

  // ids that can change between floor and top with one put
  const moveUp = must(ok(must(ok(base, item('lamp1', 'lamp_desk', 36, 36))), top('lamp1', 'lamp_desk', 'desk', 0, 5)));
  const lamp = moveUp.stories[0].items.find((i) => i.id === 'lamp1')!;
  check(lamp.on === 'desk' && lamp.x === undefined && lamp.z === undefined, 'the same lamp lifted from the floor onto a desk is one put, and has no floor cell left');

  // delete the host: what stood on it goes, and undo brings both back
  const loaded = must(ok(withMug, top('books1', 'books', 'desk', 0, 0), top('plant1', 'plant_small', 'shelf', 2, 0)));
  const gone = applyOps(loaded, [{ t: 'items', story: 0, put: [], del: [id('desk')] }], noCtx);
  check(gone.ok && !gone.building.stories[0].items.some((i) => i.id === 'mug1' || i.id === 'books1' || i.id === 'desk') && gone.building.stories[0].items.some((i) => i.id === 'plant1'), 'deleting a desk deletes what stands on it and nothing else');
  const back = gone.ok && applyOps(gone.building, gone.inverse, noCtx);
  check(back && back.ok && eq(back.building, loaded), 'its inverse puts the desk and every item on it back exactly');
  const hist = new BuildHistory();
  if (gone.ok) hist.push({ forward: gone.forward, inverse: gone.inverse, label: 'delete' });
  const undone = gone.ok ? hist.undo(gone.building, noCtx) : null;
  check(undone?.ok === true && eq(undone.building, loaded), 'undo restores the desk with its items');
  const redone = undone?.ok ? hist.redo(undone.building, noCtx) : null;
  check(redone?.ok === true && redone.building.stories[0].items.every((i) => i.id !== 'mug1'), 'redo drops them again');
  // a rule-breaking add of a block's furniture by its id: the office's own `dropItems` shape
  const team = must(applyOps(base, [put(0, item('t:desk', 'bench_desk', 20, 4, 0, 'blk'))], noCtx));
  const teamTop = must(applyOps(team, [put(0, top('t:mug', 'mug', 't:desk', 0, 6))], noCtx));
  const dropped = must(applyOps(teamTop, [{ t: 'items', story: 0, put: [], del: floorItems(teamTop.stories[0]).filter((i) => i.blockId === 'blk').map((i) => i.id) }], noCtx));
  check(!dropped.stories[0].items.some((i) => i.id === 't:mug'), 'removing a block by its pieces takes what stood on them');

  // a block move keeps them, on the same floor and to another floor
  const decorated = must(applyOps(base, [put(0, item('b:desk1', 'bench_desk', 4, 30, 0, 'blk'), item('b:desk2', 'bench_desk', 10, 30, 0, 'blk')), put(0, top('b:mug', 'mug', 'b:desk1', 0, 6), top('b:books', 'books', 'b:desk2', 1, 0, 1))], noCtx));
  const blockStory = decorated.stories[0];
  const here = moveBlockOps(blockStory, 0, 'blk', blockPose(blockItems(blockStory, 'blk'), 1, { x: 30, z: 30 }));
  const movedHere = must(applyOps(decorated, here, noCtx));
  check(movedHere.stories[0].items.some((i) => i.id === 'b:mug' && i.on === 'b:desk1') && valid(movedHere) && here.every((o) => o.t !== 'items' || o.put.every((i) => i.on === undefined)), 'turning and moving a block on its floor edits only its pieces and leaves what stands on them on top');
  const up = moveBlockOps(blockStory, 0, 'blk', blockPose(blockItems(blockStory, 'blk'), 0, { x: 20, z: 12 }), 1);
  const movedUp = must(applyOps(decorated, up, noCtx));
  const onTwo = movedUp.stories[1].items.filter((i) => i.on !== undefined).map((i) => i.id).sort();
  check(onTwo.join() === 'b:books,b:mug' && !movedUp.stories[0].items.some((i) => i.id === 'b:mug' || i.id === 'b:books'), 'a block moved to another floor takes what stands on its desks');
  check(valid(movedUp), 'and the building is valid there');
  const undoUp = applyOps(movedUp, applyOps(decorated, up, noCtx).ok ? (applyOps(decorated, up, noCtx) as Extract<Applied, { ok: true }>).inverse : [], noCtx);
  check(undoUp.ok && eq(undoUp.building, decorated), 'undoing the move to another floor restores everything');

  // persistence
  const wire = JSON.parse(JSON.stringify(encodeBuilding(loaded)));
  const reread = parseBuilding(wire);
  check(eq(reread, loaded) && reread.stories[0].items.filter((i) => i.on !== undefined).length === 3, 'save and load keeps every item on its host');
  wire.stories[0].items = wire.stories[0].items.filter((i: { id: string }) => i.id !== 'desk');
  let dropped2 = '';
  const stale = parseBuilding(wire, (m) => (dropped2 += m));
  check(!stale.stories[0].items.some((i) => i.id === 'mug1') && dropped2.includes('mug1') && stale.stories[0].items.some((i) => i.id === 'plant1'), 'a file whose desk is gone drops what stood on it, and says so');

  // picking
  // A ray that comes in slanted and meets the plane of the desk top at (x, z): the floor plane would put it a quarter meter off.
  const slanted = (x: number, z: number, y: number): PickRay => ({ o: { x: x - 1, y: y + 3, z: z - 1 }, d: { x: 1 / Math.hypot(1, 3, 1), y: -3 / Math.hypot(1, 3, 1), z: 1 / Math.hypot(1, 3, 1) } });
  const surfaceHit = surfaceAt(withMug.stories[0], { o: { x: 5.75, y: 4, z: 5.5 }, d: { x: 0, y: -1, z: 0 } });
  check(surfaceHit?.host.id === 'desk' && Math.abs(surfaceHit.point.x - 5.75) < 1e-9, 'a ray down onto a desk top finds the desk and the point');
  check(surfaceAt(withMug.stories[0], { o: { x: 5.75, y: 4, z: 8.5 }, d: { x: 0, y: -1, z: 0 } }) === null, 'a ray down onto bare floor finds no surface');
  const front = surfaceAt(withMug.stories[0], slanted(5.2, 5.2, ITEM_DEFS.bench_desk.surface!.height));
  check(front?.host.id === 'desk' && Math.abs(front.point.x - 5.2) < 1e-9 && Math.abs(front.point.z - 5.2) < 1e-9, 'a slanted ray finds the desk by the plane of its top, at the point it meets it, not at the floor under it');
  const hit = topItemAt(withMug.stories[0], { o: { x: p0.x, y: 3, z: p0.z }, d: { x: 0, y: -1, z: 0 } });
  check(hit?.id === 'mug1', 'a ray down onto a mug picks the mug');
  check(topItemAt(withMug.stories[0], { o: { x: 8, y: 3, z: 8 }, d: { x: 0, y: -1, z: 0 } }) === null, 'and a ray beside it picks nothing');

  // twelve items, six desks and a table, no rule broken, and the old floor items still collide as before
  const row = must(applyOps(flat(1, 40), [put(0, ...[0, 1, 2, 3, 4, 5].map((n) => item(`row${n}`, 'bench_desk', 4 + n * 6, 4)), item('big', 'meeting_table', 4, 20))], noCtx));
  const names = ['laptop', 'books', 'mug', 'picture_frame', 'vase', 'pen_cup', 'desk_clock', 'trophy', 'papers', 'lamp_desk', 'plant_small', 'plant_cactus'];
  const placed: Item[] = names.map((def, n) => (n < 6 ? top(`it${n}`, def, `row${n}`, 0, 6) : top(`it${n}`, def, 'big', 2 + (n - 6) * 3, 2)));
  const full = applyOps(row, [put(0, ...placed)], noCtx);
  check(full.ok && valid(full.building), `${placed.length} small items across six desks and a table are accepted`, full.ok ? '' : JSON.stringify(full.violations));
  const chairOnDesk = applyOps(row, [put(0, item('c9', 'chair', 4, 4))], noCtx);
  check(!chairOnDesk.ok, 'a floor item still cannot stand where a desk stands');
  const geo = deriveFloors(full.ok ? full.building : row)[0];
  const lapMatrix = geo.render.items.get('laptop');
  check(!!lapMatrix && lapMatrix.ids.length === 1 && Math.abs(lapMatrix.matrices[1] - ITEM_DEFS.bench_desk.surface!.height) < 1e-6, 'the render list gives a top item its host height');

  // speed of the verdict that drives the ghost
  const ghostOps = [put(0, top('probe', 'mug', 'row3', 0, 6))];
  checkOps(full.ok ? full.building : row, ghostOps, noCtx);
  const t0 = performance.now();
  for (let n = 0; n < 500; n++) checkOps(full.ok ? full.building : row, [put(0, top('probe', 'mug', 'row3', n % 12, 6))], noCtx);
  const mean = (performance.now() - t0) / 500;
  console.log(`checkOps one top item: mean ${mean.toFixed(3)} ms`);
  check(mean < 1, 'checkOps for one top item under 1 ms');
}


// ---------------------------------------------------------------- dressing: looks, a few degrees of turn, and things stacked on things
{
  const topOf = (name: string, def: string, on: string, u: number, v: number, extra: { rot?: 0 | 1 | 2 | 3; look?: number; ang?: number; lvl?: number } = {}): Item => ({ id: id(name), def, on: id(on), u, v, rot: extra.rot ?? 0, ...(extra.look && { look: extra.look }), ...(extra.ang && { ang: extra.ang }), ...(extra.lvl && { lvl: extra.lvl }) });
  const small = Object.values(ITEM_DEFS).filter((d) => d.placement === 'surface' || d.placement === 'both');
  check(small.length >= 35, `${small.length} small defs can stand on a surface`);
  check(small.filter((d) => (d.looks ?? 1) >= 2).length >= 25, `${small.filter((d) => (d.looks ?? 1) >= 2).length} of them come in two or more looks`);
  check(small.filter((d) => d.stackable).length >= 6 && small.every((d) => !d.stackable || d.top!.w * d.top!.d >= 1), 'several are flat enough to carry others');
  check(small.every((d) => (d.looks ?? 1) >= 1 && Number.isInteger(d.looks ?? 1)), 'a def has a whole number of looks');

  const base = must(applyOps(flat(1), [put(0, item('desk', 'bench_desk', 10, 10), item('table', 'meeting_table', 20, 20, 1))], noCtx));
  const ok = (b: Building, ...ops: Item[]) => applyOps(b, [put(0, ...ops)], noCtx);
  const bad = (name: string, r: Applied, kind: ViolationKind) => check(kinds(r).includes(kind), name, JSON.stringify(kinds(r)));
  const hostOf = (b: Building, hostId: string) => floorItems(b.stories[0]).find((i) => i.id === hostId)!;
  const poseOf = (b: Building, it: Item) => {
    const t = b.stories[0].items.find((i) => i.id === it.id) as never as Item & { on: ItemId };
    const host = hostOf(b, t.on);
    return topPose(host, ITEM_DEFS[host.def], t as never, ITEM_DEFS[t.def], liftOf(t as never, ITEM_DEFS[t.def], b.stories[0].items));
  };

  // a look and a turn are kept, drawn under their own key, and a change of look is a change
  const seen = must(ok(base, topOf('m1', 'mug', 'desk', 0, 6, { look: 3, ang: -7 })));
  const m1 = seen.stories[0].items.find((i) => i.id === 'm1')!;
  check(m1.look === 3 && m1.ang === -7 && m1.lvl === undefined, 'a mug keeps its look and its turn, and has no stack level when it is on the surface');
  check(eq(parseBuilding(JSON.parse(JSON.stringify(encodeBuilding(seen)))), seen), 'save and load keeps the look, the turn and the level');
  const geo = deriveFloors(seen)[0];
  check(geo.render.items.has('mug#3') && !geo.render.items.has('mug') && geo.render.items.get('mug#3')!.ids[0] === 'm1', 'the render list draws a mug of look 3 under its own key');
  check(drawKey({ ...m1, look: 8 } as Item, ITEM_DEFS.mug) === 'mug#3' && drawKey({ ...m1, look: 5 } as Item, ITEM_DEFS.mug) === 'mug', 'a look the def does not have wraps round');
  check(Math.abs(poseOf(seen, m1).yaw - (0 + (-7 * Math.PI) / 180)) < 1e-9, 'the few degrees turn the drawing and nothing else');
  const relooked = must(ok(seen, topOf('m1', 'mug', 'desk', 0, 6, { look: 1, ang: -7 })));
  check(relooked.stories[0].rev !== seen.stories[0].rev, 'a new look is a new story revision, so the scene draws it');
  check(ok(seen, topOf('m2', 'mug', 'desk', 0, 6, { ang: 12 })).ok === false, 'a turn does not make room: the footprint is the same');
  let refused = '';
  try {
    parseBuilding({ ...encodeBuilding(seen) as object, stories: [{ ...(encodeBuilding(seen) as { stories: object[] }).stories[0], items: [{ id: 'x', def: 'mug', on: 'desk', u: 0, v: 0, rot: 0, lvl: 9 }] }] });
  } catch (e) {
    refused = String(e);
  }
  check(refused.includes('lvl'), 'a file with a stack nine high is refused at the door');

  // stacks: a mug on a notebook, books on books
  const notebook = topOf('nb', 'notebook', 'desk', 0, 0, { look: 1 });
  const withNote = must(ok(base, notebook));
  const heightOf = (d: string) => ITEM_DEFS[d].height;
  const mugOn = topOf('mug', 'mug', 'desk', 1, 0, { lvl: 1 });
  const stackedMug = must(ok(withNote, mugOn));
  check(Math.abs(poseOf(stackedMug, mugOn).y - (ITEM_DEFS.bench_desk.surface!.height + heightOf('notebook'))) < 1e-9, 'a mug on a notebook stands as high as the notebook is thick');
  bad('a mug at level 1 with nothing under it is unsupported', ok(base, mugOn), 'unsupported');
  bad('a mug on the surface where the notebook lies is refused', ok(withNote, topOf('mug', 'mug', 'desk', 1, 0)), 'overlap');
  bad('a mug at level 1 beside the notebook, off its edge, is unsupported', ok(withNote, topOf('mug', 'mug', 'desk', 3, 0, { lvl: 1 })), 'unsupported');
  check(ok(withNote, topOf('mug', 'mug', 'desk', 3, 0)).ok, 'a mug beside the notebook, on the surface, is fine');
  bad('a mug does not carry a mug', ok(stackedMug, topOf('mug2', 'mug', 'desk', 1, 0, { lvl: 2 })), 'unsupported');
  bad('two mugs at level 1 on one spot are refused', ok(stackedMug, topOf('mug2', 'mug', 'desk', 1, 0, { lvl: 1 })), 'overlap');
  check(ok(stackedMug, topOf('mug2', 'mug', 'desk', 2, 1, { lvl: 1 })).ok, 'two mugs side by side on one notebook are fine');
  bad('a laptop does not carry anything: it is not flat', ok(must(ok(base, topOf('lap', 'laptop', 'desk', 0, 0))), topOf('mug', 'mug', 'desk', 1, 0, { lvl: 1 })), 'unsupported');
  const books = must(ok(withNote, topOf('bk1', 'books', 'desk', 0, 0, { lvl: 1 })));
  const books2 = must(ok(books, topOf('bk2', 'books', 'desk', 0, 0, { lvl: 2, ang: 6 })));
  check(Math.abs(poseOf(books2, books2.stories[0].items.find((i) => i.id === 'bk2')!).y - (ITEM_DEFS.bench_desk.surface!.height + heightOf('notebook') + heightOf('books'))) < 1e-9, 'books on books on a notebook add up their heights');
  const four = must(ok(books2, topOf('f3', 'folder', 'desk', 0, 0, { lvl: 3 })));
  bad('a stack five high is refused', ok(four, topOf('c4', 'coaster', 'desk', 0, 0, { lvl: 4 })), 'unsupported');

  // what rests on a thing leaves with it, and comes back with undo
  const takeNote = applyOps(stackedMug, [{ t: 'items', story: 0, put: [], del: [id('nb')] }], noCtx);
  check(takeNote.ok && !takeNote.building.stories[0].items.some((i) => i.id === 'nb' || i.id === 'mug'), 'taking the notebook away takes the mug with it: a stack never keeps a mug in the air');
  check(takeNote.ok && eq(must(applyOps(takeNote.building, takeNote.inverse, noCtx)), stackedMug), 'and undo brings both back, the mug still on the notebook');
  const slid = applyOps(stackedMug, [put(0, topOf('nb', 'notebook', 'desk', 0, 4, { look: 1 }))], noCtx);
  check(!slid.ok && kinds(slid).includes('unsupported'), 'sliding the notebook out from under the mug is refused');
  const moved = applyOps(stackedMug, [put(0, topOf('mug', 'mug', 'desk', 0, 0, { lvl: 1 }), topOf('nb', 'notebook', 'desk', 0, 4, { look: 1 }))], noCtx);
  check(!moved.ok || kinds(moved).length === 0, 'unless the mug moves in the same edit');
  const hostGone = applyOps(books2, [{ t: 'items', story: 0, put: [], del: [id('desk')] }], noCtx);
  check(hostGone.ok && hostGone.building.stories[0].items.length === 1 && eq(must(applyOps(hostGone.building, hostGone.inverse, noCtx)), books2), 'deleting the desk deletes the whole stack, and undo brings it all back');

  // picking and aiming
  const down = (x: number, z: number): PickRay => ({ o: { x, y: 4, z }, d: { x: 0, y: -1, z: 0 } });
  const mugPose = poseOf(stackedMug, mugOn);
  check(topItemAt(stackedMug.stories[0], down(mugPose.x, mugPose.z))?.id === 'mug', 'a ray down onto the mug on the notebook picks the mug');
  check(topItemAt(stackedMug.stories[0], down(mugPose.x, mugPose.z), id('mug'))?.id === 'nb', 'without the mug in the way it picks the notebook under it');
  const [nbPose] = [poseOf(stackedMug, notebook)];
  check(topItemAt(stackedMug.stories[0], down(nbPose.box.x1 - 0.03, nbPose.box.z1 - 0.03))?.id === 'nb', 'and a ray onto the bare end of the notebook picks the notebook');
  const nbItem = stackedMug.stories[0].items.find((i) => i.id === 'nb') as never as Item & { on: ItemId };
  check(restingOn(stackedMug.stories[0], nbItem as never).map((i) => i.id).join() === 'mug' && topOfStack(stackedMug.stories[0], nbItem as never).id === 'mug', 'what rests on the notebook is the mug, and the mug is what a hand takes first');
  check(Math.abs((pointAtHeight({ o: { x: 1, y: 3, z: 1 }, d: { x: 0, y: -1, z: 0 } }, 1)?.x ?? 0) - 1) < 1e-9 && pointAtHeight({ o: { x: 1, y: 3, z: 1 }, d: { x: 0, y: 1, z: 0 } }, 1) === null, 'a point of a ray at a height, and none for a ray that goes up');
  const desk = hostOf(withNote, 'desk');
  const spot = stackSpot(desk, ITEM_DEFS.bench_desk, nbItem as never, ITEM_DEFS.notebook, ITEM_DEFS.mug, 0, { x: nbPose.x + 0.4, z: nbPose.z });
  check(!!spot && spot.lvl === 1 && ok(withNote, topOf('m', 'mug', 'desk', spot.u, spot.v, { lvl: spot.lvl, rot: spot.rot })).ok, 'the spot for a mug aimed at the end of a notebook is pulled in so the mug stays on it');
  check(stackSpot(desk, ITEM_DEFS.bench_desk, nbItem as never, ITEM_DEFS.notebook, ITEM_DEFS.vase, 0, { x: nbPose.x, z: nbPose.z })?.lvl === 1, 'a vase fits a notebook');
  const coaster = must(ok(base, topOf('co', 'coaster', 'desk', 0, 0)));
  check(stackSpot(desk, ITEM_DEFS.bench_desk, coaster.stories[0].items.find((i) => i.id === 'co') as never, ITEM_DEFS.coaster, ITEM_DEFS.vase, 0, { x: 5.2, z: 5.1 }) === null && stackSpot(desk, ITEM_DEFS.bench_desk, nbItem as never, ITEM_DEFS.laptop, ITEM_DEFS.mug, 0, { x: 1, z: 1 }) === null, 'a vase is too big for a coaster, and a laptop carries nothing');

  // a block move keeps the stack together, on its floor and on another
  const two = must(applyOps(flat(2), [put(0, item('desk', 'bench_desk', 10, 10), item('table', 'meeting_table', 20, 20, 1))], noCtx));
  const dressed = must(applyOps(two, [put(0, item('b:desk', 'bench_desk', 4, 30, 0, 'blk')), put(0, topOf('b:nb', 'notebook', 'b:desk', 0, 0), topOf('b:mug', 'mug', 'b:desk', 1, 0, { lvl: 1, look: 2, ang: 5 }))], noCtx));
  const blockStory = dressed.stories[0];
  const shifted = must(applyOps(dressed, moveBlockOps(blockStory, 0, 'blk', blockPose(blockItems(blockStory, 'blk'), 1, { x: 30, z: 30 })), noCtx));
  const mugNow = shifted.stories[0].items.find((i) => i.id === 'b:mug')!;
  check(mugNow.on === 'b:desk' && mugNow.lvl === 1 && mugNow.look === 2 && mugNow.ang === 5 && validate(shifted, noCtx).every((v) => v.kind === 'story_unreachable'), 'a block moved and turned keeps a mug on its notebook, with its look and turn');
  const upstairs = must(applyOps(dressed, moveBlockOps(blockStory, 0, 'blk', blockPose(blockItems(blockStory, 'blk'), 0, { x: 20, z: 12 }), 1), noCtx));
  check(upstairs.stories[1].items.filter((i) => i.on !== undefined).map((i) => `${i.id}:${i.lvl ?? 0}`).sort().join() === 'b:mug:1,b:nb:0', 'and carried to another floor');

  // the verdict that drives the ghost stays fast with stacks about
  const t0 = performance.now();
  for (let n = 0; n < 500; n++) checkOps(stackedMug, [put(0, topOf('probe', 'mug', 'desk', 1 + (n % 2), n % 2, { lvl: 1 }))], noCtx);
  const mean = (performance.now() - t0) / 500;
  console.log(`checkOps one stacked item: mean ${mean.toFixed(3)} ms`);
  check(mean < 1, 'checkOps for one stacked item under 1 ms');
}

// ---------------------------------------------------------------- performance
{
  const size = 40;
  const lot = { x0: 0, z0: 0, w: size, h: size };
  const populate = (): Building => {
    let b = emptyBuilding(lot, 3);
    const ops: BuildOp[] = [];
    for (let s = 0; s < 3; s++) {
      const items: Item[] = [];
      for (let n = 0; n < 100; n++) {
        const x = 4 + (n % 10) * 7;
        const z = 4 + Math.floor(n / 10) * 7;
        items.push(n % 2 ? item(`s${s}-${String(n).padStart(3, '0')}`, 'bench_desk', x, z) : item(`s${s}-${String(n).padStart(3, '0')}`, 'plant', x, z));
      }
      ops.push(paintRect(s, { x: 0, z: 0, w: size, h: size }, PAINT.concrete), { t: 'walls', story: s, put: [{ x: 1, z: 1, d: 'e', style: 0 }, { x: 5, z: 5, d: 's', style: 1 }], del: [] }, put(s, ...items));
    }
    b = must(applyOps(b, ops, noCtx));
    return parseBuilding(encodeBuilding(b));
  };
  const times: number[] = [];
  for (let n = 0; n < 7; n++) {
    const b = populate();
    const t0 = performance.now();
    deriveFloors(b);
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  const median = times[3];
  console.log(`deriveFloors 3 stories, 40x40, 300 items: median ${median.toFixed(2)} ms, worst ${times[6].toFixed(2)} ms`);
  check(median < 15, 'deriveFloors under 15 ms');

  const b = populate();
  deriveFloors(b);
  const move = (n: number): BuildOp[] => [put(1, item('s1-051', 'bench_desk', 4 + (n % 5) * 2, 4 + 7))];
  checkOps(b, move(0), noCtx);
  const runs = 500;
  let worst = 0;
  const t0 = performance.now();
  for (let n = 0; n < runs; n++) {
    const t = performance.now();
    checkOps(b, move(n), noCtx);
    worst = Math.max(worst, performance.now() - t);
  }
  const mean = (performance.now() - t0) / runs;
  console.log(`checkOps one item move: mean ${mean.toFixed(3)} ms, worst ${worst.toFixed(3)} ms over ${runs} runs`);
  check(mean < 1, 'checkOps for one item move under 1 ms');
}

finish();
