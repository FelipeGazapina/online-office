// A CronoSpark MCP server on a local port, so a check can run the office's own client against something that answers like
// the real one without ever reaching it. It lists the tasks it was given and records every registrar_horas call.
// Stateless: each request gets its own server, which is all this client needs.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export type FakeTask = { _id: string; code: string; title: string; status: string; priority?: number; url?: string };
export type HoursRecord = { taskId: string; hours: number; date: string; description?: string };

export async function startFakeCronoSpark(a: { tasks: FakeTask[] }) {
  const calls: HoursRecord[] = [];
  const headers: { authorization?: string; user?: string }[] = [];
  const build = () => {
    const server = new McpServer({ name: 'fake-cronospark', version: '0.0.0' });
    server.registerTool(
      'listar_tasks_projeto',
      { description: 'Lista todas as tasks de um projeto.', inputSchema: { projectId: z.string().min(1), limit: z.number().int().optional(), status: z.string().optional() } },
      async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { tasks: a.tasks } }) }] }),
    );
    // The schema is the real tool's: hours above 0 up to 24, a YYYY-MM-DD date, a task id.
    server.registerTool(
      'registrar_horas',
      { description: 'Registra horas trabalhadas manualmente em uma task.', inputSchema: { taskId: z.string().min(1), hours: z.number().gt(0).max(24), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), description: z.string().optional() } },
      async (args) => {
        calls.push(args);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      },
    );
    return server;
  };
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    headers.push({ authorization: req.headers.authorization, user: req.headers['x-mcp-user-id'] as string | undefined });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, calls, headers, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}
