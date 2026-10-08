// What the owner waits for after hold-V push-to-talk, with the whisper-server asleep (cold) and already up (warm), on a short
// command and on a sentence. The owner holds V while they speak and lets go when they stop, so each trial presses V when the
// level meter shows the phrase begin and releases it a moment after the meter falls quiet. The renderer's own
// `voice:ptt` measure then says how long it took from the release to the words, which is the wait the owner feels.
// It runs on the old build too (set E2E_VOICE_COLD=0): there the server is always up, so it only has warm trials.
// Run: pnpm build:verify && OFFICE_OUT_DIR=out/verify OFFICE_CDP_PORT=9342 node verify/cdp.mjs verify/e2e-voice-latency.mjs
//   E2E_VOICE_TRIALS=4 repeats per phrase and state, E2E_VOICE_QUALITY=fast|accurate, E2E_VOICE_COLD=0 skips the cold trials.
import { HAIKU, assert, company, claude, hireClaudeInBlock, scratch, walkUpToClaude } from './lib.mjs';
import { concat, roomTone, say, writeWav } from './wav.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TRIALS = Number(process.env.E2E_VOICE_TRIALS ?? 4);
const QUALITY = process.env.E2E_VOICE_QUALITY ?? 'fast';
const COLD = process.env.E2E_VOICE_COLD !== '0';
const IDLE_MS = 8000;

const { dataDir, repo } = scratch();
const clips = join(dataDir, 'clips');
mkdirSync(clips);
const PHRASES = {
  short: { spoken: 'Yes, go ahead.', words: ['go ahead'] },
  sentence: { spoken: 'Please reply with the single word banana.', words: ['banana'] },
};
const clipOf = {};
for (const [name, p] of Object.entries(PHRASES)) {
  const phrase = say('Samantha', p.spoken);
  p.seconds = (phrase.length / 16_000).toFixed(1);
  clipOf[name] = join(clips, `${name}.wav`);
  writeWav(clipOf[name], concat(roomTone(1.5), phrase, roomTone(6)));
}

const base = { OFFICE_DATA_DIR: dataDir, OFFICE_START_LEVEL: '3', OFFICE_CLAUDE_MODEL: HAIKU, OFFICE_VOICE_IDLE_MS: String(IDLE_MS) };
export const env = { ...base, OFFICE_TEST_AUDIO: clipOf.short };

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

async function trial(s, name, state) {
  await quiet(s);
  if (state === 'cold') await s.waitFor(`__office.store.getState().voice.engine.kind === 'asleep'`, IDLE_MS + 30000);
  else {
    await s.eval('window.office.voice.wake()');
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
  assert(ms !== undefined, `${name} ${state}: the words arrived`);
  const asked = state === 'cold' ? engineAtPress === 'asleep' || engineAtPress === 'starting' : engineAtPress === 'ready';
  console.log(`latency: ${name} (${PHRASES[name].seconds} s of speech, V held ${held} ms), engine ${engineAtPress} at the press: release to text ${ms} ms${asked ? '' : '  (state at the press differs from the trial, discarded)'}`);
  if (asked) results.push({ name, state, held, ms });
}

async function session(s, name, { hire }) {
  if (hire) await hireClaudeInBlock(s, repo);
  else {
    await s.waitFor(`!!${company} && ${company}.employees.length === 1`);
    await s.eval('__office.step(25)');
  }
  await s.waitFor(`['ready', 'asleep'].includes(__office.store.getState().voice.engine.kind)`, 60000);
  assert(await s.clickText('.settings .seg button', QUALITY === 'accurate' ? 'Accurate' : 'Fast'), `chose Voice: ${QUALITY}`);
  assert(await s.clickText('.settings .seg button', 'Hold V'), 'chose the Hold V microphone mode');
  assert(await s.clickText('.settings .seg button', 'English'), 'chose English');
  await s.waitFor(`['ready', 'asleep'].includes(__office.store.getState().voice.engine.kind)`, 120000);
  console.log(`${name}: quality ${QUALITY}, engine ${await engineKind(s)} before the first talk`);
  // The first trial of a session warms the page and the clip pipeline, and is not counted.
  let first = true;
  for (const state of COLD ? ['warm', 'cold'] : ['warm']) {
    for (let i = 0; i < TRIALS + (state === 'warm' ? 1 : 0); i++) {
      const before = results.length;
      await trial(s, name, state);
      if (first) results.length = before;
      first = false;
    }
  }
}

export default async (s, { launch }) => {
  await session(s, 'short', { hire: true });
  await s.close();
  const second = await launch({ env: { ...base, OFFICE_TEST_AUDIO: clipOf.sentence } });
  await second.waitFor('!!window.__office && !!window.office');
  await session(second, 'sentence', { hire: false });
  await second.close();
  report();
};

function report() {
  console.log('\nlatency summary (release of V to the words, ms)');
  for (const name of Object.keys(PHRASES)) {
    for (const state of ['warm', 'cold']) {
      const xs = results.filter((r) => r.name === name && r.state === state);
      if (xs.length) console.log(`  ${name.padEnd(9)} ${state.padEnd(5)} n=${xs.length} median ${median(xs.map((r) => r.ms))}  all ${xs.map((r) => r.ms).join(' ')}  (V held ${xs.map((r) => r.held).join(' ')})`);
    }
  }
}

export async function diagnose(s) {
  console.log('voice at failure:', JSON.stringify(await s.eval('__office.store.getState().voice').catch((e) => e.message)));
  report();
}
