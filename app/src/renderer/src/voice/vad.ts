import { MicVAD } from '@ricky0123/vad-web';
import { VOICE_ORIGIN } from '../../../shared/voice.ts';
import { audioGraph } from './mic.ts';

export type Vad = { listen(on: boolean): void };
export type VadEvents = { speechStart(): void; speechEnd(pcm: Int16Array): void; misfire(): void };

const toInt16 = (samples: Float32Array) => Int16Array.from(samples, (v) => (v < 0 ? v * 0x8000 : v * 0x7fff));

// Silero through vad-web. It listens to the bus and not to the microphone, so it never holds a stream that has ended,
// and "listening" is only a matter of whether it is started.
export async function createVad(events: VadEvents): Promise<Vad> {
  const { ctx, bus } = await audioGraph();
  const vad = await MicVAD.new({
    model: 'v5',
    audioContext: ctx,
    getStream: async () => bus.stream,
    pauseStream: async () => {},
    resumeStream: async () => bus.stream,
    baseAssetPath: `${VOICE_ORIGIN}/`,
    onnxWASMBasePath: `${VOICE_ORIGIN}/`,
    // One thread needs no cross-origin isolation.
    ortConfig: (ort) => {
      ort.env.wasm.numThreads = 1;
    },
    startOnLoad: false,
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    redemptionMs: 600,
    preSpeechPadMs: 300,
    minSpeechMs: 250,
    onSpeechStart: events.speechStart,
    onSpeechEnd: (samples) => events.speechEnd(toInt16(samples)),
    onVADMisfire: events.misfire,
  });

  // start() and pause() are slow, and calling one while the other runs is ignored. So the caller states what it wants,
  // and one loop makes it so.
  let wanted = false;
  let running = false;
  let syncing = false;
  const sync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      while (running !== wanted) {
        running = wanted;
        await (wanted ? vad.start() : vad.pause());
      }
    } catch (err) {
      running = false;
      console.error('voice detector', err);
    } finally {
      syncing = false;
    }
  };
  return {
    listen(on) {
      wanted = on;
      void sync();
    },
  };
}
