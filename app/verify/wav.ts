import { readFileSync, writeFileSync } from 'node:fs';

// Walks the RIFF chunks instead of assuming a 44-byte header, because macOS `say` writes a FLLR filler chunk before the samples.
export function readWav(path: string): Int16Array {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path} is not a WAV file`);
  let format = '';
  for (let at = 12; at + 8 <= b.length; ) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') format = `${b.readUInt16LE(at + 8)}/${b.readUInt16LE(at + 10)}/${b.readUInt32LE(at + 12)}/${b.readUInt16LE(at + 22)}`;
    if (id === 'data') {
      if (format !== '1/1/16000/16') throw new Error(`${path} must be 16 kHz mono 16-bit PCM, got tag/channels/rate/bits ${format}`);
      const pcm = new Int16Array(size / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = b.readInt16LE(at + 8 + i * 2);
      return pcm;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no data chunk`);
}

export function writeWav(path: string, pcm: Int16Array) {
  const wav = Buffer.alloc(44 + pcm.length * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) wav.writeInt16LE(pcm[i]!, 44 + i * 2);
  writeFileSync(path, wav);
}

// The Int16 samples as the bytes that cross the IPC boundary.
export const bytesOf = (pcm: Int16Array) => new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
