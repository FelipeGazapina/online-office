import { memo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Employee, EmployeeId } from '../../../../shared/protocol.ts';
import type { PrState, Task, TaskStage, TaskTime } from '../../../../shared/tasks.ts';
import { fmtClock, fmtHours, isRunning, originOf, providerNote, sharesOf, taskMs } from '../../boardView.ts';
import { avatarColor, isPo } from '../chat/model.ts';
import { breakdownOf, cardLine, namerOf, questionCount } from './activityView.ts';
import { useTaskLive } from './live.ts';
import { openOnComputer } from '../../computer.ts';
import { Alert, Branch, Check, Clock, External, OriginTile } from './icons.tsx';

export function Avatar({ person, size = 22, layer }: { person: Employee | undefined; size?: number; layer?: number }) {
  return (
    <i
      className={`tb-av ${person && isPo(person) ? 'po' : ''}`}
      style={{ width: size, height: size, fontSize: size * 0.48, background: person ? avatarColor(person.id) : '#b9bacb', ...(layer ? { zIndex: layer } : {}) }}
      data-employee={person?.id}
      title={person ? `${person.name}${isPo(person) ? ' (PO)' : ''}` : 'Former employee'}
    >
      {person?.name[0] ?? '?'}
    </i>
  );
}

const MAX_AVATARS = 3;

export function AvatarStack({ ids, people }: { ids: readonly EmployeeId[]; people: ReadonlyMap<EmployeeId, Employee> }) {
  if (!ids.length) return <i className="tb-av empty" aria-label="No assignee" title="No assignee" style={{ width: 22, height: 22 }} />;
  return (
    <span className="tb-av-stack" aria-label={`Assigned to ${ids.map((id) => people.get(id)?.name ?? 'a former employee').join(', ')}`}>
      {ids.slice(0, MAX_AVATARS).map((id, i) => <Avatar key={id} person={people.get(id)} layer={MAX_AVATARS - i} />)}
      {ids.length > MAX_AVATARS && <i className="tb-av more" style={{ width: 22, height: 22 }}>+{ids.length - MAX_AVATARS}</i>}
    </span>
  );
}

// Time on a task. Hovering it lists everyone who worked and keeps counting for whoever still is.
export function TimeChip({ time, now, people }: { time: TaskTime | undefined; now: number; people: ReadonlyMap<EmployeeId, Employee> }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  if (!time || (time.totalMs === 0 && !isRunning(time))) return null;
  const running = isRunning(time);
  const shares = at ? sharesOf(time, now) : [];
  return (
    <span
      className={`tb-chip tb-time ${running ? 'running' : ''}`}
      data-testid="task-timer"
      data-running={running}
      data-ms={Math.round(taskMs(time, now))}
      tabIndex={-1}
      onPointerEnter={(e) => setAt(e.currentTarget.getBoundingClientRect())}
      onPointerLeave={() => setAt(null)}
    >
      {running ? <i className="tb-live" aria-hidden="true" /> : <Clock size={11} />}
      {fmtClock(taskMs(time, now))}
      {at &&
        createPortal(
          <div className="tb-pop" style={{ left: at.left, top: at.bottom + 6 }} role="tooltip">
            {shares.map((s) => (
              <div key={s.employeeId}>
                <Avatar person={people.get(s.employeeId)} size={16} />
                <span>{people.get(s.employeeId)?.name ?? 'Former employee'}</span>
                <b>{fmtClock(s.ms)}</b>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

export const PR_STATE_LABEL: Record<PrState, string> = { draft: 'Draft', open: 'Open', merged: 'Merged', closed: 'Closed' };

// Where the task stands on GitHub: its pull request and the state it is in, or why there is none. Nothing for a task with no branch.
export function PrChip({ task }: { task: Task }) {
  const git = task.git;
  if (!git) return null;
  if (!git.pr) return git.note ? <span className="tb-chip ghost" data-testid="card-pr-note" title={git.note}><Branch size={11} />No PR</span> : null;
  const { number, url, state } = git.pr;
  return (
    <a className={`tb-chip tb-pr ${state}`} href={url} target="_blank" rel="noreferrer" data-testid="card-pr" data-pr-state={state} title={`Pull request #${number} is ${PR_STATE_LABEL[state].toLowerCase()}. Open it on GitHub at your Mac.`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); openOnComputer(url); }}>
      <Branch size={11} />#{number} {PR_STATE_LABEL[state]}
    </a>
  );
}

type CardProps = {
  task: Task;
  stage: TaskStage;
  time: TaskTime | undefined;
  now: number;
  people: ReadonlyMap<EmployeeId, Employee>;
  selected: boolean;
  dragging: boolean;
  onOpen: (task: Task) => void;
  onPress: (task: Task, stage: TaskStage, e: PointerEvent<HTMLElement>) => void;
  onKey: (task: Task, stage: TaskStage, e: KeyboardEvent<HTMLElement>) => void;
  wasDragged: () => boolean;
  ghost?: boolean;
};

export const Card = memo(function Card({ task, stage, time, now, people, selected, dragging, onOpen, onPress, onKey, wasDragged, ghost }: CardProps) {
  const origin = originOf(task);
  const running = isRunning(time);
  const outcome = task.lastOutcome && !running ? task.lastOutcome.outcome : undefined;
  const hoursError = task.hours?.error;
  const unsent = Object.values(time?.unsent ?? {}).reduce<number>((sum, ms) => sum + (ms ?? 0), 0);
  const providerStatus = providerNote(task, stage);
  const live = useTaskLive(task.id);
  const name = namerOf(people);
  const line = cardLine(live, name);
  const asks = questionCount(live);
  const first = live?.questions[0];
  return (
    <div
      className={`tb-card ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${running ? 'running' : ''}`}
      role={ghost ? undefined : 'button'}
      tabIndex={ghost ? undefined : 0}
      aria-hidden={ghost || undefined}
      data-task-id={ghost ? undefined : task.id}
      data-origin={origin.kind}
      aria-pressed={ghost ? undefined : selected}
      aria-label={ghost ? undefined : `${origin.ref}: ${task.title}`}
      onPointerDown={(e) => onPress(task, stage, e)}
      onClick={() => !wasDragged() && onOpen(task)}
      onKeyDown={(e) => onKey(task, stage, e)}
    >
      <div className="tb-card-top">
        <span className="tb-ref">
          <OriginTile kind={origin.kind} />
          {origin.url ? (
            <a href={origin.url} target="_blank" rel="noreferrer" title={`Open ${origin.ref} in ${origin.source}`} onClick={(e) => e.stopPropagation()}>
              {origin.ref}
              <External size={11} />
            </a>
          ) : (
            <span className="tb-ref-text">{origin.ref}</span>
          )}
        </span>
        <AvatarStack ids={task.assignees} people={people} />
      </div>
      <p className="tb-card-title"><span className="tb-ref-text tb-no" data-task-no={task.number}>#{task.number}</span> {task.title}</p>
      {first && (
        <p className="tb-card-ask" data-testid="card-question">
          <b>{name(first.asker)} asks</b> {breakdownOf(first, name).question}
        </p>
      )}
      <div className="tb-chips">
        <TimeChip time={time} now={now} people={people} />
        <PrChip task={task} />
        {asks > 0 && (
          <span className="tb-chip ask" data-testid="question-badge" data-count={asks} title={live?.questions.map((q) => `${name(q.asker)}: ${breakdownOf(q, name).question}`).join('\n')}>
            <b aria-hidden="true">?</b>
            {asks} {asks === 1 ? 'question' : 'questions'}
          </span>
        )}
        {line && <span className={`tb-chip live st-${line.state}`} data-testid="card-live" data-state={line.state}>{line.text}</span>}
        {task.handoff && <span className="tb-chip ghost" data-testid="card-handoff" title={task.handoff.reason}>To {name(task.handoff.to)}, waits on {name(task.handoff.awaits)}</span>}
        {outcome === 'done' && stage !== 'done' && <span className="tb-chip ok" title={task.lastOutcome?.text.slice(0, 200)}><Check size={11} />Run done</span>}
        {outcome && outcome !== 'done' && <span className="tb-chip bad" title={task.lastOutcome?.text.slice(0, 200)}><Alert size={11} />Run {outcome}</span>}
        {origin.priority && <span className="tb-chip">{origin.priority}</span>}
        {providerStatus && <span className="tb-chip ghost">{providerStatus}</span>}
        {hoursError && <span className="tb-chip bad" title={hoursError.message}><Alert size={11} />Hours not sent</span>}
        {unsent > 0 && <span className="tb-chip" data-testid="unsent-chip" title="Worked, and not sent to CronoSpark yet">{fmtHours(unsent)} to send</span>}
      </div>
    </div>
  );
});
