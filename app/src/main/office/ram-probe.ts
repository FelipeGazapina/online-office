// Test-only: what the main process holds, for the RAM harness (verify/e2e-ram.mjs). ipc.ts publishes `globalThis.__officeRam` when a
// test or debug run started the app; the harness reads it over the Node inspector (--inspect), so nothing here is reachable from the
// page and nothing runs unless it is asked for. Heap snapshots go through the same inspector (HeapProfiler).
//
// The structures are found by walking the Office object the way a person would browse it: every field, two levels of the objects
// inside the fields that hold state (the mailroom, the tasks), with a rough byte count per field (strings by length, numbers 8,
// every object and entry a small overhead). The count ranks the fields; the heap snapshot has the exact figures.
import { getHeapStatistics, getHeapSpaceStatistics } from 'node:v8';
import { app } from 'electron';

type Row = { path: string; kind: string; count: number | null; approxBytes: number };

const SKIP = new Set(['Timeout', 'Immediate', 'ChildProcess', 'Socket', 'Server', 'BrowserWindow', 'WebContents', 'EventEmitter', 'Promise', 'AbortController', 'ReadStream', 'WriteStream']);
const NODE_BUDGET = 3_000_000;

function sizeOf(root: unknown): { bytes: number; truncated: boolean } {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  let bytes = 0;
  let nodes = 0;
  while (stack.length) {
    const v = stack.pop();
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === 'string') bytes += (v as string).length + 16;
    else if (t === 'number' || t === 'bigint') bytes += 8;
    else if (t === 'boolean') bytes += 4;
    else if (t === 'object') {
      const o = v as object;
      if (seen.has(o)) continue;
      seen.add(o);
      if (++nodes > NODE_BUDGET) return { bytes, truncated: true };
      const name = o.constructor?.name ?? '';
      if (SKIP.has(name)) continue;
      if (ArrayBuffer.isView(o)) bytes += o.byteLength;
      else if (o instanceof ArrayBuffer) bytes += o.byteLength;
      else if (o instanceof Map) {
        bytes += 48 + o.size * 24;
        for (const [k, x] of o) stack.push(k, x);
      } else if (o instanceof Set) {
        bytes += 48 + o.size * 16;
        for (const x of o) stack.push(x);
      } else if (Array.isArray(o)) {
        bytes += 16 + o.length * 8;
        for (const x of o) stack.push(x);
      } else {
        const keys = Object.keys(o);
        bytes += 24 + keys.length * 8;
        for (const k of keys) stack.push((o as Record<string, unknown>)[k]);
      }
    }
  }
  return { bytes, truncated: false };
}

const kindOf = (v: unknown) => (v instanceof Map ? 'Map' : v instanceof Set ? 'Set' : Array.isArray(v) ? 'Array' : v === null ? 'null' : typeof v === 'object' ? (v as object).constructor?.name || 'Object' : typeof v);
const countOf = (v: unknown) => (v instanceof Map || v instanceof Set ? v.size : Array.isArray(v) ? v.length : typeof v === 'string' ? v.length : null);

// Fields of `owner`, each as a row. A field that is a plain holder of state (not a collection) is opened two levels when `open` is set.
function rowsOf(prefix: string, owner: object, open: boolean, depth = 0): Row[] {
  const rows: Row[] = [];
  for (const [key, value] of Object.entries(owner)) {
    if (typeof value === 'function') continue;
    const path = `${prefix}.${key}`;
    const isHolder = value !== null && typeof value === 'object' && !(value instanceof Map) && !(value instanceof Set) && !Array.isArray(value) && !SKIP.has(value.constructor?.name ?? '') && !ArrayBuffer.isView(value);
    if (open && isHolder && depth < 2) {
      rows.push(...rowsOf(path, value as object, true, depth + 1));
      continue;
    }
    const { bytes, truncated } = sizeOf(value);
    rows.push({ path, kind: kindOf(value) + (truncated ? ' (truncated)' : ''), count: countOf(value), approxBytes: bytes });
  }
  return rows;
}

export function ramProbe(roots: Record<string, object>) {
  const t0 = performance.now();
  const rows = Object.entries(roots).flatMap(([name, root]) => rowsOf(name, root, true));
  rows.sort((a, b) => b.approxBytes - a.approxBytes);
  const heap = getHeapStatistics();
  return {
    at: Date.now(),
    pid: process.pid,
    memoryUsage: process.memoryUsage(),
    heap: { totalMiB: heap.total_heap_size / 2 ** 20, usedMiB: heap.used_heap_size / 2 ** 20, mallocedMiB: heap.malloced_memory / 2 ** 20, externalMiB: heap.external_memory / 2 ** 20, limitMiB: heap.heap_size_limit / 2 ** 20 },
    heapSpaces: getHeapSpaceStatistics().map((s) => ({ space: s.space_name, usedMiB: +(s.space_used_size / 2 ** 20).toFixed(2), sizeMiB: +(s.space_size / 2 ** 20).toFixed(2) })),
    // The app's own per-process figures (working set; the harness reads phys_footprint from the OS).
    appMetrics: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? null, workingSetKiB: m.memory.workingSetSize, privateKiB: m.memory.privateBytes ?? null })),
    structures: rows.slice(0, 40),
    walkedMs: +(performance.now() - t0).toFixed(1),
  };
}
