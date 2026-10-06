import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Employee } from '../../../../shared/protocol.ts';
import { PRIORITIES, type Board, type Priority, type TaskStage } from '../../../../shared/tasks.ts';
import { PRIORITY_LABEL, STAGE_LABEL, assigneeOf, landingStage, listStep, nextDraft, presenceOf, type Draft } from '../../boardView.ts';
import { isPo } from '../chat/model.ts';
import { createTaskFrom } from './actions.ts';
import { Avatar } from './Card.tsx';
import { Chevron, Notes, PriorityIcon, StageIcon } from './icons.tsx';

type PickerId = 'assignee' | 'priority';

type Option<V> = { key: string; value: V; text: string; node: ReactNode };

// A list opened under the pills, in the card's flow so the hint and the Create button stay in view. Arrow keys move through it,
// Enter picks, Esc shuts it and Tab moves on from its pill. Focus never leaves the composer, so the composer can tell a click
// away from a click inside.
function Menu<V>({ label, options, current, onPick, onShut, children }: { label: string; options: Option<V>[]; current: V; onPick: (value: V) => void; onShut: () => void; children?: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  const items = () => [...(list.current?.querySelectorAll<HTMLElement>('[role=option]') ?? [])];
  useEffect(() => {
    const all = items();
    (all.find((el) => el.getAttribute('aria-selected') === 'true') ?? all[0])?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onShut();
    } else if (e.key === 'Tab') onShut();
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const all = items();
      all[listStep(all.indexOf(document.activeElement as HTMLElement), all.length, e.key)]?.focus();
    }
  };
  return (
    <div className="tb-menu" onKeyDown={onKeyDown}>
      <div role="listbox" aria-label={label} ref={list}>
        {options.map((o) => (
          <button key={o.key} type="button" role="option" tabIndex={-1} aria-selected={o.value === current} className="tb-opt" data-value={o.key} onClick={() => onPick(o.value)}>
            {o.node}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

function PersonOption({ person }: { person: Employee }) {
  const presence = presenceOf(person);
  return (
    <>
      <Avatar person={person} size={22} />
      <span className="tb-opt-name">
        <b>{person.name}</b>
        {isPo(person) && <small className="tb-po">PO</small>}
      </span>
      <em className={`tb-presence ${presence.kind}`}>
        <i className="tb-dot" />
        {presence.word}
      </em>
    </>
  );
}

const noOne = (stage: TaskStage): Option<string | undefined> => ({
  key: 'none',
  value: undefined,
  text: 'No one yet',
  node: (
    <>
      <i className="tb-av empty" style={{ width: 22, height: 22 }} />
      <span className="tb-opt-name"><b>No one yet</b><small>Stays in {STAGE_LABEL[stage]}</small></span>
    </>
  ),
});

const priorityOptions: Option<Priority | undefined>[] = [
  { key: 'none', value: undefined, text: 'No priority', node: <><PriorityIcon priority={undefined} /><span className="tb-opt-name"><b>No priority</b></span></> },
  ...PRIORITIES.map((p) => ({ key: p, value: p as Priority | undefined, text: PRIORITY_LABEL[p], node: <><PriorityIcon priority={p} /><span className="tb-opt-name"><b>{PRIORITY_LABEL[p]}</b></span></> })),
];

type Props = { board: Board; stage: TaskStage; team: readonly Employee[]; onDone: () => void };

// A card made inline. Type a title and press Enter and it is made in this column. Under the title the card can be given to
// someone (it then starts at once, in In Progress), given a priority and notes. Cmd+Enter or Create more keeps it open for
// the next, with the same person and priority. Esc cancels.
export function Composer({ board, stage, team, onDone }: Props) {
  const [draft, setDraft] = useState<Draft>({ title: '', notes: '' });
  const [notesOpen, setNotesOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<PickerId | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const pills = useRef<Record<PickerId, HTMLButtonElement | null>>({ assignee: null, priority: null });

  const who = assigneeOf(draft, team);
  const lands = landingStage(stage, who);
  const ready = !!draft.title.trim();
  const pristine = !ready && !draft.notes.trim();
  const patch = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));

  const submit = (keepOpen: boolean) => {
    if (!createTaskFrom(board, stage, draft, team)) return void title.current?.focus();
    if (!keepOpen) return onDone();
    setDraft(nextDraft(draft));
    title.current?.focus();
  };
  // A pick hands focus to the title, so Enter right after picking someone makes the task.
  const pick = (next: Partial<Draft>) => {
    patch(next);
    setOpen(null);
    title.current?.focus();
  };
  // Shutting a list puts focus on its pill. For Tab that is where the browser moves on from.
  const shut = (id: PickerId) => () => {
    setOpen(null);
    pills.current[id]?.focus();
  };

  const pill = (id: PickerId, label: string, body: ReactNode) => (
    <button
      type="button"
      ref={(el) => void (pills.current[id] = el)}
      className={`tb-pill ${open === id ? 'open' : ''}`}
      data-testid={`pill-${id}`}
      aria-haspopup="listbox"
      aria-expanded={open === id}
      aria-label={label}
      onClick={() => setOpen(open === id ? null : id)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' && open !== id) {
          e.preventDefault();
          setOpen(id);
        }
      }}
    >
      {body}
      <Chevron size={12} />
    </button>
  );

  return (
    <div
      ref={root}
      className="tb-composer"
      data-testid="composer"
      data-stage={lands}
      onMouseDown={(e) => {
        // A click on the card's own padding must not take focus off the field, or leaving an empty composer would close it.
        if (!(e.target as HTMLElement).closest('input, textarea, button')) e.preventDefault();
      }}
      onBlur={(e) => {
        if (pristine && !root.current?.contains(e.relatedTarget as Node | null)) onDone();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit(true);
        }
      }}
    >
      <div className="tb-composer-stage" data-testid="composer-stage" data-stage={lands}>
        <StageIcon stage={lands} size={14} />
        <b>{STAGE_LABEL[lands]}</b>
        {who && <em className="tb-starts">{who.name} starts at once</em>}
      </div>
      <input
        ref={title}
        autoFocus
        className="tb-composer-input"
        data-testid="composer-title"
        aria-label={`New task in ${STAGE_LABEL[stage]}`}
        placeholder="Task title"
        value={draft.title}
        onFocus={() => setOpen(null)}
        onChange={(e) => patch({ title: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit(more);
          }
        }}
      />
      {notesOpen && (
        <textarea
          autoFocus
          className="tb-composer-notes"
          data-testid="composer-notes"
          aria-label="Notes"
          placeholder="Notes for whoever picks this up"
          rows={3}
          value={draft.notes}
          onFocus={() => setOpen(null)}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      )}
      <div className="tb-pills" role="group" aria-label="Task properties">
        {pill(
          'assignee',
          'Assignee',
          who ? (
            <>
              <Avatar person={who} size={18} />
              <span className="tb-pill-text">{who.name}</span>
            </>
          ) : (
            <>
              <i className="tb-av empty" style={{ width: 18, height: 18 }} />
              <span className="tb-pill-text dim">Assignee</span>
            </>
          ),
        )}
        {pill(
          'priority',
          'Priority',
          <>
            <PriorityIcon priority={draft.priority} />
            <span className={`tb-pill-text ${draft.priority ? '' : 'dim'}`}>{draft.priority ? PRIORITY_LABEL[draft.priority] : 'Priority'}</span>
          </>,
        )}
        <button
          type="button"
          className={`tb-pill ${notesOpen ? 'open' : ''}`}
          data-testid="pill-notes"
          aria-expanded={notesOpen}
          aria-label="Notes"
          onClick={() => setNotesOpen(!notesOpen)}
        >
          <Notes size={15} />
          <span className={`tb-pill-text ${draft.notes.trim() ? '' : 'dim'}`}>{draft.notes.trim() ? 'Notes added' : 'Notes'}</span>
        </button>
        {open === 'assignee' && (
          <Menu
            label="Assignee"
            current={who?.id}
            options={[noOne(stage), ...team.map((p) => ({ key: p.id, value: p.id as string | undefined, text: p.name, node: <PersonOption person={p} /> }))]}
            onPick={(id) => pick({ assignee: id as Draft['assignee'] })}
            onShut={shut('assignee')}
          >
            {team.length === 0 && <p className="tb-menu-note">Hire someone in this block to hand them work.</p>}
          </Menu>
        )}
        {open === 'priority' && <Menu label="Priority" current={draft.priority} options={priorityOptions} onPick={(p) => pick({ priority: p })} onShut={shut('priority')} />}
      </div>
      <p className="tb-composer-hint" data-testid="composer-hint">
        {more ? (
          <>
            <span><kbd>Enter</kbd> creates another</span>
            <span><kbd>Esc</kbd> closes</span>
          </>
        ) : (
          <>
            <span><kbd>Enter</kbd> creates</span>
            <span><kbd>⌘ Enter</kbd> creates another</span>
            <span><kbd>Esc</kbd> cancels</span>
          </>
        )}
      </p>
      <div className="tb-composer-foot">
        <button type="button" role="switch" aria-checked={more} className={`tb-switch ${more ? 'on' : ''}`} data-testid="create-more" onClick={() => setMore(!more)}>
          <i />
          Create more
        </button>
        <button type="button" className="tb-btn primary" data-testid="create-task" disabled={!ready} onClick={() => submit(more)}>
          Create task
        </button>
      </div>
    </div>
  );
}
