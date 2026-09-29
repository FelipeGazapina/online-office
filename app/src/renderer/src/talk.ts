// Owner speech: routing text to the right protocol message, and the speech recognizer lifecycle.
import type { EmployeeId } from '../../shared/protocol.ts';
import { isSpeaking } from './audio.ts';
import { employeeById, get, send, set, toast, useStore } from './store.ts';

// What a sentence means depends on what the listener is doing, exactly like in a real office.
export function routeText(employeeId: EmployeeId, text: string) {
  const e = employeeById(employeeId);
  const clean = text.trim();
  if (!e || !clean) return;
  const s = e.status;
  if (s.kind === 'blocked_on_owner') {
    send({ type: 'answer', employeeId, questionId: s.question.id, text: clean });
    toast(`Answered ${e.name}: ${clean}`, 'ok');
  } else if (s.kind === 'working') {
    const style = get().interrupt;
    send({ type: 'interject', employeeId, text: clean, style });
    toast(`${style === 'now' ? 'Stopped' : 'Tapped'} ${e.name}: ${clean}`, 'ok');
  } else {
    send({ type: 'assign', employeeId, task: clean });
    toast(`Assigned to ${e.name}: ${clean}`, 'ok');
  }
}

// Minimal shape of the parts of SpeechRecognition we use; lib.dom does not ship it.
type Alt = { transcript: string };
type Result = { isFinal: boolean; 0: Alt };
type ResultEvent = { resultIndex: number; results: ArrayLike<Result> };
interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognizerCtor = new () => Recognizer;
// Electron defines SpeechRecognition but ships no speech backend: start() opens the mic, then fails with `network`.
// Listening returns with a local engine, so until then the recognizer stays off and the owner types.
const inElectron = navigator.userAgent.includes('Electron/');
const Ctor = inElectron
  ? undefined
  : (window as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: RecognizerCtor }).webkitSpeechRecognition;

export const speechSupported = !!Ctor;

type Source = 'proximity' | 'ptt' | 'card';
type Want = { source: Source; target: EmployeeId; once: boolean; lang: string };
type Session = { want: Want; rec: Recognizer; stopped: boolean };

let pttHeld = false;
let cardMic = false;
let current: Session | null = null;
// A denied mic or dead network would otherwise restart forever. Only an explicit gesture retries.
let fatal = false;

export function setPtt(held: boolean) {
  pttHeld = held;
  if (held) fatal = false;
  reconcile();
}

export function toggleCardMic() {
  cardMic = !cardMic;
  fatal = false;
  reconcile();
}

export const cardMicOn = () => cardMic;

// One pure question: given the world right now, who should the microphone be pointed at, if anyone.
function desired(): Want | null {
  const s = get();
  if (!speechSupported || fatal) return null;
  if (cardMic && s.askerId) return { source: 'card', target: s.askerId, once: true, lang: s.lang };
  if (pttHeld) {
    const target = s.talkingTo ?? s.askerId;
    return target ? { source: 'ptt', target, once: false, lang: s.lang } : null;
  }
  if (s.mic === 'proximity' && s.talkingTo) return { source: 'proximity', target: s.talkingTo, once: false, lang: s.lang };
  return null;
}

const same = (a: Want, b: Want) => a.source === b.source && a.target === b.target && a.lang === b.lang;

function setVoice(patch: Partial<ReturnType<typeof get>['voice']>) {
  set((s) => ({ voice: { ...s.voice, ...patch } }));
}

function stop(session: Session) {
  session.stopped = true;
  try {
    session.rec.stop(); // stop, not abort: a pending final result still gets delivered
  } catch {
    // already stopped
  }
}

function begin(want: Want) {
  if (!Ctor) return;
  const rec = new Ctor();
  rec.lang = want.lang;
  rec.continuous = !want.once;
  rec.interimResults = true;
  const session: Session = { want, rec, stopped: false };
  current = session;

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0].transcript.trim();
      if (!r.isFinal) {
        interim += text + ' ';
        continue;
      }
      // Speakers feed our own TTS back into the mic. Drop anything heard while an employee talks.
      if (isSpeaking() || text.length < 2) continue;
      routeText(want.target, text);
      if (want.once) {
        cardMic = false;
        stop(session);
      }
    }
    setVoice({ interim: interim.trim() });
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      fatal = true;
      session.stopped = true;
      setVoice({ note: 'Microphone blocked. Allow it in the browser, or type with Enter.' });
    } else if (e.error === 'network') {
      fatal = true;
      session.stopped = true;
      setVoice({ note: 'Speech recognition needs a network connection in this browser. Type with Enter.' });
    }
  };
  rec.onend = () => {
    setVoice({ interim: '' });
    if (current === session && !session.stopped) {
      // Chrome ends continuous sessions after a silence. Keep listening while the reason still holds.
      setTimeout(() => {
        if (current !== session || session.stopped) return;
        try {
          rec.start();
        } catch {
          session.stopped = true;
        }
      }, 250);
    }
    if (current === session && session.stopped) {
      current = null;
      setVoice({ active: false });
      reconcile();
    }
  };
  try {
    rec.start();
    setVoice({ active: true, note: null });
  } catch {
    current = null;
  }
}

export function reconcile() {
  const want = desired();
  if (current && (!want || !same(current.want, want)) && !current.stopped) {
    stop(current);
    current = null;
    setVoice({ active: false, interim: '' });
  }
  if (want && !current) begin(want);
}

export function installTalk() {
  // No note here: the talk badge and the disabled mic button already say voice is off, and a permanent toast would nag.
  if (!speechSupported) setVoice({ supported: false });
  useStore.subscribe(reconcile);
}
