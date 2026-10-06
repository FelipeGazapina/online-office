// What the chat shows, derived from the mailroom's messages. Pure: no store, no React.
import type { Employee, EmployeeId } from '../../../../shared/protocol.ts';
import type { ActorId, ActorView, MailView, Message, MessageId, Outcome, RequestView, Verdict } from '../../../../shared/mail.ts';

export type Req = Extract<Message, { kind: 'request' }>;
export type Say = Extract<Message, { kind: 'say' }>;
export type Reply = Extract<Message, { kind: 'reply' }>;
export type Note = Extract<Message, { kind: 'event' }>;

// The state of a request, as the owner needs to read it.
export type ReqState =
  | { kind: 'queued'; ahead: number }
  | { kind: 'working' }
  | { kind: 'settled'; outcome: Outcome; auto: boolean }
  | { kind: 'unknown' };

export type Round = { n: number; verdict: Verdict | null };
export type Item =
  | { t: 'bubble'; m: Say | Req | Reply; side: 'owner' | 'them' }
  | { t: 'card'; m: Req }
  | { t: 'gauntlet'; m: Req; rounds: Round[]; maxRounds: number }
  | { t: 'note'; m: Note };

// Oldest first, one entry per id. The newest copy wins, so a history page never shadows live state.
export function mergeMessages(...lists: Message[][]): Message[] {
  const byId = new Map<MessageId, Message>();
  for (const list of lists) for (const m of list) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

const direct = (m: Message, who: EmployeeId) => (m.from === 'owner' && m.to === who) || (m.from === who && m.to === 'owner');

export function requestStates(view: MailView, messages: Message[]): Map<MessageId, ReqState> {
  const states = new Map<MessageId, ReqState>();
  for (const m of messages) {
    if (m.kind === 'reply') states.set(m.requestId, { kind: 'settled', outcome: m.outcome, auto: Boolean(m.auto) });
  }
  for (const r of view.open) states.set(r.id, openState(r));
  return states;
}

function openState(r: RequestView): ReqState {
  if (r.life.s === 'queued') return { kind: 'queued', ahead: r.ahead };
  if (r.life.s === 'settled') return { kind: 'settled', outcome: r.life.outcome, auto: false };
  return { kind: 'working' };
}

function rounds(messages: Message[], g: Req): Round[] {
  const children = messages.filter((m): m is Req => m.kind === 'request' && m.parentId === g.id);
  const verdicts = messages
    .filter((m): m is Reply => m.kind === 'reply' && Boolean(m.verdict))
    .filter((m) => children.some((c) => c.id === m.requestId && c.intent === 'review'));
  return children
    .filter((c) => c.intent === 'work')
    .map((_, i) => ({ n: i + 1, verdict: verdicts[i]?.verdict ?? null }));
}

function item(m: Message, messages: Message[], byId: Map<MessageId, Message>, side: (m: Message) => 'owner' | 'them'): Item | null {
  switch (m.kind) {
    case 'event':
      return { t: 'note', m };
    case 'request': {
      if (m.intent === 'gauntlet') return { t: 'gauntlet', m, rounds: rounds(messages, m), maxRounds: m.gauntlet?.maxRounds ?? 0 };
      const parent = m.parentId ? byId.get(m.parentId) : undefined;
      // The rounds of a gauntlet live inside its tracker.
      if (parent?.kind === 'request' && parent.intent === 'gauntlet') return null;
      return { t: 'card', m };
    }
    default:
      return { t: 'bubble', m, side: side(m) };
  }
}

// The thread with one person: what the owner and they said to each other, plus the work they handed on, as cards.
export function personThread(messages: Message[], who: EmployeeId): Item[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const inChain = (m: Message) => direct(byId.get(m.rootId) ?? m, who);
  const out: Item[] = [];
  for (const m of messages) {
    if (m.kind === 'event') {
      if (inChain(m) || m.subject === who) out.push({ t: 'note', m });
    } else if (direct(m, who)) {
      out.push({ t: 'bubble', m, side: m.from === 'owner' ? 'owner' : 'them' });
    } else if (m.kind === 'request' && m.from === who && m.to !== 'owner' && inChain(m)) {
      const it = item(m, messages, byId, () => 'them');
      if (it) out.push(it);
    }
  }
  return out;
}

// The chain under one request: what its assignee said, and what they handed on in turn.
export function chainThread(messages: Message[], rootId: MessageId): Item[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const inside = new Set<MessageId>([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of messages) {
      if (inside.has(m.id)) continue;
      if ((m.parentId && inside.has(m.parentId)) || (m.kind === 'reply' && inside.has(m.requestId))) {
        inside.add(m.id);
        grew = true;
      }
    }
  }
  const out: Item[] = [];
  for (const m of messages) {
    if (!inside.has(m.id)) continue;
    const it = m.id === rootId && m.kind === 'request' ? ({ t: 'bubble', m, side: 'them' } as Item) : item(m, messages, byId, (x) => (x.from === 'owner' ? 'owner' : 'them'));
    if (it) out.push(it);
  }
  return out;
}

export const textOf = (m: Message) => (m.kind === 'request' ? m.title || m.text : m.text);

export type Roster = { employee: Employee; last: Message | null };

// PO first, then by desk. Only people of one block: the block is the room the owner is standing in.
export function rosterOf(employees: Employee[], blockId: Employee['blockId'], messages: Message[]): Roster[] {
  const mine = employees.filter((e) => e.blockId === blockId).sort((a, b) => Number((b.role ?? 'employee') === 'orchestrator') - Number((a.role ?? 'employee') === 'orchestrator') || (a.seat ?? '').localeCompare(b.seat ?? ''));
  return mine.map((employee) => ({ employee, last: [...messages].reverse().find((m) => m.kind !== 'event' && (m.from === employee.id || m.to === employee.id)) ?? null }));
}

export const isPo = (e: Employee) => (e.role ?? 'employee') === 'orchestrator';

export type LiveState = { kind: 'typing' | 'waiting_you' | 'working' | 'waiting_team' | 'idle' | 'error'; text: string };
export function liveState(e: Employee, actor: ActorView | undefined, open: RequestView[], streaming: boolean): LiveState {
  if (streaming) return { kind: 'typing', text: 'typing…' };
  if (e.status.kind === 'blocked_on_owner') return { kind: 'waiting_you', text: 'waiting on you' };
  if (e.status.kind === 'error') return { kind: 'error', text: 'error' };
  if (actor?.state === 'awaiting') return { kind: 'waiting_team', text: 'waiting on a teammate' };
  if (actor?.state === 'running' || e.status.kind === 'working') {
    const title = open.find((r) => r.id === actor?.serving)?.title ?? (e.status.kind === 'working' ? e.status.task : '');
    return { kind: 'working', text: title ? `working on ${title}` : 'working' };
  }
  return { kind: 'idle', text: 'idle' };
}

export const nameOf = (employees: Employee[], who: ActorId) => (who === 'owner' ? 'You' : who === 'mailroom' ? 'Office' : employees.find((e) => e.id === who)?.name ?? 'Someone');

const PALETTE = ['#e07a5f', '#3d85c6', '#81b29a', '#c9a227', '#9b6bd1', '#d1608f', '#4aa3a2', '#8a7f5a'];
export function avatarColor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function clock(at: number, now = Date.now()) {
  const d = new Date(at);
  if (now - at < 20 * 3600_000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
