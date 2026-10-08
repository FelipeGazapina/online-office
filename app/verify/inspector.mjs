// A small DevTools-protocol client for a target of the running app: its main process over the Node inspector (--inspect), or the
// renderer page as a second session beside the driver's. Used by the RAM scenario for heap usage, heap snapshots and the probes in main.
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

export async function targets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`could not connect to ${wsUrl}`));
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) for (const fn of listeners.get(m.method) ?? []) fn(m.params);
  };
  ws.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error('the inspector connection closed'));
    pending.clear();
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error('the inspector connection is closed'));
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  return {
    call,
    on,
    close: () => ws.close(),
    // Evaluates in the target's global scope and returns the value (JSON-serializable results only).
    async eval(expression) {
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120_000 });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    // A heap snapshot of the target, streamed to `file`.
    async heapSnapshot(file) {
      const out = createWriteStream(file);
      on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => out.write(chunk));
      await call('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      out.end();
      await finished(out);
    },
  };
}
