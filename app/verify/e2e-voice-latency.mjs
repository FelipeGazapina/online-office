// What the owner waits for after hold-V push-to-talk, on this build and on a build without on-demand voice, with the whisper-server
// asleep (cold) and already up (warm), on a short command and on a sentence. The owner holds V while they speak and lets go when they
// stop, so each trial presses V when the level meter shows the phrase begin and releases it a moment after the meter falls quiet. The
// renderer's own `voice:ptt` measure then says how long it took from the release to the words, which is the wait the owner feels.
// Both builds run inside this one scenario, one after the other and phrase by phrase, so they share the machine and one hold of the run lock.
// Run: pnpm build:verify, build the other tree the same way, then
//   E2E_VOICE_BASE_OUT=/abs/path/to/other/app/out/verify OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-voice-latency.mjs
//   E2E_VOICE_TRIALS=4 repeats per phrase and state, E2E_VOICE_QUALITY=fast|accurate, without E2E_VOICE_BASE_OUT only this build runs.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HAIKU, assert, claude, hireClaudeInBlock, scratch, walkUpToClaude } from './lib.mjs';
import { concat, roomTone, say, writeWav } from './wav.ts';

const TRIALS = Number(process.env.E2E_VOICE_TRIALS ?? 4);
const QUALITY = process.env.E2E_VOICE_QUALITY ?? 'fast';
const BASE_OUT = process.env.E2E_VOICE_BASE_OUT;
const IDLE_MS = 8000;

const PHRASES = {
  short: { spoken: 'Yes, go ahead.' },
  sentence: { spoken: 'Please reply with the single word banana.' },
};
const clipDir = scratch().dataDir;
mkdirSync(join(clipDir, 'clips'));
const clipOf = {};
for (const [name, p] of Object.entries(PHRASES)) {
  const phrase = say('Samantha', p.spoken);
  p.seconds = (phrase.length / 16_000).toFixed(1);
  clipOf[name] = join(clipDir, 'clips', `${name}.wav`);
  writeWav(clipOf[name], concat(roomTone(1.5), phrase, roomTone(6)));
}

const sessionEnv = (dataDir, clip) => ({ OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3', OFFICE_CLAUDE_MODEL: HAIKU, OFFICE_DEBUG: '1', OFFICE_VOICE_IDLE_MS: String(IDLE_MS), OFFICE_TEST_AUDIO: clip });
const first = scratch();
export const env = sessionEnv(first.dataDir, clipOf.short);

// The settings panel lives on the office desktop now (My Mac), so a scenario sets them the way its buttons do: in the store.
const choose = async (s, key, value) => {
  await s.eval(`__office.set({ ${key}: ${JSON.stringify(value)} })`);
  return (await s.eval(`__office.store.getState().${key}`)) === value;
};
const engineKind = (s) => s.eval('__office.store.getState().voice.engine.kind');
const level = (s) => s.eval(`Number(document.querySelector('.talk-badge .meter')?.style.getPropertyValue('--level') || 0)`);
const measures = (s) => s.eval(`performance.getEntriesByName('voice:ptt').map(e => Math.round(e.duration))`);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = [];

// The owner steps away so the microphone closes, and steps back so it opens on a fresh stream and the clip plays again.
async function freshMic(s) {
  const a = await s.eval('__office.state().avatars[0]');
  await s.eval(`__office.teleport(${a.x + 9}, ${a.z + 9}, 0); __office.step(0.5)`);
  await s.waitFor(`__office.store.getState().voice.capture.kind === 'closed'`, 5000);
  assert(await walkUpToClaude(s), 'walked up to the employee');
  await s.waitFor(`__office.store.getState().voice.capture.kind === 'open'`, 15000);
}

async function quiet(s) {
  await s.waitFor(`${claude}.status.kind === 'idle'`, 120000);
  for (let calm = 0; calm < 4; ) {
    calm = (await s.eval('speechSynthesis.speaking')) ? 0 : calm + 1;
    await s.sleep(400);
  }
}

async function trial(s, tag, phrase, state) {
  await quiet(s);
  if (state === 'cold') await s.waitFor(`__office.store.getState().voice.engine.kind === 'asleep'`, IDLE_MS + 30000);
  else {
    await s.eval('window.office.voice.wake?.()');
    await s.waitFor(`__office.store.getState().voice.engine.kind === 'ready'`, 60000);
  }
  const before = (await measures(s)).length;
  await freshMic(s);
  // The clip plays after 1.5 s of room tone. V goes down when the phrase begins and comes up when the meter has been quiet for 250 ms.
  const t0 = Date.now();
  while ((await level(s)) < 0.05) {
    if (Date.now() - t0 > 15000) throw new Error('the clip never reached the meter');
    await s.sleep(20);
  }
  const engineAtPress = await engineKind(s);
  // Selecting an employee puts the cursor in the chat box, and V typed there is a letter. The owner clicks out of it first.
  await s.eval('document.activeElement?.blur()');
  // What the page saw happen, in case no words arrive.
  await s.eval(`(() => { window.__trace = []; window.__unsub?.(); const t0 = performance.now(); let last = ''; window.__unsub = __office.store.subscribe((st) => { const row = st.voice.phase + '|' + st.voice.engine.kind + '|' + st.toasts.map((t) => t.text).join(';'); if (row !== last) { last = row; window.__trace.push([Math.round(performance.now() - t0), row]); } }); })()`);
  await s.key('keyDown', 'KeyV', 'v');
  const pressedAt = Date.now();
  let quietSince = null;
  for (;;) {
    const l = await level(s);
    if (l >= 0.03) quietSince = null;
    else quietSince ??= Date.now();
    if (quietSince && Date.now() - quietSince > 250) break;
    if (Date.now() - pressedAt > 12000) throw new Error('the phrase never ended');
    await s.sleep(25);
  }
  await s.key('keyUp', 'KeyV', 'v');
  const held = Date.now() - pressedAt;
  const t1 = Date.now();
  while ((await measures(s)).length === before && Date.now() - t1 < 40000) await s.sleep(50);
  const [ms] = (await measures(s)).slice(before);
  if (ms === undefined) console.log('no words; trace:', JSON.stringify(await s.eval('window.__trace')), 'focus:', await s.eval('document.activeElement?.tagName'));
  assert(ms !== undefined, `${tag} ${phrase} ${state}: the words arrived`);
  const asked = state === 'cold' ? engineAtPress === 'asleep' || engineAtPress === 'starting' : engineAtPress === 'ready';
  console.log(`latency: ${tag} ${phrase} (${PHRASES[phrase].seconds} s of speech, V held ${held} ms), engine ${engineAtPress} at the press: release to text ${ms} ms${asked ? '' : '  (state at the press differs from the trial, discarded)'}`);
  return asked ? { tag, phrase, state, held, ms } : null;
}

async function session(s, tag, phrase, { dataDir, repo, fresh }) {
  if (fresh) await hireClaudeInBlock(s, repo);
  await s.waitFor(`['ready', 'asleep'].includes(__office.store.getState().voice.engine.kind)`, 60000);
  assert(await choose(s, 'voiceQuality', QUALITY), `${tag}: chose Voice: ${QUALITY}`);
  assert(await choose(s, 'mic', 'push'), `${tag}: chose the Hold V microphone mode`);
  assert(await choose(s, 'lang', 'en-US'), `${tag}: chose English`);
  await s.waitFor(`['ready', 'asleep'].includes(__office.store.getState().voice.engine.kind)`, 120000);
  console.log(`${tag} ${phrase}: quality ${QUALITY}, engine ${await engineKind(s)} before the first talk (${dataDir})`);
  // The first trial of a session warms the page and the clip pipeline, and is not counted. Only a build with on-demand voice has a cold state.
  const states = tag === 'new' ? ['warm', 'cold'] : ['warm'];
  let discard = true;
  for (const state of states) {
    for (let i = 0; i < TRIALS + (state === 'warm' ? 1 : 0); i++) {
      const row = await trial(s, tag, phrase, state);
      if (row && !discard) results.push(row);
      discard = false;
    }
  }
}

// The scenario's own app is this build on the short phrase. The others are launched here, one at a time.
export default async (s, { launch }) => {
  await session(s, 'new', 'short', { dataDir: first.dataDir, repo: first.repo, fresh: true });
  await s.close();
  const plan = [...(BASE_OUT ? [['base', 'short']] : []), ['new', 'sentence'], ...(BASE_OUT ? [['base', 'sentence']] : [])];
  for (const [tag, phrase] of plan) {
    const mine = process.env.OFFICE_OUT_DIR;
    if (tag === 'base') process.env.OFFICE_OUT_DIR = BASE_OUT;
    const scratchDirs = scratch();
    let app;
    try {
      app = await launch({ env: sessionEnv(scratchDirs.dataDir, clipOf[phrase]) });
    } finally {
      process.env.OFFICE_OUT_DIR = mine;
    }
    await app.waitFor('!!window.__office && !!window.office');
    await session(app, tag, phrase, { ...scratchDirs, fresh: true });
    await app.close();
  }
  report();
};

function report() {
  console.log(`\nlatency summary: release of V to the words, ms (voice quality ${QUALITY}; "base" is the build without on-demand voice)`);
  for (const phrase of Object.keys(PHRASES)) {
    for (const tag of ['base', 'new']) {
      for (const state of ['warm', 'cold']) {
        const xs = results.filter((r) => r.tag === tag && r.phrase === phrase && r.state === state);
        if (xs.length) console.log(`  ${tag.padEnd(5)} ${phrase.padEnd(9)} ${state.padEnd(5)} n=${xs.length} median ${median(xs.map((r) => r.ms))}  all ${xs.map((r) => r.ms).join(' ')}  (V held ${xs.map((r) => r.held).join(' ')})`);
      }
    }
  }
}

export async function diagnose(s) {
  console.log('voice at failure:', JSON.stringify(await s.eval('__office.store.getState().voice').catch((e) => e.message)));
  report();
}
