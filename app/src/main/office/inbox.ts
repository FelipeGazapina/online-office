// The owner's inbox: what each employee is waiting to hear back on. It lives in the office, not in an adapter,
// so every harness gets the same behavior. Plain Node: the MCP check script runs this file directly.
import { randomUUID } from 'node:crypto';
import type { EmployeeId, Question, QuestionBody, QuestionId } from '../../shared/protocol.ts';
import { logger } from './debug.ts';

const debug = logger('inbox');

// The question that just left the owner's desk, and whether the owner answered it or the caller took it back.
export type Left = { question: Question; answered: boolean };

export type InboxEvents = {
  // `head` is the question on the owner's desk for this employee, or undefined when none is waiting.
  headChanged(employeeId: EmployeeId, head: Question | undefined, left: Left | undefined): void;
};

type Entry = { question: Question; settle(text: string): void };

// One first-in-first-out line per employee. The owner sees only the front of each line. A harness that runs tools in
// parallel can have several questions open, and the next one appears when the front one is answered.
export class Inbox {
  private readonly lines = new Map<EmployeeId, Entry[]>();
  private readonly events: InboxEvents;

  constructor(events: InboxEvents) {
    this.events = events;
  }

  pending(employeeId: EmployeeId): readonly Question[] {
    return (this.lines.get(employeeId) ?? []).map((e) => e.question);
  }

  // Resolves with the owner's answer. It never rejects: when the caller aborts, or the session ends before an
  // answer, the question is withdrawn and the promise resolves with '', which nobody is listening for any more.
  ask(employeeId: EmployeeId, body: QuestionBody, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.resolve('');
    const question: Question = { ...body, id: randomUUID() as QuestionId, askedAt: Date.now() };
    return new Promise((resolve) => {
      const onAbort = () => this.withdraw(employeeId, question.id);
      signal?.addEventListener('abort', onAbort, { once: true });
      const entry: Entry = {
        question,
        settle: (text) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(text);
        },
      };
      const line = this.lines.get(employeeId) ?? [];
      line.push(entry);
      this.lines.set(employeeId, line);
      debug(`${employeeId} ${question.kind} question, ${line.length - 1} ahead of it`);
      if (line.length === 1) this.events.headChanged(employeeId, question, undefined);
    });
  }

  // Answers the question on the owner's desk. False when `questionId` is not the front of the line, a stale card.
  answer(employeeId: EmployeeId, questionId: QuestionId, text: string): boolean {
    if (this.lines.get(employeeId)?.[0]?.question.id !== questionId) return false;
    this.remove(employeeId, 0, text, true);
    return true;
  }

  // The session is over (fired, reset, moved, quit). Nothing is shown and nobody's answer is coming.
  clear(employeeId: EmployeeId) {
    const line = this.lines.get(employeeId) ?? [];
    this.lines.delete(employeeId);
    for (const entry of line) entry.settle('');
  }

  private withdraw(employeeId: EmployeeId, questionId: QuestionId) {
    const index = this.lines.get(employeeId)?.findIndex((e) => e.question.id === questionId) ?? -1;
    if (index >= 0) this.remove(employeeId, index, '', false);
  }

  private remove(employeeId: EmployeeId, index: number, text: string, answered: boolean) {
    const line = this.lines.get(employeeId)!;
    const [entry] = line.splice(index, 1);
    if (!line.length) this.lines.delete(employeeId);
    // The card changes before the caller wakes up, so the owner never sees a stale card next to a working employee.
    if (index === 0) this.events.headChanged(employeeId, line[0]?.question, { question: entry!.question, answered });
    entry!.settle(text);
  }
}
