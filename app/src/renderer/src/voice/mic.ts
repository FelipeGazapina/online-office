import { VOICE_ORIGIN } from '../../../shared/voice.ts';
import { Ring, SAMPLE_RATE } from './ring.ts';

const KEEP_SECONDS = 60;
// The worklet's block, and Silero's frame, is 512 samples: 32 ms at 16 kHz.
const FIRST_SECOND_BLOCKS = Math.ceil(SAMPLE_RATE / 512);
// A block of exact zeros reads -120 dB. A single least-significant bit already reads about -90.
const SILENT_DB = -110;

export type Graph = { ctx: AudioContext; bus: MediaStreamAudioDestinationNode };
let graph: Promise<Graph> | null = null;

// One 16 kHz context for the life of the page. Chromium resamples the device to it, and whisper wants 16 kHz.
export function audioGraph(): Promise<Graph> {
  graph ??= (async () => {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
      await ctx.audioWorklet.addModule(`${VOICE_ORIGIN}/pcm-worklet.js`);
    } catch (err) {
      graph = null;
      void ctx.close();
      throw err;
    }
    return { ctx, bus: ctx.createMediaStreamDestination() };
  })();
  return graph;
}

let level = 0;
// 0 to 1 for the HUD meter: -60 dB is empty, -10 dB is full. Read on a timer, so nothing re-renders 31 times a second.
export const micLevel = () => level;

export type Capture = { ring: Ring; close(): void };
export type CaptureEvents = {
  // `silent` is a full second of exact zeros from the start. `live` is the first real sample, and can follow a `silent`.
  liveness(state: 'live' | 'silent'): void;
};

// Opens the microphone into a fresh ring. The stream feeds the worklet tap and the bus that the voice detector reads.
export async function openCapture(events: CaptureEvents): Promise<Capture> {
  // All three processors are off, as in R4's tests. Echo cancellation has no far end to work from here, and it can also
  // swallow the owner's voice while an employee talks.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  try {
    const { ctx, bus } = await audioGraph();
    await ctx.resume();
    const ring = new Ring(KEEP_SECONDS);
    const tap = new AudioWorkletNode(ctx, 'pcm', { numberOfInputs: 1, numberOfOutputs: 0 });
    let blocks = 0;
    let sound = false;
    tap.port.onmessage = ({ data }: MessageEvent<{ pcm: Int16Array; rmsDb: number }>) => {
      ring.push(data.pcm);
      const now = Math.min(1, Math.max(0, (data.rmsDb + 60) / 50));
      level = Math.max(now, level * 0.85);
      blocks++;
      if (data.rmsDb > SILENT_DB) {
        if (!sound) events.liveness('live');
        sound = true;
      } else if (!sound && blocks === FIRST_SECOND_BLOCKS) events.liveness('silent');
    };
    const source = ctx.createMediaStreamSource(stream);
    source.connect(tap);
    source.connect(bus);
    return {
      ring,
      close() {
        tap.port.onmessage = null;
        source.disconnect();
        tap.disconnect();
        for (const track of stream.getTracks()) track.stop();
        level = 0;
        void ctx.suspend();
      },
    };
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    throw err;
  }
}
