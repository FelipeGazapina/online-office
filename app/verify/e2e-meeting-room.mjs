// The shared meeting room in the real app: the build bar's button takes it out and puts it back, with its table and chairs,
// undo reverses it, and a save keeps it across a restart. The button is real pointer input; the checks read the store and company.json.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9344 node verify/cdp.mjs verify/e2e-meeting-room.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
mkdirSync(join(repo, 'b'));
writeFileSync(join(dataDir, 'company.json'), readFileSync(new URL('./fixtures/company-no-building.json', import.meta.url), 'utf8').replaceAll('__REPO__', repo));

export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '5' };

const store = '__office.store.getState()';
const disk = () => JSON.parse(readFileSync(join(dataDir, 'company.json'), 'utf8')).building;
const PIECES = `${store}.building.stories.flatMap((st) => st.items).filter((i) => i.id === 'meeting_table:00' || /^chair:0[0-7]$/.test(i.id)).length`;
const label = (s) => s.eval(`document.querySelector('[data-testid=build-meeting]').innerText`);
const shown = (s) => s.eval(`document.querySelector('[data-testid=build-meeting]').dataset.on`);
const shot = async (s, name) => process.env.OFFICE_SHOTS_DIR && (await s.shot(name));

async function ready(s) {
  await s.waitFor(`!!window.__office && !!${store}.building && !!${store}.company`, 20000);
  await s.resize(1440, 900);
  await s.sleep(800);
}

export default async function (s, { launch }) {
  await ready(s);
  assert((await s.eval(PIECES)) === 9, 'the office starts with the meeting table and its eight chairs');
  const itemsAtStart = await s.eval(`${store}.building.stories.flatMap((st) => st.items).length`);

  // Build mode opens looking at where the owner stands, so stand by the meeting room for the screenshots.
  await s.eval(`(() => { const l = ${store}.building.lot; __office.teleport(l.x0 + l.w / 2, 2.5); __office.step(1); })()`);
  await s.press('KeyB', 'b');
  await s.waitFor(`${store}.build !== null`, 4000);
  await s.sleep(1500);
  assert((await label(s)) === 'Remove meeting room' && (await shown(s)) === 'true', 'build mode offers to remove the meeting room');
  await shot(s, 'meeting-room-there');

  await s.clickOn('[data-testid=build-meeting]');
  await s.waitFor(`${store}.building.meeting === false`, 4000);
  assert((await s.eval(PIECES)) === 0, 'one click takes out the table and the chairs');
  assert((await s.eval(`${store}.building.stories.flatMap((st) => st.items).length`)) === itemsAtStart - 9, 'and no other furniture');
  assert((await label(s)) === 'Add meeting room' && (await shown(s)) === 'false', 'the button now offers to add it');
  assert((await s.eval(`!${store}.building.bare`)), 'the reception, kitchen and lounge stay');
  assert(disk().meeting === undefined, 'company.json is untouched while the draft is open');
  await s.sleep(1500);
  await shot(s, 'meeting-room-gone');

  await s.clickOn('[aria-label="Undo"]');
  await s.waitFor(`${PIECES} === 9`, 4000);
  assert((await label(s)) === 'Remove meeting room', 'undo brings the room and its furniture back');
  await s.clickOn('[aria-label="Redo"]');
  await s.waitFor(`${PIECES} === 0`, 4000);

  await s.clickOn('[data-testid=build-save]');
  await s.waitFor(`${store}.build === null`, 4000);
  assert(disk().meeting === false && !disk().stories[0].items.some((i) => i.id === 'meeting_table:00'), 'saving writes the office without its meeting room');
  await s.sleep(400);
  await shot(s, 'meeting-room-gone-saved');

  await s.close();
  s = await launch({ env });
  await ready(s);
  assert((await s.eval(`${store}.building.meeting`)) === false && (await s.eval(PIECES)) === 0, 'after a restart the meeting room is still gone');

  await s.press('KeyB', 'b');
  await s.waitFor(`${store}.build !== null`, 4000);
  assert((await label(s)) === 'Add meeting room', 'build mode offers to add it');
  await s.clickOn('[data-testid=build-meeting]');
  await s.waitFor(`${store}.building.meeting === true`, 4000);
  assert((await s.eval(PIECES)) === 9, 'one click puts the room back with its table and eight chairs');
  assert(!(await s.eval(`${store}.toasts.some((t) => t.text.includes('meeting room'))`)), 'and says nothing was left out');
  await s.clickOn('[data-testid=build-save]');
  await s.waitFor(`${store}.build === null`, 4000);
  assert(disk().meeting === true && disk().stories[0].items.filter((i) => i.id === 'meeting_table:00').length === 1, 'saving writes the office with its meeting room again');
  await s.sleep(400);
  await shot(s, 'meeting-room-back');
}
