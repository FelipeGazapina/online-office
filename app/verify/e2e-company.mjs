// The company end to end with real Claude agents: the owner gives one task to the PO, who replies first, splits it, hires a
// teammate, delegates, runs a gauntlet, and answers. Then the owner gives a small task straight to an employee.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9343 OFFICE_CLAUDE_MODEL=claude-haiku-4-5-20251001 node verify/cdp.mjs verify/e2e-company.mjs
// OFFICE_PO_MODEL overrides the model of the PO only. OFFICE_COMPANY_WAIT_MIN caps each scenario (default 20).
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { HAIKU, company } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME = '/Users/feliperico/.claude/orchestrate/online-office-game';
const SHOTS = `${GAME}/shots`;
const WAIT_MS = Number(process.env.OFFICE_COMPANY_WAIT_MIN ?? 20) * 60_000;

// Prefixed g1-company so another worktree's cleanup of office-* scratch folders cannot delete a run in progress.
const dataDir = mkdtempSync(join(tmpdir(), 'g1-company-data-'));
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'g1-company-repo-')));
execFileSync('git', ['init', '-q'], { cwd: repo });
cpSync(join(HERE, 'fixtures', 'company-project'), repo, { recursive: true });
const git = (...args) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', ...args], { cwd: repo, stdio: 'pipe' }).toString();
git('add', '-A');
git('commit', '-q', '-m', 'initial');

export const env = {
  OFFICE_DATA_DIR: dataDir,
  OFFICE_START_LEVEL: '3',
  OFFICE_CLAUDE_MODEL: process.env.OFFICE_CLAUDE_MODEL ?? HAIKU,
};

const BAR = 'node --test passes and slugify handles accents, spaces, punctuation and empty input';
const TASK = `Add a slugify(text) function in src/slug.js (ES module, named export) with tests in test/slug.test.js, and a "slugify" section in README.md documenting it. The bar: ${BAR}. Split the work between people, get the function reviewed against the bar, and tell me when it is all done.`;
const TASK_2 = 'Add a wordCount(text) function in src/words.js (ES module, named export) that counts whitespace-separated words and returns 0 for empty input, with a test in test/words.test.js. Run node --test and tell me when it passes.';

const results = [];
const check = (ok, line) => {
  results.push({ ok, line });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${line}`);
};

const ledger = () => {
  const file = join(dataDir, 'company.mail.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
};
const posts = () => ledger().filter((e) => e.t === 'post').map((e) => e.msg);

// Every message in the chain that starts at `rootId`, and whether all its requests have a reply.
const chain = (rootId) => {
  const all = posts().filter((m) => m.rootId === rootId);
  const replied = new Set(all.filter((m) => m.kind === 'reply').map((m) => m.requestId));
  const open = all.filter((m) => m.kind === 'request' && !replied.has(m.id));
  return { all, open };
};

async function waitSettled(s, rootId, label, shotName, viewId) {
  const t0 = Date.now();
  let shot = false;
  while (Date.now() - t0 < WAIT_MS) {
    const { all, open } = chain(rootId);
    if (!shot && all.length > 6) {
      shot = true;
      await chatShot(s, viewId, `${shotName}-during`);
    }
    await unattended(s);
    if (all.length > 1 && open.length === 0) return true;
    if ((Date.now() - t0) % 60_000 < 3100) console.log(`[${Math.round((Date.now() - t0) / 1000)} s] ${label}: ${all.length} messages, ${open.length} open; ${await progress(s)}`);
    await s.sleep(3000);
  }
  console.log(`${label}: timed out after ${Math.round((Date.now() - t0) / 1000)} s, open: ${chain(rootId).open.map((m) => m.title).join(' | ')}`);
  return false;
}

// Nobody is at the keyboard, so every employee runs in yolo mode, and a permission card that was raised before the switch
// is answered yes. Both are counted and printed, because they are the harness acting as the owner.
const interventions = { modeSwitches: 0, permissionAnswers: 0 };
async function unattended(s) {
  const emps = await s.eval(`${company}.employees.map((e) => ({ id: e.id, name: e.name, mode: e.permissions.mode, q: e.status.kind === 'blocked_on_owner' ? e.status.question : null }))`);
  for (const e of emps) {
    if (e.mode !== 'yolo') {
      interventions.modeSwitches++;
      await s.eval(`window.office.send({ type: 'set_permissions', employeeId: ${JSON.stringify(e.id)}, mode: 'yolo' })`);
    }
    if (e.q?.kind === 'permission') {
      interventions.permissionAnswers++;
      console.log(`answering a permission card for ${e.name}: ${e.q.tool} ${e.q.detail}`);
      await s.eval(`window.office.send({ type: 'answer', employeeId: ${JSON.stringify(e.id)}, questionId: ${JSON.stringify(e.q.id)}, text: 'Yes' })`);
    } else if (e.q) console.log(`${e.name} is blocked on the owner: ${e.q.kind} ${e.q.text}`);
  }
}

const progress = (s) =>
  s.eval(`${company}.employees.map((e) => e.name + ' ' + e.status.kind + ' (' + e.activity.slice(0, 60) + ') log ' + (__office.store.getState().logs[e.id] ?? []).length).join('; ')`).catch(() => '?');

// The chat panel opens on whoever is selected. Select again before every capture, then wait for the panel to draw.
async function chatShot(s, id, name) {
  await s.eval(`__office.set({ selectedId: ${JSON.stringify(id)} })`);
  await s.waitFor(`!!document.querySelector('aside.drawer .thread')`, 5000).catch(() => console.log(`no chat panel for ${name}`));
  await s.sleep(300);
  // Other runs on this machine clear /tmp/office-shots, so recreate it and take the picture again if it vanished.
  const take = () => {
    mkdirSync('/tmp/office-shots', { recursive: true });
    return s.shot(name).then((p) => (copyShot(p, name), true), () => false);
  };
  if (!(await take()) && !(await take())) console.log(`could not save ${name}`);
}

function copyShot(from, name) {
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(from, `${SHOTS}/${name}.png`);
}

const nameOf = (emps) => (id) => (id === 'owner' || id === 'mailroom' ? id : emps.find((e) => e.id === id)?.name ?? id.slice(0, 6));

let diagnoseText = '';
export const diagnose = async (s) => {
  console.log('ledger at failure:\n' + posts().map((m) => `${m.kind} ${m.from}->${m.to} ${(m.text ?? '').slice(0, 100)}`).join('\n'));
  await s.shot('company-failure').catch(() => {});
};

export default async (s) => {
  const startedAt = Date.now();
  await s.resize(1440, 900);
  await s.waitFor(`!!${company}`);
  await s.eval(`window.office.send({ type: 'create_block', cwd: ${JSON.stringify(repo)} })`);
  await s.waitFor(`${company}.blocks.length === 1`);
  const blockId = await s.eval(`${company}.blocks[0].id`);
  const poModel = process.env.OFFICE_PO_MODEL;
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Pia', role: 'orchestrator'${poModel ? `, model: ${JSON.stringify(poModel)}` : ''} })`);
  await s.eval(`window.office.send({ type: 'hire', provider: 'claude-code', blockId: ${JSON.stringify(blockId)}, name: 'Eli' })`);
  await s.waitFor(`${company}.employees.length === 2`);
  const emps = () => s.eval(`${company}.employees.map(e => ({ id: e.id, name: e.name, role: e.role ?? 'employee' }))`);
  const [po, eli] = [(await emps()).find((e) => e.role === 'orchestrator'), (await emps()).find((e) => e.name === 'Eli')];
  console.log(`data ${dataDir}`);
  console.log(`PO ${po.name} ${po.id}, employee ${eli.name} ${eli.id}, repo ${repo}`);

  await s.eval(`(() => {
    const id = ${JSON.stringify(po.id)};
    window.__timeTask = (text, clientId) => new Promise((resolve) => {
      const st0 = __office.store.getState();
      const seen = new Set(st0.mail.tail.map((m) => m.id));
      const out = { stream: null, bubble: null };
      const unsub = __office.store.subscribe((st) => {
        const now = performance.now() - t0;
        if (out.stream === null && st.streams[id]) out.stream = now;
        if (out.bubble === null && st.mail.tail.some((m) => !seen.has(m.id) && m.from === id && m.kind === 'say')) out.bubble = now;
        if (out.stream !== null && out.bubble !== null) { unsub(); resolve(out); }
      });
      const t0 = performance.now();
      window.office.send({ type: 'post', to: id, clientId, as: 'request', text });
      setTimeout(() => { unsub(); resolve(out); }, 90000);
    });
  })()`);

  const timing = await s.eval(`window.__timeTask(${JSON.stringify(TASK)}, 'g1-task-1')`);
  const rootId = posts().find((m) => m.from === 'owner' && m.to === po.id && m.kind === 'request')?.id;
  console.log(`ms from post to first stream token: ${timing.stream === null ? 'never' : Math.round(timing.stream)}; to first PO bubble: ${timing.bubble === null ? 'never' : Math.round(timing.bubble)}`);
  check(timing.bubble !== null, 'the PO answered with a bubble first (reply-first ack)');
  check(timing.stream !== null, 'tokens streamed to the owner');
  await chatShot(s, po.id, 'g1-chat-early');

  const settled = await waitSettled(s, rootId, 'scenario 1', 'g1-chat', po.id);
  const names = nameOf(await emps().then(async () => s.eval(`${company}.employees.map(e => ({ id: e.id, name: e.name }))`)));
  const msgs = chain(rootId).all;
  const wallS = Math.round((Date.now() - startedAt) / 1000);

  const poReqs = msgs.filter((m) => m.kind === 'request' && m.from === po.id);
  const targets = new Set(poReqs.map((m) => m.to));
  const employeesNow = await s.eval(`${company}.employees.length`);
  const hiredEvents = msgs.filter((m) => m.kind === 'event' && m.event === 'hired');
  check(poReqs.length >= 2 && targets.size >= 2, `the PO posted ${poReqs.length} requests to ${targets.size} different people (${[...targets].map(names).join(', ')})`);
  check(hiredEvents.length === 1 && employeesNow === 3, `the PO called hireTeammate once and the new hire is in the block (${hiredEvents.length} hire events, ${employeesNow} employees)`);

  const gauntlets = msgs.filter((m) => m.kind === 'request' && m.intent === 'gauntlet');
  const reviews = msgs.filter((m) => m.kind === 'request' && m.intent === 'review');
  const builders = new Set(msgs.filter((m) => m.kind === 'request' && m.intent === 'work' && m.from === 'mailroom').map((m) => m.to));
  const reviewOk = reviews.length > 0 && reviews.every((r) => !builders.has(r.to) && (r.bar?.length ?? 0) > 0 && !msgs.some((b) => b.kind === 'reply' && b.text.length > 40 && r.text.includes(b.text)) && /^Judge the artifact against the bar\. You see no description/.test(r.text));
  const verdicts = msgs.filter((m) => m.kind === 'reply' && m.verdict && reviews.some((r) => r.id === m.requestId));
  console.log(`gauntlets ${gauntlets.length}, rounds (review requests) ${reviews.length}, verdicts: ${verdicts.map((v) => `${names(v.from)}:${v.verdict.pass ? 'pass' : 'fail'}`).join(', ') || 'none'}`);
  const gauntletOutcomes = gauntlets.map((g) => msgs.find((m) => m.kind === 'reply' && m.requestId === g.id)?.outcome);
  console.log(`gauntlet outcomes: ${gauntletOutcomes.join(', ')}`);
  check(gauntlets.length >= 1 && reviewOk && gauntletOutcomes.every((o) => o === 'done'), 'a requestGauntlet passed with a critic different from the builder, the review prompt carries the bar and no builder prose');

  const finalReply = msgs.filter((m) => m.kind === 'reply' && m.to === 'owner' && m.requestId === rootId).at(-1);
  const lastOther = Math.max(...msgs.filter((m) => m.kind === 'reply' && m !== finalReply).map((m) => m.at));
  check(finalReply && finalReply.at >= lastOther, 'the PO answered the owner after every other request settled');
  check(settled && !!finalReply, `all requests settled and the PO replied to the owner (${wallS} s wall${finalReply ? `, outcome ${finalReply.outcome}` : ''})`);

  const asked = new Map(posts().filter((m) => m.kind === 'request').map((m) => [m.id, m]));
  const dones = posts().filter((m) => m.kind === 'reply' && m.outcome === 'done' && asked.get(m.requestId)?.intent === 'work');
  const noProof = dones.filter((m) => !m.artifact?.length || m.artifact.some((a) => !/^[0-9a-f]{7,40}$/.test(a) && !existsSync(join(repo, a))));
  console.log(`done replies on work requests: ${dones.length}; without existing artifacts: ${noProof.map((m) => `${names(m.from)}:${(m.artifact ?? []).join(',') || 'none'}`).join(' | ') || 'none'}`);
  check(dones.length > 0 && noProof.length === 0, 'every done reply on a work request carries artifacts that exist in the repo');
  const talky = dones.filter((m) => /waiting|will check back|once .* (is|are) done/i.test(m.text));
  check(talky.length === 0, `no done reply says it is waiting (${talky.map((m) => m.text.slice(0, 60)).join(' | ') || 'none'})`);
  const listed = finalReply?.artifact ?? [];
  check(finalReply?.outcome === 'done' && listed.length > 0 && listed.every((a) => existsSync(join(repo, a))), `the PO final reply to the owner lists the artifacts (${listed.join(', ') || 'none'})`);

  let testsOk = false;
  try {
    execFileSync('node', ['--test'], { cwd: repo, stdio: 'pipe' });
    testsOk = true;
  } catch (e) {
    console.log('node --test output:\n' + (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''));
  }
  const slugOk = existsSync(join(repo, 'src/slug.js')) && existsSync(join(repo, 'test/slug.test.js'));
  check(testsOk && slugOk, 'node --test passes in the repo with src/slug.js and test/slug.test.js');
  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  const readmeChanged = git('status', '--porcelain', 'README.md').trim() !== '' || git('log', '--oneline', '--', 'README.md').trim().split('\n').length > 1;
  check(readmeChanged && /slugify\(|^#{1,6}\s.*slugify/im.test(readme), 'README.md was edited and documents slugify');
  console.log(`README headings: ${readme.split('\n').filter((l) => l.startsWith('#')).join(' | ')}`);
  await chatShot(s, po.id, 'g1-chat-after');
  const thread1 = await s.eval(`[...document.querySelectorAll('.thread .msg')].map((m) => m.innerText.replace(/\\n+/g, ' ')).join('\\n')`);

  console.log(`harness interventions: ${JSON.stringify(interventions)}`);
  const t2 = Date.now();
  await s.eval(`__office.set({ selectedId: ${JSON.stringify(eli.id)} })`);
  await s.eval(`window.office.send({ type: 'post', to: ${JSON.stringify(eli.id)}, clientId: 'g1-task-2', as: 'request', text: ${JSON.stringify(TASK_2)} })`);
  await s.waitFor(`__office.store.getState().mail.tail.some((m) => m.from === 'owner' && m.to === ${JSON.stringify(eli.id)})`, 10000);
  const root2 = posts().find((m) => m.from === 'owner' && m.to === eli.id && m.kind === 'request')?.id;
  const settled2 = await waitSettled(s, root2, 'scenario 2', 'g1-direct', eli.id);
  const chain2 = chain(root2).all;
  const poInvolved = chain2.some((m) => m.from === po.id || m.to === po.id);
  const reply2 = chain2.find((m) => m.kind === 'reply' && m.requestId === root2);
  check(settled2 && reply2?.outcome === 'done' && !poInvolved, `the direct task settled ${reply2?.outcome ?? 'never'} in ${Math.round((Date.now() - t2) / 1000)} s with no PO in the chain (${chain2.length} messages)`);
  let words = false;
  try {
    execFileSync('node', ['--test'], { cwd: repo, stdio: 'pipe' });
    words = existsSync(join(repo, 'src/words.js')) && existsSync(join(repo, 'test/words.test.js'));
  } catch {}
  check(words, 'node --test passes with src/words.js and test/words.test.js');
  await chatShot(s, eli.id, 'g1-direct-after');
  const thread2 = await s.eval(`[...document.querySelectorAll('.thread .msg')].map((m) => m.innerText.replace(/\\n+/g, ' ')).join('\\n')`);

  const render = (list) =>
    list
      .map((m) => {
        const body = m.kind === 'event' ? m.text : m.kind === 'reply' ? `[reply ${m.outcome}${m.verdict ? ` verdict ${m.verdict.pass ? 'pass' : 'fail'}: ${m.verdict.findings.join('; ')}` : ''}] ${m.text}` : `[${m.kind}${m.intent ? ' ' + m.intent : ''}] ${m.title ? m.title + ' - ' : ''}${m.text}`;
        return `- ${new Date(m.at).toISOString().slice(11, 19)} ${names(m.from)} -> ${names(m.to)}: ${body}`;
      })
      .join('\n');
  writeFileSync(
    `${GAME}/w3-transcript.md`,
    `# W3 company transcript\n\nPO first bubble ${timing.bubble === null ? 'never' : Math.round(timing.bubble) + ' ms'}, first token ${timing.stream === null ? 'never' : Math.round(timing.stream) + ' ms'}.\n\n## Scenario 1, task to the PO\n\n${render(msgs)}\n\n### Thread as rendered\n\n${thread1}\n\n## Scenario 2, task straight to ${eli.name}\n\n${render(chain2)}\n\n### Thread as rendered\n\n${thread2}\n`,
  );
  console.log(`transcript: ${GAME}/w3-transcript.md`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} lines pass`);
  if (failed.length) throw new Error(`${failed.length} acceptance lines failed: ${failed.map((f) => f.line).join(' || ')}`);
};
