export const SAMPLE_RATE = 16_000;

// The last few seconds the microphone heard. Positions are absolute sample counts since the ring was made, so "from the
// key press until now" is two numbers that stay valid while the buffer wraps.
export class Ring {
  readonly #samples: Int16Array;
  #written = 0;

  constructor(seconds: number) {
    this.#samples = new Int16Array(seconds * SAMPLE_RATE);
  }

  get written() {
    return this.#written;
  }

  push(block: Int16Array) {
    for (let i = 0; i < block.length; i++) this.#samples[(this.#written + i) % this.#samples.length] = block[i];
    this.#written += block.length;
  }

  // Clamped to what the ring still holds.
  slice(from: number, to: number): Int16Array {
    const start = Math.max(from, this.#written - this.#samples.length, 0);
    const end = Math.min(to, this.#written);
    const out = new Int16Array(Math.max(0, end - start));
    for (let i = 0; i < out.length; i++) out[i] = this.#samples[(start + i) % this.#samples.length];
    return out;
  }
}
