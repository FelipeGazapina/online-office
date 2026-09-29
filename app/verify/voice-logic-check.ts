// No Electron, no model. The renderer's voice logic that does not need a browser: the ring buffer, the half-duplex gate
// and the one line the HUD chip shows for every state.
// Run from app/: node verify/voice-logic-check.ts   Exits 1 on any failed check.
import type { MicAccess, VoiceEngine } from '../src/shared/voice.ts';
import { correctTechnicalTerms } from '../src/main/voice/server.ts';
import { chipLine, chipOf, initialVoice, type VoiceState } from '../src/renderer/src/voice/chip.ts';
import { createGate } from '../src/renderer/src/voice/gate.ts';
import { Ring, SAMPLE_RATE } from '../src/renderer/src/voice/ring.ts';
import { check, finish, sleep } from './check.ts';

console.log('# technical transcript corrections');
check(
  correctTechnicalTerms('push this type script app to get hub and run it with node js') ===
    'push this TypeScript app to GitHub and run it with Node.js',
  'common split IT terms are restored with their conventional spelling',
);
check(correctTechnicalTerms('use postgres, graphql, and m c p') === 'use PostgreSQL, GraphQL, and MCP', 'database, API, and protocol terms are corrected');

console.log('# the ring');
const ring = new Ring(1);
ring.push(Int16Array.from({ length: 1000 }, (_, i) => i));
check(ring.written === 1000, 'it counts the samples pushed');
check(ring.slice(100, 105).join() === '100,101,102,103,104', 'a slice is addressed by absolute position');
check(ring.slice(990, 2000).length === 10, 'a slice past the end stops at what was heard');
ring.push(Int16Array.from({ length: SAMPLE_RATE }, (_, i) => 1000 + i));
check(ring.written === 1000 + SAMPLE_RATE, 'positions keep counting after the buffer wraps');
const oldest = ring.written - SAMPLE_RATE;
check(ring.slice(500, 1020).length === 20 && ring.slice(500, 1020)[0] === oldest, `a slice that starts before the oldest sample starts at the oldest (${oldest})`);
check(ring.slice(0, 20).length === 0, 'and one that ends before it is empty');
check(ring.slice(ring.written - 3, ring.written).join() === '16997,16998,16999', 'the newest samples survive the wrap');
check(ring.slice(500, 400).length === 0, 'a backwards slice is empty');

console.log('\n# the gate');
const gate = createGate(40);
let changes = 0;
gate.subscribe(() => changes++);
check(gate.isOpen(), 'it starts open');
gate.speaking(true);
check(!gate.isOpen() && changes === 1, 'an employee speaking closes it, once');
gate.speaking(true);
check(changes === 1, 'a second utterance queued behind the first does not announce a change');
gate.speaking(false);
check(!gate.isOpen(), 'it stays closed when the speech ends, for the tail');
await sleep(80);
check(gate.isOpen() && changes === 2, 'and opens once the tail has passed');
gate.speaking(true);
gate.speaking(false);
await sleep(20);
gate.speaking(true);
await sleep(80);
check(!gate.isOpen() && changes === 3, 'a new utterance during the tail cancels the reopening');
gate.speaking(false);
await sleep(80);
check(gate.isOpen(), 'and the gate opens after that one ends');

console.log('\n# the chip');
const state = (patch: Partial<VoiceState>): VoiceState => ({ ...initialVoice, capture: { kind: 'open' }, engine: { kind: 'ready', model: 'm' }, ...patch });
const chip = (patch: Partial<VoiceState>, mode: 'proximity' | 'push' = 'proximity') => chipOf(state(patch), mode);
const ready: VoiceEngine = { kind: 'ready', model: 'ggml-small-q5_1.bin' };

const missing = chip({ engine: { kind: 'missing_binary' } });
check(missing.command === 'brew install whisper-cpp' && missing.action === 'check_again' && missing.tone === 'warn', 'a missing binary says brew install whisper-cpp and offers Check again');
check(chipLine(missing) === 'Voice needs whisper.cpp. Run brew install whisper-cpp', `and reads as one line (${chipLine(missing)})`);
const failed = chip({ engine: { kind: 'error', message: 'whisper-server exited with code 3' } });
check(failed.tone === 'warn' && failed.text.includes('exited with code 3') && failed.action === 'try_again', 'an engine error shows its message and offers Try again');
const denied = chip({ access: { kind: 'denied' } });
check(denied.action === 'open_mic_settings' && denied.tone === 'warn', 'a denied mic offers to open System Settings');
const silent = chip({ access: { kind: 'silent' } });
check(silent.command === 'pnpm beta' && silent.action === undefined, 'a silent mic says to start the app with pnpm beta');
check(chip({ access: { kind: 'needs_prompt' } }).text.includes('macOS dialog'), 'a mic that macOS has not answered points at the macOS dialog');
check(chip({ engine: { kind: 'downloading', file: 'f', received: 37_400_000, total: 100_000_000 } }).text === 'Downloading the voice model 37%', 'a download shows its percent');
check(chip({ engine: { kind: 'downloading', file: 'f', received: 0, total: 0 } }).text.endsWith('0%'), 'an unknown size does not divide by zero');
check(chip({ engine: { kind: 'starting' } }).tone === 'busy', 'a starting engine says the model is loading');
check(chip({ capture: { kind: 'opening' } }).text === 'Mic starting', 'a microphone that is opening says so');
check(chip({ capture: { kind: 'failed', message: 'Requested device not found' } }).text.includes('Requested device not found'), 'a microphone that cannot open says why');
check(chip({ phase: 'listening' }).text === 'Listening' && chip({ phase: 'listening' }).tone === 'live', 'speech shows Listening');
check(chip({ phase: 'transcribing' }).text === 'Transcribing', 'and then Transcribing');
check(chip({}).meter && chip({ phase: 'listening' }).meter && !chip({ access: { kind: 'denied' } }).meter, 'the level meter shows while the mic works and not while it does not');
check(chip({}, 'push').text === 'Hold V to talk' && chip({}, 'proximity').text.startsWith('Just talk'), 'idle tells each mode what to do');

const denyThenBinary = chipOf(state({ engine: { kind: 'missing_binary' }, access: { kind: 'denied' } }), 'proximity');
check(denyThenBinary.action === 'check_again', 'with two problems the engine comes first, because the owner fixes one at a time');
const denyDuringDownload = chipOf(state({ engine: { kind: 'downloading', file: 'f', received: 1, total: 2 }, access: { kind: 'denied' } }), 'proximity');
check(denyDuringDownload.action === 'open_mic_settings', 'a download that needs nothing from the owner does not hide a mic they can fix');
const accesses: MicAccess[] = [{ kind: 'granted' }, { kind: 'needs_prompt' }, { kind: 'denied' }, { kind: 'silent' }];
check(accesses.every((access) => chipOf(state({ engine: ready, access }), 'push').text.length > 0), 'every mic access state has a line');

finish();
