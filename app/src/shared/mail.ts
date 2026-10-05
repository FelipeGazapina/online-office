// Wire types of the mailroom: how the owner, the PO and the employees talk. Plain types, no behavior.
// The rules that fold these into state live in main/office/mail.ts.
import type { BlockId, EmployeeId } from './protocol.ts';

// 'mailroom' is the office itself: it asks builders and critics on behalf of a gauntlet and consumes their replies.
export type ActorId = 'owner' | 'mailroom' | EmployeeId;
export type MessageId = string & { readonly __brand: 'MessageId' };
export type TurnId = string & { readonly __brand: 'TurnId' };

export type Outcome = 'done' | 'blocked' | 'failed' | 'declined' | 'cancelled';
// A review reply only. Compared against the bar, never against the builder's claims.
export type Verdict = { pass: boolean; findings: string[] };
export type Urgency = 'queue' | 'next' | 'now';
export type Intent = 'work' | 'help' | 'review' | 'gauntlet';
export type GauntletSpec = { builder: EmployeeId; critic: EmployeeId; maxRounds: number };

type Base = {
  id: MessageId;
  // The first message of the chain this one belongs to.
  rootId: MessageId;
  // The request its sender was serving when it wrote this. Null for owner posts and spontaneous messages.
  parentId: MessageId | null;
  from: ActorId;
  to: ActorId;
  at: number;
  // Delegation depth: parent.hops + 1.
  hops: number;
  // Idempotency key: a second post with the same key is the first post.
  key?: string;
};

export type Message = Base &
  (
    // Chat. No reply owed. `wake: false` is transcript only and never starts a turn.
    | { kind: 'say'; text: string; wake: boolean; urgency: Urgency }
    // Work or help. A reply is owed. A gauntlet request is never delivered: the mailroom runs its rounds.
    | { kind: 'request'; intent: Intent; title: string; text: string; bar?: string[]; artifact?: string[]; gauntlet?: GauntletSpec }
    // The result. Settles `requestId` exactly once. `auto` means the office wrote it from the turn's final text.
    | { kind: 'reply'; requestId: MessageId; outcome: Outcome; text: string; verdict?: Verdict; artifact?: string[]; auto?: boolean }
    // Facts shown inline in the thread.
    | { kind: 'event'; event: 'hired' | 'fired'; subject?: EmployeeId; text: string }
  );

// mail.jsonl, one entry per line. All mailbox state is a fold of it.
export type LedgerEntry =
  | { t: 'post'; msg: Message }
  | { t: 'deliver'; ids: MessageId[]; to: ActorId; turn: TurnId; at: number }
  | { t: 'turn_end'; turn: TurnId; at: number }
  // Startup repair: turns with no turn_end go back to queued.
  | { t: 'recover'; at: number };

export type Lifecycle =
  | { s: 'queued'; redelivered: boolean }
  | { s: 'delivered'; turn: TurnId }
  // A gauntlet request while its rounds run.
  | { s: 'running' }
  | { s: 'settled'; by: MessageId; outcome: Outcome };

export const MAX_HOPS = 3;
export const MAX_QUEUE_PER_ACTOR = 20;
export const MAX_OPEN_OUTGOING = 8;
export const MAX_BATCH = { messages: 8, chars: 12_000 } as const;
export const DEFAULT_GAUNTLET_ROUNDS = 6;
export const MAIL_TAIL = 40;

// 'dm:E' is the owner and E plus every chain rooted there. A view, never stored.
export type ConvoKey = `dm:${EmployeeId}`;

export type ActorState = 'idle' | 'running' | 'awaiting';
export type ActorView = { state: ActorState; queued: number; serving: MessageId | null; awaiting: MessageId[] };
export type RequestView = {
  id: MessageId;
  rootId: MessageId;
  parentId: MessageId | null;
  from: ActorId;
  to: ActorId;
  intent: Intent;
  title: string;
  at: number;
  life: Lifecycle;
  ahead: number;
};
// Small by construction: live state and a first-paint tail, never history.
export type MailView = { seq: number; actors: Record<string, ActorView>; open: RequestView[]; tail: Message[] };

export const emptyMailView = (): MailView => ({ seq: 0, actors: {}, open: [], tail: [] });

export type PostBody =
  | { kind: 'say'; text: string; urgency?: Urgency }
  | { kind: 'request'; intent?: 'work' | 'help'; text: string; title?: string; bar?: string[] };

export type PostFailure = 'unknown_target' | 'ambiguous' | 'cross_block' | 'hop_limit' | 'queue_full' | 'too_many_open' | 'target_fired' | 'bad_request' | 'critic_is_builder';
export type Posted =
  | { ok: true; id: MessageId; delivery: 'delivered' | 'queued'; ahead: number; target: string }
  | { ok: false; reason: PostFailure; detail: string };

export type MailServerMessage =
  // Mail changed. Sent at once, past the snapshot coalescer.
  | { type: 'mail'; view: MailView }
  // Live tokens of the bubble an employee is writing with `message` or `reply`. Not persisted.
  | { type: 'stream'; employeeId: EmployeeId; replyingTo: MessageId | null; delta: string; done?: boolean }
  | { type: 'history'; convo: ConvoKey; messages: Message[]; hasMore: boolean };

export type MailClientMessage =
  // `to` is an employee id, a name, or 'po' (the block's orchestrator, which needs `blockId`).
  | { type: 'post'; to: string; blockId?: BlockId; clientId: string; as: 'request' | 'say'; text: string; urgency?: Urgency }
  | { type: 'cancel_message'; messageId: MessageId }
  | { type: 'load_history'; convo: ConvoKey; before?: MessageId; limit: number };
