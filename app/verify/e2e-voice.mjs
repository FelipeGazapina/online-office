// Beta predicate item 7 in the real app. Clips made with macOS `say` are played into the microphone through Chromium's fake
// capture device, and a real Claude employee receives the right words, in English and in Portuguese, by hold-V push-to-talk
// and by proximity with no key. It also proves that audio arriving while an employee speaks is dropped, that pressing V
// stops an employee who is talking, that Accurate, Auto and a dead microphone behave, that an app killed with SIGKILL takes its whisper-server with it, and what the chip says in every state.
// It also proves the server's lifecycle: no whisper-server exists until the owner talks, V or the detector starts it while they
// speak, and it is gone again after the idle period (OFFICE_VOICE_IDLE_MS, 20 s here).
// Run: pnpm build && OFFICE_CDP_PORT=9336 node verify/screen-watch.mjs node verify/cdp.mjs verify/e2e-voice.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HAIKU, assert, claude, company, diagnoseClaude, hireClaudeInBlock, scratch, status, stepUntil, text, walkUpToClaude } from './lib.mjs';
import { concat, roomTone, say, writeWav } from './wav.ts';

const { dataDir, repo } = scratch();
const clips = join(dataDir, 'clips');
mkdirSync(clips);

const PHRASES = {
  en: { voice: 'Samantha', spoken: 'Please reply with the single word banana.', words: ['reply', 'single word', 'banana'], answer: /banana/i },
  pt: { voice: 'Luciana', spoken: 'Por favor, responda apenas com a palavra abacaxi.', words: ['responda', 'apenas', 'abacaxi'], answer: /abacaxi/i },
};
// Three seconds of room before the phrase give a person time to reach for V. The phrase plays once each time the microphone opens.
const LEAD_S = 3;
const clipOf = {};
for (const [lang, p] of Object.entries(PHRASES)) {
  const phrase = say(p.voice, p.spoken);
  p.seconds = phrase.length / 16_000;
  clipOf[lang] = join(clips, `${lang}.wav`);
  writeWav(clipOf[lang], concat(roomTone(LEAD_S), phrase, roomTone(4)));
}
const deadClip = join(clips, 'dead.wav');
writeWav(deadClip, new Int16Array(16_000 * 20));

const IDLE_MS = 20000;
const base = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3', OFFICE_CLAUDE_MODEL: HAIKU, OFFICE_DEBUG: '1', OFFICE_VOICE_IDLE_MS: String(IDLE_MS) };
export const env = { ...base, OFFICE_TEST_AUDIO: clipOf.en };

const voiceOf = (s) => s.eval('JSON.parse(JSON.stringify(__office.store.getState().voice))');
const measures = (s, name) => s.eval(`performance.getEntriesByName(${JSON.stringify(name)}).map(e => Math.round(e.duration))`);
const engineOf = (s) => s.eval('__office.store.getState().voice.engine.kind');
const pidFile = join(dataDir, 'whisper-server.pid');
// The processes of this run's whisper-server (the supervising shell, its watcher and the server), found through the pid file
// the app keeps while the server runs. Empty once the app has stopped it.
const serverProcesses = () => {
  if (!existsSync(pidFile)) return [];
  const supervisor = String(JSON.parse(readFileSync(pidFile, 'utf8')).pid);
  return execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim().split(/\s+/)[1] === supervisor)
    .map((l) => Number(l.trim().split(/\s+/)[0]));
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// The page keeps every engine change with its time, so the idle stop is measured when it happened and not when this script looked.
const traceEngine = (s) =>
  s.eval(`(() => { window.__engine = []; let last = ''; __office.store.subscribe((st) => { const k = st.voice.engine.kind; if (k !== last) { last = k; window.__engine.push([Date.now(), k]); } }); })()`);
let lastUse = 0;
// Waits until the engine has stopped on its own after the last use, and says how long the quiet lasted and that nothing of the server is left.
async function engineFallsAsleep(s, how, ms = 90000) {
  const t0 = Date.now();
  let at = null;
  while (at === null && Date.now() - t0 < ms) {
    const rows = await s.eval('window.__engine');
    at = rows.find(([t, kind]) => kind === 'asleep' && t > lastUse)?.[0] ?? null;
    if (at === null) await s.sleep(250);
  }
  assert(at !== null, `${how}: the engine fell asleep after the last use`);
  const quiet = at - lastUse;
  const kinds = (await s.eval('window.__engine')).filter(([t]) => t > lastUse).map(([, k]) => k);
  assert(quiet >= IDLE_MS - 1500, `${how}: it stayed up for the idle period after the last use and no less (${quiet} ms, the period is ${IDLE_MS} ms)`);
  assert(quiet <= IDLE_MS + 45000 && !kinds.includes('error'), `${how}: and then stopped (engine states since: ${kinds.join(' > ')})`);
  const t1 = Date.now();
  while (serverProcesses().length && Date.now() - t1 < 5000) await s.sleep(50);
  assert(serverProcesses().length === 0 && !existsSync(pidFile), `${how}: no whisper-server process and no pid file are left`);
  console.log(`lifecycle: ${how}: the whisper-server was gone ${quiet} ms after the last use`);
}
// The settings panel lives on the office desktop now (My Mac), so a voice scenario sets them the way its buttons do: in the store.
const SETTING = { 'Hold V': ['mic', 'push'], Proximity: ['mic', 'proximity'], English: ['lang', 'en-US'], Português: ['lang', 'pt-BR'], Auto: ['lang', 'auto'], Fast: ['voiceQuality', 'fast'], Accurate: ['voiceQuality', 'accurate'] };
const click = async (s, label) => {
  const [key, value] = SETTING[label];
  await s.eval(`__office.set({ ${key}: ${JSON.stringify(value)} })`);
  return (await s.eval(`__office.store.getState().${key}`)) === value;
};

// What the office was told, as the main process saw it arrive. It logs each message cut at 200 characters, so a long
// instruction that the script sends itself arrives here without its text, and only the owner's short sentences are read.
const routed = (s) =>
  s.mainLogs
    .join('\n')
    .split('\n')
    .filter((l) => /^\[ipc\] \{"type":"(post|answer)"/.test(l))
    .map((l) => {
      try {
        return JSON.parse(l.slice('[ipc] '.length));
      } catch {
        return { type: /"type":"(\w+)"/.exec(l)[1], truncated: true };
      }
    });
const wordsOf = (m) => m.text;

const ANNOUNCEMENT = 'This is a long announcement from your colleague, so the microphone has to stay closed while I keep on talking for several seconds without any pause at all.';
const employeeSays = async (s, words) => s.eval(`__office.apply({ type: 'said', employeeId: ${claude}.id, text: ${JSON.stringify(words)} })`);

const latencies = [];
// Whether the owner found the engine running when they began to speak, which decides if the words waited for a load.
const coldNow = async (s) => (await engineOf(s)) !== 'ready';

// The owner steps away, so the microphone closes, and steps back, so it opens on a fresh stream and the clip plays again.
async function freshMic(s) {
  const a = await s.eval('__office.state().avatars[0]');
  await s.eval(`__office.teleport(${a.x + 9}, ${a.z + 9}, 0); __office.step(0.5)`);
  await s.waitFor(`__office.store.getState().voice.capture.kind === 'closed'`, 5000);
  assert(await walkUpToClaude(s), 'walked up to the employee');
  await s.waitFor(`__office.store.getState().voice.capture.kind === 'open'`, 15000);
  return Date.now();
}

// Nothing is being spoken and the gate has had time to reopen, so no speech is left to hide the next clip.
async function stopTalking(s) {
  for (let calm = 0; calm < 4; ) {
    calm = (await s.eval('speechSynthesis.speaking')) ? 0 : calm + 1;
    await s.sleep(400);
  }
}

const quiet = async (s) => {
  await s.waitFor(`${status}.kind === 'idle'`, 90000);
  await stopTalking(s);
};

async function arrived(s, before, lang, how) {
  const t0 = Date.now();
  while (routed(s).length <= before && Date.now() - t0 < 30000) await s.sleep(200);
  const all = routed(s);
  assert(all.length === before + 1, `${how}: exactly one message reached the office (${all.length - before})`);
  const heard = wordsOf(all.at(-1));
  assert(hears(heard, PHRASES[lang].words), `${how}: the office received the right words: "${heard}"`);
  assert(all.at(-1).type === 'post' && all.at(-1).as === 'request', `${how}: an idle employee got it as a task`);
  return heard;
}

function sessionSaw(sessionId, words) {
  const file = join(homedir(), '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'user')
    .some((e) => hears(typeof e.message?.content === 'string' ? e.message.content : JSON.stringify(e.message?.content ?? ''), words));
}

async function employeeUnderstood(s, lang, how) {
  await s.waitFor(`${status}.kind === 'working'`, 30000);
  await s.waitFor(`${status}.kind === 'idle'`, 120000);
  const lines = await s.eval(`(__office.store.getState().logs[${claude}.id] ?? []).map(l => l.line)`);
  const said = lines.filter((l) => l.startsWith('Said:'));
  assert(said.some((l) => PHRASES[lang].answer.test(l)), `${how}: the employee did what it was told and said the word (${said.at(-1)})`);
  const sessionId = await s.eval(`${claude}.sessionId`);
  assert(sessionId && sessionSaw(sessionId, PHRASES[lang].words), `${how}: the words are in the employee's own session log (${sessionId})`);
}

async function pushToTalk(s, lang, { bargeIn = false, shots = '' } = {}) {
  const how = `hold V, ${lang}${bargeIn ? ', over an employee talking' : ''}`;
  await quiet(s);
  const before = routed(s).length;
  const heardBefore = (await measures(s, 'voice:ptt')).length;
  const opened = await freshMic(s);
  if (bargeIn) {
    await employeeSays(s, ANNOUNCEMENT);
    await s.waitFor('speechSynthesis.speaking', 3000);
    assert(await s.eval('speechSynthesis.speaking'), `${how}: an employee is talking`);
  }
  await s.sleep(Math.max(0, 1500 - (Date.now() - opened)));
  const cold = await coldNow(s);
  if (cold) assert((await s.eval(text('.talk-badge'))).includes('Hold V to talk'), `${how}: with the engine asleep the chip reads as a working microphone, not as a model loading (${await s.eval(text('.talk-badge'))})`);
  // Selecting an employee puts the cursor in the chat box, and V typed there is a letter. The owner clicks out of it first.
  await s.eval('document.activeElement?.blur()');
  await s.key('keyDown', 'KeyV', 'v');
  assert((await voiceOf(s)).phase === 'listening', `${how}: pressing V shows Listening`);
  await s.waitFor(`document.querySelector('.talk-badge')?.innerText.includes('Listening')`, 2000).catch(() => {});
  assert((await s.eval(text('.talk-badge'))).includes('Listening'), `${how}: and the chip says Listening, even while the engine loads (${await s.eval(text('.talk-badge'))})`);
  await s.waitFor(`__office.store.getState().voice.engine.kind === 'ready'`, 30000);
  assert(serverProcesses().length > 0, `${how}: holding V woke the engine (${cold ? 'it was asleep' : 'it was already up'}), so a whisper-server runs`);
  const model = (await voiceOf(s)).engine.model;
  if (bargeIn) {
    await s.sleep(300);
    assert(!(await s.eval('speechSynthesis.speaking')), `${how}: pressing V stopped the employee mid-sentence`);
  }
  if (shots) {
    await s.sleep((LEAD_S + PHRASES[lang].seconds / 2) * 1000 - (Date.now() - opened));
    assert((await s.eval(`Number(document.querySelector('.talk-badge .meter')?.style.getPropertyValue('--level') || 0)`)) > 0.05, `${how}: the meter moves while the clip plays`);
    await s.shot(`${shots}-listening`);
  }
  await s.sleep(Math.max(0, (LEAD_S + PHRASES[lang].seconds + 1) * 1000 - (Date.now() - opened)));
  await s.key('keyUp', 'KeyV', 'v');
  if (shots) await s.shot(`${shots}-transcribing`);
  const heard = await arrived(s, before, lang, how);
  lastUse = Date.now();
  const [ms] = (await measures(s, 'voice:ptt')).slice(heardBefore);
  console.log(`latency: ${how}: V released to text in ${ms} ms, engine ${cold ? 'cold' : 'warm'} at the press ("${heard}")`);
  latencies.push({ how: `${how} (${cold ? 'cold' : 'warm'})`, ms, note: 'V released to text' });
  await employeeUnderstood(s, lang, how);
  return model;
}

// The card's Mic button listens for one answer, whatever the microphone mode. The clip only plays when the microphone
// opens, so the owner steps away from the asker and the asker walks over, which opens it again.
async function answerByVoice(s) {
  const how = 'the question card, en';
  await quiet(s);
  assert(await click(s, 'Hold V'), `${how}: chose the Hold V microphone mode, where the detector is otherwise off`);
  await s.eval(`window.office.send({ type: 'post', to: ${claude}.id, clientId: 'fruit', as: 'request', text: 'Call the ask_owner tool to ask me which fruit I want, with exactly two options: Banana and Apple. Then say the fruit I chose.' })`);
  await s.waitFor(`${status}.kind === 'blocked_on_owner'`, 120000);
  await stepUntil(s, `__office.state().askerId === ${claude}.id && !!document.querySelector('.qcard')`, 60000, 'the question card');
  await stopTalking(s);
  const before = routed(s).length;

  const owner = await s.eval('__office.state().owner');
  await s.eval(`__office.teleport(${owner.x + 4}, ${owner.z}, ${owner.yaw}); __office.step(0.2)`);
  await s.waitFor(`__office.store.getState().voice.capture.kind === 'closed'`, 5000);
  await s.eval('__office.step(5)');
  await s.waitFor(`__office.store.getState().voice.capture.kind === 'open'`, 15000);
  assert(await s.clickText('.qcard .btn.mic', 'Mic'), `${how}: clicked the card's Mic button`);
  await s.sleep(200);
  assert((await voiceOf(s)).cardMic && (await s.eval(text('.qcard .btn.mic'))) === 'Listening', `${how}: the button says Listening`);

  const t0 = Date.now();
  while (routed(s).length <= before && Date.now() - t0 < 30000) await s.sleep(200);
  const sent = routed(s).slice(before);
  assert(sent.length === 1 && sent[0].type === 'answer', `${how}: the spoken answer reached the office as an answer to the question (${sent.map((m) => m.type)})`);
  lastUse = Date.now();
  assert(hears(wordsOf(sent[0]), PHRASES.en.words), `${how}: with the right words: "${wordsOf(sent[0])}"`);
  assert(!(await voiceOf(s)).cardMic, `${how}: the card mic switched itself off after one answer`);
  assert((await engineOf(s)) === 'ready', `${how}: the detector hearing the answer woke the engine`);
  await quiet(s);
}

async function proximity(s, lang) {
  const how = `proximity, ${lang}`;
  await quiet(s);
  const before = routed(s).length;
  const heardBefore = (await measures(s, 'voice:proximity')).length;
  const cold = await coldNow(s);
  await freshMic(s);
  const heard = await arrived(s, before, lang, how);
  lastUse = Date.now();
  const [ms] = (await measures(s, 'voice:proximity')).slice(heardBefore);
  assert((await engineOf(s)) === 'ready', `${how}: hearing the owner speak woke the engine (${cold ? 'it was asleep' : 'it was already up'})`);
  console.log(`latency: ${how}: end of speech detected to text in ${ms} ms, after the 600 ms the detector waits to be sure, engine ${cold ? 'cold' : 'warm'} when the owner started ("${heard}")`);
  latencies.push({ how: `${how} (${cold ? 'cold' : 'warm'})`, ms, note: 'detected end of speech to text, after a 600 ms hangover' });
  await employeeUnderstood(s, lang, how);
}

export default async (s, { launch }) => {
  await hireClaudeInBlock(s, repo);
  await s.waitFor(`__office.store.getState().voice.engine.kind === 'asleep'`, 30000);
  await s.sleep(3000);
  assert(serverProcesses().length === 0 && !existsSync(pidFile), 'voice unused: the app has run for a while with the model on disk and no whisper-server process');
  await traceEngine(s);
  assert(await click(s, 'Hold V'), 'chose the Hold V microphone mode');
  assert(await click(s, 'English'), 'chose English');
  assert((await pushToTalk(s, 'en', { shots: 'u5-chip' })) === 'ggml-small-q5_1.bin', 'the talk was heard by the engine on the fast model');
  await engineFallsAsleep(s, 'after hold V');
  await pushToTalk(s, 'en', { bargeIn: true });

  assert(await click(s, 'Proximity'), 'chose the Proximity microphone mode');
  await proximity(s, 'en');

  await quiet(s);
  const before = routed(s).length;
  const measuresBefore = (await measures(s, 'voice:proximity')).length;
  const opened = await freshMic(s);
  await employeeSays(s, ANNOUNCEMENT);
  await s.sleep(Math.max(0, (LEAD_S + PHRASES.en.seconds / 2) * 1000 - (Date.now() - opened)));
  assert(await s.eval('speechSynthesis.speaking'), 'while the clip plays the employee is still talking');
  await s.sleep(Math.max(0, (LEAD_S + PHRASES.en.seconds + 2) * 1000 - (Date.now() - opened)));
  await quiet(s);
  await s.sleep(1500);
  assert(routed(s).length === before, 'the clip that played over the employee never reached the office');
  assert((await measures(s, 'voice:proximity')).length === measuresBefore, 'and was never sent to whisper');
  console.log('gate: the same clip was delivered a moment ago with the employee silent, and was dropped with the employee talking');

  await answerByVoice(s);

  // Choosing a model puts it on disk. A running engine moves onto it, and a sleeping one stays asleep until someone talks.
  assert(await click(s, 'Accurate'), 'chose Voice: Accurate');
  await s.waitFor(`(__office.store.getState().voice.engine.kind === 'asleep') || (__office.store.getState().voice.engine.kind === 'ready' && __office.store.getState().voice.engine.model.includes('turbo'))`, 90000);
  assert(await click(s, 'Hold V'), 'chose the Hold V microphone mode again');
  assert((await pushToTalk(s, 'en')) === 'ggml-large-v3-turbo-q5_0.bin', 'the talk was heard by the engine on large-v3-turbo-q5_0');
  assert(await click(s, 'Fast'), 'chose Voice: Fast again');
  await s.waitFor(`(__office.store.getState().voice.engine.kind === 'asleep') || (__office.store.getState().voice.engine.kind === 'ready' && __office.store.getState().voice.engine.model.includes('small'))`, 60000);
  await engineFallsAsleep(s, 'after Accurate and back');

  await chipStates(s);
  await s.close();

  const pt = await launch({ env: { ...base, OFFICE_TEST_AUDIO: clipOf.pt } });
  try {
    await pt.waitFor('!!window.__office && !!window.office');
    await pt.waitFor(`!!${company} && ${company}.employees.length === 1`);
    await pt.eval('__office.step(25)');
    await pt.waitFor(`__office.store.getState().voice.engine.kind === 'asleep'`, 30000);
    assert(await click(pt, 'Português'), 'chose Português');
    assert(await click(pt, 'Hold V'), 'chose the Hold V microphone mode');
    await pushToTalk(pt, 'pt');
    assert(await click(pt, 'Proximity'), 'chose the Proximity microphone mode');
    await proximity(pt, 'pt');
    assert(await click(pt, 'Auto'), 'chose Auto, so whisper decides the language');
    assert(await click(pt, 'Hold V'), 'chose the Hold V microphone mode');
    await pushToTalk(pt, 'pt');
    assert(await pt.eval(`__office.store.getState().lang === 'auto'`), 'the settings still hold');
  } catch (e) {
    await diagnoseClaude(pt, 'u5-pt-failure').catch(() => {});
    throw e;
  }
  await pt.close();

  const dead = await launch({ env: { ...base, OFFICE_TEST_AUDIO: deadClip } });
  await dead.waitFor('!!window.__office && !!window.office');
  await dead.waitFor(`!!${company} && ${company}.employees.length === 1`);
  await dead.eval('__office.step(25)');
  await dead.waitFor(`__office.store.getState().voice.engine.kind === 'asleep'`, 30000);
  const beforeDead = routed(dead).length;
  assert(await walkUpToClaude(dead), 'walked up to the employee with a microphone that only ever reads zeros');
  await dead.waitFor(`__office.store.getState().voice.access.kind === 'silent'`, 8000);
  const chip = await dead.eval(text('.talk-badge'));
  assert(chip.includes('The mic is silent') && chip.includes('pnpm beta'), `after one second of exact zeros the chip says so (${chip})`);
  await dead.shot('u5-chip-silent-real');
  await dead.eval('document.activeElement?.blur()');
  await dead.key('keyDown', 'KeyV', 'v');
  await dead.sleep(1500);
  await dead.key('keyUp', 'KeyV', 'v');
  await dead.sleep(2500);
  assert(routed(dead).length === beforeDead, 'holding V over silence sends nothing to the employee');

  // Holding V over silence woke the engine, so a server runs.
  await dead.waitFor(`__office.store.getState().voice.engine.kind === 'ready'`, 30000);
  const supervisor = JSON.parse(readFileSync(join(dataDir, 'whisper-server.pid'), 'utf8')).pid;
  const ofThisRun = () =>
    execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.trim().split(/\s+/)[1] === String(supervisor));
  assert(ofThisRun().length > 1, `the app's whisper-server runs under a supervisor of its own (${ofThisRun().length} processes in its group)`);
  const appPid = Number(execFileSync('lsof', ['-nP', `-iTCP:${process.env.OFFICE_CDP_PORT ?? 9333}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]);
  const killedAt = Date.now();
  process.kill(appPid, 'SIGKILL');
  while (ofThisRun().length && Date.now() - killedAt < 2000) await dead.sleep(50);
  assert(ofThisRun().length === 0, `the app was killed with SIGKILL and nothing of its whisper-server was left after ${Date.now() - killedAt} ms`);
  await dead.close();

  console.log('\nlatency summary');
  for (const { how, ms, note } of latencies) console.log(`  ${how.padEnd(42)} ${String(ms).padStart(5)} ms  ${note}`);
};

// Everything the chip can say. Some states come from main and the OS, so they are put in the store the way main would.
async function chipStates(s) {
  assert(await walkUpToClaude(s), 'walked up to the employee');
  assert(await click(s, 'Hold V'), 'chose the Hold V microphone mode');
  await s.sleep(250);
  assert((await s.eval(text('.talk-badge'))).includes('Hold V to talk'), 'in Hold V mode an idle chip says to hold V');
  assert(await click(s, 'Proximity'), 'chose the Proximity microphone mode');
  const idle = { engine: { kind: 'ready', model: 'ggml-small-q5_1.bin' }, access: { kind: 'granted' } };
  const set = (patch) => s.eval(`__office.set({ voice: { ...__office.store.getState().voice, ...${JSON.stringify(patch)} } })`);
  const cases = [
    ['idle', {}, ['Just talk, or hold V'], null],
    ['downloading', { engine: { kind: 'downloading', file: 'ggml-small-q5_1.bin', received: 71_000_000, total: 190_085_487 } }, ['Downloading the voice model 37%'], null],
    ['starting', { engine: { kind: 'starting' } }, ['Loading the voice model'], null],
    ['asleep', { engine: { kind: 'asleep' } }, ['Just talk, or hold V'], null],
    ['missing-binary', { engine: { kind: 'missing_binary' } }, ['brew install whisper-cpp'], 'Check again'],
    ['engine-error', { engine: { kind: 'error', message: 'whisper-server exited with code 3' } }, ['Voice failed', 'exited with code 3'], 'Try again'],
    ['mic-needs-prompt', { access: { kind: 'needs_prompt' } }, ['Allow the microphone in the macOS dialog'], null],
    ['mic-denied', { access: { kind: 'denied' } }, ['Microphone access is off'], 'Open System Settings'],
    ['mic-silent', { access: { kind: 'silent' } }, ['The mic is silent', 'pnpm beta'], null],
    ['capture-failed', { capture: { kind: 'failed', message: 'Requested device not found' } }, ['Could not open the microphone', 'Requested device not found'], null],
  ];
  for (const [name, patch, parts, button] of cases) {
    await set({ ...idle, capture: { kind: 'open' }, ...patch });
    await s.sleep(250);
    const chip = await s.eval(text('.talk-badge'));
    assert(parts.every((p) => chip.includes(p)), `the chip for ${name} says: ${chip}`);
    const buttons = await s.eval(`[...document.querySelectorAll('.talk-badge .chip-btn')].map(b => b.innerText)`);
    assert(button ? buttons.join() === button : buttons.length === 0, `${name}: ${button ? `offers ${button}` : 'offers no button'}`);
    await s.shot(`u5-chip-${name}`);
  }
  await set({ ...idle, capture: { kind: 'open' }, access: { kind: 'denied' } });
  await s.sleep(200);
  const before = s.mainLogs.join('\n').split('[voice] would open the microphone settings').length;
  assert(await s.clickText('.talk-badge .chip-btn', 'Open System Settings'), 'clicked Open System Settings');
  await s.sleep(500);
  assert(s.mainLogs.join('\n').split('[voice] would open the microphone settings').length === before + 1, 'the click reached main, which in a test run only logs it and opens nothing');
  await set({ ...idle, capture: { kind: 'open' } });
}

export async function diagnose(s) {
  console.log('voice at failure:', JSON.stringify(await s.eval('__office.store.getState().voice').catch((e) => e.message)));
  console.log('chip at failure:', await s.eval(text('.talk-badge')).catch(() => '(none)'));
  console.log('routed to the office:', JSON.stringify(routed(s)));
  await diagnoseClaude(s, 'u5-failure').catch(() => {});
}
