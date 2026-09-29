// Throwaway end to end check against a running bridge.
//   OFFICE_START_LEVEL=3 OFFICE_CLAUDE_MODEL=claude-haiku-4-5-20251001 pnpm bridge
//   npx tsx bridge/smoke.ts [basic|bash|bash-deny|diagram|now|next-long|blocked-interject|resume]
// It fires everyone already in the company first (except in `resume`), then hires one claude-code and one
// codex (simulated) employee, drives them, and exits when both are idle again.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  BRIDGE_PORT,
  type ClientMessage,
  type Company,
  type Employee,
  type InterruptStyle,
  type Question,
  type ServerMessage,
} from '../shared/protocol.ts';

type Scenario = {
  task: string;
  answer: (q: Question) => string;
  answerAs?: 'answer' | 'interject';
  interject?: { text: string; style: InterruptStyle; whenActivity: RegExp; afterMs: number };
  reuseClaude?: boolean;
};

// Claude Code moves long foreground commands to the background, so use several short ones.
const LONG_TASK =
  'Run these three commands, each as its own separate Bash tool call, one after another, waiting for each before the next: `sleep 8; echo one`, then `sleep 8; echo two`, then `sleep 8; echo three`. After all three say: all done.';

const SCENARIOS: Record<string, Scenario> = {
  basic: {
    task: "Create hello.txt containing 'hi'. Then use ask_owner to ask me whether to also add a README, with options Yes and No.",
    answer: () => 'Yes',
    interject: { text: 'By the way, keep it short and sweet.', style: 'next', whenActivity: /./, afterMs: 2500 },
  },
  bash: {
    task: 'Use the Bash tool to run `python3 -c "print(6*7)"` and tell me the number it printed.',
    answer: () => 'Yes',
  },
  'bash-deny': {
    task: 'Use the Bash tool to run `python3 -c "print(1+1)"` and tell me the number. If you are not allowed to run it, say so.',
    answer: () => 'No, do not run commands',
  },
  diagram: {
    task: 'Draw a 4-step login flow on the whiteboard with draw_diagram, then say one sentence about it.',
    answer: () => 'Yes',
  },
  now: {
    task: LONG_TASK,
    answer: () => 'Yes',
    interject: { text: 'Stop that and just say the word banana.', style: 'now', whenActivity: /^Running sleep/, afterMs: 5000 },
  },
  'next-long': {
    task: LONG_TASK,
    answer: () => 'Yes',
    interject: { text: 'Stop that and just say the word banana.', style: 'next', whenActivity: /^Running sleep/, afterMs: 5000 },
  },
  'blocked-interject': {
    task: 'Use ask_owner to ask me which color to use, options Red and Blue, then write it into color.txt.',
    answer: () => 'Blue, definitely',
    answerAs: 'interject',
  },
  resume: {
    task: 'What single word did your boss last tell you to say? Answer in one short sentence.',
    answer: () => 'Yes',
    reuseClaude: true,
  },
};

const scenarioName = process.argv[2] ?? 'basic';
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
  console.error(`Unknown scenario ${scenarioName}. Pick one of ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

const TIMEOUT_MS = 240_000;
const t0 = Date.now();
const out = (s: string) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s ${s}`);

const ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}`);
const send = (m: ClientMessage) => ws.send(JSON.stringify(m));

let company: Company | undefined;
let phase: 'clear' | 'hiring' | 'running' = 'clear';
const ids = { claude: '', codex: '' };
const sequence: Record<string, string[]> = {};
const lastLine = new Map<string, string>();
const answered = new Set<string>();
const seenWorking = new Set<string>();
let assignedAt = 0;
let matchedAt = 0;
let interjectedAt = 0;

const describe = (e: Employee) => {
  const s = e.status;
  const kind =
    s.kind === 'blocked_on_owner'
      ? `blocked_on_owner "${s.question.text}" ${JSON.stringify(s.question.options ?? [])}`
      : s.kind === 'error'
        ? `error (${s.message})`
        : s.kind;
  return `${kind} | ${e.activity}`;
};

const finish = (code: number) => {
  if (company) {
    out(`company: level ${company.level}, xp ${company.xp}`);
    for (const b of company.blocks) {
      if (b.whiteboard) out(`whiteboard [${b.name}] "${b.whiteboard.title}":\n${b.whiteboard.mermaid}`);
    }
    for (const e of company.employees) out(`status sequence ${e.name} (${e.provider}): ${(sequence[e.name] ?? []).join(' -> ')}`);
    const claude = company.employees.find((e) => e.id === ids.claude);
    out(`claude sessionId: ${claude?.sessionId}`);
    const block = claude && company.blocks.find((b) => b.id === claude.blockId);
    if (block && existsSync(block.cwd)) {
      out(`workspace ${block.cwd}: ${readdirSync(block.cwd).join(', ') || '(empty)'}`);
      for (const f of readdirSync(block.cwd).filter((n) => n.endsWith('.txt'))) {
        out(`${f} = ${JSON.stringify(readFileSync(join(block.cwd, f), 'utf8'))}`);
      }
    }
  }
  ws.close();
  process.exit(code);
};
setTimeout(() => {
  out('TIMEOUT');
  finish(1);
}, TIMEOUT_MS);

function track(c: Company) {
  for (const e of c.employees) {
    const line = describe(e);
    if (lastLine.get(e.id) !== line) {
      lastLine.set(e.id, line);
      out(`[snapshot] ${e.name} (${e.provider}): ${line}`);
      const seq = (sequence[e.name] ??= []);
      if (seq.at(-1) !== e.status.kind) seq.push(e.status.kind);
    }
    if (e.status.kind === 'working') seenWorking.add(e.id);
  }
}

function onSnapshot(c: Company) {
  company = c;
  if (phase !== 'clear') track(c);
  if (phase === 'clear') {
    phase = 'hiring';
    if (scenario!.reuseClaude) {
      const claude = c.employees.find((e) => e.provider === 'claude-code');
      if (!claude) {
        out('resume needs an existing claude-code employee. Run `basic` first.');
        return finish(2);
      }
      ids.claude = claude.id;
      phase = 'running';
      assignedAt = Date.now();
      out(`reusing ${claude.name} (${describe(claude)}) with sessionId ${claude.sessionId}`);
      send({ type: 'assign', employeeId: claude.id, task: scenario!.task });
      return;
    }
    for (const e of c.employees) send({ type: 'fire', employeeId: e.id });
    const client = c.blocks.find((b) => b.name === 'Client Apps')!;
    const podium = c.blocks.find((b) => b.name === 'Podium')!;
    send({ type: 'hire', provider: 'claude-code', blockId: client.id });
    send({ type: 'hire', provider: 'codex', blockId: podium.id });
    return;
  }
  if (phase === 'hiring') {
    const claude = c.employees.find((e) => e.provider === 'claude-code');
    const codex = c.employees.find((e) => e.provider === 'codex');
    if (!claude || !codex) return;
    phase = 'running';
    ids.claude = claude.id;
    ids.codex = codex.id;
    assignedAt = Date.now();
    send({ type: 'assign', employeeId: claude.id, task: scenario!.task });
    send({ type: 'assign', employeeId: codex.id, task: 'Draft a launch checklist for the podium app' });
    return;
  }

  for (const e of c.employees) {
    if (e.status.kind === 'blocked_on_owner' && !answered.has(e.status.question.id)) {
      answered.add(e.status.question.id);
      const { question } = e.status;
      const text = scenario!.answer(question);
      if (scenario!.answerAs === 'interject') {
        out(`>>> INTERJECT-as-answer "${text}" to "${question.text}"`);
        send({ type: 'interject', employeeId: e.id, text, style: 'next' });
      } else {
        out(`>>> answering "${question.text}" with "${text}"`);
        send({ type: 'answer', employeeId: e.id, questionId: question.id, text });
      }
    }
  }

  const claude = c.employees.find((e) => e.id === ids.claude);
  const plan = scenario!.interject;
  if (claude && plan && !interjectedAt && claude.status.kind === 'working' && plan.whenActivity.test(claude.activity)) {
    matchedAt ||= Date.now();
    if (Date.now() - matchedAt >= plan.afterMs) {
      interjectedAt = Date.now();
      out(`>>> interject (${plan.style}) to claude: "${plan.text}"`);
      send({ type: 'interject', employeeId: claude.id, text: plan.text, style: plan.style });
    }
  }

  const watched = scenario!.reuseClaude ? [ids.claude] : [ids.claude, ids.codex];
  const done = watched.every((id) => seenWorking.has(id) && c.employees.find((e) => e.id === id)?.status.kind === 'idle');
  if (done) finish(0);
}

// The interject trigger also needs to fire when no snapshot arrives for a while (a quiet Bash).
setInterval(() => company && phase === 'running' && onSnapshot(company), 500);

ws.on('open', () => out(`connected, scenario=${scenarioName}`));
ws.on('message', (data) => {
  const m = JSON.parse(data.toString()) as ServerMessage;
  const name = (id: string) => company?.employees.find((e) => e.id === id)?.name ?? id.slice(0, 6);
  switch (m.type) {
    case 'snapshot':
      return onSnapshot(m.company);
    case 'said':
      return out(`[said] ${name(m.employeeId)}: ${m.text}`);
    case 'log':
      return out(`[log] ${name(m.employeeId)}: ${m.line}`);
    case 'error':
      return out(`[error] ${m.message}`);
  }
});
ws.on('error', (e) => {
  console.error('ws error (is the bridge running?)', e.message);
  process.exit(1);
});
