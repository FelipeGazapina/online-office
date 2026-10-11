// No model, no Electron. A team at work through the real mailroom: the owner gives the PO a goal, the PO splits it over three
// teammates, two of them settle a detail between themselves, and the PO reports back. Then it checks the conversations the Chat
// app on the owner's Mac shows: the owner's thread with each person, and one private thread per pair of teammates.
// Run from app/: node verify/team-chat-check.ts [--write]   Exits 1 on any failed check.
// --write saves what the mailroom ended with to verify/fixtures/team-chat.json, which verify/e2e-team-chat.mjs shows on screen.
import { writeFileSync } from 'node:fs';
import type { EmployeeId } from '../src/shared/protocol.ts';
import { betweenPair, pairKey, type ConvoKey, type Message, type MessageId } from '../src/shared/mail.ts';
import { check, finish } from './check.ts';
import { ANA, B1, BRUNO, CLEO, PO, world } from './mail-world.ts';

const start = Date.now() - 40 * 60_000;
let now = start;
const at = (min: number) => void (now = start + min * 60_000);
const w = world([], undefined, () => now);
const ok = (r: ReturnType<typeof w.room.post>) => {
  if (!r.ok) throw new Error(`post refused: ${r.reason} ${r.detail}`);
  return r.id;
};
const say = (from: EmployeeId, to: string, text: string) => ok(w.room.post({ from, to, body: { kind: 'say', text } }));
const ask = (from: EmployeeId, to: string, title: string, text: string, bar?: string[], intent: 'work' | 'help' = 'work') =>
  ok(w.room.post({ from, to, body: { kind: 'request', intent, title, text, ...(bar ? { bar } : {}) } }));
const thread = (convo: ConvoKey) => w.room.history(convo, undefined, 200).messages;
const kinds = (ms: Message[]) => ms.map((m) => `${m.kind}:${m.from}>${m.to}`).join(' ');

console.log('# the owner gives the PO a goal');
at(0);
const goal = ok(w.room.post({ from: 'owner', to: 'po', blockId: B1, body: { kind: 'request', text: 'Add CSV export to the reports page, with tests and a docs section.' } }));
at(0.2);
say(PO, 'owner', 'On it. I will split this into the API, the UI and the docs, one piece each.');
at(0.6);
const api = ask(PO, 'Ana', 'API: GET /reports.csv', 'Expose GET /reports.csv returning RFC 4180 CSV of the visible rows. Only touch src/routes/reports.ts and its test.', ['returns text/csv with a header row', 'quotes commas and line breaks', 'has a test for quoting']);
const ui = ask(PO, 'Bruno', 'UI: Export button', 'Add an Export button to /reports that downloads from GET /reports.csv. Only touch src/pages/Reports.tsx.', ['button sits next to the filters', 'downloads a .csv file']);
const docs = ask(PO, 'Cleo', 'Docs: Export to CSV', 'Write an "Export to CSV" section in README.md that says what the file holds.');
at(0.8);
say(PO, 'Ana', 'Bruno builds the button against your route. Agree the column names with him directly, not through me.');
w.room.turnEnded(PO, 'Split into three pieces.', true);
check(w.room.state.unsettled.has(goal), 'the PO splits the goal and stays on it while the pieces are out');
check(w.prompts.get(ANA)?.some((p) => p.includes('API: GET /reports.csv') || p.includes('GET /reports.csv')) === true && w.prompts.get(BRUNO)?.length === 1 && w.prompts.get(CLEO)?.length === 1, 'each teammate gets their own piece');

console.log('\n# two teammates settle a detail between themselves');
at(3);
say(ANA, 'Bruno', 'The route returns id, title, owner and created_at, in that order. Does the button need anything else?');
at(3.5);
const help = ask(ANA, 'Bruno', 'Download file name', 'Which file name should the download use? I will send it in Content-Disposition.', undefined, 'help');
check(w.room.state.life.get(help)?.s === 'queued', 'Bruno is busy on his own piece, so Ana\'s question waits for him');
at(6);
w.room.turnEnded(BRUNO, 'The Export button is next to the filters and downloads the file.', true);
at(7);
say(BRUNO, 'Ana', 'Those columns work for the button. Nothing else needed.');
w.room.reply(BRUNO, help, { outcome: 'done', text: 'Use reports-YYYY-MM-DD.csv. The button reads it from Content-Disposition, so nothing is hard coded on my side.' });
w.room.turnEnded(BRUNO, 'Answered Ana.', true);
at(9);
w.fresh.add('src/routes/reports.ts').add('test/reports.test.ts');
const apiDone = w.room.reply(ANA, api, { outcome: 'done', text: 'GET /reports.csv returns RFC 4180 CSV named reports-YYYY-MM-DD.csv. The quoting test covers commas, quotes and line breaks.', artifact: ['src/routes/reports.ts', 'test/reports.test.ts'] });
check(apiDone.ok, 'Ana settles her piece with the files she changed', JSON.stringify(apiDone));
w.room.turnEnded(ANA, 'Done.', true);
// Bruno's lines waited for her while she worked, and arrive now as a turn of their own.
w.room.turnEnded(ANA, 'Read Bruno\'s answer.', true);
at(10);
w.room.turnEnded(CLEO, 'Added the "Export to CSV" section to README.md: columns, file name, and the row limit.', true);
at(11);
w.room.turnEnded(PO, 'CSV export shipped: the API with its quoting test (Ana), the Export button (Bruno) and the README section (Cleo). All three pieces passed my check.', true);
// The replies came back while the PO was awake, so they wake it once more each until nothing waits for it.
for (let i = 0; i < 5 && w.room.state.active.has(PO); i++) w.room.turnEnded(PO, 'Checked the pieces.', true);
check(!w.room.state.active.has(PO), 'the PO goes idle once the replies are read');
const final = [...w.room.state.messages.values()].find((m) => m.kind === 'reply' && m.requestId === goal);
check(final?.kind === 'reply' && final.outcome === 'done' && final.to === 'owner', 'the PO reports back to the owner once every piece is in');

console.log('\n# the next goal is in progress');
at(25);
const next = ok(w.room.post({ from: 'owner', to: 'po', blockId: B1, body: { kind: 'request', text: 'Next: add a PDF export of the same report.' } }));
at(25.3);
say(PO, 'owner', 'Starting on PDF. Ana takes the renderer and will split it with subagents.');
at(25.6);
const pdf = ask(PO, 'Ana', 'PDF: render the report', 'Render the visible report rows to PDF at GET /reports.pdf. Split the work with subagents if it helps.', ['one page per 40 rows', 'same columns as the CSV', 'snapshot test of page one']);
w.room.turnEnded(PO, 'Handed the PDF renderer to Ana.', true);
at(26);
say(ANA, 'owner', 'Got the PDF piece. I am running two subagents: one reads the report templates, one writes the snapshot test.');
check(w.room.state.unsettled.has(next) && w.room.state.life.get(pdf)?.s === 'delivered', 'the PO is waiting on Ana, who is working on her piece');
check(w.room.state.messages.get(pdf)?.parentId === next, 'the PDF piece belongs to the owner\'s second goal');

console.log('\n# what the Chat app shows');
const dm = thread('dm:po' as ConvoKey);
check(dm.some((m) => m.id === goal) && dm.some((m) => m.id === api) && dm.some((m) => m.id === final?.id), 'the owner\'s thread with the PO holds the goal, the pieces it went out as, and the report back');
const anaBruno = thread(pairKey(ANA, BRUNO));
check(anaBruno.length === 4 && anaBruno.every((m) => betweenPair(m, ANA, BRUNO)), 'Ana and Bruno have a thread of their own with the four lines they sent each other', kinds(anaBruno));
check(anaBruno.some((m) => m.id === help) && anaBruno.some((m) => m.kind === 'reply' && m.requestId === help), 'it holds Ana\'s question and Bruno\'s answer');
const poAna = thread(pairKey(PO, ANA));
check(poAna.some((m) => m.id === api) && poAna.some((m) => m.id === pdf) && poAna.some((m) => m.kind === 'reply' && m.requestId === api) && !poAna.some((m) => m.from === BRUNO || m.to === BRUNO), 'the PO and Ana have another, with her pieces and her result, and no Bruno in it');
const poBruno = thread(pairKey(PO, BRUNO));
check(poBruno.some((m) => m.id === ui) && poBruno.some((m) => m.kind === 'reply' && m.requestId === ui) && !poBruno.some((m) => m.id === help), 'the PO and Bruno have theirs');
const poCleo = thread(pairKey(PO, CLEO));
check(poCleo.some((m) => m.id === docs) && poCleo.length === 2, 'and so do the PO and Cleo', kinds(poCleo));
check(thread(pairKey(BRUNO, CLEO)).length === 0, 'two teammates who never talked have an empty thread');
check(thread(pairKey(ANA, CLEO)).length === 0, 'nor do Ana and Cleo');

if (process.argv.includes('--write')) {
  const convos: ConvoKey[] = [...(['po', 'ana', 'bruno', 'cleo'] as const).map((e) => `dm:${e}` as ConvoKey), pairKey(PO, ANA), pairKey(PO, BRUNO), pairKey(PO, CLEO), pairKey(ANA, BRUNO), pairKey(ANA, CLEO), pairKey(BRUNO, CLEO)];
  const histories = Object.fromEntries(convos.map((c) => [c, thread(c)]));
  const file = new URL('./fixtures/team-chat.json', import.meta.url);
  writeFileSync(file, `${JSON.stringify({ generatedAt: now, view: w.room.view(), histories, ids: { goal, api, ui, docs, help, pdf, next } satisfies Record<string, MessageId> }, null, 1)}\n`);
  console.log(`\nwrote ${file.pathname}`);
}
finish();
