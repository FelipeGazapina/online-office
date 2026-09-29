// A stand-in bridge on port 4801 that speaks shared/protocol.ts, so the real WebSocket client path
// (parse, reconnect with backoff, outgoing messages) can be exercised without touching the real bridge.
import { WebSocketServer } from 'ws';

export function company(now = Date.now()) {
  return {
    name: 'Mock Co',
    level: 2,
    xp: 44,
    blocks: [
      { id: 'b1', name: 'Mock A', cwd: '/tmp/mock-a', color: '#4fb286', slot: 0, whiteboard: { title: 'Broken diagram', mermaid: 'flowchart LR\n A --> \n [[[', by: 'e1', at: now } },
    ],
    employees: [
      { id: 'e1', name: 'Ada', provider: 'claude-code', blockId: 'b1', desk: 0, status: { kind: 'working', task: 'Refactor', startedAt: now }, activity: 'Reading files', hiredAt: now },
      { id: 'e2', name: 'Ben', provider: 'codex', blockId: 'b1', desk: 1, status: { kind: 'blocked_on_owner', task: 'Refactor', question: { id: 'q1', text: 'Use tabs or spaces?', options: ['Tabs', 'Spaces'], askedAt: now - 130_000 } }, activity: 'Waiting', hiredAt: now },
    ],
  };
}

export function startMock(port = 4801) {
  const received = [];
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', company: company() }));
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
  });
  return {
    received,
    wss,
    async stop() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(r));
    },
  };
}
