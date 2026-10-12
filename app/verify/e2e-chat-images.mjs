// The owner attaches pictures in the chat and a real employee reads them. One real Claude session: the picture holds a word and
// a number drawn in the page, and the reply has to name both, which it can only do by opening the file the office saved.
// Real clicks and keys drive the composer. The attach button's file input and a paste both feed it.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9347 node verify/cdp.mjs verify/e2e-chat-images.mjs   Screenshots land in /tmp/office-shots.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HAIKU, assert, company, sceneReady, scratch } from './lib.mjs';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3', OFFICE_CLAUDE_MODEL: process.env.OFFICE_CLAUDE_MODEL ?? HAIKU };

const WORD = 'ZEBRA';
const NUMBER = '4172';
const LONG = 180000;
const tail = '__office.store.getState().mail.tail';
const count = (s, sel) => s.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

// A PNG drawn in the page, as a File the way the OS hands one over.
const picture = (name, lines, bg) => `(async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  const g = c.getContext('2d');
  g.fillStyle = ${JSON.stringify(bg)}; g.fillRect(0, 0, 640, 360);
  g.fillStyle = '#111'; g.font = 'bold 96px sans-serif'; g.textAlign = 'center';
  ${JSON.stringify(lines)}.forEach((t, i) => g.fillText(t, 320, 150 + i * 120));
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new File([blob], ${JSON.stringify(name)}, { type: 'image/png' });
})()`;

export default async (s) => {
  await s.waitFor(`!!${company}`);
  await s.resize(1440, 900);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${company}.blocks.length === 1`);
  await sceneReady(s);
  const blockId = await s.eval(`${company}.blocks[0].id`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Ana' })`);
  await s.waitFor(`${company}.employees.length === 1`);
  const ana = await s.eval(`${company}.employees[0].id`);
  await s.eval(`__office.set({ selectedId: ${JSON.stringify(ana)}, chatFocus: true })`);
  await s.waitFor(`!!document.querySelector('.cp-compose [data-attach]')`);
  assert(true, 'the composer has an attach button');

  // The attach button: the file the owner picks in the dialog arrives on its input.
  await s.eval(`(async () => {
    const input = document.querySelector('.cp-compose [data-attach-input]');
    const dt = new DataTransfer();
    dt.items.add(await ${picture('sign.png', [WORD, NUMBER], '#ffe9a8')});
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await s.waitFor(`document.querySelectorAll('.cp-compose .img-thumb img').length === 1`);
  assert(true, 'a picked file shows as a thumbnail above the message');

  // A paste: a copied screenshot lands in the same tray, and pasted text still goes into the message.
  await s.clickOn('#drawer-input');
  await s.eval(`(async () => {
    const dt = new DataTransfer();
    dt.items.add(await ${picture('extra.png', ['extra'], '#cfe8ff')});
    document.querySelector('#drawer-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await s.waitFor(`document.querySelectorAll('.cp-compose .img-thumb img').length === 2`);
  assert(true, 'a pasted picture joins it');
  await s.clickOn('.cp-compose .img-thumb:last-child button');
  await s.waitFor(`document.querySelectorAll('.cp-compose .img-thumb img').length === 1`);
  assert(true, 'the × on a thumbnail takes it off again');
  // A wrong kind of file is refused with a reason.
  await s.eval(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    document.querySelector('.cp-compose').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await s.waitFor(`__office.store.getState().toasts.some((t) => /Only PNG, JPEG, GIF and WebP/.test(t.text))`);
  assert((await count(s, '.cp-compose .img-thumb img')) === 1, 'a dropped text file is refused with a toast and the tray keeps its one picture');

  await s.clickOn('#drawer-input');
  await s.type('What word and what number are written in this image? Answer with exactly those two, nothing else.');
  await s.sleep(200);
  await s.shot('chat-images-1-composing');
  await s.press('Enter');

  await s.waitFor(`${tail}.some((m) => m.from === 'owner' && /\\[image: /.test(m.text))`);
  assert((await count(s, '.cp-compose .img-thumb')) === 0 && (await s.eval(`document.querySelector('#drawer-input').value`)) === '', 'sending empties the composer and its tray');
  // The bubble shows the words and the picture, and never the path the employee is given.
  await s.waitFor(`[...document.querySelectorAll('.cp-line.owner .img-attached img')].some((i) => i.naturalWidth === 640)`);
  await s.shot('chat-images-2-sent');
  const bubble = await s.eval(`document.querySelector('.cp-line.owner .msg.owner').innerText`);
  assert(bubble.startsWith('What word') && !bubble.includes('[image:') && !bubble.includes('attached these images'), `the owner's bubble holds only their words (${JSON.stringify(bubble)})`);
  assert(true, 'the sent picture is drawn in the thread at its full size, read back from the office');

  const files = readdirSync(join(dataDir, 'attachments'));
  assert(files.length === 1 && files[0].endsWith('.png'), `one PNG is saved in the app's data folder (${files})`);
  assert(!existsSync(join(repo, files[0])) && readdirSync(repo).filter((f) => f !== '.git').length === 0, 'and nothing in the project folder');

  // The employee's reply names what only the picture says.
  const reply = `${tail}.filter((m) => m.from === ${JSON.stringify(ana)} && m.to === 'owner').map((m) => m.text).join(' ')`;
  await s.waitFor(`${reply}.toUpperCase().includes(${JSON.stringify(WORD)}) && ${reply}.includes(${JSON.stringify(NUMBER)})`, LONG);
  assert(true, `the employee read the picture: ${JSON.stringify((await s.eval(reply)).slice(0, 200))}`);
  await s.waitFor(`${company}.employees[0].status.kind === 'idle'`, LONG);
  await s.eval(`__office.set({ selectedId: ${JSON.stringify(ana)} })`);
  await s.waitFor(`document.querySelectorAll('.cp-line.them .msg').length > 0 && !!document.querySelector('.cp-line.owner .img-attached img')`);
  await s.sleep(500);
  await s.shot('chat-images-3-answered');

  // The terminal on her monitor: a paste waits above the prompt as [Image #1], and goes with what is typed.
  await s.eval(`__office.set({ selectedId: null }); __officeMonitor.setState({ open: ${JSON.stringify(ana)} })`);
  await s.waitFor(`!!document.querySelector('[data-terminal] textarea')`);
  await s.sleep(600);
  await s.eval(`(async () => {
    const dt = new DataTransfer();
    dt.items.add(await ${picture('fruit.png', ['MANGO', '9031'], '#d9f2d0')});
    document.querySelector('[data-terminal] textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await s.waitFor(`document.querySelector('[data-terminal] .term-images')?.innerText.trim() === '[Image #1]'`);
  assert(true, 'a picture pasted into the terminal waits above the prompt as [Image #1]');
  await s.eval(`document.querySelector('[data-terminal] textarea').focus()`);
  await s.type('And in this one? Exactly the word and the number.');
  await s.sleep(200);
  await s.shot('chat-images-4-terminal');
  await s.press('Enter');
  await s.waitFor(`${reply}.toUpperCase().includes('MANGO') && ${reply}.includes('9031')`, LONG);
  assert(!(await s.eval(`!!document.querySelector('[data-terminal] .term-images')`)), 'the terminal sent it and the prompt is clear again');
  assert(true, 'the employee read the picture sent from the terminal');
  await s.waitFor(`${company}.employees[0].status.kind === 'idle'`, LONG);
  await s.eval(`__officeMonitor.setState({ open: null })`);

  // The Chat app on the owner's Mac: the same button, tray and thumbnails, and the picture alone is a message.
  await s.eval('window.__office.teleport(-15.6, 5.2, Math.PI); window.__office.step(0.5)');
  await s.press('KeyF', 'f');
  await s.waitFor('__office.store.getState().portalMode');
  await s.clickOn('.mac-tab', 'Chat');
  await s.waitFor(`!!document.querySelector('.tc-compose [data-attach]')`);
  await s.waitFor(`document.querySelectorAll('.tc-main .tc-msg .img-attached img').length === 2`);
  assert(true, 'the Chat app shows both earlier pictures in the conversation');
  const before = await s.eval(`${tail}.length`);
  await s.eval(`(async () => {
    const input = document.querySelector('.tc-compose [data-attach-input]');
    const dt = new DataTransfer();
    dt.items.add(await ${picture('alone.png', ['PIANO', '5508'], '#f3d6ee')});
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await s.waitFor(`document.querySelectorAll('.tc-compose .img-thumb img').length === 1`);
  assert(!(await s.eval(`document.querySelector('.tc-compose .tc-btn.send').disabled`)), 'a picture with no words can be sent');
  await s.shot('chat-images-5-mac-composing');
  await s.clickOn('.tc-compose .tc-btn.send', 'Send');
  await s.waitFor(`${tail}.length > ${before} && ${tail}.some((m) => m.from === 'owner' && m.kind === 'request' && m.intent === 'help' && m.text.startsWith('Look at this image.'))`);
  assert(true, 'it is posted as a question that says to look at the image');
  await s.waitFor(`${reply}.toUpperCase().includes('PIANO') || ${reply}.includes('5508')`, LONG);
  assert(true, 'the employee looked at the picture sent with no words');
  await s.waitFor(`document.querySelectorAll('.tc-main .tc-msg .img-attached img').length === 3`);
  await s.sleep(500);
  await s.shot('chat-images-6-mac-answered');
  assert(readdirSync(join(dataDir, 'attachments')).length === 3, 'three pictures are saved in all');
};

export const diagnose = async (s) => {
  console.log('tail:', JSON.stringify(await s.eval(`${tail}.map((m) => ({ from: m.from, kind: m.kind, text: m.text.slice(0, 300) }))`), null, 1));
  console.log('status:', JSON.stringify(await s.eval(`${company}.employees.map((e) => e.status)`)));
  await s.shot('chat-images-failed');
};
