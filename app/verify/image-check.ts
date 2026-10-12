// No model, no Electron. The real Office with a scripted stand-in for the harness, checking the pictures the owner attaches:
// each one is saved outside the project, and the employee is handed its path whether the owner gives a task, steers a
// running turn or answers a question.
// Run from app/: node verify/image-check.ts   Exits 1 on any failed check.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES, splitImages, withImages, type ImageUpload, type Message } from '../src/shared/mail.ts';
import type { EmployeeId, Question } from '../src/shared/protocol.ts';
import { HARNESSES } from '../src/main/office/adapters/index.ts';
import type { SessionHost } from '../src/main/office/adapters/types.ts';
import { attachmentsDir, readImage } from '../src/main/office/attachments.ts';
import { Office } from '../src/main/office/company.ts';
import { startOfficeMcp } from '../src/main/office/mcp.ts';
import { MemoryStore } from '../src/main/office/memory.ts';
import { check, finish, sleep } from './check.ts';

process.env.OFFICE_START_LEVEL = '3';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'office-image-check-')));
const repo = join(dir, 'repo');
mkdirSync(repo);
const mcp = await startOfficeMcp();
const acker = { warm() {}, ack: () => undefined, stop() {} };

type Fake = { host: SessionHost; assigned: string[]; interjected: string[] };
const fakes: Fake[] = [];
HARNESSES['claude-code'] = {
  ...HARNESSES['claude-code'],
  detect: async () => 'fake',
  session: (host) => {
    const fake: Fake = { host, assigned: [], interjected: [] };
    fakes.push(fake);
    return {
      assign: (task, title) => {
        fake.assigned.push(task);
        host.setStatus({ kind: 'working', task: title ?? task, startedAt: Date.now() });
      },
      interject: (text) => void fake.interjected.push(text),
      interrupt() {},
      setModel() {},
      permissionsChanged() {},
      rulesChanged() {},
      stop() {},
    };
  },
};

const errors: string[] = [];
const dataFile = join(dir, 'company.json');
const office = new Office(
  dataFile,
  { 'claude-code': { kind: 'ready', version: 'fake' }, codex: { kind: 'missing' }, hermes: { kind: 'missing' }, cursor: { kind: 'missing' } },
  { building() {}, rejected() {}, changed() {}, said() {}, log() {}, error: (m) => void errors.push(m) },
  { mcp, memory: MemoryStore.open(join(dir, 'memory')), acker },
);
const store = attachmentsDir(dataFile);

// The smallest PNG there is, and a second file that differs from it.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = (name: string): ImageUpload => ({ name, mime: 'image/png', data: PNG });
const jpg: ImageUpload = { name: 'photo.jpg', mime: 'image/jpeg', data: Buffer.from('not really a jpeg, but bytes').toString('base64') };

office.handle({ type: 'create_block', cwd: repo });
const blockId = office.snapshot().company.blocks[0]!.id;
office.handle({ type: 'hire', provider: 'claude-code', blockId, name: 'Ana' });
const ana = office.snapshot().company.employees[0]!.id;
const fake = fakes[0]!;
const tail = (): Message[] => office.snapshot().mail.tail;
const saved = () => (existsSync(store) ? readdirSync(store) : []);
const refused = (run: () => void) => {
  try {
    run();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};
const question = (id: EmployeeId): Question | undefined => {
  const s = office.snapshot().company.employees.find((e) => e.id === id)!.status;
  return s.kind === 'blocked_on_owner' ? s.question : undefined;
};

console.log('# the text an employee reads');
const both = withImages('Match this mock.', ['/a/one.png', '/a/two.jpg']);
check(both.startsWith('Match this mock.\n\n'), 'the owner\'s words come first');
check(JSON.stringify(splitImages(both)) === JSON.stringify({ text: 'Match this mock.', images: ['/a/one.png', '/a/two.jpg'] }), 'the chat reads the words and the paths back out', JSON.stringify(splitImages(both)));
check(withImages('plain', []) === 'plain' && splitImages('plain [image: /x.png]').images.length === 0, 'a message with no pictures is untouched');
check(splitImages(withImages('', ['/a/one.png'])).text === 'Look at this image.', 'pictures with no words still say something');

console.log('# a task with pictures');
office.handle({ type: 'post', to: ana, clientId: 'c1', as: 'request', text: 'Fix the header so it matches this mock.', images: [png('mock.png'), jpg] });
await sleep(20);
const first = splitImages(tail().find((m) => m.key === 'c1' && m.kind === 'request')?.text ?? '');
check(first.text === 'Fix the header so it matches this mock.' && first.images.length === 2, 'the request carries both pictures', JSON.stringify(first));
check(first.images.every((p) => p.startsWith(store + '/') && existsSync(p)), 'each one is a file in the office\'s attachments folder');
check(first.images[0]!.endsWith('.png') && first.images[1]!.endsWith('.jpg'), 'in the order they were attached, named by their type');
check(readFileSync(first.images[0]!).equals(Buffer.from(PNG, 'base64')), 'the file holds the bytes the owner attached');
check(!first.images.some((p) => p.startsWith(repo)) && readdirSync(repo).length === 0, 'nothing is written into the project folder');
check(fake.assigned.length === 1 && first.images.every((p) => fake.assigned[0]!.includes(`[image: ${p}]`)), 'the prompt the employee starts with names both files', fake.assigned[0]);

console.log('# while the employee works');
office.handle({ type: 'post', to: ana, clientId: 'c2', as: 'say', text: 'Use this one instead.', urgency: 'now', images: [png('newer.png')] });
await sleep(20);
const steer = splitImages(tail().find((m) => m.key === 'c2')?.text ?? '');
check(steer.images.length === 1 && fake.interjected.some((t) => t.includes(`[image: ${steer.images[0]}]`)), 'a steer hands the running turn the picture', JSON.stringify(fake.interjected));
office.handle({ type: 'post', to: ana, clientId: 'c3', as: 'request', text: '', images: [png('later.png')] });
await sleep(20);
const queued = tail().find((m) => m.key === 'c3');
check(queued?.kind === 'request' && queued.intent === 'help' && splitImages(queued.text).text === 'Look at this image.', 'pictures alone queue as a question, not a work order', JSON.stringify(queued));

console.log('# answering a question');
const asked = fake.host.ask({ kind: 'ask', text: 'Which logo do you mean?' });
await sleep(20);
office.handle({ type: 'answer', employeeId: ana, questionId: question(ana)!.id, text: 'This one.', images: [png('logo.png')] });
const answer = splitImages(await asked);
check(answer.text === 'This one.' && answer.images.length === 1 && existsSync(answer.images[0]!), 'the answer the employee gets names the picture', JSON.stringify(answer));
const permission = fake.host.ask({ kind: 'permission', text: 'Can I run a shell command?', tool: 'Bash', detail: 'npm test' });
await sleep(20);
const before = saved().length;
const noPicture = refused(() => office.handle({ type: 'answer', employeeId: ana, questionId: question(ana)!.id, text: 'yes', images: [png('x.png')] }));
check(/permission question/.test(noPicture) && question(ana)?.kind === 'permission' && saved().length === before, 'a permission card takes no picture and stays open', noPicture);
office.handle({ type: 'answer', employeeId: ana, questionId: question(ana)!.id, text: 'yes' });
check((await permission) === 'yes', 'and it is still answered with a plain yes');

console.log('# what is refused');
const count = saved().length;
const big = refused(() => office.handle({ type: 'post', to: ana, clientId: 'c4', as: 'request', text: 'too big', images: [png('ok.png'), { name: 'huge.png', mime: 'image/png', data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }] }));
check(/huge\.png is larger than 8 MB/.test(big) && saved().length === count && !tail().some((m) => m.key === 'c4'), 'an oversized picture refuses the whole post and writes nothing', big);
const nothing = refused(() => office.handle({ type: 'post', to: ana, clientId: 'c5', as: 'request', text: '  ' }));
check(/Write something or attach an image/.test(nothing), 'a post with no words and no picture is refused', nothing);

console.log('# reading a picture back for the chat');
check(readImage(store, first.images[0]!) === `data:image/png;base64,${PNG}`, 'a saved picture comes back as a data URL');
const outside = join(dir, 'secret.png');
writeFileSync(outside, 'secret');
check(readImage(store, outside) === null, 'a file outside the attachments folder is not read');
check(readImage(store, join(store, '..', 'secret.png')) === null, 'nor is one reached by climbing out of it');
check(readImage(store, dataFile) === null && readImage(store, join(store, 'missing.png')) === null, 'nor a file that is not a picture, or not there');

check(errors.length === 0, 'the office reported no error', errors.join(' | '));
office.shutdown();
await mcp.close();
finish();
