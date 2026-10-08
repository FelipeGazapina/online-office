import { useEffect, useState, type KeyboardEvent } from 'react';
import type { TaskBoardSource, TaskProvider } from '../../../../shared/protocol.ts';
import { withFilters } from '../../boardView.ts';
import type { Board } from '../../../../shared/tasks.ts';
import { send } from '../../store.ts';
import { LinearFiltersEditor } from './Filters.tsx';
import { Close, KindIcon, Plus } from './icons.tsx';
import { ProviderConnections } from './Providers.tsx';

const KIND_NAME = { feature: 'Feature board', bug: 'Bug board', quick: 'Quick board' } as const;
const PLACEHOLDER: Record<TaskProvider, string> = { linear: 'Team, project, workspace or Linear URL', cronospark: 'CronoSpark project id' };

type Props = { board: Board; isLast: boolean; taskCount: number; onClose: () => void };

// Everything about one board, on the board: its name, where its tasks come from, and removing it.
export function Settings({ board, isLast, taskCount, onClose }: Props) {
  const [name, setName] = useState(board.name);
  useEffect(() => setName(board.name), [board.name]);
  const saved = board.kind === 'quick' ? [] : board.sources;
  const [sources, setSources] = useState<TaskBoardSource[]>(saved);
  useEffect(() => setSources(saved), [JSON.stringify(saved)]);
  const [armed, setArmed] = useState(false);
  const dirty = JSON.stringify(sources) !== JSON.stringify(saved);
  const incomplete = sources.some((s) => !s.projectId.trim());

  const rename = () => {
    const next = name.trim();
    if (!next || next === board.name) return setName(board.name);
    send({ type: 'update_board', boardId: board.id, name: next });
  };
  const nameKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setName(board.name);
      e.currentTarget.blur();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur();
  };
  const patch = (i: number, p: { projectId?: string; label?: string }) => setSources((cur) => cur.map((s, j) => (j === i ? { ...s, ...p } : s)));
  // A source keeps only what its provider can use, so a Linear source's filters do not follow it to CronoSpark.
  const setProvider = (i: number, provider: TaskProvider) =>
    setSources((cur) => cur.map((s, j) => (j === i && s.provider !== provider ? { provider, projectId: s.projectId, ...(s.label ? { label: s.label } : {}) } : s)));
  const add = (provider: TaskProvider) => setSources((cur) => [...cur, { provider, projectId: '' }]);

  return (
    <aside className="tb-dock tb-settings" aria-label="Board settings" data-testid="board-settings">
      <header className="tb-dock-head">
        <span className="tb-kind"><KindIcon kind={board.kind} />{KIND_NAME[board.kind]}</span>
        <button type="button" className="tb-icon" aria-label="Close settings" onClick={onClose}>
          <Close />
        </button>
      </header>
      <div className="tb-dock-body">
        <label className="tb-label">
          Name
          <input className="tb-input" aria-label="Board name" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={nameKeys} />
        </label>

        {board.kind === 'quick' ? (
          <p className="tb-hint">A quick board holds tasks from your head. It pulls from nothing and logs no hours.</p>
        ) : (
          <>
            <section className="tb-section">
              <h3>Sources</h3>
              {sources.length === 0 && <p className="tb-hint">This board is empty until it has a source. Add Linear or CronoSpark and its tasks land here.</p>}
              <div className="tb-sources">
                {sources.map((s, i) => (
                  <div className="tb-source" key={i} data-provider={s.provider}>
                    <select aria-label="Provider" value={s.provider} onChange={(e) => setProvider(i, e.target.value as TaskProvider)}>
                      <option value="linear">Linear</option>
                      <option value="cronospark">CronoSpark</option>
                    </select>
                    <button type="button" className="tb-icon" aria-label="Remove source" onClick={() => setSources((cur) => cur.filter((_, j) => j !== i))}>
                      <Close size={14} />
                    </button>
                    <input className="tb-input" aria-label="Project" value={s.projectId} placeholder={PLACEHOLDER[s.provider]} onChange={(e) => patch(i, { projectId: e.target.value })} />
                    <input className="tb-input" aria-label="Label" value={s.label ?? ''} placeholder="Label on its cards (optional)" onChange={(e) => patch(i, { label: e.target.value })} />
                    {s.provider === 'linear' ? (
                      <LinearFiltersEditor source={s} onChange={(f) => setSources((cur) => cur.map((x, j) => (j === i ? withFilters(x, f) : x)))} />
                    ) : (
                      <p className="tb-hint tb-source-note">CronoSpark lists a project's tasks and cannot filter them by person or cycle.</p>
                    )}
                  </div>
                ))}
              </div>
              <div className="tb-row">
                <button type="button" className="tb-btn" onClick={() => add('linear')}><Plus size={13} />Linear</button>
                <button type="button" className="tb-btn" onClick={() => add('cronospark')}><Plus size={13} />CronoSpark</button>
                <span className="tb-grow" />
                <button type="button" className="tb-btn primary" disabled={!dirty || incomplete} onClick={() => send({ type: 'update_board', boardId: board.id, sources })}>
                  Save and sync
                </button>
              </div>
              <p className="tb-hint">Linear takes a team, a project, a workspace id or a Linear URL. Prefix an unclear value with <code>team:</code>, <code>project:</code> or <code>workspace:</code>.</p>
            </section>

            <section className="tb-section">
              <h3>Connections</h3>
              <ProviderConnections only={sources.length ? [...new Set(sources.map((s) => s.provider))] : undefined} />
            </section>
          </>
        )}
      </div>
      <footer className="tb-dock-foot">
        <button
          type="button"
          className={`tb-btn danger ${armed ? 'armed' : ''}`}
          disabled={isLast}
          title={isLast ? 'A block keeps at least one board.' : undefined}
          onBlur={() => setArmed(false)}
          onClick={() => {
            if (!armed) return setArmed(true);
            send({ type: 'delete_board', boardId: board.id });
            onClose();
          }}
        >
          {armed ? `Delete the board and its ${taskCount} task${taskCount === 1 ? '' : 's'}?` : 'Delete board'}
        </button>
        {isLast && <small className="tb-hint">A block keeps at least one board.</small>}
      </footer>
    </aside>
  );
}
