import type { Employee } from '../../shared/protocol.ts';
import { hash } from './util.ts';
import { get, LANGS, set } from './store.ts';
import { runtime } from './runtime.ts';
import { gate } from './voice/gate.ts';

export const LISTEN_RADIUS = 1.5;
export const EAR_RADIUS = 4;

let ctx: AudioContext | null = null;

// Browsers gate audio and notification prompts behind a user gesture, so do it on the first one.
export function installGestureUnlock() {
  // Chromium loads the voice list on the first call, not at startup, so ask now to have it by the first spoken line.
  speechSynthesis.getVoices();
  const unlock = () => {
    ctx ??= new AudioContext();
    void ctx.resume();
    speechSynthesis.getVoices();
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

export function chime() {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  // Two-note bell, rising: hard to miss, not alarming.
  [
    [784, 0],
    [1175, 0.13],
  ].forEach(([freq, delay]) => {
    const t = t0 + delay;
    for (const [mult, peak] of [[1, 0.22], [2.01, 0.06]] as const) {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 1);
    }
  });
}

// macOS ships novelty voices under en-US. One of them asking "which database?" ruins the mood.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy)\b/;

function pickVoice(id: string): SpeechSynthesisVoice | undefined {
  const lang = LANGS[get().lang].tts;
  const norm = (l: string) => l.replace('_', '-').toLowerCase();
  const all = speechSynthesis.getVoices().filter((v) => !NOVELTY.test(v.name));
  const exact = all.filter((v) => norm(v.lang) === norm(lang));
  const pool = exact.length ? exact : all.filter((v) => norm(v.lang).startsWith(norm(lang).slice(0, 2)));
  return pool.length ? pool[hash(id) % pool.length] : undefined;
}

// Chromium can collect an utterance nobody holds while it is still speaking, and its end event goes with it.
const utterances = new Set<SpeechSynthesisUtterance>();

export function speak(employeeId: string, text: string, opts: { cancel?: boolean } = {}) {
  if (!('speechSynthesis' in window)) return;
  if (opts.cancel) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(employeeId);
  if (v) u.voice = v;
  u.lang = LANGS[get().lang].tts;
  u.pitch = 0.85 + (hash(employeeId, 1) % 36) / 100;
  u.rate = 0.95 + (hash(employeeId, 2) % 16) / 100;
  // The microphone hears the employees too, so it stops listening while one speaks. The gate's tail bridges the gap to a queued
  // utterance, and cancel() ends the utterance with an error event.
  utterances.add(u);
  u.onstart = () => gate.speaking(true);
  u.onend = u.onerror = () => {
    utterances.delete(u);
    gate.speaking(false);
  };
  speechSynthesis.speak(u);
}

// Pressing V is the owner interrupting: whoever is talking stops.
export function cancelSpeech() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

export function isAudible(employee: Employee) {
  if (employee.status.kind === 'blocked_on_owner') return true;
  const av = runtime.avatars.get(employee.id);
  return !!av && av.pos.distanceTo(runtime.owner.pos) <= EAR_RADIUS;
}

// Called by the office client for `said` events.
export function heard(employee: Employee, text: string) {
  // Normal speech follows the same active proximity target as the chat and mic.
  // The wider ear radius must not leave a previous employee talking after the owner moves on.
  if (get().talkingTo !== employee.id || !isAudible(employee)) return;
  speak(employee.id, text);
  set((s) => ({ bubbles: { ...s.bubbles, [employee.id]: { text, until: Date.now() + 6000 } } }));
}

// The arrival is the interruption: sound, voice, and an OS notification if the tab is hidden.
export function announceArrival(employee: Employee, blockName: string) {
  if (get().meetingDoor === 'closed') return;
  if (employee.status.kind !== 'blocked_on_owner') return;
  const q = employee.status.question;
  chime();
  speak(employee.id, q.text, { cancel: true });
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(`${employee.name} needs you (${blockName})`, { body: q.text, tag: q.id });
  }
}
