// No model, no Electron. Build mode as a session on the real Office: a draft that stays out of company.json, Clear all,
// a save that is refused until the essentials stand, discard, and a whole office built from an empty lot.
// Run from app/: node verify/build-session-check.ts   Exits 1 on any failed check.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessStatus, Provider } from '../src/shared/protocol.ts';
import { drawRoom, ITEM_DEFS, missingEssentials, type Building, type BuildOp, type Item, type ItemId, type Missing, type Violation } from '../src/shared/space/index.ts';
import { spaceContext } from '../src/renderer/src/hud/build/state.ts';
import { HARNESSES } from '../src/main/office/adapters/index.ts';
import { Office } from '../src/main/office/company.ts';
import { startOfficeMcp } from '../src/main/office/mcp.ts';
import { MemoryStore } from '../src/main/office/memory.ts';
import { check, finish } from './check.ts';

delete process.env.OFFICE_CLAUDE_MODEL;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'build-session-check-')));
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
let incomplete: readonly Missing[] | null = null;
let pushed: Building | undefined;
const open = (file: string) =>
  new Office(file, statuses, {
    changed() {},
    said() {},
    log() {},
    building: (b) => void (pushed = b),
    rejected: (v) => void (rejected = v),
    incomplete: (m) => void (incomplete = m),
  }, { mcp, memory });

const file = join(dir, 'company.json');
writeFileSync(file, readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));
const storedBuilding = () => JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).building);
const items = (b: Building): Item[] => b.stories.flatMap((s) => s.items);
const kinds = (m: readonly Missing[] | null) => (m ?? []).map((x) => x.kind).sort().join(',');

let o = open(file);
const shown = () => o.buildingState().building;
const original = JSON.stringify(shown().stories[0].items);
const saved0 = storedBuilding();

console.log('# an office that already runs saves as it is');
check(missingEssentials(shown(), spaceContext(o.snapshot().company)).length === 0, 'the migrated office has every essential', JSON.stringify(missingEssentials(shown(), spaceContext(o.snapshot().company))));
o.handle({ type: 'build_begin' });
check(o.snapshot().buildDraft === true, 'build_begin opens a draft and the snapshot says so');
o.handle({ type: 'build_save' });
check(incomplete === null && o.snapshot().buildDraft === false, 'saving an untouched draft closes the session without complaint');

console.log('# clear all, then discard');
o.handle({ type: 'build_begin' });
o.handle({ type: 'build_clear' });
const cleared = shown();
check(items(cleared).length === 0 && cleared.stories.every((s) => s.walls.length === 0 && s.paint.every((p) => p === 0)) && cleared.stories.length === 1, 'Clear all leaves an empty lot: no items, walls or floor, one level', JSON.stringify(rejected));
check(cleared.bare === true, 'Clear all also takes away the stock lobby, reception, kitchen and lounge');
check(pushed === cleared, 'the renderer is shown the cleared draft');
check(storedBuilding() === saved0, 'company.json still holds the old building while the draft is open');
o.handle({ type: 'build_save' });
check(kinds(incomplete) === 'desks,desks,desks,entrance,owner_desk,team_item,team_item,team_item,team_item', 'saving an empty lot is refused and names every missing essential', kinds(incomplete));
check(o.snapshot().buildDraft === true && items(shown()).length === 0, 'after the refusal the draft is still open and still empty');
o.handle({ type: 'undo' });
check(JSON.stringify(shown().stories[0].items) === original && !shown().bare, 'undo in the draft brings back what Clear all took, stock rooms included');
o.handle({ type: 'redo' });
check(items(shown()).length === 0, 'redo clears it again');
o.handle({ type: 'build_discard' });
check(o.snapshot().buildDraft === false && JSON.stringify(shown().stories[0].items) === original, 'discard drops the draft and the office is back as it was');
check(storedBuilding() === saved0, 'and company.json never changed');
o.handle({ type: 'undo' });
check(JSON.stringify(shown().stories[0].items) === original, 'an undo after discard has nothing of the draft to undo');

console.log('# build a whole office from an empty lot');
incomplete = null;
o.handle({ type: 'build_begin' });
o.handle({ type: 'build_clear' });
const { lot } = shown();
const room = { x: lot.x0 + 2, z: lot.z0 + lot.h - 16, w: 30, h: 16 };
const door = { x: room.x + 4, z: room.z + room.h, d: 'e' as const, style: 0, open: 'door' as const };
const build = (ops: BuildOp[]) => {
  rejected = [];
  o.handle({ type: 'build', ops });
  return rejected;
};
check(build(drawRoom(0, room, { paint: 1 })).length === 0, 'a room with a floor goes onto the empty lot', JSON.stringify(rejected));
const cx = room.x * 2;
const cz = room.z * 2;
let n = 0;
const piece = (def: string, x: number, z: number, blockId?: string): Item => ({ id: `${blockId ?? 'office'}:${def}:${String(n++).padStart(2, '0')}` as ItemId, def, x, z, rot: 0, ...(blockId && { blockId }) });
const people = o.snapshot().company.employees;
const desks = people.map((e, i) => piece(e.role === 'orchestrator' ? 'po_desk' : 'bench_desk', cx + 4 + i * 6, cz + 8, e.blockId));
check(build([{ t: 'items', story: 0, put: desks, del: [] }]).length === 0, 'a desk for each of the four people', JSON.stringify(rejected));
o.handle({ type: 'build_save' });
check(kinds(incomplete) === 'entrance,owner_desk,team_item,team_item,team_item,team_item', 'with desks alone the save still wants a door, your desk and each team its board pieces', kinds(incomplete));
const boards = ['blk-a', 'blk-b'].flatMap((b, i) => [piece('whiteboard', cx + 4 + i * 22, cz + 18, b), piece('board_terminal', cx + 16 + i * 22, cz + 18, b)]);
check(build([{ t: 'items', story: 0, put: [...boards, piece('owner_desk', cx + 40, cz + 8)], del: [] }]).length === 0, 'each team gets its whiteboard and board computer, and the owner a desk', JSON.stringify(rejected));
incomplete = null;
o.handle({ type: 'build_save' });
check(kinds(incomplete) === 'entrance', 'without a door into the room the save still refuses, now only for the entrance', kinds(incomplete));
check(build([{ t: 'walls', story: 0, put: [door], del: [] }]).length === 0, 'a door goes into the outer wall', JSON.stringify(rejected));
const walled = drawRoom(0, { x: room.x + 18, z: room.z + 1, w: 6, h: 6 }).filter((op) => op.t === 'walls');
check(build(walled).length === 0, 'a closed inner room is drawn around the owner desk', JSON.stringify(rejected));
incomplete = null;
o.handle({ type: 'build_save' });
check(kinds(incomplete) === 'owner_desk_unreachable', 'a desk nobody can walk to blocks the save', kinds(incomplete));
o.handle({ type: 'undo' });
incomplete = null;
o.handle({ type: 'build_save' });
check(incomplete === null && o.snapshot().buildDraft === false, 'with everything in place the save goes through', kinds(incomplete));
const built = items(shown());
check(built.length === desks.length + boards.length + 1 && built.every((i) => [...desks, ...boards].some((d) => d.id === i.id) || i.def === 'owner_desk'), 'the saved office is exactly what was built');
const seats = o.snapshot().company.employees.map((e) => built.find((i) => i.id === e.seat));
check(
  o.snapshot().company.employees.every((e, i) => seats[i] && seats[i]!.blockId === e.blockId && ITEM_DEFS[seats[i]!.def].kind === (e.role === 'orchestrator' ? 'po_desk' : 'bench_desk')),
  'everyone sits at a new desk of their own team and kind',
);
check(new Set(seats.map((s) => s?.id)).size === seats.length, 'and no two share a desk');
const savedBuilt = storedBuilding();
check(savedBuilt !== saved0 && JSON.parse(savedBuilt).bare === true, 'company.json now holds the new office, without the stock rooms');
o.handle({ type: 'undo' });
check(items(shown()).length === built.length, 'an undo after the save cannot reach back into the draft');
o.shutdown();
o = open(file);
check(storedBuilding() === savedBuilt && items(shown()).length === built.length && shown().bare === true, 'after a restart the new office is still there, unchanged');

console.log('# office-made edits during a draft');
o.handle({ type: 'build_begin' });
o.handle({ type: 'remove_block', blockId: 'blk-b' as never });
check(!items(shown()).some((i) => i.blockId === 'blk-b'), 'removing a team during a draft takes its pieces out of the draft too');
o.handle({ type: 'build_save' });
check(o.snapshot().buildDraft === false && !items(shown()).some((i) => i.blockId === 'blk-b'), 'and the save keeps no piece of the removed team');
o.handle({ type: 'build_begin' });
o.handle({ type: 'hire', provider: 'claude-code', blockId: 'blk-a' as never, name: 'Gil', bypassLimit: true });
const gil = o.snapshot().company.employees.find((e) => e.name === 'Gil')!;
check(!!gil.seat && items(shown()).some((i) => i.id === gil.seat), "a hire during the draft gets a desk, and the draft shows it too");
o.handle({ type: 'build_discard' });
check(o.snapshot().company.employees.every((e) => e.seat !== null), 'after discarding, everyone has a desk in the saved office');
o.shutdown();
finish();
