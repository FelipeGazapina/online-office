// Ranks the biggest owners of the app's memory in an e2e-ram result.json, from the breakdown taken at about 90% of the run. An owner is a
// leaf that no other row contains: a memory region category of the main, renderer or GPU process (the `footprint` tool's own
// categories, dirty MiB, which add up to the process's footprint), or a whole process that has no regions listed (whisper-server, the
// acknowledgers, the other helpers). Notes put the page's own numbers beside the regions they should explain.
//   node verify/ram-owners.mjs <run/result.json> [count]
import { readFileSync } from 'node:fs';

const [, , file, count = '10'] = process.argv;
if (!file) throw new Error('usage: node verify/ram-owners.mjs <run/result.json> [count]');
const r = JSON.parse(readFileSync(file, 'utf8'));
const b = r.breakdown;
const g = b.renderer.graphics;
const heap = r.heap?.renderer?.top ?? [];
const heapOf = (name) => heap.find((c) => c.constructor === name)?.retainedMiB ?? 0;
const r1 = (n) => +n.toFixed(1);

const notes = {
  gpu: {
    'IOAccelerator (graphics)': `GPU-side buffers. three.js estimate: textures ${g.textures.uploadedMiB} + render targets ${g.renderTargets.totalMiB} + drawing buffer ${g.canvas.drawingBuffer.MiBEstimate} MiB (${g.canvas.drawingBuffer.width}x${g.canvas.drawingBuffer.height}, pixel ratio ${g.canvas.drawingBuffer.rendererPixelRatio}, antialias ${g.canvas.drawingBuffer.antialias})`,
    IOSurface: 'surfaces the compositor shares with the renderer and the browser (the canvas, the page)',
    'Owned physical footprint (unmapped) (graphics)': 'graphics memory this process owns that is mapped in another process',
  },
  renderer: {
    'app-specific tag 16': `native heap. JS heap used ${b.renderer.jsHeapUsedMiB} / total ${b.renderer.jsHeapTotalMiB} MiB, embedder ${b.renderer.embedderHeapUsedMiB}, ArrayBuffer data ${heapOf('system / JSArrayBufferData')}, SharedArrayBuffer ${heapOf('SharedArrayBuffer')}, wasm ${heapOf('system / Managed (WasmNativeModuleTag)')} MiB (heap snapshot)`,
    'app-specific tag 14': `native allocations. Decoded texture images are about ${r1((g.textures.totalMiB * 3) / 4)} MiB of it (${g.counts.textureSources} sources, ${g.three.textures} textures)`,
  },
};

const owners = [];
for (const [proc, list] of [['main', [b.regions.main]], ['renderer', b.regions.renderer], ['gpu', b.regions.gpu]]) {
  for (const p of list) {
    for (const c of p.top ?? []) owners.push({ owner: `${proc}: ${c.name}`, MiB: c.dirtyMiB, swappedMiB: c.swappedMiB, note: notes[proc]?.[c.name] ?? '' });
  }
}
const covered = new Set(['main', 'renderer', 'gpu']);
const byPid = new Map();
for (const p of b.processes) {
  if (covered.has(p.cls) || p.cls === 'agents') continue;
  const key = p.cls === 'ackers' ? 'ackers' : p.cls === 'other' && /whisper-server/.test(p.command) ? 'whisper-server' : `${p.cls}: ${p.command.split(' ')[0].split('/').pop()}`;
  const row = byPid.get(key) ?? { owner: key, MiB: 0, n: 0 };
  row.MiB += p.mib;
  row.n++;
  byPid.set(key, row);
}
for (const row of byPid.values()) owners.push({ owner: `${row.owner}${row.n > 1 ? ` (${row.n} processes)` : ''}`, MiB: r1(row.MiB), note: row.owner === 'whisper-server' ? 'the voice model, resident' : row.owner === 'ackers' ? "the Acknowledger's spare claude processes (ack and triage)" : '' });

owners.sort((a, c) => c.MiB - a.MiB);
const total = r1(owners.reduce((s, o) => s + o.MiB, 0));
console.log(`breakdown at ${b.at}; owners listed add up to ${total} MiB of the app (agents are not in it)`);
owners.slice(0, Number(count)).forEach((o, i) => console.log(`${String(i + 1).padStart(2)}. ${String(o.MiB).padStart(7)} MiB  ${o.owner}${o.swappedMiB ? ` (+${o.swappedMiB} swapped)` : ''}${o.note ? `\n              ${o.note}` : ''}`));
