// A Linear MCP server on a local port, so the office's own client can run against something with Linear's list_issues,
// list_users and list_cycles input schemas (assignee, cycle, state, limit up to 250, a cursor) without ever reaching the
// real one. The schemas follow what Linear's remote MCP advertises; the real server could not be read from here (it asks for
// the owner's login), so the first sync on the owner's machine is what confirms them.
// Stateless: each request gets its own server, which is all this client needs.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export type FakeStatus = { name: string; type: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' };
export type FakeUser = { id: string; name: string; email: string };
export type FakeCycle = { id: string; number: number; team: string; current: boolean };
export type FakeIssue = { id: string; identifier: string; title: string; team: string; status: FakeStatus; assignee?: string; cycle?: string; updatedAt: number };

export const TEAM = 'BLOOM';
export const TOKEN = 'fake-linear-token';
export const ME: FakeUser = { id: 'u-me', name: 'Felipe', email: 'felipe@example.com' };

export const STATUSES: FakeStatus[] = [
  { name: 'Backlog', type: 'backlog' },
  { name: 'Todo', type: 'unstarted' },
  { name: 'In Progress', type: 'started' },
  { name: 'In Review', type: 'started' },
  { name: 'Done', type: 'completed' },
  { name: 'Canceled', type: 'canceled' },
  { name: 'Duplicate', type: 'canceled' },
];

// 300 issues over seven statuses, six people, two cycles and issues in no cycle. Issue 0 is the most recently updated. The
// mix is a fixed function of the index, so a check can say what any filter must return.
export function linearWorld(count = 300, people = 70) {
  const users: FakeUser[] = [ME, ...Array.from({ length: people - 1 }, (_, i) => ({ id: `u-${i + 1}`, name: `Person ${String(i + 1).padStart(2, '0')}`, email: `p${i + 1}@example.com` }))];
  users[1] = { id: 'u-ana', name: 'Ana', email: 'ana@example.com' };
  const cycles: FakeCycle[] = [
    { id: 'cy-6', number: 6, team: TEAM, current: false },
    { id: 'cy-7', number: 7, team: TEAM, current: true },
  ];
  const assignees = [ME.id, 'u-ana', 'u-2', 'u-3', 'u-4', undefined];
  const issues: FakeIssue[] = Array.from({ length: count }, (_, i) => ({
    id: `iss-${String(i).padStart(3, '0')}`,
    identifier: `${TEAM}-${1000 + i}`,
    title: `Issue ${i}`,
    team: TEAM,
    status: STATUSES[(i * 5 + (i >> 3)) % STATUSES.length]!,
    assignee: assignees[(i * 7 + (i >> 2)) % assignees.length],
    cycle: [undefined, 'cy-7', 'cy-6', 'cy-7'][(i * 3 + (i >> 4)) % 4],
    updatedAt: 1_760_000_000_000 - i * 60_000,
  }));
  return { issues, users, cycles };
}

export type FakeLinearOptions = ReturnType<typeof linearWorld> & {
  // The largest limit list_issues takes. Linear's is 250.
  maxLimit?: number;
  // `cursor` is Linear's newer paging: the page says where the next one starts. `after` is its older one: the next page
  // starts after an issue id, and the page says nothing.
  paging?: 'cursor' | 'after';
  // Whether list_issues takes the word "current" for a cycle. The real one is only known to take a name, number or id.
  acceptsCurrent?: boolean;
  // Leaves a filter out of list_issues' schema, as an older server might.
  without?: ('assignee' | 'cycle')[];
};

type Args = Record<string, unknown>;
const bad = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });
const good = (body: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] });

export async function startFakeLinear(o: FakeLinearOptions) {
  const maxLimit = o.maxLimit ?? 250;
  const paging = o.paging ?? 'cursor';
  const calls: { tool: string; args: Args }[] = [];
  const auth: (string | undefined)[] = [];
  const userOf = (who: string): FakeUser | undefined => (who === 'me' ? ME : o.users.find((u) => [u.id, u.name, u.email].includes(who)));

  const build = () => {
    const server = new McpServer({ name: 'fake-linear', version: '0.0.0' });
    const filters = {
      query: z.string().optional().describe('Search for content in the issue title or description'),
      team: z.string().optional().describe('The team name or ID to filter by'),
      project: z.string().optional().describe('The project name or ID to filter by'),
      state: z.string().optional().describe('The state name or ID to filter by'),
      label: z.string().optional().describe('A label name or ID to filter by'),
      orderBy: z.enum(['createdAt', 'updatedAt']).optional().describe('The order in which to return results'),
      limit: z.number().int().min(1).max(maxLimit).optional().describe(`The number of results to return (Max is ${maxLimit})`),
      [paging === 'cursor' ? 'cursor' : 'after']: z.string().optional().describe(paging === 'cursor' ? 'The cursor to start from' : 'An ID to start from'),
      ...(o.without?.includes('assignee') ? {} : { assignee: z.string().optional().describe('The assignee name or ID to filter by, or "me"') }),
      ...(o.without?.includes('cycle') ? {} : { cycle: z.string().optional().describe('The cycle name, number or ID to filter by') }),
    };
    server.registerTool('list_issues', { description: 'List issues in the user\'s Linear workspace.', inputSchema: filters }, async (args: Args) => {
      calls.push({ tool: 'list_issues', args });
      let rows = [...o.issues].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
      if (typeof args.team === 'string') {
        if (args.team !== TEAM) return bad(`Team not found: ${args.team}`);
        rows = rows.filter((r) => r.team === TEAM);
      }
      if (typeof args.assignee === 'string') {
        const who = userOf(args.assignee);
        if (!who) return bad(`User not found: ${args.assignee}`);
        rows = rows.filter((r) => r.assignee === who.id);
      }
      if (typeof args.cycle === 'string') {
        const cycle = o.cycles.find((c) => [c.id, String(c.number)].includes(args.cycle as string)) ?? (o.acceptsCurrent && args.cycle === 'current' ? o.cycles.find((c) => c.current) : undefined);
        if (!cycle) return bad(`Cycle not found: ${args.cycle}`);
        rows = rows.filter((r) => r.cycle === cycle.id);
      }
      if (typeof args.state === 'string') {
        const want = args.state;
        rows = rows.filter((r) => r.status.name === want || r.status.type === want);
      }
      const size = Number(args.limit ?? 50);
      let start = 0;
      if (typeof args.cursor === 'string') start = Number(args.cursor.replace(/^c:/, ''));
      if (typeof args.after === 'string') start = rows.findIndex((r) => r.id === args.after) + 1;
      const page = rows.slice(start, start + size);
      const more = start + size < rows.length;
      const body = {
        issues: page.map((r) => ({
          id: r.id,
          identifier: r.identifier,
          title: r.title,
          status: r.status.name,
          assignee: r.assignee ? o.users.find((u) => u.id === r.assignee)?.name : null,
          cycle: r.cycle ? { id: r.cycle, number: o.cycles.find((c) => c.id === r.cycle)?.number } : null,
          url: `https://linear.example/issue/${r.identifier}`,
          updatedAt: new Date(r.updatedAt).toISOString(),
        })),
        hasNextPage: more,
        ...(paging === 'cursor' && more ? { cursor: `c:${start + size}` } : {}),
      };
      return good(body);
    });
    server.registerTool(
      'list_users',
      { description: 'Retrieve users in the Linear workspace.', inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(maxLimit).optional(), cursor: z.string().optional() } },
      async (args: Args) => {
        calls.push({ tool: 'list_users', args });
        const rows = o.users.filter((u) => !args.query || u.name.toLowerCase().includes(String(args.query).toLowerCase()));
        const size = Number(args.limit ?? 50);
        const start = typeof args.cursor === 'string' ? Number(args.cursor.replace(/^c:/, '')) : 0;
        const more = start + size < rows.length;
        return good({ users: rows.slice(start, start + size).map((u) => ({ ...u, active: true })), hasNextPage: more, ...(more ? { cursor: `c:${start + size}` } : {}) });
      },
    );
    server.registerTool(
      'list_cycles',
      { description: 'Retrieve cycles in the Linear workspace for a specific team.', inputSchema: { teamId: z.string().describe('The team ID'), type: z.enum(['current', 'previous', 'next']).optional() } },
      async (args: Args) => {
        calls.push({ tool: 'list_cycles', args });
        if (args.teamId !== TEAM) return bad(`Team not found: ${args.teamId}`);
        const rows = o.cycles.filter((c) => args.type !== 'current' || c.current);
        return good({ cycles: rows.map((c) => ({ id: c.id, number: c.number, name: `Cycle ${c.number}` })) });
      },
    );
    return server;
  };

  const http = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    auth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
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
  return { url: `http://127.0.0.1:${port}/mcp`, calls, auth, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}
