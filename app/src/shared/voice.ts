// What the speech engine and the microphone report to the owner. Main knows the engine and the OS grant, the renderer
// knows whether samples arrive, and the HUD chip renders both as one line.

// `auto` makes whisper run its encoder twice, so it is the slow choice.
export const LANGUAGES = ['auto', 'en', 'pt'] as const;
export type Language = (typeof LANGUAGES)[number];

// fast is small-q5_1 (about 0.4 s per utterance), accurate is large-v3-turbo-q5_0 (about 1.4 s, 574 MB).
export const QUALITIES = ['fast', 'accurate'] as const;
export type VoiceQuality = (typeof QUALITIES)[number];

// The whole lifecycle of whisper-server. `model` is the file the running server loaded. The server only runs while the owner
// talks and for a while after: `asleep` is the model on disk with no server, and the next `wake` starts it.
export type VoiceEngine =
  | { kind: 'missing_binary' }
  | { kind: 'downloading'; file: string; received: number; total: number }
  | { kind: 'starting' }
  | { kind: 'asleep' }
  | { kind: 'ready'; model: string }
  | { kind: 'error'; message: string };

// `silent` is granted but every sample is zero. macOS hands the responsible process silence when it cannot prompt,
// and a terminal that launched the app is that process. It is decided in the renderer, which sees the samples.
export type MicAccess = { kind: 'granted' } | { kind: 'needs_prompt' } | { kind: 'denied' } | { kind: 'silent' };
export type OsMicAccess = Exclude<MicAccess, { kind: 'silent' }>;

export const VOICE_SCHEME = 'office-voice';
// The privileged protocol that serves the worklet, the Silero model and onnxruntime-web to the page, because fetch fails on file://.
export const VOICE_ORIGIN = `${VOICE_SCHEME}://assets`;

// What the preload exposes as `window.office.voice`. Audio is 16 kHz mono Int16.
export type VoiceApi = {
  engine(): Promise<VoiceEngine>;
  onEngine(cb: (engine: VoiceEngine) => void): () => void;
  // Puts the model for this quality on disk and moves a running engine onto it. The renderer owns the setting and sends it at boot.
  useQuality(quality: VoiceQuality): void;
  // The owner starts to talk (V goes down, or the detector hears speech). Starts the engine so it has loaded when they stop, and
  // keeps it up for the idle period after the last call. Cheap to call again.
  wake(): void;
  // Looks for whisper-server again, then retries. Also retries after an engine error.
  recheck(): void;
  // Resolves the words, or '' when the audio held no speech. One request runs at a time.
  transcribe(pcm: Int16Array, language: Language): Promise<string>;
  mic: {
    // What macOS says now, without asking.
    status(): Promise<OsMicAccess>;
    // Asks macOS when it has not been asked. Resolves what it says afterwards, which stays needs_prompt when no dialog could open.
    request(): Promise<OsMicAccess>;
    openSettings(): void;
  };
};

export const VOICE_IPC = {
  engine: 'voice:engine',
  engineChanged: 'voice:engine-changed',
  useQuality: 'voice:use-quality',
  wake: 'voice:wake',
  recheck: 'voice:recheck',
  transcribe: 'voice:transcribe',
  micStatus: 'voice:mic-status',
  micRequest: 'voice:mic-request',
  micSettings: 'voice:mic-settings',
} as const;
