// What one employee's mailroom tools do, as plain JSON-able values. The MCP server only parses arguments and calls these.
// `who` is fixed by the URL token, so a tool can only ever speak as its own employee.
import type { EmployeeId } from '../../shared/protocol.ts';
import type { ActorId, Blocker, Message, Outcome, Urgency, Verdict } from '../../shared/mail.ts';
import type { HireSpec, Mailroom } from './mail.ts';

export type MailTools = {
  team(): unknown;
  message(a: { to: string; text: string }): unknown;
  request(a: { to: string; text: string; title?: string; intent?: 'work' | 'help'; bar?: string[]; key?: string }): unknown;
  requestGauntlet(a: { piece: string; bar: string[]; builder: string; critic: string; maxRounds?: number; key?: string }): unknown;
  reply(a: { requestId: string; outcome: Outcome; text: string; verdict?: Verdict; artifact?: string[] } & Partial<Blocker>): unknown;
  awaitReplies(a: { ids?: string[]; mode?: 'any' | 'all'; timeoutSec?: number }, signal?: AbortSignal): Promise<unknown>;
  inbox(a: { peek?: boolean }): unknown;
  cancelRequest(a: { id: string }): unknown;
  // Present for a block's PO only.
  hireTeammate?(a: HireSpec): unknown;
};

export function mailTools(room: Mailroom, who: EmployeeId, nameOf: (a: ActorId) => string, isPo: boolean): MailTools {
  const present = (m: Message) => {
    const head = { id: m.id, from: nameOf(m.from), at: m.at };
    switch (m.kind) {
      case 'say':
        return { ...head, kind: 'say', text: m.text };
      case 'request':
        return { ...head, kind: 'request', intent: m.intent, title: m.title, text: m.text, ...(m.bar ? { bar: m.bar } : {}), ...(m.artifact ? { artifact: m.artifact } : {}) };
      case 'reply':
        return { ...head, kind: 'reply', requestId: m.requestId, outcome: m.outcome, text: m.text, ...(m.verdict ? { verdict: m.verdict } : {}), ...(m.artifact ? { artifact: m.artifact } : {}), ...(m.blocker ? { blocker: m.blocker } : {}) };
      case 'event':
        return { ...head, kind: 'event', text: m.text };
    }
  };
  const say = (to: string, text: string, urgency: Urgency = 'queue') => room.post({ from: who, to, body: { kind: 'say', text, urgency } });
  return {
    team: () => room.team(who),
    message: (a) => say(a.to, a.text),
    request: (a) => room.post({ from: who, to: a.to, ...(a.key ? { key: a.key } : {}), body: { kind: 'request', text: a.text, ...(a.title ? { title: a.title } : {}), ...(a.intent ? { intent: a.intent } : {}), ...(a.bar ? { bar: a.bar } : {}) } }),
    requestGauntlet: (a) => room.requestGauntlet(who, a),
    reply: ({ why, question, next, ...a }) => room.reply(who, a.requestId, { ...a, ...(a.outcome === 'blocked' && question ? { blocker: { why: why ?? '', question, next: next ?? '' } } : {}) }),
    awaitReplies: async (a, signal) => (await room.await(who, a, signal)).map(present),
    inbox: (a) => room.inbox(who, a.peek ?? false).map(present),
    cancelRequest: (a) => room.cancel(who, a.id),
    ...(isPo ? { hireTeammate: (a: HireSpec) => room.hire(who, a) } : {}),
  };
}
