// What the main process says about the work behind a task: the live summary that rides every snapshot, and the activity log
// that is pulled while a task is open. Kept here, beside the screens that draw it, and fed by its own subscription.
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { ActivityEntry, TaskLive } from '../../../../shared/activity.ts';
import type { ServerMessage } from '../../../../shared/protocol.ts';
import type { Task, TaskId } from '../../../../shared/tasks.ts';
import { send, useStore } from '../../store.ts';

type Log = { entries: ActivityEntry[]; live: TaskLive };
type Feed = { live: Record<TaskId, TaskLive>; logs: Record<TaskId, Log> };

export const useFeed = create<Feed>(() => ({ live: {}, logs: {} }));

// A snapshot rebuilds every summary. One that did not change keeps the object it had, so a card only draws again for its own.
const lastText = new Map<TaskId, string>();
function steady(prev: Record<TaskId, TaskLive>, next: Record<TaskId, TaskLive>): Record<TaskId, TaskLive> {
  const out = {} as Record<TaskId, TaskLive>;
  for (const id of Object.keys(next) as TaskId[]) {
    const text = JSON.stringify(next[id]);
    const old = prev[id];
    out[id] = old && lastText.get(id) === text ? old : next[id]!;
    lastText.set(id, text);
  }
  for (const id of lastText.keys()) if (!(id in next)) lastText.delete(id);
  return out;
}

let started = false;
function start() {
  if (started || !window.office) return;
  started = true;
  const take = (msg: ServerMessage) => {
    if (msg.type === 'snapshot') useFeed.setState((s) => ({ live: steady(s.live, msg.taskLive ?? {}) }));
    else if (msg.type === 'activity') useFeed.setState((s) => ({ logs: { ...s.logs, [msg.taskId]: { entries: msg.entries, live: msg.live } } }));
  };
  window.office.subscribe(take);
  void window.office.getSnapshot().then(take);
}

// What the people on every task are doing, keyed by task. The tags above people's heads read it.
export function useAllLive(): Record<TaskId, TaskLive> {
  useEffect(start, []);
  return useFeed((s) => s.live);
}

// What the people on one task are doing, from the latest snapshot. Undefined for a task nobody has worked on.
export function useTaskLive(taskId: TaskId): TaskLive | undefined {
  useEffect(start, []);
  return useFeed((s) => s.live[taskId]);
}

const REFRESH_MS = 120;

// The log of an open task. It is asked for again whenever the mailroom or the task changed, at most every REFRESH_MS, so a
// burst of ledger entries is one pull.
export function useActivity(task: Task): Log | undefined {
  useEffect(start, []);
  const seq = useStore((s) => s.mail.seq);
  const stamp = `${task.updatedAt}:${task.history?.length ?? 0}:${task.runs.length}`;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      send({ type: 'load_activity', taskId: task.id });
    }, REFRESH_MS);
  }, [task.id, seq, stamp]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    },
    [task.id],
  );
  return useFeed((s) => s.logs[task.id]);
}
