import { useEffect, useState } from 'react';
import type { ActivityEntry, OpenQuestion } from '../../../../shared/activity.ts';
import type { Employee, EmployeeId } from '../../../../shared/protocol.ts';
import type { Task } from '../../../../shared/tasks.ts';
import { send } from '../../store.ts';
import { Avatar } from './Card.tsx';
import { answerKind, breakdownOf, cut, hhmm, namerOf, sayEntry } from './activityView.ts';

type People = ReadonlyMap<EmployeeId, Employee>;

const QUOTE_CHARS = 280;

// A long text opens in place. The first words are enough to tell what it is.
function Words({ text, limit = QUOTE_CHARS }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > limit;
  return (
    <>
      <span className="tb-words">{open || !long ? text : `${text.slice(0, limit).trimEnd()}…`}</span>
      {long && (
        <button type="button" className="tb-more" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  );
}

// ───────────────────────────── Questions ─────────────────────────────

function Question({ task, q, people }: { task: Task; q: OpenQuestion; people: People }) {
  const name = namerOf(people);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), 4000);
    return () => clearTimeout(t);
  }, [sent]);
  const answer = (value: string) => {
    const clean = value.trim();
    if (!clean || sent) return;
    setSent(true);
    setText('');
    send({ type: 'answer_question', taskId: task.id, ref: q.ref, text: clean });
  };
  const kind = answerKind(q);
  const who = people.get(q.asker);
  const b = breakdownOf(q, name);
  return (
    <li className="tb-ask" data-testid="task-question" data-asker={q.asker} data-how={q.how}>
      <div className="tb-ask-head">
        <Avatar person={who} size={22} />
        <b>{name(q.asker)}</b>
        <span>{q.to === 'owner' ? 'asks you' : `asks ${name(q.to)}`}</span>
        <time>{hhmm(q.at)}</time>
      </div>
      {(q.how === 'blocked' || q.how === 'help') && <p className="tb-ask-about">about “{cut(q.piece.title, 70)}”{q.how === 'blocked' ? ', stopped blocked' : ''}</p>}
      <dl className="tb-why" data-testid="question-breakdown" data-structured={q.how === 'blocked' && q.blocker ? 'yes' : 'no'}>
        <dt>Why it stopped</dt>
        <dd data-testid="question-why">
          <Words text={b.why} />
        </dd>
        <dt>The question</dt>
        <dd className="tb-why-q" data-testid="question-text">
          {b.question}
        </dd>
        <dt>Proposed next step</dt>
        <dd data-testid="question-next">{b.next}</dd>
      </dl>
      <p className="tb-ask-then" data-testid="question-then">{b.then}</p>
      {b.full && q.how !== 'permission' && (
        <details className="tb-ask-full">
          <summary>{q.how === 'blocked' ? 'Their whole reply' : 'Their whole message'}</summary>
          <p className="tb-ask-text">
            <Words text={b.full} limit={1200} />
          </p>
        </details>
      )}
      {q.how === 'permission' && (
        <pre className="tb-ask-cmd">
          <span>{q.tool}</span>
          {q.detail}
        </pre>
      )}
      {kind === 'permission' && (
        <div className="tb-ask-opts">
          <button type="button" className="tb-btn primary" disabled={sent} onClick={() => answer('Allow')}>
            Allow
          </button>
          <button type="button" className="tb-btn" disabled={sent} onClick={() => answer('Deny')}>
            Deny
          </button>
        </div>
      )}
      {kind === 'options' && q.how === 'ask' && (
        <div className="tb-ask-opts">
          {q.options?.map((o) => (
            <button key={o} type="button" className="tb-btn" disabled={sent} onClick={() => answer(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      {kind !== 'permission' && (
        <form
          className="tb-answer"
          onSubmit={(e) => {
            e.preventDefault();
            answer(text);
          }}
        >
          <textarea
            aria-label={`Answer ${name(q.asker)}`}
            data-testid="question-answer"
            placeholder={`Answer ${name(q.asker)}…`}
            rows={2}
            value={text}
            disabled={sent}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                answer(text);
              }
            }}
          />
          <button type="submit" className="tb-btn primary" data-testid="question-send" disabled={sent || !text.trim()}>
            {sent ? 'Sent' : 'Answer'}
          </button>
        </form>
      )}
    </li>
  );
}

// What the people on the task are waiting on the owner for, with a box to answer in.
export function Questions({ task, questions, people }: { task: Task; questions: readonly OpenQuestion[]; people: People }) {
  if (!questions.length) return null;
  return (
    <section className="tb-section tb-asks" data-testid="task-questions">
      <h3>
        Waiting on you<span className="tb-count">{questions.length}</span>
      </h3>
      <ul className="tb-ask-list">
        {questions.map((q) => (
          <Question key={q.ref.id} task={task} q={q} people={people} />
        ))}
      </ul>
    </section>
  );
}

// ───────────────────────────── The log ─────────────────────────────

const stamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const day = (at: number) => new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
const FILES_SHOWN = 4;

function Files({ files }: { files: readonly string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  return (
    <ul className="tb-files" data-testid="entry-files">
      {shown.map((f) => (
        <li key={f}>
          <code>{f}</code>
        </li>
      ))}
      {files.length > FILES_SHOWN && (
        <li>
          <button type="button" className="tb-more" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `+${files.length - FILES_SHOWN} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

function Detail({ e }: { e: ActivityEntry }) {
  switch (e.kind) {
    case 'request': {
      // The text of a request usually opens with its title, which the head of the entry already says.
      const body = e.text.startsWith(e.title) ? e.text.slice(e.title.length).trim() : e.text;
      return body ? (
        <p className="tb-log-text">
          <Words text={body} limit={200} />
        </p>
      ) : null;
    }
    case 'say':
      return (
        <p className="tb-log-text">
          <Words text={e.text} limit={200} />
        </p>
      );
    case 'reply':
      return (
        <>
          {e.text && (
            <p className="tb-log-text">
              <Words text={e.text} limit={200} />
            </p>
          )}
          {e.verdict && e.verdict.findings.length > 0 && (
            <ul className="tb-findings" data-testid="entry-verdict">
              {e.verdict.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
          {e.artifact && e.artifact.length > 0 && <Files files={e.artifact} />}
        </>
      );
    case 'stage':
    case 'handoff':
      return e.reason ? (
        <p className="tb-log-text" data-testid="entry-reason">
          <Words text={e.reason} limit={200} />
        </p>
      ) : null;
    default:
      return null;
  }
}

function Entry({ e, name }: { e: ActivityEntry; name: ReturnType<typeof namerOf> }) {
  const words = sayEntry(e, name);
  return (
    <li className={`tb-log-row ${words.tone}`} data-testid="activity-entry" data-kind={e.kind} data-at={e.at}>
      <time>{stamp(e.at)}</time>
      <i className="tb-log-dot" aria-hidden="true" />
      <div className="tb-log-body">
        <p className="tb-log-head">
          <b>{words.head}</b>
          {words.title && <span className="tb-log-title">{words.title}</span>}
          {words.tag && <span className="tb-chip ghost">{words.tag}</span>}
          {e.kind === 'request' && e.answers && <span className="tb-chip ok">Your answer</span>}
          {e.kind === 'say' && e.answers && <span className="tb-chip ok">Your answer</span>}
        </p>
        <Detail e={e} />
      </div>
    </li>
  );
}

// Everything that happened on the task, in the order it happened.
export function ActivityLog({ entries, people }: { entries: readonly ActivityEntry[] | undefined; people: People }) {
  const name = namerOf(people);
  const [quiet, setQuiet] = useState(false);
  const shown = (entries ?? []).filter((e) => !quiet || (e.kind !== 'say' && e.kind !== 'started'));
  return (
    <section className="tb-section" data-testid="task-activity">
      <h3>
        Activity
        <button type="button" className="tb-more" aria-pressed={quiet} onClick={() => setQuiet(!quiet)}>
          {quiet ? 'Show progress notes' : 'Hide progress notes'}
        </button>
      </h3>
      {!entries ? (
        <p className="tb-hint">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="tb-hint">Nothing yet. Every request, reply and move on this task lands here.</p>
      ) : (
        <ol className="tb-log">
          {shown.flatMap((e, i) => {
            const rows = [<Entry key={e.id} e={e} name={name} />];
            if (i === 0 || day(shown[i - 1]!.at) !== day(e.at)) rows.unshift(<li key={`day-${e.id}`} className="tb-log-day">{day(e.at)}</li>);
            return rows;
          })}
        </ol>
      )}
    </section>
  );
}
