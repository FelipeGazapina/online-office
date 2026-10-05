// What does Claude Code do to a long MCP tool call over HTTP? Runs one real Claude session (Haiku) against the
// office MCP server, whose ask_owner answers after a delay, and prints what the model got back and when Claude gave up.
// Run from app/: node verify/claude-timeout-probe.ts <variant> <waitSeconds>
// The `server-timeout` variant is the option shape adapters/claude.ts ships. The others show why it needs to.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { BlockId, EmployeeId } from '../src/shared/protocol.ts';
import { Mailroom } from '../src/main/office/mail.ts';
import { mailTools } from '../src/main/office/mail-tools.ts';
import { startOfficeMcp } from '../src/main/office/mcp.ts';
import { MemoryStore } from '../src/main/office/memory.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const VARIANTS: Record<string, { server: Partial<McpHttpServerConfig>; env: Record<string, string> }> = {
  default: { server: {}, env: {} },
  'env-timeout': { server: {}, env: { MCP_TOOL_TIMEOUT: String(DAY_MS) } },
  'server-timeout': { server: { timeout: DAY_MS }, env: {} },
  // An owner whose shell exports CLAUDE_AUTO_BACKGROUND_TASKS would switch on Claude's 120 s auto-background for MCP calls.
  'auto-bg': { server: { timeout: DAY_MS }, env: { CLAUDE_AUTO_BACKGROUND_TASKS: '1' } },
  'auto-bg-pinned': { server: { timeout: DAY_MS }, env: { CLAUDE_AUTO_BACKGROUND_TASKS: '1', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' } },
};

const [variant = '', waitArg = ''] = process.argv.slice(2);
const chosen = VARIANTS[variant];
const waitSeconds = Number(waitArg);
if (!chosen || !Number.isFinite(waitSeconds) || waitSeconds <= 0) {
  console.error(`usage: node verify/claude-timeout-probe.ts <${Object.keys(VARIANTS).join('|')}> <waitSeconds>`);
  process.exit(2);
}

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (s: string) => console.log(`${at()} [${variant}] ${s}`);

const dir = mkdtempSync(join(tmpdir(), 'office-timeout-probe-'));
const employeeId = 'probe' as EmployeeId;
const mcp = await startOfficeMcp();
const url = mcp.attach(employeeId, {
  ask: async (body, signal) => {
    log(`office got the question "${body.text}", answering in ${waitSeconds}s`);
    const asked = Date.now();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitSeconds * 1000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        log(`office: Claude dropped the call after ${((Date.now() - asked) / 1000).toFixed(1)}s`);
        resolve();
      });
    });
    if (signal?.aborted) return '';
    log('office answers PINEAPPLE');
    return 'PINEAPPLE';
  },
  openBoard: async () => {},
  mail: mailTools(new Mailroom({ members: () => [], nameOf: () => '', deliver() {}, steer() {}, hire: () => ({ ok: false, reason: 'probe' }), persist() {}, changed() {}, stream() {}, now: Date.now, newId: () => '0' }), employeeId, () => '', false),
  drawDiagram: () => {},
  memory: MemoryStore.open(join(dir, 'memory')).notebook({ employeeId, blockId: 'probe-block' as BlockId, provider: 'claude-code' }),
});

const q = query({
  prompt:
    'Call the ask_owner tool once, with the question "Codeword?". When it returns, reply with exactly: GOT followed by the text it returned. If the call fails, reply with exactly: FAILED followed by the error text.',
  options: {
    cwd: dir,
    model: 'claude-haiku-4-5-20251001',
    settingSources: [],
    // A probe is not an employee: keep it out of ~/.claude/projects.
    persistSession: false,
    strictMcpConfig: true,
    tools: [],
    mcpServers: { office: { type: 'http', url, alwaysLoad: true, ...chosen.server } },
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...chosen.env },
  },
});

let toolResult = '(none)';
let final = '(none)';
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') log(`claude init, mcp=${m.mcp_servers.map((s) => `${s.name}:${s.status}`)}`);
  if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') log(`claude calls ${b.name}`);
  if (m.type === 'user' && Array.isArray(m.message.content)) {
    for (const b of m.message.content) {
      if (b.type === 'tool_result') {
        toolResult = (Array.isArray(b.content) ? b.content.map((c) => ('text' in c ? c.text : '')).join('') : String(b.content)).replace(/\s+/g, ' ');
        log(`tool_result${b.is_error ? ' (error)' : ''}: ${toolResult}`);
      }
    }
  }
  if (m.type === 'result') final = 'result' in m ? m.result.replace(/\s+/g, ' ') : m.subtype;
}
const answered = toolResult.includes('PINEAPPLE');
console.log(`${at()} RESULT variant=${variant} wait=${waitSeconds}s observed=${answered ? 'answer reached the model' : 'answer did NOT reach the model'} | tool_result=${JSON.stringify(toolResult)} | final=${JSON.stringify(final)}`);

q.close();
await mcp.close();
rmSync(dir, { recursive: true, force: true });
process.exit(answered ? 0 : 1);
