// The mailroom. The owner, the PO and the employees all talk through post(). A message to a busy actor queues and is
// delivered when the actor goes idle, a reply flows back to whoever asked, and a gauntlet runs builder and critic rounds
// as structure. Plain Node: verify/mail-check.ts imports it without Electron.
//
// All state is a fold of an append-only ledger (mail.jsonl), and every entry is idempotent under replay.
// Below the divider is the pure core. Mailroom, further down, is the shell that owns IO.
import { randomUUID } from 'node:crypto';
import type { BlockId, EmployeeId, EmployeeRole } from '../../shared/protocol.ts';
import {
  DEFAULT_GAUNTLET_ROUNDS,
  MAIL_TAIL,
  MAX_BATCH,
  MAX_HOPS,
  MAX_OPEN_OUTGOING,
  MAX_QUEUE_PER_ACTOR,
  type ActorId,
  type ActorView,
  type ConvoKey,
  type GauntletSpec,
  type Intent,
  type LedgerEntry,
  type Lifecycle,
  type MailView,
  type Message,
  type MessageId,
  type Outcome,
  type PostBody,
  type Posted,
  type RequestView,
  type TurnId,
  type Urgency,
  type Verdict,
} from '../../shared/mail.ts';

// ───────────────────────────── Pure core ─────────────────────────────

export type Turn = { id: TurnId; to: ActorId; ids: MessageId[]; ended: boolean };

export type MailState = {
  seq: number;
  messages: Map<MessageId, Message>;
  order: MessageId[];
  life: Map<MessageId, Lifecycle>;
  // Queued messages per actor, in delivery order.
  queue: Map<ActorId, MessageId[]>;
  // Requests nobody has settled yet.
  unsettled: Set<MessageId>;
  // parent request -> requests posted while serving it
  children: Map<MessageId, MessageId[]>;
  turns: Map<TurnId, Turn>;
  active: Map<ActorId, TurnId>;
  keys: Map<string, MessageId>;
};

export const emptyMail = (): MailState => ({
  seq: 0,
  messages: new Map(),
  order: [],
  life: new Map(),
  queue: new Map(),
  unsettled: new Set(),
  children: new Map(),
  turns: new Map(),
  active: new Map(),
  keys: new Map(),
});

// Employees have a mailbox. The owner reads the thread and the mailroom consumes replies on the spot.
const hasMailbox = (actor: ActorId) => actor !== 'owner' && actor !== 'mailroom';

const enqueue = (s: MailState, actor: ActorId, id: MessageId, front = false) => {
  const q = s.queue.get(actor) ?? [];
  if (front) q.unshift(id);
  else q.push(id);
  s.queue.set(actor, q);
};

const dequeue = (s: MailState, actor: ActorId, id: MessageId) => {
  const q = s.queue.get(actor);
  if (q) s.queue.set(actor, q.filter((x) => x !== id));
};

// Applies one entry. Mutates and returns `s`. Folding the same ledger twice gives the same state as folding it once.
export const fold = (s: MailState, entry: LedgerEntry): MailState => {
  s.seq++;
  switch (entry.t) {
    case 'post': {
      const m = entry.msg;
      if (s.messages.has(m.id)) return s;
      s.messages.set(m.id, m);
      s.order.push(m.id);
      if (m.key) s.keys.set(m.key, m.id);
      if (m.kind === 'request') {
        s.unsettled.add(m.id);
        if (m.parentId) s.children.set(m.parentId, [...(s.children.get(m.parentId) ?? []), m.id]);
        if (m.intent === 'gauntlet') s.life.set(m.id, { s: 'running' });
        else if (hasMailbox(m.to)) {
          s.life.set(m.id, { s: 'queued', redelivered: false });
          enqueue(s, m.to, m.id);
        }
      } else if (m.kind === 'say') {
        if (m.wake && hasMailbox(m.to)) {
          s.life.set(m.id, { s: 'queued', redelivered: false });
          enqueue(s, m.to, m.id);
        }
      } else if (m.kind === 'reply') {
        if (hasMailbox(m.to)) {
          s.life.set(m.id, { s: 'queued', redelivered: false });
          enqueue(s, m.to, m.id);
        }
        const asked = s.messages.get(m.requestId);
        if (asked && s.unsettled.delete(asked.id)) {
          if (hasMailbox(asked.to)) dequeue(s, asked.to, asked.id);
          s.life.set(asked.id, { s: 'settled', by: m.id, outcome: m.outcome });
        }
      }
      return s;
    }
    case 'deliver': {
      let t = s.turns.get(entry.turn);
      if (t?.ended) return s;
      if (!t) {
        t = { id: entry.turn, to: entry.to, ids: [], ended: false };
        s.turns.set(entry.turn, t);
        s.active.set(entry.to, entry.turn);
      }
      for (const id of entry.ids) {
        if (s.life.get(id)?.s !== 'queued') continue;
        dequeue(s, entry.to, id);
        s.life.set(id, { s: 'delivered', turn: entry.turn });
        t.ids.push(id);
      }
      return s;
    }
    case 'turn_end': {
      const t = s.turns.get(entry.turn);
      if (!t) return s;
      t.ended = true;
      if (s.active.get(t.to) === t.id) s.active.delete(t.to);
      return s;
    }
    case 'recover':
      return recover(s);
  }
};

// Startup repair: a turn with no turn_end died with the process. What it was serving goes back to the front of the
// queue, flagged so the agent knows it may have started the work. Delivery is at-least-once, settling is exactly-once.
export const recover = (s: MailState): MailState => {
  for (const t of s.turns.values()) {
    if (t.ended) continue;
    t.ended = true;
    if (s.active.get(t.to) === t.id) s.active.delete(t.to);
    const back = t.ids.filter((id) => {
      const l = s.life.get(id);
      return l?.s === 'delivered' && l.turn === t.id;
    });
    for (const id of back) s.life.set(id, { s: 'queued', redelivered: true });
    const q = s.queue.get(t.to) ?? [];
    s.queue.set(t.to, [...back, ...q]);
  }
  return s;
};

// What a message written right now is in answer to: a request of the running turn, else the oldest one still being served.
export const servingNow = (s: MailState, actor: ActorId): Message | undefined => {
  const turn = s.active.get(actor);
  const current = turn && s.turns.get(turn)?.ids.map((id) => s.messages.get(id)!).find((m) => m.kind === 'request' && s.unsettled.has(m.id));
  return current || serving(s, actor)[0];
};

export const openChildren = (s: MailState, id: MessageId): MessageId[] => (s.children.get(id) ?? []).filter((c) => s.unsettled.has(c));

// Requests an employee is serving: delivered to them and not settled yet, oldest first. Gauntlets are the office's.
export const serving = (s: MailState, actor: ActorId): Message[] =>
  s.order
    .filter((id) => s.unsettled.has(id))
    .map((id) => s.messages.get(id)!)
    .filter((m) => m.to === actor && m.kind === 'request' && m.intent !== 'gauntlet' && s.life.get(m.id)?.s === 'delivered');

// The next batch for an idle actor: the owner first, then arrival order, capped.
export const nextBatch = (s: MailState, actor: ActorId): Message[] => {
  const msgs = (s.queue.get(actor) ?? []).map((id) => s.messages.get(id)!);
  const ordered = [...msgs.filter((m) => m.from === 'owner'), ...msgs.filter((m) => m.from !== 'owner')];
  const out: Message[] = [];
  let chars = 0;
  for (const m of ordered) {
    const size = 'text' in m ? m.text.length : 0;
    if (out.length && (out.length >= MAX_BATCH.messages || chars + size > MAX_BATCH.chars)) break;
    out.push(m);
    chars += size;
  }
  return out;
};

// Which requests a finished turn settles on its own: the ones it served that have no open child request. A parent with
// open children is never settled early, because the last child's reply wakes its owner. A failed turn settles all.
export const settleAtTurnEnd = (s: MailState, turn: TurnId, ok: boolean): MessageId[] => {
  const t = s.turns.get(turn);
  if (!t) return [];
  const out = new Set<MessageId>();
  const consider = (id: MessageId | null | undefined) => {
    if (!id) return;
    const m = s.messages.get(id);
    if (!m || m.kind !== 'request' || m.intent === 'gauntlet' || m.to !== t.to) return;
    if (s.life.get(id)?.s !== 'delivered') return;
    if (!ok || openChildren(s, id).length === 0) out.add(id);
  };
  for (const id of t.ids) {
    const m = s.messages.get(id);
    if (m?.kind === 'request') consider(id);
    else if (m?.kind === 'reply') consider(s.messages.get(m.requestId)?.parentId);
  }
  return [...out];
};

const bullets = (items: readonly string[]) => items.map((i) => `- ${i}`).join('\n');

// The chat transcript an agent reads at the start of a turn. Request ids are shown because `reply` takes one.
export const renderBatch = (batch: readonly Message[], redelivered: boolean, nameOf: (a: ActorId) => string): string => {
  const parts = batch.map((m) => {
    switch (m.kind) {
      case 'say':
        return `[${nameOf(m.from)} says]\n${m.text}`;
      case 'request': {
        const head = `[Request ${m.id} from ${nameOf(m.from)}, ${m.intent}] ${m.title}`;
        const body = m.intent === 'review' ? '' : `\n${m.text}`;
        const artifact = m.artifact?.length ? `\nArtifact to review:\n${bullets(m.artifact)}` : '';
        const bar = m.bar?.length ? `\nAcceptance bar:\n${bullets(m.bar)}` : '';
        return `${head}${body}${artifact}${bar}\nSettle it with the reply tool (requestId ${m.id}), or end your turn and your final text becomes the reply.`;
      }
      case 'reply': {
        const verdict = m.verdict ? `\nVerdict: ${m.verdict.pass ? 'PASS' : 'FAIL'}${m.verdict.findings.length ? `\nFindings:\n${bullets(m.verdict.findings)}` : ''}` : '';
        const artifact = m.artifact?.length ? `\nArtifacts:\n${bullets(m.artifact)}` : '';
        return `[Reply from ${nameOf(m.from)} to your request ${m.requestId}: ${m.outcome}]\n${m.text}${verdict}${artifact}`;
      }
      case 'event':
        return `[Office] ${m.text}`;
    }
  });
  const note = redelivered ? 'You may have started this before a restart. Check the repo state before you redo any work.\n\n' : '';
  return `${note}${parts.join('\n\n')}`;
};

// What the desk shows while this batch is being worked: the first request's title, else the first words.
export const titleOfBatch = (batch: readonly Message[]): string => {
  const request = batch.find((m) => m.kind === 'request');
  if (request?.kind === 'request') return request.title;
  const first = batch[0];
  return first && 'text' in first ? titleOf(first.text) : 'Messages';
};

export const titleOf = (text: string): string => {
  const line = text.trim().split('\n')[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line || 'Untitled';
};

const replyOf = (s: MailState, id: MessageId): Extract<Message, { kind: 'reply' }> | undefined => {
  const life = s.life.get(id);
  const m = life?.s === 'settled' ? s.messages.get(life.by) : undefined;
  return m?.kind === 'reply' ? m : undefined;
};

// What the gauntlet does next, derived from its children alone. null while a round is still open.
export type GauntletStep =
  | { act: 'work'; round: number; findings?: string[] }
  | { act: 'review'; artifact: string[] }
  | { act: 'settle'; outcome: Outcome; text: string; artifact?: string[] };

export const gauntletNext = (s: MailState, gid: MessageId): GauntletStep | null => {
  const g = s.messages.get(gid);
  if (!g || g.kind !== 'request' || !g.gauntlet || !s.unsettled.has(gid)) return null;
  const kids = (s.children.get(gid) ?? []).map((id) => s.messages.get(id)!);
  const last = kids.at(-1);
  const rounds = kids.filter((k) => k.kind === 'request' && k.intent === 'work').length;
  if (!last) return { act: 'work', round: 1 };
  const reply = replyOf(s, last.id);
  if (!reply || last.kind !== 'request') return null;
  if (reply.outcome !== 'done') return { act: 'settle', outcome: reply.outcome === 'cancelled' ? 'cancelled' : reply.outcome === 'blocked' ? 'blocked' : 'failed', text: reply.text };
  if (last.intent === 'work') return { act: 'review', artifact: reply.artifact ?? [] };
  const verdict = reply.verdict ?? { pass: false, findings: [reply.text] };
  const lastWork = [...kids].reverse().find((k) => k.kind === 'request' && k.intent === 'work');
  const workReply = lastWork && replyOf(s, lastWork.id);
  const artifact = workReply?.artifact;
  if (verdict.pass) return { act: 'settle', outcome: 'done', text: workReply?.text ?? reply.text, ...(artifact ? { artifact } : {}) };
  if (rounds >= g.gauntlet.maxRounds) return { act: 'settle', outcome: 'blocked', text: `The critic still found gaps after ${rounds} rounds:\n${bullets(verdict.findings)}` };
  return { act: 'work', round: rounds + 1, findings: verdict.findings };
};

// dm:E is the owner and E, plus every chain rooted in a message between them.
export const convoMessages = (s: MailState, convo: ConvoKey): Message[] => {
  const e = convo.slice(3);
  const between = (m: Message) => (m.from === 'owner' && m.to === e) || (m.from === e && m.to === 'owner');
  const roots = new Set<MessageId>();
  for (const id of s.order) {
    const m = s.messages.get(id)!;
    if (m.parentId === null && between(m)) roots.add(m.rootId);
  }
  return s.order.map((id) => s.messages.get(id)!).filter((m) => between(m) || roots.has(m.rootId));
};

// ───────────────────────────── Shell ─────────────────────────────

export type Member = { id: EmployeeId; name: string; role: EmployeeRole; blockId: BlockId; status: string; doing?: string };

export type HireSpec = { key: string; name?: string; brief?: string };
export type Hired = { ok: true; id: EmployeeId; name: string } | { ok: false; reason: string };

// What the mailroom needs from the office. Narrow on purpose.
export type MailPorts = {
  members(): Member[];
  nameOf(actor: ActorId): string;
  // Starts a turn. May throw (a missing folder, a session that is gone): the turn then fails and its requests settle failed.
  deliver(to: EmployeeId, prompt: string, title: string): void;
  steer(to: EmployeeId, text: string, style: 'next' | 'now'): void;
  hire(from: EmployeeId, spec: HireSpec): Hired;
  persist(entry: LedgerEntry): void;
  changed(view: MailView): void;
  stream(employeeId: EmployeeId, replyingTo: MessageId | null, delta: string, done: boolean): void;
  now(): number;
  newId(): string;
};

export type PostInput = {
  from: ActorId;
  to: string;
  // Needed to resolve names and 'po' for the owner, who is in no block.
  blockId?: BlockId;
  body: PostBody;
  key?: string;
  parentId?: MessageId;
};

export type Resolved = { ok: true; id: ActorId; label: string } | { ok: false; reason: 'unknown_target' | 'ambiguous' | 'cross_block' | 'bad_request'; detail: string };

type Waiter = { who: EmployeeId; ids: MessageId[]; mode: 'any' | 'all'; poll(): boolean; resolve(): void };

const mid = (id: string) => id as MessageId;
const tid = (id: string) => id as TurnId;

export class Mailroom {
  readonly state = emptyMail();
  private readonly ports: MailPorts;
  private waiters = new Set<Waiter>();
  private dirty = false;

  constructor(ports: MailPorts, ledger: readonly LedgerEntry[] = []) {
    this.ports = ports;
    for (const entry of ledger) fold(this.state, entry);
  }

  // ── ledger ──

  private append(entry: LedgerEntry) {
    fold(this.state, entry);
    this.ports.persist(entry);
    if (!this.dirty) {
      this.dirty = true;
      queueMicrotask(() => {
        this.dirty = false;
        this.ports.changed(this.view());
      });
    }
  }

  private put(msg: Message) {
    this.append({ t: 'post', msg });
    this.wake(msg.to);
  }

  private base(from: ActorId, to: ActorId, parent: Message | undefined, id = mid(this.ports.newId()), key?: string) {
    return { id, rootId: parent?.rootId ?? id, parentId: parent?.id ?? null, from, to, at: this.ports.now(), hops: parent ? parent.hops + 1 : 0, ...(key ? { key } : {}) };
  }

  // ── names ──

  resolve(from: ActorId, to: string, blockId?: BlockId): Resolved {
    const key = to.trim().toLocaleLowerCase();
    if (key === 'owner') return { ok: true, id: 'owner', label: 'owner' };
    const all = this.ports.members();
    const byId = all.find((m) => m.id === to);
    const fromMember = all.find((m) => m.id === from);
    const block = fromMember?.blockId ?? blockId ?? byId?.blockId;
    if (!block) return { ok: false, reason: 'unknown_target', detail: `No block to look for ${to} in.` };
    const team = all.filter((m) => m.blockId === block);
    if (key === 'po') {
      const po = team.find((m) => m.role === 'orchestrator');
      return po ? { ok: true, id: po.id, label: po.name } : { ok: false, reason: 'unknown_target', detail: 'This block has no PO.' };
    }
    const hit = byId && byId.blockId === block ? [byId] : team.filter((m) => m.name.toLocaleLowerCase() === key);
    if (hit.length === 1) return hit[0]!.id === from ? { ok: false, reason: 'bad_request', detail: 'You cannot post to yourself.' } : { ok: true, id: hit[0]!.id, label: hit[0]!.name };
    if (hit.length > 1) return { ok: false, reason: 'ambiguous', detail: `More than one teammate is called ${to}.` };
    if (all.some((m) => m.id === to || m.name.toLocaleLowerCase() === key)) return { ok: false, reason: 'cross_block', detail: `${to} works in another block. Ask your PO to reach them.` };
    return { ok: false, reason: 'unknown_target', detail: `No teammate named ${to} works in this block.` };
  }

  // ── post ──

  post(req: PostInput): Posted {
    const known = req.key ? this.state.keys.get(req.key) : undefined;
    if (known) return this.posted(known, req.to);
    const target = this.resolve(req.from, req.to, req.blockId);
    if (!target.ok) return target;
    const parent = this.parentOf(req);
    const { body } = req;
    if (body.kind === 'request') {
      if (target.id === 'owner') return { ok: false, reason: 'bad_request', detail: 'Ask the owner with ask_owner. To tell them something, use message.' };
      const hops = parent ? parent.hops + 1 : 0;
      if (hops > MAX_HOPS) return { ok: false, reason: 'hop_limit', detail: `Delegation is already ${MAX_HOPS} levels deep. Do this one yourself or reply blocked.` };
      if (req.from !== 'owner' && this.openOutgoing(req.from) >= MAX_OPEN_OUTGOING) return { ok: false, reason: 'too_many_open', detail: `You already have ${MAX_OPEN_OUTGOING} open requests. Wait for replies first.` };
    }
    if (hasMailbox(target.id) && (this.state.queue.get(target.id)?.length ?? 0) >= MAX_QUEUE_PER_ACTOR) {
      return { ok: false, reason: 'queue_full', detail: `${target.label} already has ${MAX_QUEUE_PER_ACTOR} messages waiting.` };
    }
    const b = this.base(req.from, target.id, parent, undefined, req.key);
    if (body.kind === 'say') {
      const urgency: Urgency = body.urgency ?? 'queue';
      this.put({ ...b, kind: 'say', text: body.text, wake: hasMailbox(target.id), urgency });
      const running = hasMailbox(target.id) ? this.state.active.get(target.id) : undefined;
      if (running && urgency !== 'queue') {
        this.append({ t: 'deliver', ids: [b.id], to: target.id, turn: running, at: this.ports.now() });
        this.ports.steer(target.id as EmployeeId, req.from === 'owner' ? body.text : renderBatch([this.state.messages.get(b.id)!], false, this.ports.nameOf), urgency);
      }
    } else {
      this.put({ ...b, kind: 'request', intent: body.intent ?? 'work', title: body.title ?? titleOf(body.text), text: body.text, ...(body.bar?.length ? { bar: body.bar } : {}) });
    }
    this.pump(target.id);
    return this.posted(b.id, target.label);
  }

  private posted(id: MessageId, target: string): Posted {
    const m = this.state.messages.get(id)!;
    const queue = this.state.queue.get(m.to) ?? [];
    const at = queue.indexOf(id);
    return { ok: true, id, delivery: at < 0 ? 'delivered' : 'queued', ahead: Math.max(at, 0), target };
  }

  private parentOf(req: PostInput): Message | undefined {
    if (req.parentId) return this.state.messages.get(req.parentId);
    if (req.from === 'owner' || req.from === 'mailroom') return undefined;
    return servingNow(this.state, req.from);
  }

  private openOutgoing(from: ActorId): number {
    let n = 0;
    for (const id of this.state.unsettled) if (this.state.messages.get(id)!.from === from) n++;
    return n;
  }

  // ── reply ──

  // Accepts a full id or an unambiguous prefix, because an agent copies ids by hand.
  findRequest(idOrPrefix: string): Message | undefined {
    const exact = this.state.messages.get(mid(idOrPrefix));
    if (exact) return exact;
    const hits = this.state.order.filter((id) => id.startsWith(idOrPrefix) && this.state.messages.get(id)!.kind === 'request');
    return hits.length === 1 ? this.state.messages.get(hits[0]!) : undefined;
  }

  // Idempotent. A second reply to a settled request is ok and changes nothing.
  reply(from: EmployeeId, requestId: string, r: { outcome: Outcome; text: string; verdict?: Verdict; artifact?: string[] }): { ok: true } | { ok: false; reason: 'not_yours' | 'unknown' } {
    const req = this.findRequest(requestId);
    if (!req || req.kind !== 'request') return { ok: false, reason: 'unknown' };
    if (req.to !== from || req.intent === 'gauntlet') return { ok: false, reason: 'not_yours' };
    if (this.state.unsettled.has(req.id)) this.settleWith(req, from, r);
    this.pump(from);
    return { ok: true };
  }

  private settleWith(req: Message, from: ActorId, r: { outcome: Outcome; text: string; verdict?: Verdict; artifact?: string[]; auto?: boolean }) {
    if (req.kind !== 'request' || !this.state.unsettled.has(req.id)) return;
    const b = this.base(from, req.from, req);
    this.put({
      ...b,
      rootId: req.rootId,
      hops: req.hops,
      kind: 'reply',
      requestId: req.id,
      outcome: r.outcome,
      text: r.text,
      ...(r.verdict ? { verdict: r.verdict } : {}),
      ...(r.artifact?.length ? { artifact: r.artifact } : {}),
      ...(r.auto ? { auto: true } : {}),
    });
    if (req.from === 'mailroom' && req.parentId) this.advance(req.parentId);
    this.pump(req.from);
  }

  // ── gauntlet ──

  requestGauntlet(from: EmployeeId, a: { piece: string; bar: string[]; builder: string; critic: string; maxRounds?: number; key?: string }): Posted {
    const known = a.key ? this.state.keys.get(a.key) : undefined;
    if (known) return this.posted(known, a.builder);
    const builder = this.resolve(from, a.builder);
    if (!builder.ok) return builder;
    const critic = this.resolve(from, a.critic);
    if (!critic.ok) return critic;
    if (!hasMailbox(builder.id) || !hasMailbox(critic.id)) return { ok: false, reason: 'bad_request', detail: 'The builder and the critic must be employees.' };
    if (builder.id === critic.id) return { ok: false, reason: 'critic_is_builder', detail: 'The critic must be a different person from the builder, or the review is not blind.' };
    if (!a.bar.length) return { ok: false, reason: 'bad_request', detail: 'A gauntlet needs a bar to judge against.' };
    const parent = servingNow(this.state, from);
    if ((parent ? parent.hops + 1 : 0) + 1 > MAX_HOPS) return { ok: false, reason: 'hop_limit', detail: 'Too deep to run a gauntlet from here.' };
    if (this.openOutgoing(from) >= MAX_OPEN_OUTGOING) return { ok: false, reason: 'too_many_open', detail: `You already have ${MAX_OPEN_OUTGOING} open requests.` };
    const spec: GauntletSpec = { builder: builder.id as EmployeeId, critic: critic.id as EmployeeId, maxRounds: a.maxRounds ?? DEFAULT_GAUNTLET_ROUNDS };
    const b = this.base(from, builder.id, parent, undefined, a.key);
    this.put({ ...b, kind: 'request', intent: 'gauntlet', title: titleOf(a.piece), text: a.piece, bar: a.bar, gauntlet: spec });
    this.advance(b.id);
    return this.posted(b.id, builder.label);
  }

  private advance(gid: MessageId) {
    const g = this.state.messages.get(gid);
    const step = gauntletNext(this.state, gid);
    if (!step || g?.kind !== 'request' || !g.gauntlet) return;
    const spec = g.gauntlet;
    if (step.act === 'settle') return this.settleWith(g, 'mailroom', { outcome: step.outcome, text: step.text, ...(step.artifact ? { artifact: step.artifact } : {}) });
    const round = (to: EmployeeId, intent: 'work' | 'review', title: string, text: string, extra: { artifact?: string[] }) => {
      const b = this.base('mailroom', to, g);
      this.put({ ...b, kind: 'request', intent, title, text, ...(g.bar ? { bar: g.bar } : {}), ...extra });
      this.pump(to);
    };
    if (step.act === 'work') {
      const text = step.findings
        ? `${g.text}\n\nRound ${step.round}. A reviewer who saw only your artifact and the bar found these gaps. Close them, then reply again with the artifact refs:\n${bullets(step.findings)}`
        : `${g.text}\n\nWhen you are done, reply with the artifact refs (paths, a diff command, a URL) so a reviewer can check it against the bar.`;
      return round(spec.builder, 'work', g.title, text, {});
    }
    round(spec.critic, 'review', 'Review the artifact against the bar', 'Judge the artifact against the bar. You see no description of how it was built.', { artifact: step.artifact });
  }

  // ── cancel, fire ──

  cancel(by: ActorId, id: string): { ok: boolean } {
    const req = this.findRequest(id);
    if (!req || req.kind !== 'request' || !this.state.unsettled.has(req.id)) return { ok: false };
    if (req.from !== by && by !== 'owner') return { ok: false };
    const delivered = this.state.life.get(req.id)?.s === 'delivered';
    this.settleWith(req, 'mailroom', { outcome: 'cancelled', text: 'Cancelled by the asker.' });
    if (delivered && hasMailbox(req.to)) this.ports.steer(req.to as EmployeeId, `The request "${req.title}" was cancelled. Drop it and stop work on it.`, 'next');
    for (const child of openChildren(this.state, req.id)) this.cancel(this.state.messages.get(child)!.from, child);
    return { ok: true };
  }

  employeeFired(id: EmployeeId) {
    const turn = this.state.active.get(id);
    if (turn) this.append({ t: 'turn_end', turn, at: this.ports.now() });
    for (const rid of [...this.state.unsettled]) {
      const req = this.state.messages.get(rid)!;
      if (req.kind === 'request' && req.to === id && req.intent !== 'gauntlet') this.settleWith(req, 'mailroom', { outcome: 'declined', text: `${this.ports.nameOf(id)} no longer works here.` });
    }
    for (const w of [...this.waiters]) if (w.who === id) this.waiters.delete(w);
  }

  // ── turns ──

  // The wake rule. Runs on post, turn end, hire and startup. Synchronous and idempotent: it re-derives from state whether
  // `actor` is idle with a batch waiting.
  pump(actor: ActorId) {
    if (!hasMailbox(actor) || this.state.active.has(actor)) return;
    if (!this.ports.members().some((m) => m.id === actor)) return;
    const batch = nextBatch(this.state, actor);
    if (!batch.length) return;
    const to = actor as EmployeeId;
    const redelivered = batch.some((m) => (this.state.life.get(m.id) as { redelivered?: boolean }).redelivered);
    const turn = tid(this.ports.newId());
    this.append({ t: 'deliver', ids: batch.map((m) => m.id), to, turn, at: this.ports.now() });
    const prompt = renderBatch(batch, redelivered, this.ports.nameOf);
    try {
      this.ports.deliver(to, prompt, titleOfBatch(batch));
    } catch (e) {
      this.turnEnded(to, e instanceof Error ? e.message : String(e), false);
    }
  }

  // The harness finished its turn. Settles what the turn served, then wakes the employee again if more is waiting.
  turnEnded(who: EmployeeId, finalText: string, ok: boolean) {
    const turn = this.state.active.get(who);
    if (!turn) return;
    this.append({ t: 'turn_end', turn, at: this.ports.now() });
    for (const id of settleAtTurnEnd(this.state, turn, ok)) {
      const req = this.state.messages.get(id)!;
      this.settleWith(req, who, ok ? { outcome: 'done', text: finalText.trim() || 'Done.', auto: true } : { outcome: 'failed', text: finalText.trim() || 'The turn failed.', auto: true });
    }
    this.pump(who);
  }

  recoverOnStart() {
    this.append({ t: 'recover', at: this.ports.now() });
    for (const m of this.ports.members()) this.pump(m.id);
  }

  // ── blocking inbox ──

  inbox(who: EmployeeId, peek: boolean): Message[] {
    const queued = (this.state.queue.get(who) ?? []).map((id) => this.state.messages.get(id)!);
    const turn = this.state.active.get(who);
    if (!peek && turn && queued.length) this.append({ t: 'deliver', ids: queued.map((m) => m.id), to: who, turn, at: this.ports.now() });
    return queued;
  }

  // Parks an agent until a listed reply lands, or ANY other message arrives, or the timeout. Because any arrival
  // resolves it, two agents waiting on each other cannot deadlock.
  await(who: EmployeeId, opts: { ids?: string[]; mode?: 'any' | 'all'; timeoutSec?: number }, signal?: AbortSignal): Promise<Message[]> {
    const ids = (opts.ids ?? []).map((i) => this.findRequest(i)?.id).filter((i): i is MessageId => !!i);
    const mode = opts.mode ?? 'any';
    const settledReplies = () =>
      ids.flatMap((id) => {
        const life = this.state.life.get(id);
        const r = life?.s === 'settled' ? this.state.messages.get(life.by) : undefined;
        return r ? [r] : [];
      });
    const ready = () => (this.state.queue.get(who)?.length ?? 0) > 0 || (ids.length > 0 && (mode === 'any' ? settledReplies().length > 0 : settledReplies().length === ids.length));
    const collect = () => {
      const fresh = this.inbox(who, false);
      const seen = new Set(fresh.map((m) => m.id));
      return [...fresh, ...settledReplies().filter((m) => !seen.has(m.id))];
    };
    if (ready()) return Promise.resolve(collect());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', done);
        this.dirty || this.ports.changed(this.view());
        resolve(ready() ? collect() : []);
      };
      const waiter: Waiter = { who, ids, mode, poll: ready, resolve: done };
      const timer = setTimeout(done, (opts.timeoutSec ?? 120) * 1000);
      signal?.addEventListener('abort', done);
      this.waiters.add(waiter);
      this.ports.changed(this.view());
    });
  }

  private wake(actor: ActorId) {
    for (const w of [...this.waiters]) if (w.who === actor && w.poll()) w.resolve();
  }

  // ── hiring ──

  hire(from: EmployeeId, spec: HireSpec): Hired {
    const me = this.ports.members().find((m) => m.id === from);
    if (me?.role !== 'orchestrator') return { ok: false, reason: 'Only the block PO can hire.' };
    const known = this.state.keys.get(`hire:${from}:${spec.key}`);
    const event = known ? this.state.messages.get(known) : undefined;
    if (event?.kind === 'event' && event.subject) {
      const again = this.ports.members().find((m) => m.id === event.subject);
      if (again) return { ok: true, id: again.id, name: again.name };
    }
    if (spec.name && this.ports.members().some((m) => m.blockId === me.blockId && m.name.toLocaleLowerCase() === spec.name!.trim().toLocaleLowerCase())) {
      return { ok: false, reason: `${spec.name} already works here. Pick another name or leave it empty.` };
    }
    const hired = this.ports.hire(from, spec);
    if (!hired.ok) return { ok: false, reason: `${hired.reason} Queueing work on the existing team is fine: busy people are not an error.` };
    const parent = servingNow(this.state, from);
    const b = this.base('mailroom', 'owner', parent, undefined, `hire:${from}:${spec.key}`);
    this.put({ ...b, kind: 'event', event: 'hired', subject: hired.id, text: `${this.ports.nameOf(from)} hired ${hired.name}.` });
    return hired;
  }

  // ── streaming ──

  streamed(who: EmployeeId, delta: string, done: boolean) {
    this.ports.stream(who, servingNow(this.state, who)?.id ?? null, delta, done);
  }

  // ── views ──

  team(who: EmployeeId) {
    const me = this.ports.members().find((m) => m.id === who);
    if (!me) return [];
    return this.ports
      .members()
      .filter((m) => m.blockId === me.blockId)
      .map((m) => {
        const request = serving(this.state, m.id)[0];
        const doing = request?.kind === 'request' ? request.title : m.doing;
        return { name: m.name, role: m.role, state: m.status, queued: this.state.queue.get(m.id)?.length ?? 0, ...(doing ? { doing } : {}), you: m.id === who };
      });
  }

  view(): MailView {
    const s = this.state;
    const actors: Record<string, ActorView> = {};
    for (const m of this.ports.members()) {
      const awaiting = [...this.waiters].filter((w) => w.who === m.id).flatMap((w) => w.ids);
      actors[m.id] = {
        state: [...this.waiters].some((w) => w.who === m.id) ? 'awaiting' : s.active.has(m.id) ? 'running' : 'idle',
        queued: s.queue.get(m.id)?.length ?? 0,
        serving: serving(s, m.id)[0]?.id ?? null,
        awaiting,
      };
    }
    const open: RequestView[] = [...s.unsettled].slice(-200).map((id) => {
      const m = s.messages.get(id) as Extract<Message, { kind: 'request' }>;
      const queue = s.queue.get(m.to) ?? [];
      return { id, rootId: m.rootId, parentId: m.parentId, from: m.from, to: m.to, intent: m.intent as Intent, title: m.title, at: m.at, life: s.life.get(id)!, ahead: Math.max(queue.indexOf(id), 0) };
    });
    return { seq: s.seq, actors, open, tail: s.order.slice(-MAIL_TAIL).map((id) => s.messages.get(id)!) };
  }

  history(convo: ConvoKey, before: MessageId | undefined, limit: number) {
    const all = convoMessages(this.state, convo);
    const end = before ? all.findIndex((m) => m.id === before) : all.length;
    const upto = end < 0 ? all.length : end;
    const from = Math.max(0, upto - limit);
    return { messages: all.slice(from, upto), hasMore: from > 0 };
  }
}

export const defaultIds = () => randomUUID().slice(0, 8);
