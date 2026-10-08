import type { MicAccess, VoiceEngine } from '../../../shared/voice.ts';

export type CaptureState = { kind: 'closed' } | { kind: 'opening' } | { kind: 'open' } | { kind: 'failed'; message: string };
export type VoicePhase = 'idle' | 'listening' | 'transcribing';

// Everything the HUD knows about the owner's voice. The engine comes from main, access is main's OS answer refined by the
// samples the renderer sees, and capture and phase are the pipeline's own.
export type VoiceState = { engine: VoiceEngine; access: MicAccess; capture: CaptureState; phase: VoicePhase; cardMic: boolean };

export const initialVoice: VoiceState = { engine: { kind: 'starting' }, access: { kind: 'granted' }, capture: { kind: 'closed' }, phase: 'idle', cardMic: false };

export type ChipAction = 'check_again' | 'try_again' | 'open_mic_settings';
// One line for the owner. `command` is set apart from the sentence because it is what they type.
export type Chip = { tone: 'idle' | 'live' | 'busy' | 'warn'; text: string; command?: string; meter: boolean; action?: ChipAction };

export const chipLine = (chip: Chip) => (chip.command ? `${chip.text} ${chip.command}` : chip.text);

const warn = (text: string, rest: Partial<Chip> = {}): Chip => ({ tone: 'warn', text, meter: false, ...rest });

// The first thing that stops the owner from being heard wins, and the owner can only fix one at a time.
export function chipOf({ engine, access, capture, phase }: VoiceState, mode: 'proximity' | 'push', micMuted = false): Chip {
  // Muted on purpose comes first: nothing else about the mic matters while it is off.
  if (micMuted) return { tone: 'idle', text: 'Your mic is muted. Type in the chat', meter: false };
  if (engine.kind === 'missing_binary') return warn('Voice needs whisper.cpp. Run', { command: 'brew install whisper-cpp', action: 'check_again' });
  if (engine.kind === 'error') return warn(`Voice failed: ${engine.message}`, { action: 'try_again' });
  switch (access.kind) {
    case 'denied':
      return warn('Microphone access is off.', { action: 'open_mic_settings' });
    case 'silent':
      return warn('The mic is silent. Unmute it, or start the app with', { command: 'pnpm beta' });
    case 'needs_prompt':
      return warn('Allow the microphone in the macOS dialog.');
    case 'granted':
      break;
    default: {
      const _exhaustive: never = access;
      return _exhaustive;
    }
  }
  if (capture.kind === 'failed') return warn(`Could not open the microphone: ${capture.message}`);
  if (engine.kind === 'downloading') {
    const percent = engine.total > 0 ? Math.floor((engine.received / engine.total) * 100) : 0;
    return { tone: 'busy', text: `Downloading the voice model ${percent}%`, meter: false };
  }
  if (engine.kind === 'starting') return { tone: 'busy', text: 'Loading the voice model', meter: false };
  if (capture.kind !== 'open') return { tone: 'idle', text: 'Mic starting', meter: false };
  switch (phase) {
    case 'listening':
      return { tone: 'live', text: 'Listening', meter: true };
    case 'transcribing':
      return { tone: 'busy', text: 'Transcribing', meter: true };
    case 'idle':
      return { tone: 'idle', text: mode === 'push' ? 'Hold V to talk' : 'Just talk, or hold V', meter: true };
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}
