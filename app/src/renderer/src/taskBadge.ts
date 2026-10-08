// The task numbers above a person's head. People on the same task show the same number, so the owner sees who works together.
// Pure: verify/badge-check.mjs runs it in plain Node.
import type { PersonLive, TaskLive } from '../../shared/activity.ts';
import type { Task, TaskId } from '../../shared/tasks.ts';

// On the task now: doing a piece, waiting on a reply, queued behind other work, or asking the owner.
const ON_IT: ReadonlySet<PersonLive['state']> = new Set(['working', 'waiting', 'queued', 'blocked']);

export function taskNumbersOf(employeeId: string, tasks: readonly Task[], live: Readonly<Record<TaskId, TaskLive | undefined>>): number[] {
  const numbers = new Set<number>();
  for (const t of tasks) {
    if (live[t.id]?.people.some((p) => p.employeeId === employeeId && ON_IT.has(p.state))) numbers.add(t.number);
  }
  return [...numbers].sort((a, b) => a - b);
}

// The golden angle apart, so neighbouring numbers never get close hues.
export const taskHue = (n: number): number => (n * 137.508) % 360;
