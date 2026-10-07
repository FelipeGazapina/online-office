import { useEffect, useState, type KeyboardEvent } from 'react';
import type { Employee, EmployeeId } from '../../../../shared/protocol.ts';
import { PRIORITIES, STAGES, type Board, type Priority, type Task, type TaskStage, type TaskTime } from '../../../../shared/tasks.ts';
import { PRIORITY_LABEL, STAGE_LABEL, fmtAgo, fmtClock, fmtHours, originOf, presenceOf, sharesOf, taskMs } from '../../boardView.ts';
import { send, useStore } from '../../store.ts';
import { isPo } from '../chat/model.ts';
import { ActivityLog, Questions } from './Activity.tsx';
import { namerOf, sayLive } from './activityView.ts';
import { useActivity, useTaskLive } from './live.ts';
import { moveTask } from './actions.ts';
import { Avatar } from './Card.tsx';
import { Alert, Check, Close, External, OriginTile, PriorityIcon, StageIcon } from './icons.tsx';

// A field that saves when the owner leaves it. Esc puts back what is saved. The saved value coming in replaces the draft.
function useDraft(saved: string, commit: (value: string) => void, opt: { multiline?: boolean; allowEmpty?: boolean } = {}) {
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const flush = () => {
    const value = draft.trim();
    if (value === saved) return setDraft(saved);
    if (!value && !opt.allowEmpty) return setDraft(saved);
    commit(value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setDraft(saved);
      e.currentTarget.blur();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && (!opt.multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };
  return { value: draft, onChange: (e: { target: { value: string } }) => setDraft(e.target.value), onBlur: flush, onKeyDown };
}

// The only place hours leave the app: what CronoSpark already has, what it does not, and the owner's button.
function SendHours({ task, time, people }: { task: Task; time: TaskTime | undefined; people: ReadonlyMap<EmployeeId, Employee> }) {
  const connected = useStore((s) => s.taskConnections.cronospark.kind === 'ready');
  const sent = Object.entries(task.hours?.pushed ?? {})
    .map(([who, days]) => [who as EmployeeId, Object.values(days ?? {}).reduce<number>((sum, ms) => sum + (ms ?? 0), 0)] as [EmployeeId, number])
    .filter(([, ms]) => ms > 0);
  const unsent = (Object.entries(time?.unsent ?? {}) as [EmployeeId, number][]).filter(([, ms]) => ms > 0);
  const sending = !!task.hours?.inflight;
  const reason = sending
    ? undefined
    : !connected
      ? 'CronoSpark is not connected. Connect it in the board settings.'
      : unsent.length
        ? undefined
        : time?.running.length
          ? 'Time that is still running can be sent once the turn ends.'
          : 'Nothing to send yet.';
  const list = (rows: [EmployeeId, number][]) => rows.map(([who, ms]) => `${people.get(who)?.name ?? 'Former employee'} ${fmtHours(ms)}`).join(', ');
  return (
    <div className="tb-send" data-testid="task-send-hours">
      <p className="tb-hint" data-testid="hours-sent">{sent.length ? `Sent to CronoSpark: ${list(sent)}.` : 'Nothing sent to CronoSpark yet.'}</p>
      {unsent.length > 0 && <p className="tb-hint" data-testid="hours-unsent">Not sent yet: {list(unsent)}.</p>}
      <button type="button" className={`tb-btn ${reason || sending ? '' : 'primary'}`} data-testid="send-hours" disabled={!!reason || sending} onClick={() => send({ type: 'send_hours', taskId: task.id })}>
        {sending ? 'Sending…' : 'Send hours to CronoSpark'}
      </button>
      {reason && <p className="tb-hint" data-testid="send-hours-reason">{reason}</p>}
    </div>
  );
}

const RUN_WORD = { done: 'finished', blocked: 'is blocked', failed: 'failed', declined: 'was declined', cancelled: 'was cancelled' } as const;

type Props = {
  task: Task;
  board: Board;
  blockPeople: readonly Employee[];
  people: ReadonlyMap<EmployeeId, Employee>;
  time: TaskTime | undefined;
  stage: TaskStage;
  now: number;
  onClose: () => void;
};

export function Detail({ task, board, blockPeople, people, time, stage, now, onClose }: Props) {
  const origin = originOf(task);
  const manual = task.origin.kind === 'manual';
  const title = useDraft(task.title, (v) => send({ type: 'update_task', taskId: task.id, title: v }));
  const notes = useDraft(task.notes ?? '', (v) => send({ type: 'update_task', taskId: task.id, notes: v }), { multiline: true, allowEmpty: true });
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(false), [task.id]);
  const shares = sharesOf(time, now);
  const total = taskMs(time, now);
  const top = shares[0]?.ms || 1;
  const outcome = task.lastOutcome;
  const log = useActivity(task);
  const snapshotLive = useTaskLive(task.id);
  const live = log?.live ?? snapshotLive;
  const name = namerOf(people);

  return (
    <aside className="tb-dock tb-detail" aria-label="Task details" data-testid="task-detail">
      <header className="tb-dock-head">
        <span className="tb-ref">
          <OriginTile kind={origin.kind} />
          {origin.url ? (
            <a href={origin.url} target="_blank" rel="noreferrer" data-testid="origin-link">
              {origin.ref}
              <External size={12} />
            </a>
          ) : (
            <span className="tb-ref-text">{origin.ref}</span>
          )}
          <small>{manual ? board.name : origin.source}</small>
        </span>
        <button type="button" className="tb-icon" aria-label="Close details" onClick={onClose}>
          <Close />
        </button>
      </header>
      <div className="tb-dock-body">
        {manual ? (
          <input className="tb-title-input" aria-label="Title" {...title} />
        ) : (
          <>
            <h2 className="tb-title-static">{task.title}</h2>
            <p className="tb-hint">The title comes from {origin.source}, so it is edited there.</p>
          </>
        )}
        <textarea className="tb-notes" aria-label="Notes" placeholder="Notes for whoever picks this up" rows={4} {...notes} />

        <dl className="tb-props">
          <dt>Status</dt>
          <dd>
            <label className="tb-select">
              <StageIcon stage={stage} />
              <select aria-label="Status" value={stage} onChange={(e) => moveTask(task, e.target.value as TaskStage)}>
                {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
              </select>
            </label>
            {origin.providerStatus && task.runs.length === 0 && <span className="tb-chip ghost" title={`${origin.source} says`}>{origin.providerStatus}</span>}
          </dd>
          {task.origin.kind === 'manual' && (
            <>
              <dt>Priority</dt>
              <dd>
                <label className="tb-select">
                  <PriorityIcon priority={task.origin.priority} size={14} />
                  <select aria-label="Priority" value={task.origin.priority ?? ''} onChange={(e) => send({ type: 'update_task', taskId: task.id, priority: (e.target.value || null) as Priority | null })}>
                    <option value="">No priority</option>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                  </select>
                </label>
              </dd>
            </>
          )}
          <dt>Source</dt>
          <dd>
            <span>{manual ? 'Added here' : origin.source}</span>
            {!manual && origin.priority && <span className="tb-chip">{origin.priority}</span>}
          </dd>
          <dt>Board</dt>
          <dd>{board.name}</dd>
        </dl>

        <Questions task={task} questions={live?.questions ?? []} people={people} />

        <section className="tb-section">
          <h3>Assign</h3>
          {blockPeople.length === 0 && <p className="tb-hint">Hire someone in this block to hand them work.</p>}
          <ul className="tb-people">
            {blockPeople.map((p) => {
              const on = task.assignees.includes(p.id);
              const running = !!time?.running.some((r) => r.employeeId === p.id);
              const presence = presenceOf(p);
              const mine = live?.people.find((l) => l.employeeId === p.id);
              const words = mine && mine.state !== 'idle' ? sayLive(mine, name) : undefined;
              return (
                <li key={p.id} data-employee={p.id}>
                  <Avatar person={p} size={26} />
                  <span className="tb-person">
                    <b>{p.name}</b>
                    {isPo(p) && <small className="tb-po">PO</small>}
                    {words ? (
                      <em className={`live st-${words.state}`} data-testid="person-live" data-state={words.state}>{words.text}</em>
                    ) : (
                      <em className={presence.kind}>{presence.word}</em>
                    )}
                  </span>
                  {running ? (
                    <span className="tb-chip running"><i className="tb-live" />On it</span>
                  ) : (
                    <button type="button" className={`tb-btn ${on ? '' : 'primary'}`} onClick={() => send({ type: 'assign_task', taskId: task.id, employeeId: p.id })}>
                      {on ? 'Assign again' : 'Assign'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="tb-section" data-testid="task-hours">
          <h3>
            Time
            <span className={`tb-total ${time?.running.length ? 'running' : ''}`} data-testid="task-total">{fmtClock(total)}</span>
          </h3>
          {shares.length === 0 ? (
            <p className="tb-hint">No time yet. Time counts from the moment someone starts on this.</p>
          ) : (
            <ul className="tb-shares">
              {shares.map((s) => (
                <li key={s.employeeId} data-employee={s.employeeId}>
                  <Avatar person={people.get(s.employeeId)} size={20} />
                  <span className="tb-share-name">{people.get(s.employeeId)?.name ?? 'Former employee'}</span>
                  <span className="tb-bar"><i style={{ width: `${Math.max(2, (s.ms / top) * 100)}%` }} /></span>
                  <b className={s.running ? 'running' : ''} data-testid="share-time" data-ms={Math.round(s.ms)}>{fmtClock(s.ms)}</b>
                </li>
              ))}
            </ul>
          )}
          {task.origin.kind === 'cronospark' && <SendHours task={task} time={time} people={people} />}
          {task.hours?.error && (
            <p className="tb-note bad">
              <Alert size={13} /> {task.hours.error.message}
            </p>
          )}
        </section>

        {outcome && (
          <section className="tb-section">
            <h3>Last run</h3>
            <p className={`tb-note ${outcome.outcome === 'done' ? 'ok' : 'bad'}`}>
              {outcome.outcome === 'done' ? <Check size={13} /> : <Alert size={13} />} The last run {RUN_WORD[outcome.outcome]} {fmtAgo(now - outcome.at)}.
            </p>
            <p className="tb-quote">{outcome.text.length > 420 ? `${outcome.text.slice(0, 420)}…` : outcome.text}</p>
          </section>
        )}

        <ActivityLog entries={log?.entries} people={people} />
      </div>
      {manual && (
        <footer className="tb-dock-foot">
          <button
            type="button"
            className={`tb-btn danger ${armed ? 'armed' : ''}`}
            onBlur={() => setArmed(false)}
            onClick={() => {
              if (!armed) return setArmed(true);
              send({ type: 'delete_task', taskId: task.id });
              onClose();
            }}
          >
            {armed ? (task.runs.length ? 'Stop the runs and delete?' : 'Really delete?') : 'Delete task'}
          </button>
        </footer>
      )}
    </aside>
  );
}
