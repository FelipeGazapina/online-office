import { useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BlockId } from '../../../../shared/protocol.ts';
import type { Board, BoardId, Task, TaskTime } from '../../../../shared/tasks.ts';
import { isRunning } from '../../boardView.ts';
import { createBoard, pickBoard } from './actions.ts';
import { KindIcon, Plus } from './icons.tsx';

const KINDS = [
  { kind: 'feature', name: 'Feature', blurb: 'Pulls tasks from Linear or CronoSpark. Hours can go to CronoSpark.' },
  { kind: 'bug', name: 'Bug', blurb: 'The same sources, kept apart for fixes.' },
  { kind: 'quick', name: 'Quick', blurb: 'Tasks from your head. No sources, no hours.' },
] as const;
const DEFAULT_NAME = { feature: 'Feature board', bug: 'Bug board', quick: 'Quick tasks' } as const;

// Drawn on the page, not inside the tab strip, which scrolls and would cut it off.
function NewBoard({ blockId, anchor, onDone }: { blockId: BlockId; anchor: DOMRect; onDone: () => void }) {
  const [kind, setKind] = useState<Board['kind']>('feature');
  const [name, setName] = useState('');
  const submit = () => {
    createBoard(blockId, name.trim() || DEFAULT_NAME[kind], kind);
    onDone();
  };
  return createPortal(
    <form
      className="tb-newboard"
      style={{ top: anchor.bottom + 8, left: Math.max(8, Math.min(anchor.left, window.innerWidth - 440)) }}
      role="dialog"
      aria-label="New board"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <h4>New board</h4>
      <input className="tb-input" aria-label="Board name" autoFocus value={name} placeholder={DEFAULT_NAME[kind]} onChange={(e) => setName(e.target.value)} />
      <div className="tb-kinds" role="radiogroup" aria-label="Kind of board">
        {KINDS.map((k) => (
          <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={`tb-kindcard ${kind === k.kind ? 'on' : ''}`} data-kind={k.kind} onClick={() => setKind(k.kind)}>
            <span><KindIcon kind={k.kind} />{k.name}</span>
            <small>{k.blurb}</small>
          </button>
        ))}
      </div>
      <div className="tb-row">
        <span className="tb-grow" />
        <button type="button" className="tb-btn" onClick={onDone}>Cancel</button>
        <button type="submit" className="tb-btn primary">Create board</button>
      </div>
    </form>,
    document.body,
  );
}

type Props = { blockId: BlockId; boards: readonly Board[]; current: BoardId | undefined; tasks: readonly Task[]; times: Readonly<Record<string, TaskTime>> };

export function BoardTabs({ blockId, boards, current, tasks, times }: Props) {
  const [adding, setAdding] = useState<DOMRect | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const counts = new Map<BoardId, { n: number; running: boolean }>();
  for (const t of tasks) {
    const c = counts.get(t.boardId) ?? { n: 0, running: false };
    c.n++;
    c.running ||= isRunning(times[t.id]);
    counts.set(t.boardId, c);
  }
  const keys = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = [...(list.current?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])];
    const at = tabs.findIndex((t) => t === document.activeElement);
    const next = tabs[(at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    if (!next || at < 0) return;
    e.preventDefault();
    next.focus();
    next.click();
  };
  return (
    <div className="tb-tabs" role="tablist" aria-label="Boards" ref={list} onKeyDown={keys}>
      {boards.map((b) => {
        const c = counts.get(b.id);
        const on = b.id === current;
        return (
          <button
            key={b.id}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            className={`tb-tab ${on ? 'on' : ''}`}
            data-board-id={b.id}
            onClick={() => pickBoard(blockId, b.id)}
          >
            <KindIcon kind={b.kind} />
            <span className="tb-tab-name">{b.name}</span>
            {c?.running && <i className="tb-live" aria-label="Someone is working" />}
            <span className="tb-count">{c?.n ?? 0}</span>
          </button>
        );
      })}
      <span className="tb-newwrap">
        <button type="button" className="tb-tab-add" aria-label="New board" aria-expanded={!!adding} title="New board" onClick={(e) => setAdding(adding ? null : e.currentTarget.getBoundingClientRect())}>
          <Plus />
        </button>
        {adding && <NewBoard blockId={blockId} anchor={adding} onDone={() => setAdding(null)} />}
      </span>
    </div>
  );
}
