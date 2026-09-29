// Runs on the audio thread, so it ships as text through the office-voice protocol and not through the bundler.
// It repacks the 128-frame render quanta into 512-sample blocks (32 ms at 16 kHz, which is also Silero's frame size),
// converts them to Int16 and posts each block with its level. An exact-zero block reads -120 dB.
export const PCM_WORKLET_SOURCE = `
class Pcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n < 512) continue;
      const pcm = new Int16Array(512);
      let sq = 0;
      for (let k = 0; k < 512; k++) {
        const v = Math.max(-1, Math.min(1, this.buf[k]));
        pcm[k] = v < 0 ? v * 0x8000 : v * 0x7fff;
        sq += v * v;
      }
      this.port.postMessage({ pcm, rmsDb: 10 * Math.log10(sq / 512 + 1e-12) }, [pcm.buffer]);
      this.n = 0;
    }
    return true;
  }
}
registerProcessor('pcm', Pcm);
`;
