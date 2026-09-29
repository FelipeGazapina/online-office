import { startMock } from './mockbridge.mjs';
export const url = 'http://localhost:5173/';
// Redirect only the bridge socket (not Vite's HMR socket) to the mock port.
export const preload = `
  const RealWS = window.WebSocket;
  window.__wsTries = [];
  window.WebSocket = class extends RealWS {
    constructor(u, p) {
      if (String(u).includes(':4800')) window.__wsTries.push(Date.now());
      super(String(u).replace(':4800', ':4801'), p);
    }
  };
`;
const j = (v) => JSON.stringify(v);
export default async (s) => {
  await s.sleep(3500);
  console.log('cold offline:', await s.eval("document.querySelector('.offline-card')?.innerText.replace(/\\n+/g,' | ')"), '| panel:', await s.eval("document.querySelector('.company')?.innerText"));
  await s.shot('p-offline-cold');
  const tries = await s.eval('__wsTries');
  console.log('bridge attempts so far:', tries.length, 'gaps ms:', j(tries.slice(1).map((t, i) => t - tries[i])));

  const mock = startMock();
  await s.waitFor("!!document.querySelector('.conn.open')", 12000);
  console.log('connected:', await s.eval("document.querySelector('.company h1')?.innerText"), '| overlay gone:', await s.eval("!document.querySelector('.offline-card')"));
  await s.eval('window.__spoken = []; speechSynthesis.speak = (u) => { __spoken.push(u.text); };');
  await s.eval("__office.teleport(-10, 3, Math.PI); __office.step(20)");
  await s.sleep(1500);
  console.log('meter urgent:', await s.eval("!!document.querySelector('.waiting.urgent')"), '| meter text:', await s.eval("document.querySelector('.waiting')?.innerText.replace(/\\n+/g,' | ')"));
  console.log('card:', await s.eval("document.querySelector('.qcard')?.innerText.replace(/\\n+/g,' | ')"));
  await s.shot('q-mock-urgent');

  await s.eval("document.querySelector('.qcard .opts button').click()");
  await s.sleep(300);
  console.log('server received:', j(mock.received));

  await s.eval("__office.set({ modal: { kind: 'whiteboard', blockId: 'b1' } })");
  await s.sleep(1500);
  console.log('bad diagram modal:', await s.eval("document.querySelector('.wb-body')?.innerText.slice(0, 160).replace(/\\n+/g,' | ')"));
  await s.shot('r-bad-diagram-modal');
  await s.eval("__office.set({ modal: null })");
  await s.sleep(500);
  await s.shot('s-bad-diagram-board');

  await mock.stop();
  await s.sleep(1500);
  console.log('after server died:', await s.eval("document.querySelector('.conn')?.innerText"), '| overlay:', await s.eval("!!document.querySelector('.offline-card')"), '| avatars kept:', (await s.eval('__office.state()')).avatars.length);
  const mock2 = startMock();
  await s.waitFor("!!document.querySelector('.conn.open')", 15000);
  console.log('reconnected after restart:', await s.eval("document.querySelector('.conn')?.innerText"));
  await mock2.stop();
};
