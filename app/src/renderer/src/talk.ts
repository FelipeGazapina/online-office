// Owner speech: routing text to the right protocol message, and the microphone pipeline that produces it.
import type { EmployeeId, InterruptStyle } from '../../shared/protocol.ts';
import type { MicAccess } from '../../shared/voice.ts';
import { cancelSpeech } from './audio.ts';
import { employeeById, get, LANGS, send, set, toast, useStore } from './store.ts';
import type { VoicePhase, VoiceState } from './voice/chip.ts';
import { gate } from './voice/gate.ts';
import { openCapture, type Capture } from './voice/mic.ts';
import type { Vad, VadEvents } from './voice/vad.ts';
import { SAMPLE_RATE } from './voice/ring.ts';

// Says `text` to an employee the way a boss would: a word to someone mid-task steers them, anything else is a request that
// queues if they are busy. The mailroom answers a boss who speaks to someone waiting on a decision by itself.
export function tell(employeeId: EmployeeId, text: string, style: InterruptStyle = get().interrupt) {
  const clientId = crypto.randomUUID();
  const status = employeeById(employeeId)?.status;
  if (status?.kind === 'blocked_on_owner') return send({ type: 'answer', employeeId, questionId: status.question.id, text });
  send(status?.kind === 'working' ? { type: 'post', to: employeeId, clientId, as: 'say', text, urgency: style } : { type: 'post', to: employeeId, clientId, as: 'request', text });
}

// What a sentence means depends on what the listener is doing, exactly like in a real office.
export function routeText(employeeId: EmployeeId, text: string) {
  const e = employeeById(employeeId);
  const clean = text.trim();
  if (!e || !clean) return;
  const s = e.status;
  if (s.kind === 'blocked_on_owner') {
    tell(employeeId, clean);
    toast(`Answered ${e.name}: ${clean}`, 'ok');
  } else if (s.kind === 'working') {
    const style = get().interrupt;
    tell(employeeId, clean, style);
    toast(`${style === 'now' ? 'Stopped' : 'Tapped'} ${e.name}: ${clean}`, 'ok');
  } else {
    tell(employeeId, clean);
    toast(`Assigned to ${e.name}: ${clean}`, 'ok');
  }
}

// Hold V: the slice starts a little before the press, because people start talking as they reach for the key, and ends
// a little after the release, because the last block and the device's own buffer are still on their way.
const PTT_PRE_ROLL_SAMPLES = Math.round(0.2 * SAMPLE_RATE);
const PTT_TAIL_MS = 150;
const PTT_TAIL_SAMPLES = Math.round((PTT_TAIL_MS / 1000) * SAMPLE_RATE);
// Shorter than this is a tap on the key. Longer than whisper's 30 s window is not worth sending.
const PTT_MIN_SAMPLES = Math.round(0.3 * SAMPLE_RATE);
const MAX_SAMPLES = 30 * SAMPLE_RATE;

type Source = 'proximity' | 'ptt' | 'card';
type Want = { source: Source; target: EmployeeId };
type Utterance = Want & { pcm: Int16Array; endedAt: number };

// The microphone is one thing in one of four states, and this is the only variable that says which.
type MicState =
  | { kind: 'closed' }
  | { kind: 'opening' }
  | { kind: 'open'; capture: Capture }
  | { kind: 'failed'; message: string };
let micState: MicState = { kind: 'closed' };
let openings = 0;
// Where the key press sits in the ring, or null while V is up. 0 when the microphone was not open yet: the whole ring.
let pttFrom: number | null = null;
let speaking = false;
let pending = 0;
let visibilityMuted = false;
// Silero and onnxruntime are big, and a session that only holds V never needs them, so they load on the first listen.
let detector: { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; vad: Vad } | { kind: 'broken' } = { kind: 'idle' };

// Only a change reaches the store, because every store update wakes the HUD and reconcile().
function patchVoice(patch: Partial<VoiceState>) {
  const now = get().voice;
  const next = { ...now, ...patch };
  if (JSON.stringify(next) !== JSON.stringify(now)) set({ voice: next });
}

function setMicState(next: MicState) {
  micState = next;
  patchVoice({ capture: next.kind === 'open' ? { kind: 'open' } : next });
}

const setAccess = (access: MicAccess) => patchVoice({ access });

function refreshPhase() {
  const phase: VoicePhase = pttFrom !== null || speaking ? 'listening' : pending > 0 ? 'transcribing' : 'idle';
  patchVoice({ phase });
}

// An engine that is asleep starts when the owner speaks, so it can serve too.
const engineCanServe = () => {
  const { engine } = get().voice;
  return engine.kind === 'ready' || engine.kind === 'starting' || engine.kind === 'asleep';
};

async function transcribeAndRoute(u: Utterance) {
  if (!engineCanServe()) return;
  const text = await window.office.voice.transcribe(u.pcm, LANGS[get().lang].stt);
  // The HUD says how long the owner waited. Tests read these entries.
  performance.measure(`voice:${u.source}`, { start: u.endedAt });
  if (text) routeText(u.target, text);
}

// Runs `work` while the HUD says Transcribing.
function counted(work: () => Promise<void>) {
  pending++;
  refreshPhase();
  void work()
    .catch((err: unknown) => toast(`Could not transcribe: ${err instanceof Error ? err.message : String(err)}`, 'warn'))
    .finally(() => {
      pending--;
      refreshPhase();
    });
}

const vadEvents: VadEvents = {
  speechStart() {
    speaking = true;
    // The engine only runs while the owner talks, and it loads while they finish the sentence.
    window.office.voice.wake();
    refreshPhase();
  },
  misfire() {
    speaking = false;
    refreshPhase();
  },
  speechEnd(pcm) {
    speaking = false;
    const want = desired();
    // The gate can close between the detector's last frame and this callback, and V takes over from the detector.
    if (!gate.isOpen() || !want || want.source === 'ptt') return refreshPhase();
    if (want.source === 'card') patchVoice({ cardMic: false });
    counted(() => transcribeAndRoute({ ...want, pcm, endedAt: performance.now() }));
  },
};

// One pure question: given the world right now, who should the microphone be pointed at, if anyone.
function desired(): Want | null {
  const s = get();
  if (s.voice.cardMic && s.askerId) return { source: 'card', target: s.askerId };
  if (pttFrom !== null) {
    const target = s.talkingTo ?? s.askerId;
    return target ? { source: 'ptt', target } : null;
  }
  if (s.mic === 'proximity' && s.talkingTo) return { source: 'proximity', target: s.talkingTo };
  return null;
}

// macOS is asked once per launch. Says whether to go on and open the stream.
async function mayOpen(token: number): Promise<boolean> {
  const { mic: os } = window.office.voice;
  let access = await os.status();
  if (access.kind === 'needs_prompt') {
    setAccess(access);
    access = await os.request();
  }
  if (token !== openings) return false;
  if (access.kind === 'denied') {
    setAccess(access);
    setMicState({ kind: 'failed', message: 'Microphone access is off' });
    return false;
  }
  // Still undecided means macOS could not show its dialog, so the stream would come back silent. The samples decide.
  setAccess(access.kind === 'needs_prompt' ? { kind: 'silent' } : access);
  return true;
}

async function openMic() {
  const token = ++openings;
  setMicState({ kind: 'opening' });
  try {
    if (!(await mayOpen(token))) return;
    const capture = await openCapture({ liveness: (state) => setAccess({ kind: state === 'live' ? 'granted' : 'silent' }) });
    if (token !== openings) return capture.close();
    setMicState({ kind: 'open', capture });
  } catch (err) {
    if (token !== openings) return;
    if (err instanceof DOMException && err.name === 'NotAllowedError') setAccess({ kind: 'denied' });
    setMicState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
}

function closeMic() {
  if (micState.kind === 'open') micState.capture.close();
  // A pending open finds a newer token and closes itself.
  openings++;
  speaking = false;
  // A hold that outlives the microphone continues in the next ring, from its start.
  if (pttFrom !== null) pttFrom = 0;
  setMicState({ kind: 'closed' });
  refreshPhase();
}

function loadVad() {
  detector = { kind: 'loading' };
  import('./voice/vad.ts')
    .then(({ createVad }) => createVad(vadEvents))
    .then((vad) => {
      detector = { kind: 'ready', vad };
      reconcile();
    })
    .catch((err: unknown) => {
      detector = { kind: 'broken' };
      console.error('voice detector', err);
      toast('Could not load the voice detector. Hold V to talk.', 'warn');
    });
}

function syncVad(listening: boolean) {
  if (!listening) speaking = false;
  if (detector.kind === 'ready') detector.vad.listen(listening);
  else if (listening && detector.kind === 'idle') loadVad();
}

let reconciling = false;
let again = false;

// Brings the microphone and the detector in line with the world. Safe to call at any time and as often as you like.
export function reconcile() {
  if (reconciling) {
    again = true;
    return;
  }
  reconciling = true;
  try {
    do {
      again = false;
      apply();
    } while (again);
  } finally {
    reconciling = false;
  }
}

function apply() {
  if (visibilityMuted) {
    if (micState.kind !== 'closed') closeMic();
    syncVad(false);
    return;
  }
  // A card mic is for the question in front of the owner, and does not carry over to the next one.
  if (get().voice.cardMic && !get().askerId) patchVoice({ cardMic: false });
  const want = desired();
  // The microphone is open only while the owner is next to someone, or a key or a card asks for it.
  if (get().talkingTo !== null || want !== null) {
    if (micState.kind === 'closed') void openMic();
  } else if (micState.kind === 'failed') {
    setMicState({ kind: 'closed' });
  } else if (micState.kind !== 'closed') {
    closeMic();
  }
  syncVad(want !== null && want.source !== 'ptt' && micState.kind === 'open' && gate.isOpen() && engineCanServe());
}

function releasePtt() {
  const from = pttFrom;
  pttFrom = null;
  const s = get();
  const target = s.talkingTo ?? s.askerId;
  if (from === null || !target || micState.kind !== 'open') return;
  const { ring } = micState.capture;
  const to = ring.written;
  const endedAt = performance.now();
  counted(async () => {
    await new Promise((resolve) => setTimeout(resolve, PTT_TAIL_MS));
    const end = Math.min(ring.written, to + PTT_TAIL_SAMPLES);
    const pcm = ring.slice(Math.max(from, end - MAX_SAMPLES), end);
    if (pcm.length >= PTT_MIN_SAMPLES) await transcribeAndRoute({ source: 'ptt', target, pcm, endedAt });
  });
}

export function setPtt(held: boolean) {
  if (held === (pttFrom !== null)) return;
  if (held) {
    // Barge-in: an employee who is talking stops the moment the owner reaches for the key.
    cancelSpeech();
    // The engine loads while the key is held, so the words are ready soon after it is let go.
    window.office.voice.wake();
    pttFrom = micState.kind === 'open' ? Math.max(0, micState.capture.ring.written - PTT_PRE_ROLL_SAMPLES) : 0;
  } else {
    releasePtt();
  }
  refreshPhase();
  reconcile();
}

export function toggleCardMic() {
  patchVoice({ cardMic: !get().voice.cardMic });
  reconcile();
}

// The owner may have just flipped the switch in System Settings, or unmuted the mic, so try again when the window is back.
function retryBlockedMic() {
  const { access } = get().voice;
  if (micState.kind === 'failed' || access.kind === 'denied' || access.kind === 'silent') {
    closeMic();
    reconcile();
  }
}

export function installTalk() {
  const { voice } = window.office;
  void voice.engine().then((engine) => patchVoice({ engine }));
  voice.onEngine((engine) => patchVoice({ engine }));
  voice.useQuality(get().voiceQuality);
  gate.subscribe(reconcile);
  useStore.subscribe((s, previous) => {
    if (s.voiceQuality !== previous.voiceQuality) voice.useQuality(s.voiceQuality);
    reconcile();
  });
  window.addEventListener('focus', retryBlockedMic);
  // Electron marks the document hidden when its window is minimized. Close the
  // capture immediately so a backgrounded office never keeps the user's mic live.
  const onVisibility = () => {
    visibilityMuted = document.visibilityState === 'hidden';
    if (visibilityMuted) closeMic();
    else reconcile();
  };
  document.addEventListener('visibilitychange', onVisibility);
}
