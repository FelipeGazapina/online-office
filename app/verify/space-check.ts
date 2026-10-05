// Proves the pure space module in plain Node. Run: node verify/space-check.ts
import { isDeepStrictEqual } from 'node:util';
import {
  BuildHistory,
  FLOOR_PAINTS,
  ITEM_DEFS,
  PAINT,
  WALL_STYLES,
  applyOps,
  checkOps,
  closeDoor,
  deriveFloors,
  deskOf,
  drawRoom,
  emptyBuilding,
  encodeBuilding,
  freeDesk,
  legacyBuilding,
  navOf,
  openDoor,
  paintRect,
  parseBuilding,
  placeDesk,
  route,
  seatPose,
  teamKit,
  validate,
  wallName,
  type Applied,
  type Building,
  type BuildOp,
  type EmployeeId,
  type Item,
  type ItemId,
  type SpaceContext,
  type ViolationKind,
} from '../src/shared/space/index.ts';
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
  check(plants === 7 && terminals === 2, `7 plants and a board terminal per block (${plants}, ${terminals})`);

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
  const other = applyOps(grown, [put(0, item('b3:bench_desk:00', 'bench_desk', grown.stories[0].items.find((i) => i.id === 'b3:bench_desk:00')!.x, grown.stories[0].items.find((i) => i.id === 'b3:bench_desk:00')!.z, 0, 'b1'))], kitCtx);
  check(kinds(other).includes('desk_wrong_block'), 'giving a seated desk to another team is desk_wrong_block');
  const dbl = validate(grown, { ...kitCtx, seats: new Map([['k0', id('b3:bench_desk:01')], ['k1', id('b3:bench_desk:01')]]) });
  check(dbl.some((v) => v.kind === 'desk_double_occupied'), 'two employees on one desk is desk_double_occupied');
  const stale = applyOps(grown, [put(0, item('zz', 'plant', 0, 0))], { ...kitCtx, seats: new Map([['k0', id('b3:po_desk:00')]]) });
  check(stale.ok, 'a seat that was already wrong does not block unrelated edits');
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
