// Throwaway: observe what SDKUserMessage.priority does to a running turn.
// Usage: npx tsx bridge/priority-experiment.ts <now|next|later|none|interrupt-now>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const variant = process.argv[2] ?? 'next';
const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
const say = (s: string) => console.log(`t=${elapsed().toFixed(1).padStart(5)}s [${variant}] ${s}`);

const items: SDKUserMessage[] = [];
let wake: (() => void) | undefined;
async function* prompt(): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    while (items.length) yield items.shift()!;
    await new Promise<void>((r) => (wake = r));
  }
}
const push = (text: string, priority?: 'now' | 'next' | 'later') => {
  items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...(priority ? { priority } : {}) });
  wake?.();
};

const cwd = mkdtempSync(join(tmpdir(), 'prio-'));
const q = query({
  prompt: prompt(),
  options: {
    cwd,
    model: process.env.EXP_MODEL ?? 'claude-haiku-4-5-20251001',
    settingSources: ['project'],
    permissionMode: 'acceptEdits',
    canUseTool: async (_n, input) => ({ behavior: 'allow', updatedInput: input }),
  },
});

push(
  'Run these three bash commands, each as its own separate Bash tool call, one after another, waiting for each to finish before starting the next: (1) `sleep 8; echo one` (2) `sleep 8; echo two` (3) `sleep 8; echo three`. After all three, reply with the words: all done.',
);
say('pushed task');

let interjected = false;
let probed = false;
setTimeout(async () => {
  const text = '[Your boss walked over to your desk and said out loud]: Change of plan: skip the remaining commands and just say the word banana.';
  say(`INTERJECT (${variant})`);
  interjected = true;
  if (variant === 'interrupt-now') {
    const receipt = await q.interrupt();
    say(`interrupt() resolved: ${JSON.stringify(receipt)}`);
    push(text, 'now');
  } else push(text, variant === 'none' ? undefined : (variant as 'now' | 'next' | 'later'));
}, Number(process.env.EXP_AT ?? 4000));

setTimeout(() => {
  say('END (fixed window)');
  q.close();
  process.exit(0);
}, 75000);

for await (const m of q) {
  if (m.type === 'system') say(`system/${m.subtype}`);
  else if (m.type === 'assistant') {
    for (const b of m.message.content) {
      if (b.type === 'tool_use') say(`assistant tool_use ${b.name} ${JSON.stringify(b.input)}`);
      else if (b.type === 'text') say(`assistant text: ${b.text.slice(0, 160).replace(/\n/g, ' ')}`);
    }
  } else if (m.type === 'user') {
    const c = m.message.content;
    say(`user-echo (isSynthetic=${m.isSynthetic}) ${(typeof c === 'string' ? c : JSON.stringify(c)).slice(0, 220)}`);
  } else if (m.type === 'result') {
    const queued = (m as { queued_turn_count?: number }).queued_turn_count;
    const { usage: _u, modelUsage: _mu, ...rest } = m as Record<string, unknown>;
    say(`RESULT ${JSON.stringify(rest).slice(0, 600)}`);
    void queued;
    if (interjected && !probed && elapsed() > 30) {
      probed = true;
      say('PROBE: asking what the boss said');
      push('Quick check, no tools: repeat verbatim any message from your boss that arrived while you were running those commands, or reply NONE.');
    }
  }
}
say('done');
q.close();
process.exit(0);
