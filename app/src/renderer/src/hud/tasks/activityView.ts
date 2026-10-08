// How the activity of a task reads: a sentence per person and per log entry. Pure, so verify/activity-view-check.ts runs it.
import type { ActivityEntry, OpenQuestion, PersonLive, TaskLive, Wait } from '../../../../shared/activity.ts';
import type { ActorId, Intent, Outcome } from '../../../../shared/mail.ts';
import type { Employee, EmployeeId } from '../../../../shared/protocol.ts';
import { STAGE_LABEL } from '../../boardView.ts';

export type Namer = (id: ActorId) => string;

// Who an actor is called on screen. The owner is you.
export const namerOf = (people: ReadonlyMap<EmployeeId, Employee>): Namer => (id) => (id === 'owner' ? 'You' : id === 'mailroom' ? 'The office' : (people.get(id)?.name ?? 'Former employee'));

export const cut = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};
const piece = (title: string, max = 48) => `“${cut(title, max)}”`;
export const hhmm = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

const WAIT_STATE: Record<Wait['state'], string> = { queued: 'queued', working: 'working', building: 'building', reviewing: 'reviewing' };

function sayWait(w: Wait, name: Namer): string {
  const how = w.state === 'working' ? '' : ` (${WAIT_STATE[w.state]}${w.round ? ` round ${w.round}` : ''})`;
  return `${name(w.who)}${how} for ${piece(w.piece.title, 40)}`;
}

export type LiveWords = { state: PersonLive['state']; text: string };

// What the detail shows under a person's name: a line, or one line per person they wait on.
export function sayLive(p: PersonLive, name: Namer): LiveWords {
  switch (p.state) {
    case 'working':
      return { state: p.state, text: `Working on ${piece(p.piece.title)} since ${hhmm(p.since)}${p.on.length ? `, waiting on ${p.on.map((w) => name(w.who)).join(', ')}` : ''}` };
    case 'waiting':
      return { state: p.state, text: p.on.length ? `Waiting since ${hhmm(p.since)} on\n${p.on.map((w) => `• ${sayWait(w, name)}`).join('\n')}` : `Holding ${piece(p.piece.title)} since ${hhmm(p.since)}` };
    case 'queued':
      return { state: p.state, text: `Next up: ${piece(p.piece.title)}${p.behind ? `, after ${piece(p.behind, 36)}` : ''}` };
    case 'blocked':
      return { state: p.state, text: `Blocked: ${piece(breakdownOf(p.question, name).question, 90)}` };
    case 'done':
      return { state: p.state, text: `Done ${piece(p.piece.title)}${p.artifact?.length ? `, ${p.artifact.length} file${p.artifact.length === 1 ? '' : 's'}` : ''}` };
    case 'stopped':
      return { state: p.state, text: `${p.outcome[0]!.toUpperCase()}${p.outcome.slice(1)}: ${piece(p.piece.title)}` };
    case 'idle':
      return { state: p.state, text: 'Idle' };
  }
}

const uniq = (names: string[]) => [...new Set(names)];
const list = (names: string[], max = 2) => (names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', '));

// What a card says about the work behind it when the timer does not: who is on it, or who everyone is waiting for.
export function cardLine(live: TaskLive | undefined, name: Namer): LiveWords | undefined {
  if (!live) return undefined;
  const of = (state: PersonLive['state']) => live.people.filter((p) => p.state === state);
  const working = of('working');
  if (working.length) return { state: 'working', text: `${list(uniq(working.map((p) => name(p.employeeId))))} working` };
  const waiting = of('waiting') as Extract<PersonLive, { state: 'waiting' }>[];
  if (waiting.length) {
    const on = uniq(waiting.flatMap((p) => p.on.map((w) => name(w.who))));
    return { state: 'waiting', text: on.length ? `${list(uniq(waiting.map((p) => name(p.employeeId))), 1)} waiting on ${list(on)}` : `${list(uniq(waiting.map((p) => name(p.employeeId))))} holding` };
  }
  const queued = of('queued');
  if (queued.length) return { state: 'queued', text: `${list(uniq(queued.map((p) => name(p.employeeId))))} queued` };
  return undefined;
}

export const questionCount = (live: TaskLive | undefined): number => live?.questions.length ?? 0;

const INTENT_WORD: Record<Intent, string> = { work: 'asked', help: 'asked for help', review: 'asked to review', gauntlet: 'started a gauntlet with' };
const OUTCOME_WORD: Record<Outcome, string> = { done: 'finished', blocked: 'is blocked', failed: 'failed', declined: 'was declined', cancelled: 'was cancelled' };

export type EntryWords = { head: string; title?: string; tag?: string; tone: 'plain' | 'ok' | 'bad' | 'warn' | 'quiet' };

// The first line of a log entry. The text, files and verdict that go with it are drawn from the entry itself.
export function sayEntry(e: ActivityEntry, name: Namer): EntryWords {
  switch (e.kind) {
    case 'created':
      return { head: e.by === 'owner' ? 'You made this task' : 'This task came from its provider', tone: 'quiet' };
    case 'request':
      return {
        head: `${name(e.from)} ${INTENT_WORD[e.intent]} ${name(e.to)}`,
        title: e.title,
        ...(e.round ? { tag: `${e.round.role === 'build' ? 'Build' : 'Review'} round ${e.round.n}` } : {}),
        tone: 'plain',
      };
    case 'started':
      return { head: `${name(e.who)} ${e.again ? 'picked it up again' : 'started'}`, title: e.title, tone: 'quiet' };
    case 'say':
      return { head: `${name(e.from)} to ${name(e.to)}`, tone: 'plain' };
    case 'reply':
      return {
        head: `${name(e.from)} ${e.verdict ? (e.verdict.pass ? 'passed it' : 'failed it') : OUTCOME_WORD[e.outcome]}`,
        title: e.title,
        ...(e.round ? { tag: `${e.round.role === 'build' ? 'Build' : 'Review'} round ${e.round.n}` } : {}),
        tone: e.verdict ? (e.verdict.pass ? 'ok' : 'bad') : e.outcome === 'done' ? 'ok' : e.outcome === 'blocked' ? 'warn' : 'bad',
      };
    case 'event':
      return { head: e.text, tone: 'quiet' };
    case 'recovered':
      return { head: `The app restarted. Back in the queue: ${e.requeued.map((r) => `${name(r.who)}’s ${piece(r.title, 40)}`).join(', ')}`, tone: 'warn' };
    case 'stage':
      return { head: `Moved to ${STAGE_LABEL[e.to]} by ${e.by === 'owner' ? 'you' : e.by === 'mailroom' ? 'the office' : e.by === 'provider' ? 'the provider' : name(e.by)}`, tone: 'plain' };
    case 'assign':
      return { head: `${name(e.by)} gave it to ${name(e.employeeId)}`, tone: 'plain' };
    case 'hours':
      return { head: e.error ? `Could not send ${e.hours} h for ${name(e.employeeId)} (${e.date})` : `Sent ${e.hours} h for ${name(e.employeeId)} (${e.date}) to CronoSpark`, tone: e.error ? 'bad' : 'plain' };
    case 'handoff':
      return sayHandoff(e, name);
  }
}

// A step of a handoff. `by` took it: the one who asked for a proposal, the one who answered for an answer.
function sayHandoff(e: Extract<ActivityEntry, { kind: 'handoff' }>, name: Namer): EntryWords {
  const to = name(e.to);
  switch (e.step) {
    case 'proposed':
      return { head: `${name(e.by)} asked ${e.by === e.from ? 'to hand' : `${name(e.from)} to hand`} this to ${to}`, tone: 'plain' };
    case 'accepted':
      return { head: `${name(e.by)} agreed: ${to} has it now`, tone: 'ok' };
    case 'declined':
      return { head: `${name(e.by)} declined the handoff to ${to}`, tone: 'warn' };
    case 'withdrawn':
      return { head: `${name(e.by)} withdrew the handoff to ${to}`, tone: 'quiet' };
    case 'dropped':
      return { head: `The office dropped the handoff to ${to}`, tone: 'quiet' };
  }
}

export type Breakdown = { why: string; question: string; next: string; then: string; full?: string };

// The first sentence of a text that asks something, so an old blocked reply still leads with its question.
const asked = (text: string): string | undefined => text.split(/(?<=[.!?])\s+|\n+/).map((q) => q.trim()).find((q) => q.length > 3 && q.endsWith('?'));

// One question as the owner reads it: what stopped the work, what to answer, the step proposed after it, and what the owner's
// answer does. A blocked reply that gave its breakdown is shown as given, with its full text kept behind. One that did not
// keeps its text as the why.
export function breakdownOf(q: OpenQuestion, name: Namer): Breakdown {
  const who = name(q.asker);
  switch (q.how) {
    case 'blocked': {
      const said = q.blocker;
      const then = q.to === 'owner' ? `Your answer goes to ${who} as a new request, and ${who} picks ${piece(q.piece.title, 40)} up again.` : `Your answer goes to ${name(q.to)}, who asked ${who} for it, to send ${who} on.`;
      if (said) return { why: said.why || `${who} stopped on ${piece(q.piece.title, 40)}.`, question: said.question, next: said.next || `${who} did not say.`, then, full: q.text };
      return { why: q.text, question: asked(q.text) ?? `${who} did not ask anything. What should ${who} do next on ${piece(q.piece.title, 40)}?`, next: `${who} did not say.`, then };
    }
    case 'help':
      return { why: `${who} asked ${name(q.to)} for help on ${piece(q.piece.title, 40)}.`, question: asked(q.text) ?? cut(q.text, 200), next: `${who} carries on with the answer.`, then: `Your answer goes to ${who}. ${name(q.to)} can still answer too.`, full: q.text };
    case 'ask':
      return { why: `${who} cannot go on without your decision.`, question: q.text, next: `${who} carries on with your answer.`, then: q.options?.length ? 'Pick one, or write your own answer.' : 'Write your answer below.' };
    case 'permission':
      return { why: `${who} needs your permission to run ${q.tool}.`, question: `Allow ${q.tool}?`, next: `${who} runs it and carries on.`, then: `Allow lets it run. Deny stops it, and ${who} looks for another way.`, full: q.detail };
  }
}

// Whether a question asks for words, for a choice, or for a yes or no.
export const answerKind = (q: OpenQuestion): 'text' | 'options' | 'permission' => (q.how === 'permission' ? 'permission' : q.how === 'ask' && q.options?.length ? 'options' : 'text');
