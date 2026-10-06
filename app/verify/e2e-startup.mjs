// Run with `pnpm build && node verify/cdp.mjs verify/e2e-startup.mjs`.
// This reaches the built Electron main process and catches import-time failures before a window opens, and proves the
// office gets as far as drawing: the snapshot arrived from main, and the render loop, which waits for the GPU to link
// the scene's programs, has started.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const env = { OFFICE_DATA_DIR: mkdtempSync(join(tmpdir(), 'office-startup-data-')) };

export default async function startup(s) {
  await s.waitFor('document.querySelector("#root canvas") !== null');
  await s.waitFor('!!__office.store.getState().company', 15000);
  await s.waitFor('performance.getEntriesByName("office-first-frame").length > 0', 15000);
  if (!(await s.eval('__office.store.getState().company.name.length > 0'))) {
    throw new Error('the office has no company name');
  }
  if (s.logs.some((line) => line.startsWith('exception:'))) {
    throw new Error(`renderer exception: ${s.logs.join('\n')}`);
  }
  console.log('ok: built Electron app opened, loaded its company and drew the office');
}
