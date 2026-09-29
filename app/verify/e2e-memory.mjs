// Beta predicate item 6 for Claude. An employee saves a fact in one session. The app quits, the employee's session id
// is dropped so the next session is fresh, the app starts again on the same data dir, and the employee answers with the fact.
// Run: pnpm build && node verify/cdp.mjs verify/e2e-memory.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HAIKU, assert, claude, company, diagnoseClaude, hireClaudeInBlock, logLines, scratch, status, typeToNearest, walkUpToClaude } from './lib.mjs';

const { dataDir, repo } = scratch();
const memoryDir = join(dataDir, 'memory');

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
  OFFICE_CLAUDE_MODEL: HAIKU,
  // The main process prints the memory digest each Claude session starts with.
  OFFICE_DEBUG: '1',
};

const noteFiles = () =>
  ['employees', 'blocks'].flatMap((scope) =>
    readdirSync(join(memoryDir, scope), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(join(memoryDir, scope, d.name)).filter((f) => f.endsWith('.md')).map((f) => join(memoryDir, scope, d.name, f))),
  );

async function tell(app, message) {
  assert(await walkUpToClaude(app), 'walked up to the employee');
  await typeToNearest(app, message);
  await app.waitFor(`${status}.kind === 'working'`, 15000);
  await app.waitFor(`${status}.kind === 'idle'`, 120000);
}

export default async (s, { launch }) => {
  await hireClaudeInBlock(s, repo);
  await tell(s, 'Remember for future sessions: our release branch is release-teal and tags look like vYYYY.MM.DD.');
  const saved = noteFiles();
  console.log('note files:', saved.map((f) => f.replace(dataDir, '<data>')).join(', ') || '(none)');
  assert(saved.length > 0, 'a note file exists under the data dir memory/');
  const note = saved.map((f) => readFileSync(f, 'utf8')).find((t) => /release-teal/.test(t));
  assert(note, 'a note holds release-teal');
  console.log(note.replace(/^/gm, '    | '));
  const title = JSON.parse(/^title: (.*)$/m.exec(note)[1]);
  console.log('session 1 log:\n  ' + (await logLines(s)).join('\n  '));

  await s.close();
  const file = join(dataDir, 'company.json');
  const saved1 = JSON.parse(readFileSync(file, 'utf8'));
  assert(saved1.employees.length === 1 && !!saved1.employees[0].sessionId, 'the employee had a session id to drop');
  for (const e of saved1.employees) delete e.sessionId;
  writeFileSync(file, JSON.stringify(saved1, null, 2));
  assert(JSON.parse(readFileSync(file, 'utf8')).employees.every((e) => e.sessionId === undefined), 'company.json no longer has a sessionId');

  const app = await launch({ env });
  try {
    await app.waitFor('!!window.__office && !!window.office');
    await app.waitFor(`!!${company} && ${company}.employees.length === 1`);
    await app.eval('__office.step(25)');
    await tell(app, 'What is our release branch and tag format?');
    const lines = await logLines(app);
    console.log('session 2 log:\n  ' + lines.join('\n  '));
    const spoken = lines.filter((l) => l.startsWith('Said:') || l.startsWith('Finished:'));
    assert(spoken.some((l) => /release-teal/.test(l)), 'the fresh session answers with release-teal');
    console.log('tag format in the reply:', spoken.some((l) => /vYYYY\.MM\.DD/.test(l)) ? 'yes (recall or digest)' : 'no');

    const out = app.mainLogs.join('\n');
    const digest = /session start for .*, memory digest:\n([\s\S]*?)\n\[/.exec(out)?.[1] ?? '';
    console.log('digest the fresh session started with:\n' + digest.replace(/^/gm, '    | '));
    assert(digest.includes(`- ${title}`), `the fresh session's persona carried the digest title "${title}"`);
    const sessionId = await app.eval(`${claude}.sessionId`);
    assert(sessionId && sessionId !== saved1.employees[0].sessionId, 'the session is a new one, not the old conversation resumed');

    // The transcript Claude recorded for that session (read only): the digest is in its system prompt, and Claude's own
    // auto memory instructions, which v0 employees carried, are not.
    const transcript = join(homedir(), '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
    const recorded = readFileSync(transcript, 'utf8');
    assert(recorded.includes('What you remember (call recall for details)') && recorded.includes(title), 'the recorded system prompt holds the digest');
    assert(!recorded.includes('# auto memory'), "Claude's own auto memory instructions are not in the session");
  } catch (e) {
    await diagnoseClaude(app, 'u1-memory-failure').catch(() => {});
    throw e;
  }
};

export const diagnose = (s) => diagnoseClaude(s, 'u1-memory-failure');
