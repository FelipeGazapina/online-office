import { useState } from 'react';
import { filtersOf, LINEAR_LIMITS, type LinearFilters, type TaskBoardSource } from '../../../../shared/protocol.ts';
import { findPeople } from '../../boardView.ts';
import { send, useStore } from '../../store.ts';

type Option<T> = { value: T; label: string };

function Segments<T extends string | number>({ label, value, options, onPick }: { label: string; value: T; options: readonly Option<T>[]; onPick: (value: T) => void }) {
  return (
    <div className="tb-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onPick(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// What one Linear source pulls: whose issues, from which cycle, and how many. Picking a person asks Linear for its users.
export function LinearFiltersEditor({ source, onChange }: { source: TaskBoardSource; onChange: (patch: Partial<LinearFilters>) => void }) {
  const f = filtersOf(source);
  const people = useStore((s) => s.linearPeople);
  const [choosing, setChoosing] = useState(false);
  const [typed, setTyped] = useState('');
  const person = typeof f.assignee === 'object' ? f.assignee : undefined;
  const ask = () => send({ type: 'load_linear_people' });
  const toggleList = () => {
    setChoosing((open) => !open);
    if (people.kind === 'unknown' || people.kind === 'error') ask();
  };
  const choose = (id: string, name: string) => {
    onChange({ assignee: { id, name } });
    setChoosing(false);
    setTyped('');
  };

  return (
    <div className="tb-filters" data-testid="linear-filters">
      <div className="tb-filter-row">
        <span>Assignee</span>
        <div className="tb-seg" role="radiogroup" aria-label="Assignee">
          <button type="button" role="radio" aria-checked={f.assignee === 'anyone'} onClick={() => { onChange({ assignee: 'anyone' }); setChoosing(false); }}>Anyone</button>
          <button type="button" role="radio" aria-checked={f.assignee === 'me'} onClick={() => { onChange({ assignee: 'me' }); setChoosing(false); }}>Me</button>
          <button type="button" role="radio" aria-checked={!!person} aria-expanded={choosing} data-testid="pick-person" onClick={toggleList}>
            {person ? person.name : 'Someone…'}
          </button>
        </div>
      </div>
      {choosing && (
        <div className="tb-menu tb-people-pick" data-testid="people-pick">
          {people.kind === 'ready' ? (
            <>
              <input
                className="tb-input"
                aria-label="Find a person"
                placeholder="Find a person"
                value={typed}
                autoFocus
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return;
                  e.stopPropagation();
                  setChoosing(false);
                }}
              />
              <div className="tb-people-list" role="listbox" aria-label="People in Linear">
                {findPeople(people.people, typed).map((p) => (
                  <button key={p.id} type="button" role="option" aria-selected={person?.id === p.id} className="tb-opt" onClick={() => choose(p.id, p.name)}>
                    <span className="tb-opt-name"><b>{p.name}</b></span>
                  </button>
                ))}
                {!findPeople(people.people, typed).length && <p className="tb-menu-note">No one in Linear matches "{typed.trim()}".</p>}
              </div>
            </>
          ) : people.kind === 'error' ? (
            <p className="tb-menu-note" role="alert">{people.message} <button type="button" className="tb-btn" onClick={ask}>Try again</button></p>
          ) : (
            <p className="tb-menu-note">Loading people from Linear…</p>
          )}
        </div>
      )}
      <div className="tb-filter-row">
        <span>Cycle</span>
        <Segments label="Cycle" value={f.cycle} options={[{ value: 'any', label: 'Any' }, { value: 'current', label: 'Current cycle' }]} onPick={(cycle) => onChange({ cycle })} />
      </div>
      <div className="tb-filter-row">
        <span>Up to</span>
        <Segments label="Limit" value={f.limit} options={LINEAR_LIMITS.map((n) => ({ value: n, label: `${n} issues` }))} onPick={(limit) => onChange({ limit })} />
      </div>
    </div>
  );
}
