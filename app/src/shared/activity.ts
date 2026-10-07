// What happened on a task, and what is happening on it now. Never stored: the mailroom's ledger says who asked whom for
// what and how it ended, the task's own history says who moved its stage and when hours went out, and this file folds both
// into an ordered log and a live summary. Pure: no clock, no disk, no Electron.
//
// The fold keeps the ledger's own lifecycle rules (queued, delivered, settled, back to queued after a crash), so what it
// says a person is doing is what the mailroom thinks. verify/activity-check.ts holds the two to each other.
import type { ActorId, Intent, LedgerEntry, Lifecycle, Message, MessageId, Outcome, TurnId, Verdict } from './mail.ts';
import type { EmployeeId, Question, QuestionId } from './protocol.ts';
import type { Task, TaskEvent, TaskId } from './tasks.ts';

type Req = Extract<Message, { kind: 'request' }>;

const isEmployee = (a: ActorId): a is EmployeeId => a !== 'owner' && a !== 'mailroom';

// A text longer than this is cut, so one pasted log does not make the activity of a task heavy to ship.
export const ACTIVITY_TEXT_CAP = 8000;
export const clipText = (t: string, cap = ACTIVITY_TEXT_CAP) => (t.length > cap ? `${t.slice(0, cap - 1)}…` : t);

// ───────────────────────────── What the owner reads ─────────────────────────────

// A gauntlet runs its builder and its critic in rounds. `n` is the round, and a review belongs to the round it judges.
export type Round = { gauntlet: MessageId; n: number; role: 'build' | 'review' };

// `n` orders entries that happened in the same millisecond: the ledger's own order.
type Stamp = { id: string; at: number; n: number };
type WithoutAt<T> = T extends unknown ? Omit<T, 'at'> : never;

export type ActivityEntry = Stamp &
  (
    | { kind: 'created'; by: 'owner' | 'provider' }
    // A request was posted. `answers` is the question of the board it answers.
    | { kind: 'request'; msg: MessageId; from: ActorId; to: ActorId; intent: Intent; title: string; text: string; parent: MessageId | null; bar?: string[]; round?: Round; answers?: MessageId }
    // The person it was given to took it up. `again` is a second go after a crash.
    | { kind: 'started'; msg: MessageId; who: EmployeeId; title: string; again: boolean }
    // A progress message, or a teammate's or the owner's word inside the chain.
    | { kind: 'say'; msg: MessageId; from: ActorId; to: ActorId; text: string; answers?: MessageId }
    // How a request ended: its files, and the critic's verdict when it was a review.
    | { kind: 'reply'; msg: MessageId; request: MessageId; title: string; from: ActorId; to: ActorId; outcome: Outcome; text: string; artifact?: string[]; verdict?: Verdict; auto?: boolean; round?: Round }
    | { kind: 'event'; event: 'hired' | 'fired'; subject?: EmployeeId; text: string }
    // The app died with these in someone's hands, and started again with them back in the queue.
    | { kind: 'recovered'; requeued: { msg: MessageId; who: EmployeeId; title: string }[] }
    // What the task's own history says: who moved it, and the hours that went out.
    | WithoutAt<TaskEvent>
  );

// ───────────────────────────── The fold ─────────────────────────────

type TurnRec = { to: EmployeeId; start: number; ended: boolean; ids: MessageId[] };

// Rebuilt entry by entry from the ledger. Mutated by `foldActivity`, which like the mailroom's fold gives the same result
// for a replayed entry.
export type ActivityIndex = {
  seq: number;
  msgs: Map<MessageId, Message>;
  ord: Map<MessageId, number>;
  life: Map<MessageId, Lifecycle>;
  unsettled: Set<MessageId>;
  children: Map<MessageId, MessageId[]>;
  turns: Map<TurnId, TurnRec>;
  active: Map<EmployeeId, TurnId>;
  // The last time the ledger heard of a person's turn starting or ending.
  lastAt: Map<EmployeeId, number>;
  deliveredAt: Map<MessageId, number>;
  // Every message of a chain, in the order it was posted, and what the chain looks like as log entries.
  members: Map<MessageId, MessageId[]>;
  entries: Map<MessageId, ActivityEntry[]>;
  rounds: Map<MessageId, Round>;
  // Questions the board answered, found by the key of the message that answered them.
  answered: Set<MessageId>;
  // The latest the owner wrote to each employee, whatever it was, in post order.
  ownerTo: Map<EmployeeId, number>;
};

export const emptyActivity = (): ActivityIndex => ({
  seq: 0,
  msgs: new Map(),
  ord: new Map(),
  life: new Map(),
  unsettled: new Set(),
  children: new Map(),
  turns: new Map(),
  active: new Map(),
  lastAt: new Map(),
  deliveredAt: new Map(),
  members: new Map(),
  entries: new Map(),
  rounds: new Map(),
  answered: new Set(),
  ownerTo: new Map(),
});

// The keys of the messages that carry the owner's answer. A blocked request is answered by a new request to the person who
// stopped (a run of the task, so crash repair finds it by the `task:` tag). A question put to a teammate is answered by a
// word to whoever must act on it.
export const answerKey = (task: TaskId, who: EmployeeId, question: MessageId) => `task:${task}:${who}:answer:${question}`;
export const noteKey = (task: TaskId, question: MessageId) => `answer:${task}:${question}`;
export function answeredBy(key: string | undefined): MessageId | undefined {
  if (!key) return undefined;
  const run = /^task:[^:]+:[^:]+:answer:([^:]+)$/.exec(key);
  const note = /^answer:[^:]+:([^:]+)$/.exec(key);
  return (run?.[1] ?? note?.[1]) as MessageId | undefined;
}

const add = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v]);

export function foldActivity(ix: ActivityIndex, entry: LedgerEntry): ActivityIndex {
  const i = ix.seq++;
  const stamp = (k: number, key: string, at: number) => ({ id: `${i}:${key}`, at, n: i * 1000 + k });
  switch (entry.t) {
    case 'post': {
      const m = entry.msg;
      if (ix.msgs.has(m.id)) return ix;
      ix.msgs.set(m.id, m);
      ix.ord.set(m.id, i);
      add(ix.members, m.rootId, m.id);
      if (m.from === 'owner' && isEmployee(m.to)) ix.ownerTo.set(m.to, i);
      const answers = answeredBy(m.key);
      if (answers) ix.answered.add(answers);
      const mailbox = isEmployee(m.to);
      let round: Round | undefined;
      let out: ActivityEntry;
      switch (m.kind) {
        case 'request': {
          ix.unsettled.add(m.id);
          const parent = m.parentId ? ix.msgs.get(m.parentId) : undefined;
          if (parent?.kind === 'request' && parent.intent === 'gauntlet') {
            const works = (ix.children.get(parent.id) ?? []).filter((c) => (ix.msgs.get(c) as Req).intent === 'work').length;
            round = m.intent === 'work' ? { gauntlet: parent.id, n: works + 1, role: 'build' } : { gauntlet: parent.id, n: Math.max(works, 1), role: 'review' };
            ix.rounds.set(m.id, round);
          }
          if (m.parentId) add(ix.children, m.parentId, m.id);
          if (m.intent === 'gauntlet') ix.life.set(m.id, { s: 'running' });
          else if (mailbox) ix.life.set(m.id, { s: 'queued', redelivered: false });
          out = {
            ...stamp(0, m.id, m.at),
            kind: 'request',
            msg: m.id,
            from: m.from,
            to: m.to,
            intent: m.intent,
            title: m.title,
            text: clipText(m.text),
            parent: m.parentId,
            ...(m.bar?.length ? { bar: m.bar } : {}),
            ...(round ? { round } : {}),
            ...(answers ? { answers } : {}),
          };
          break;
        }
        case 'say':
          if (m.wake && mailbox) ix.life.set(m.id, { s: 'queued', redelivered: false });
          out = { ...stamp(0, m.id, m.at), kind: 'say', msg: m.id, from: m.from, to: m.to, text: clipText(m.text), ...(answers ? { answers } : {}) };
          break;
        case 'reply': {
          if (mailbox) ix.life.set(m.id, { s: 'queued', redelivered: false });
          const asked = ix.msgs.get(m.requestId);
          if (asked && ix.unsettled.delete(asked.id)) ix.life.set(asked.id, { s: 'settled', by: m.id, outcome: m.outcome });
          round = ix.rounds.get(m.requestId);
          out = {
            ...stamp(0, m.id, m.at),
            kind: 'reply',
            msg: m.id,
            request: m.requestId,
            title: asked?.kind === 'request' ? asked.title : '',
            from: m.from,
            to: m.to,
            outcome: m.outcome,
            text: clipText(m.text),
            ...(m.artifact?.length ? { artifact: m.artifact } : {}),
            ...(m.verdict ? { verdict: m.verdict } : {}),
            ...(m.auto ? { auto: true } : {}),
            ...(round ? { round } : {}),
          };
          break;
        }
        case 'event':
          out = { ...stamp(0, m.id, m.at), kind: 'event', event: m.event, ...(m.subject ? { subject: m.subject } : {}), text: m.text };
          break;
      }
      add(ix.entries, m.rootId, out);
      return ix;
    }
    case 'deliver': {
      let t = ix.turns.get(entry.turn);
      if (t?.ended) return ix;
      if (!t) {
        t = { to: entry.to as EmployeeId, start: entry.at, ended: false, ids: [] };
        ix.turns.set(entry.turn, t);
        ix.active.set(t.to, entry.turn);
      }
      ix.lastAt.set(t.to, entry.at);
      entry.ids.forEach((id, k) => {
        const life = ix.life.get(id);
        if (life?.s !== 'queued') return;
        ix.life.set(id, { s: 'delivered', turn: entry.turn });
        ix.deliveredAt.set(id, entry.at);
        t.ids.push(id);
        const m = ix.msgs.get(id);
        if (m?.kind === 'request') add(ix.entries, m.rootId, { ...stamp(k, id, entry.at), kind: 'started', msg: id, who: t.to, title: m.title, again: life.redelivered });
      });
      return ix;
    }
    case 'turn_end': {
      const t = ix.turns.get(entry.turn);
      if (!t) return ix;
      t.ended = true;
      ix.lastAt.set(t.to, entry.at);
      if (ix.active.get(t.to) === entry.turn) ix.active.delete(t.to);
      return ix;
    }
    case 'recover': {
      const back = new Map<MessageId, { msg: MessageId; who: EmployeeId; title: string }[]>();
      for (const [id, t] of ix.turns) {
        if (t.ended) continue;
        t.ended = true;
        if (ix.active.get(t.to) === id) ix.active.delete(t.to);
        for (const msg of t.ids) {
          const life = ix.life.get(msg);
          if (life?.s !== 'delivered' || life.turn !== id) continue;
          ix.life.set(msg, { s: 'queued', redelivered: true });
          const m = ix.msgs.get(msg);
          if (m?.kind === 'request') add(back, m.rootId, { msg, who: t.to, title: m.title });
        }
      }
      let k = 0;
      for (const [root, requeued] of back) add(ix.entries, root, { ...stamp(k++, root, entry.at), kind: 'recovered', requeued });
      return ix;
    }
  }
}

export const activityIndexOf = (ledger: readonly LedgerEntry[]): ActivityIndex => ledger.reduce(foldActivity, emptyActivity());

// ───────────────────────────── The live summary ─────────────────────────────

export type PieceRef = { id: MessageId; title: string; intent: Intent };
const pieceOf = (m: Req): PieceRef => ({ id: m.id, title: m.title, intent: m.intent });

// What someone is waiting for from someone else. A gauntlet piece is waited on through whoever holds its open round.
export type Wait = { who: ActorId; piece: PieceRef; state: 'queued' | 'working' | 'building' | 'reviewing'; round?: number; since: number };

// How an answer from the owner reaches the one who asked.
export type QuestionRef = { kind: 'mail'; id: MessageId } | { kind: 'ask'; employeeId: EmployeeId; id: QuestionId };

export type OpenQuestion = {
  ref: QuestionRef;
  asker: EmployeeId;
  // Who the asker is waiting on to answer.
  to: ActorId;
  at: number;
  text: string;
} & (
  | { how: 'blocked' | 'help'; piece: PieceRef }
  | { how: 'ask'; options?: string[] }
  | { how: 'permission'; tool: string; detail: string }
);

export type PersonLive = { employeeId: EmployeeId } & (
  | { state: 'working'; piece: PieceRef; since: number; on: Wait[] }
  | { state: 'waiting'; piece: PieceRef; since: number; on: Wait[] }
  | { state: 'queued'; piece: PieceRef; since: number; behind?: string }
  | { state: 'blocked'; question: OpenQuestion }
  | { state: 'done'; piece: PieceRef; at: number; artifact?: string[] }
  | { state: 'stopped'; outcome: Exclude<Outcome, 'done'>; piece: PieceRef; at: number }
  | { state: 'idle' }
);

export type TaskLive = { people: PersonLive[]; questions: OpenQuestion[]; open: number };
export const emptyLive: TaskLive = { people: [], questions: [], open: 0 };

// What lives outside the ledger: who is parked waiting for replies, and what employees asked the owner in person.
export type OwnerAsk = { employeeId: EmployeeId; question: Question };
export type LiveInputs = { awaiting: ReadonlySet<EmployeeId>; asks: readonly OwnerAsk[] };
export const noInputs: LiveInputs = { awaiting: new Set(), asks: [] };

// The roots of the chains a task owns. A run is usually a root request, but an answer to a question is a run inside a chain.
export const rootsOf = (task: Pick<Task, 'runs'>, ix: ActivityIndex): Set<MessageId> => new Set(task.runs.map((r) => ix.msgs.get(r)?.rootId ?? r));

const chainOf = (ix: ActivityIndex, roots: ReadonlySet<MessageId>): Message[] => [...roots].flatMap((r) => ix.members.get(r) ?? []).sort((a, b) => ix.ord.get(a)! - ix.ord.get(b)!).map((id) => ix.msgs.get(id)!);

export function liveOf(task: Task, ix: ActivityIndex, inputs: LiveInputs = noInputs): TaskLive {
  const roots = rootsOf(task, ix);
  const chain = chainOf(ix, roots);
  const ord = (m: Message) => ix.ord.get(m.id)!;
  const requests = chain.filter((m): m is Req => m.kind === 'request');
  const open = requests.filter((m) => m.intent !== 'gauntlet' && ix.unsettled.has(m.id));
  const turnOn = (who: EmployeeId) => {
    const turn = ix.active.get(who);
    return turn ? ix.turns.get(turn) : undefined;
  };
  const serving = (who: EmployeeId) => !!turnOn(who)?.ids.some((id) => roots.has(ix.msgs.get(id)!.rootId));

  const questions = task.stage === 'done' ? [] : questionsOf(ix, chain, requests, inputs, serving);

  const people: EmployeeId[] = [];
  const see = (a: ActorId) => isEmployee(a) && !people.includes(a) && people.push(a);
  for (const m of chain) {
    see(m.from);
    see(m.to);
  }
  for (const a of task.assignees) see(a);

  const waitsOf = (who: EmployeeId): Wait[] =>
    open
      .filter((r) => r.to === who && ix.life.get(r.id)?.s === 'delivered')
      .flatMap((r) => (ix.children.get(r.id) ?? []).map((c) => ix.msgs.get(c) as Req).filter((c) => c.from === who && ix.unsettled.has(c.id)))
      .map((c): Wait => {
        const since = c.at;
        if (c.intent !== 'gauntlet') return { who: c.to, piece: pieceOf(c), state: ix.life.get(c.id)?.s === 'delivered' ? 'working' : 'queued', since };
        const round = (ix.children.get(c.id) ?? []).map((g) => ix.msgs.get(g) as Req).find((g) => ix.unsettled.has(g.id));
        if (!round) return { who: c.to, piece: pieceOf(c), state: 'working', since };
        const n = ix.rounds.get(round.id)?.n;
        const state = ix.life.get(round.id)?.s === 'queued' ? 'queued' : round.intent === 'review' ? 'reviewing' : 'building';
        return { who: round.to, piece: pieceOf(c), state, ...(n ? { round: n } : {}), since };
      });

  const lastSettled = (who: EmployeeId) => {
    let best: { piece: Req; reply: Extract<Message, { kind: 'reply' }> } | undefined;
    for (const r of requests) {
      if (r.to !== who || r.intent === 'gauntlet') continue;
      const life = ix.life.get(r.id);
      const reply = life?.s === 'settled' ? ix.msgs.get(life.by) : undefined;
      if (reply?.kind === 'reply' && (!best || ord(reply) > ord(best.reply))) best = { piece: r, reply };
    }
    return best;
  };

  const personOf = (who: EmployeeId): PersonLive => {
    const question = questions.find((q) => q.asker === who);
    if (question) return { employeeId: who, state: 'blocked', question };
    const mine = open.filter((r) => r.to === who);
    const held = mine.filter((r) => ix.life.get(r.id)?.s === 'delivered');
    const on = waitsOf(who);
    const parked = inputs.awaiting.has(who);
    const lastDelivered = [...held].sort((a, b) => (ix.deliveredAt.get(b.id) ?? 0) - (ix.deliveredAt.get(a.id) ?? 0))[0];
    if (serving(who) && !parked) {
      const turn = turnOn(who)!;
      const fallback = requests.find((r) => r.to === who) ?? requests[0];
      const piece = lastDelivered ?? fallback;
      // A long turn that moved on to this piece is working on it from the pickup, not from when the turn began.
      if (piece) return { employeeId: who, state: 'working', piece: pieceOf(piece), since: Math.max(turn.start, ix.deliveredAt.get(piece.id) ?? 0), on };
    }
    if (lastDelivered || (parked && serving(who))) {
      const piece = lastDelivered ?? requests.find((r) => r.to === who) ?? requests[0];
      if (piece) return { employeeId: who, state: 'waiting', piece: pieceOf(piece), since: ix.lastAt.get(who) ?? piece.at, on };
    }
    const queued = mine.find((r) => ix.life.get(r.id)?.s === 'queued');
    if (queued) {
      const busy = turnOn(who)?.ids.map((id) => ix.msgs.get(id)).find((m): m is Req => m?.kind === 'request');
      return { employeeId: who, state: 'queued', piece: pieceOf(queued), since: queued.at, ...(busy ? { behind: busy.title } : {}) };
    }
    const settled = lastSettled(who);
    if (settled) {
      const { piece, reply } = settled;
      if (reply.outcome === 'done') return { employeeId: who, state: 'done', piece: pieceOf(piece), at: reply.at, ...(reply.artifact?.length ? { artifact: reply.artifact } : {}) };
      return { employeeId: who, state: 'stopped', outcome: reply.outcome, piece: pieceOf(piece), at: reply.at };
    }
    return { employeeId: who, state: 'idle' };
  };

  return { people: people.map(personOf), questions, open: open.length };
}

// ───────────────────────────── Questions ─────────────────────────────

// What the owner can still answer. A blocked reply is open until the person who sent it was given something new, or the
// owner spoke to them, or the request it blocked is no longer anyone's; a help request until it is replied to. Both close
// when the board answered them. An employee waiting on the owner in person is open for as long as they wait.
function questionsOf(ix: ActivityIndex, chain: readonly Message[], requests: readonly Req[], inputs: LiveInputs, serving: (who: EmployeeId) => boolean): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  const lastGiven = new Map<EmployeeId, number>();
  for (const r of requests) if (isEmployee(r.to)) lastGiven.set(r.to, Math.max(lastGiven.get(r.to) ?? -1, ix.ord.get(r.id)!));
  for (const m of chain) {
    if (ix.answered.has(m.id)) continue;
    if (m.kind === 'reply' && m.outcome === 'blocked' && isEmployee(m.from) && m.to !== 'mailroom') {
      const at = ix.ord.get(m.id)!;
      if ((lastGiven.get(m.from) ?? -1) > at) continue;
      const asked = ix.msgs.get(m.requestId);
      if (asked?.kind !== 'request') continue;
      if (m.to === 'owner' ? (ix.ownerTo.get(m.from) ?? -1) > at : !asked.parentId || !ix.unsettled.has(asked.parentId)) continue;
      out.push({ ref: { kind: 'mail', id: m.id }, asker: m.from, to: m.to, at: m.at, text: m.text, how: 'blocked', piece: pieceOf(asked) });
    } else if (m.kind === 'request' && m.intent === 'help' && isEmployee(m.from) && isEmployee(m.to) && ix.unsettled.has(m.id)) {
      out.push({ ref: { kind: 'mail', id: m.id }, asker: m.from, to: m.to, at: m.at, text: m.text, how: 'help', piece: pieceOf(m) });
    }
  }
  for (const a of inputs.asks) {
    const onTask = serving(a.employeeId) || requests.some((r) => r.to === a.employeeId && ix.unsettled.has(r.id) && ix.life.get(r.id)?.s === 'delivered');
    if (!onTask) continue;
    const ref: QuestionRef = { kind: 'ask', employeeId: a.employeeId, id: a.question.id };
    const base = { ref, asker: a.employeeId, to: 'owner' as const, at: a.question.askedAt, text: a.question.text };
    out.push(a.question.kind === 'permission' ? { ...base, how: 'permission', tool: a.question.tool, detail: a.question.detail } : { ...base, how: 'ask', ...(a.question.options?.length ? { options: a.question.options } : {}) });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ───────────────────────────── The log ─────────────────────────────

const HISTORY_BASE = 1e15;

// Every entry of the task in the order it happened: the chains it started, then the moves and hours its history keeps.
export function logOf(task: Task, ix: ActivityIndex): ActivityEntry[] {
  const roots = rootsOf(task, ix);
  const created: ActivityEntry = { id: 'created', at: task.createdAt, n: -1, kind: 'created', by: task.origin.kind === 'manual' ? 'owner' : 'provider' };
  const chains = [...roots].flatMap((r) => ix.entries.get(r) ?? []);
  const history = (task.history ?? []).map(({ at, ...rest }, k): ActivityEntry => ({ id: `H${k}`, at, n: HISTORY_BASE + k, ...rest }));
  return [created, ...chains, ...history].sort((a, b) => a.at - b.at || a.n - b.n);
}

// The log and the live summary of a task. `source` is a ledger, or the index of one a caller keeps up to date.
export function activityOf(task: Task, source: ActivityIndex | readonly LedgerEntry[], inputs: LiveInputs = noInputs): { entries: ActivityEntry[]; live: TaskLive } {
  const ix = 'msgs' in source ? source : activityIndexOf(source);
  return { entries: logOf(task, ix), live: liveOf(task, ix, inputs) };
}

// Where the open question `id` of a task stands, for the code that answers it.
export const questionById = (live: TaskLive, id: MessageId): OpenQuestion | undefined => live.questions.find((q) => q.ref.kind === 'mail' && q.ref.id === id);
