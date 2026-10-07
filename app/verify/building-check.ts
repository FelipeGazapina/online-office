// No model, no Electron. The real Office on a company.json from before the building: migration, hire and fire seating,
// build / undo / redo, and a second launch that must leave the building part of the file untouched.
// Run from app/: node verify/building-check.ts   Exits 1 on any failed check.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmployeeId, HarnessStatus, Provider } from '../src/shared/protocol.ts';
import { ITEM_DEFS, deriveFloors, isFloor, type Building, type Item, type ItemId, type Violation } from '../src/shared/space/index.ts';
import { HARNESSES } from '../src/main/office/adapters/index.ts';
import { Office } from '../src/main/office/company.ts';
import { startOfficeMcp } from '../src/main/office/mcp.ts';
import { MemoryStore } from '../src/main/office/memory.ts';
import { check, finish } from './check.ts';

delete process.env.OFFICE_CLAUDE_MODEL;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'building-check-')));
const repo = join(dir, 'repo');
mkdirSync(join(repo, 'b'), { recursive: true });
const memory = MemoryStore.open(join(dir, 'memory'));
const mcp = await startOfficeMcp();

HARNESSES['claude-code'] = {
  ...HARNESSES['claude-code'],
  detect: async () => 'fake',
  session: () => ({ assign() {}, interject() {}, setModel() {}, permissionsChanged() {}, rulesChanged() {}, stop() {} }),
};
const statuses: Record<Provider, HarnessStatus> = { 'claude-code': { kind: 'ready', version: 'fake' }, codex: { kind: 'missing' }, hermes: { kind: 'missing' } };

let rejected: readonly Violation[] = [];
let pushed: Building | undefined;
const open = (file: string) =>
  new Office(file, statuses, { changed() {}, said() {}, log() {}, building: (b) => void (pushed = b), rejected: (v) => void (rejected = v) }, { mcp, memory });

const file = join(dir, 'company.json');
writeFileSync(file, readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
const stored = (): { building: unknown; employees: { seat: string | null; desk?: number }[] } => JSON.parse(readFileSync(file, 'utf8'));
check(!('building' in stored()), 'the fixture has no building field');

console.log('# migration');
const office = open(file);
const snap = () => office.snapshot().company;
const items = (b: Building): Item[] => b.stories.flatMap((s) => s.items);
const itemOf = (id: ItemId | null) => items(office.buildingState().building).find((i) => i.id === id);
check(snap().employees.every((e) => e.seat !== null && !('desk' in e)), 'every employee has a seat and no desk');
const ana = snap().employees.find((e) => e.name === 'Ana')!;
check(itemOf(ana.seat)?.def === 'po_desk' && itemOf(ana.seat)?.blockId === 'blk-a', 'the orchestrator sits at its block PO desk');
const benchSeats = snap().employees.filter((e) => e.role !== 'orchestrator').map((e) => itemOf(e.seat));
check(benchSeats.every((i) => i?.def === 'bench_desk' && i.blockId === snap().employees.find((e) => itemOf(e.seat) === i)!.blockId), 'the others sit at bench desks of their own block');
check(new Set(snap().employees.map((e) => e.seat)).size === 4, 'no two employees share a desk');
check(snap().employees.find((e) => e.name === 'Cleo')!.seat === 'blk-a:bench_desk:03', 'an old desk index becomes the same bench desk');
check(items(office.buildingState().building).some((i) => i.def === 'board_terminal' && i.blockId === 'blk-a'), 'each team has a board terminal');
check(items(office.buildingState().building).some((i) => i.def === 'meeting_table'), 'the shared meeting table is an item');
check(typeof office.snapshot().buildingRev === 'number', 'the snapshot carries buildingRev');
const POD = ['pod_rug', 'pod_rail_back', 'pod_rail_side', 'pod_glass_rail', 'pod_slat_wall', 'pod_credenza', 'pod_shelf', 'pod_huddle_table', 'pod_daily_sign', 'chair', 'plant', 'lamp_floor'];
const podOf = (b: Building, blockId: string) => items(b).filter((i) => i.blockId === blockId);
check(['blk-a', 'blk-b'].every((id) => POD.every((def) => podOf(office.buildingState().building, id).some((i) => i.def === def))), 'each team has its rug, boundary, decor and huddle as items');
check(stored().building && (stored().building as { shelled?: boolean }).shelled === true, 'the saved building says the pods are items now');

console.log('# idempotent');
const first = readFileSync(file, 'utf8');
const buildingPart = (text: string) => JSON.stringify(JSON.parse(text).building);
office.shutdown();
const again = open(file);
const second = readFileSync(file, 'utf8');
check(buildingPart(first) === buildingPart(second), 'a second launch leaves the building part byte-identical');
check(first === second, 'a second launch leaves company.json byte-identical');
check(JSON.stringify(again.snapshot().company.employees.map((e) => e.seat)) === JSON.stringify(stored().employees.map((e) => e.seat)), 'the seats persisted are the seats loaded');
again.shutdown();

console.log('# hire and fire');
const o = open(file);
const emps = () => o.snapshot().company.employees;
const blk = 'blk-b';
o.handle({ type: 'hire', provider: 'claude-code', blockId: blk as never, name: 'Eli', bypassLimit: true });
const eli = emps().find((e) => e.name === 'Eli')!;
check(ITEM_DEFS[items(o.buildingState().building).find((i) => i.id === eli.seat)!.def]?.kind === 'bench_desk', 'a hire sits at a bench desk');
check(eli.seat !== emps().find((e) => e.name === 'Dana')!.seat, 'the hire gets a free desk, not the taken one');
o.handle({ type: 'hire', provider: 'claude-code', blockId: blk as never, name: 'Orla', role: 'orchestrator', bypassLimit: true });
check(items(o.buildingState().building).find((i) => i.id === emps().find((e) => e.name === 'Orla')!.seat)?.def === 'po_desk', 'a hired orchestrator sits at the PO desk');
const freed = eli.seat;
o.handle({ type: 'fire', employeeId: eli.id });
o.handle({ type: 'hire', provider: 'claude-code', blockId: blk as never, name: 'Fay', bypassLimit: true });
check(emps().find((e) => e.name === 'Fay')!.seat === freed, 'firing frees the desk for the next hire');
for (let n = 0; n < 6; n++) o.handle({ type: 'hire', provider: 'claude-code', blockId: blk as never, bypassLimit: true });
const seats = emps().map((e) => e.seat);
check(new Set(seats).size === seats.length && seats.every((s) => s !== null), 'overflow hires get new desks, never a shared one');

console.log('# build, reject, undo, redo');
const rev0 = o.snapshot().buildingRev;
const before = JSON.stringify(o.buildingState().building.stories[0].items);
const stray = { id: 'plant:99' as ItemId, def: 'plant', x: 30, z: -19, rot: 0 as const };
o.handle({ type: 'build', ops: [{ t: 'items', story: 0, put: [stray], del: [] }] });
check(items(o.buildingState().building).some((i) => i.id === stray.id) && o.snapshot().buildingRev > rev0, 'a legal build applies and bumps the rev', JSON.stringify(rejected));
check(pushed === o.buildingState().building, 'the new building is pushed to the renderer');
const rev1 = o.snapshot().buildingRev;
const cleo = emps().find((e) => e.name === 'Cleo')!;
const occupied = cleo.seat!;
const desk = itemOf(occupied);
if (!desk || !isFloor(desk)) throw new Error('the occupied seat is not a floor item');
o.handle({ type: 'build', ops: [{ t: 'items', story: 0, put: [{ ...desk, x: -400 }], del: [] }] });
check(rejected.length > 0 && o.snapshot().buildingRev === rev1, 'an illegal build is rejected with violations and changes nothing');
rejected = [];
o.handle({ type: 'build', ops: [{ t: 'items', story: 0, put: [], del: [occupied] }] });
const gone = !items(o.buildingState().building).some((i) => i.id === occupied);
const cleoNow = emps().find((e) => e.name === 'Cleo')!;
check(gone && cleoNow.seat !== null && cleoNow.seat !== occupied && itemOf(cleoNow.seat)?.def === 'bench_desk', 'deleting a seated desk moves its sitter to another desk', JSON.stringify(rejected));
o.handle({ type: 'undo' });
o.handle({ type: 'undo' });
check(JSON.stringify(o.buildingState().building.stories[0].items) === before, 'undo restores the building exactly');
o.handle({ type: 'redo' });
check(items(o.buildingState().building).some((i) => i.id === stray.id), 'redo applies the edit again');

console.log('# stories');
const floors0 = deriveFloors(o.buildingState().building).length;
check(floors0 === 1, 'the migrated office has one story');
o.handle({ type: 'build', ops: [{ t: 'stories', count: 2 }] });
check(o.buildingState().building.stories.length === 2, 'a build can add a story');

console.log('# block lifecycle');
const extra = join(dir, 'extra');
mkdirSync(extra);
o.handle({ type: 'create_block', cwd: extra });
const made = o.snapshot().company.blocks.find((b) => b.cwd === extra)!;
check(items(o.buildingState().building).filter((i) => i.blockId === made.id).length >= 9, 'a new block gets its desks, board and sign');
check(POD.filter((d) => d !== 'pod_slat_wall').every((def) => podOf(o.buildingState().building, made.id).some((i) => i.def === def)), 'and the rest of its pod');
const stray2 = items(o.buildingState().building).find((i) => i.id === 'plant:99');
check(!!stray2 && !items(o.buildingState().building).some((i) => i.blockId === made.id && i.def === 'pod_slat_wall'), "a new block's pod skips the piece the owner's plant is in the way of");
o.handle({ type: 'remove_block', blockId: made.id });
check(items(o.buildingState().building).every((i) => i.blockId !== made.id), 'removing a block takes its furniture with it, pod included');
console.log('# a piece the owner deletes stays deleted');
const rugOf = items(o.buildingState().building).find((i) => i.blockId === 'blk-a' && i.def === 'pod_rug')!;
const credenza = items(o.buildingState().building).find((i) => i.blockId === 'blk-a' && i.def === 'pod_credenza')!;
o.handle({ type: 'build', ops: [{ t: 'items', story: 0, put: [], del: [rugOf.id, credenza.id] }] });
check(!items(o.buildingState().building).some((i) => i.id === rugOf.id), 'the owner deletes the rug and the credenza');
o.shutdown();
const reopened = open(file);
const left = items(reopened.buildingState().building);
check(!left.some((i) => i.id === rugOf.id || i.id === credenza.id) && left.some((i) => i.blockId === 'blk-a' && i.def === 'pod_shelf'), 'after a restart they are still gone and the rest of the pod is there');
reopened.shutdown();
finish();
