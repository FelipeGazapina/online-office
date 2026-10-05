// Run with `pnpm build && node verify/cdp.mjs verify/e2e-missing-folder.mjs`.
// A block whose folder was deleted after it was made. The owner is told which folder is gone instead of a Claude error
// that blames its own binary, and a long error never squeezes the chat out of the drawer.
import { rmSync } from 'node:fs';
import { assert, claude, hireClaudeInBlock, scratch, status } from './lib.mjs';

const { dataDir, repo } = scratch();
export const env = { OFFICE_DATA_DIR: dataDir };

const LONG_ERROR =
  'Claude Code native binary at /Applications/Online Office.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude exists but failed to launch. This usually means the binary does not match this system\'s libc — e.g. spawning a musl-linked binary on a glibc Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a matching binary with options.pathToClaudeCodeExecutable.';

export default async function missingFolder(s) {
  await hireClaudeInBlock(s, repo);
  const id = await s.eval(`${claude}.id`);
  rmSync(repo, { recursive: true, force: true });

  await s.eval(`window.office.send({ type: 'interject', employeeId: '${id}', text: 'hello?', style: 'next' })`);
  await s.waitFor(`__office.store.getState().toasts.some((t) => t.text.includes(${JSON.stringify(repo)}))`, 10000);
  await s.sleep(1500);
  assert((await s.eval(`${status}.kind`)) !== 'error', 'talking to an employee whose folder is gone names the folder and starts no harness');

  await s.eval(`(() => {
    const st = __office.store.getState();
    const lines = Array.from({ length: 6 }, (_, i) => ({ from: i % 2 ? 'employee' : 'owner', text: 'line ' + i, at: Date.now() }));
    __office.store.setState({
      selectedId: '${id}',
      chat: { ...st.chat, '${id}': lines },
      company: { ...st.company, employees: st.company.employees.map((e) => (e.id === '${id}' ? { ...e, status: { kind: 'error', message: ${JSON.stringify(LONG_ERROR)} } } : e)) },
    });
  })()`);
  await s.waitFor(`!!document.querySelector('.drawer .thread')`);
  await s.sleep(400);
  const thread = await s.eval(`Math.round(document.querySelector('.drawer .thread').getBoundingClientRect().height)`);
  await s.shot('missing-folder-drawer');
  assert(thread >= 120, `a long error leaves the chat readable (${thread}px tall)`);
  const overflow = await s.eval(`(() => { const d = document.querySelector('.drawer'); return d.scrollWidth - d.clientWidth; })()`);
  assert(overflow <= 0, `and its long path wraps inside the drawer (${overflow}px over)`);
}
