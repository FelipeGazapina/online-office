import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BlockId, Employee, EmployeeId } from '../../../../shared/protocol.ts';
import type { Board, BoardSync, Task, TaskId, TaskStage } from '../../../../shared/tasks.ts';
import { STAGE_LABEL, boardFor, boardsOf, columnsOf, fmtAgo, fmtClock, foldedOf, foldStep, isRunning, peopleOf, stageOf, stageStep, statsOf, type Column } from '../../boardView.ts';
import { send, set, useStore } from '../../store.ts';
import { useNow } from '../hooks.ts';
import { dropOnDesk, foldColumn, moveTask, openBoard, pickBoard } from './actions.ts';
import { Card } from './Card.tsx';
import { Composer } from './Composer.tsx';
import { Detail } from './Detail.tsx';
import { useCardDrag } from './drag.ts';
import { Alert, Close, Eye, EyeOff, Plus, Sliders, StageIcon, Sync, Whiteboard } from './icons.tsx';
import { Settings } from './Settings.tsx';
import { BoardTabs } from './Tabs.tsx';
import { CarryTray, RestTray } from './Tray.tsx';
import { barOf } from '../../carry.ts';
import './tasks.css';

const close = () => set({ modal: null });

function SyncStatus({ board, sync, now }: { board: Board; sync: BoardSync | undefined; now: number }) {
  if (board.kind === 'quick') return <span className="tb-sync quiet">Saved on this Mac</span>;
  const state = sync?.kind ?? 'idle';
  const at = sync && 'lastFetchedAt' in sync ? sync.lastFetchedAt : undefined;
  const text = state === 'loading' ? 'Syncing…' : state === 'error' ? 'Sync failed' : state === 'ready' && at ? `Synced ${fmtAgo(now - at)}` : 'Not synced yet';
  return (
    <span className={`tb-sync ${state}`} data-sync={state} role="status">
      {state === 'error' && <Alert size={13} />}
      {text}
    </span>
  );
}

type ColumnProps = {
  column: Column;
  board: Board;
  composing: boolean;
  dragOver: boolean;
  dragging: TaskId | null;
  selected: TaskId | undefined;
  times: ReturnType<typeof useStore.getState>['taskTime'];
  people: ReadonlyMap<EmployeeId, Employee>;
  team: readonly Employee[];
  now: number;
  open: (task: Task) => void;
  compose: (stage: TaskStage | null) => void;
  press: ReturnType<typeof useCardDrag>['press'];
  wasDragged: () => boolean;
  onKey: (task: Task, stage: TaskStage, e: KeyboardEvent<HTMLElement>) => void;
  // Hides the column. Undefined when it is the last one open.
  onHide: (() => void) | undefined;
};

function ColumnView({ column, board, composing, dragOver, dragging, selected, times, people, team, now, open, compose, press, wasDragged, onKey, onHide }: ColumnProps) {
  return (
    <section className={`tb-col ${dragOver ? 'over' : ''}`} data-stage={column.stage} aria-label={`${column.label}, ${column.tasks.length} tasks`}>
      <header className="tb-col-head">
        <StageIcon stage={column.stage} />
        <h3>{column.label}</h3>
        <span className="tb-count" data-testid="column-count">{column.tasks.length}</span>
        <span className="tb-grow" />
        <button type="button" className="tb-icon" aria-label={`Add a task to ${column.label}`} title={`Add a task to ${column.label}`} onClick={() => compose(composing ? null : column.stage)}>
          <Plus />
        </button>
        <button type="button" className="tb-icon" aria-label={`Hide ${column.label}`} title={onHide ? `Hide ${column.label}${board.kind === 'quick' ? '' : ': its issues are not pulled while it is hidden'}` : 'A board keeps at least one column open.'} disabled={!onHide} onClick={onHide}>
          <EyeOff />
        </button>
      </header>
      <div className="tb-col-body">
        {composing && <Composer board={board} stage={column.stage} team={team} onDone={() => compose(null)} />}
        {column.tasks.map((task) => (
          <Card
            key={task.id}
            task={task}
            stage={column.stage}
            time={times[task.id]}
            now={isRunning(times[task.id]) ? now : 0}
            people={people}
            selected={selected === task.id}
            dragging={dragging === task.id}
            onOpen={open}
            onPress={press}
            onKey={onKey}
            wasDragged={wasDragged}
          />
        ))}
        {!column.tasks.length && !composing && <p className="tb-col-empty">{column.stage === 'todo' ? 'Nothing waiting. Add a task with +.' : 'Nothing here yet.'}</p>}
      </div>
    </section>
  );
}

// Columns the owner hid, the way Linear lists its hidden columns: narrow, each with its count, a click brings one back.
function HiddenColumns({ board, columns }: { board: Board; columns: readonly Column[] }) {
  const hidden = columns.filter((c) => foldedOf(board).includes(c.stage));
  if (!hidden.length) return null;
  return (
    <aside className="tb-hidden" aria-label="Hidden columns" data-testid="hidden-columns">
      <h3>Hidden columns</h3>
      {hidden.map((c) => (
        <button key={c.stage} type="button" className="tb-hidden-row" data-stage={c.stage} aria-label={`Show ${c.label}, ${c.tasks.length} ${c.tasks.length === 1 ? 'task' : 'tasks'}`} title={`Show ${c.label}`} onClick={() => foldColumn(board, c.stage)}>
          <StageIcon stage={c.stage} />
          <span>{c.label}</span>
          <span className="tb-count" data-testid="hidden-count">{c.tasks.length}</span>
          <Eye size={14} />
        </button>
      ))}
      {board.kind !== 'quick' && <p className="tb-hint">Sync does not pull issues for these columns, so their share of the limit goes to the open ones.</p>}
    </aside>
  );
}

export function TaskBoardModal({ blockId }: { blockId: BlockId }) {
  const company = useStore((s) => s.company);
  const boards = useStore((s) => s.boards);
  const tasks = useStore((s) => s.tasks);
  const times = useStore((s) => s.taskTime);
  const syncs = useStore((s) => s.boardSync);
  const pick = useStore((s) => s.boardPick);
  const holds = useStore((s) => s.stageHold);
  const modal = useStore((s) => s.modal);
  const connections = useStore((s) => s.taskConnections);
  const aim = useStore((s) => s.aim);
  const root = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState<TaskStage | null>(null);

  const block = company?.blocks.find((b) => b.id === blockId);
  const mine = useMemo(() => boardsOf(boards, blockId), [boards, blockId]);
  const board = boardFor(boards, blockId, pick);
  const boardTasks = useMemo(() => tasks.filter((t) => t.boardId === board?.id), [tasks, board?.id]);
  const blockTaskIds = useMemo(() => new Set(mine.map((b) => b.id)), [mine]);
  const blockTasks = useMemo(() => tasks.filter((t) => blockTaskIds.has(t.boardId)), [tasks, blockTaskIds]);
  const team = useMemo(() => peopleOf(company?.employees ?? [], blockId), [company?.employees, blockId]);
  const people = useMemo(() => new Map((company?.employees ?? []).map((e) => [e.id, e])), [company?.employees]);
  const anyRunning = boardTasks.some((t) => isRunning(times[t.id]));
  // Once a second while someone works, so a timer reads true. Otherwise often enough for "synced 2 min ago".
  const now = useNow(anyRunning ? 1000 : 20_000);
  const columns = useMemo(() => columnsOf(boardTasks, holds, Date.now()), [boardTasks, holds]);
  const sync = board ? syncs[board.id] : undefined;
  const hiddenStages = foldedOf(board);

  // After a card goes to a desk the board stays folded as a tray of what is left to hand out, so the owner can take the next
  // card without opening the board again. Opening the board from anywhere (the Tasks chip, the tray's button) unfolds it.
  const tray = modal?.kind === 'task_board' && modal.tray === true;
  const selected = modal?.kind === 'task_board' ? boardTasks.find((t) => t.id === modal.taskId) : undefined;
  const settings = modal?.kind === 'task_board' && modal.settings === true && !!board;
  const stats = statsOf(boardTasks, times, now);

  // A task opened by id lives on its own board.
  const wanted = modal?.kind === 'task_board' ? tasks.find((t) => t.id === modal.taskId) : undefined;
  useEffect(() => {
    if (wanted && wanted.boardId !== board?.id && blockTaskIds.has(wanted.boardId)) pickBoard(blockId, wanted.boardId);
  }, [wanted?.id, wanted?.boardId]);
  useEffect(() => {
    if (!tray) root.current?.focus({ preventScroll: true });
  }, [tray]);
  useEffect(() => setComposing(null), [board?.id]);
  const docked = !!selected || settings;
  // Escape leaves the dock first, then the board, wherever focus is. A button that disables itself on click leaves focus on
  // the page, so the key cannot rely on landing inside the board. Fields that use Escape themselves stop it before here.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (docked) set({ modal: { kind: 'task_board', blockId } });
      else close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [docked, blockId]);

  const dock = useCallback((next: { taskId?: TaskId; settings?: boolean }) => set({ modal: { kind: 'task_board', blockId, ...next } }), [blockId]);
  const open = useCallback((task: Task) => dock({ taskId: task.id }), [dock]);
  const { drag, press, ghostRef, wasDragged } = useCardDrag({
    blockId,
    home: () => (tray ? strip.current : root.current?.querySelector('[data-testid=task-board-columns]')),
    onStage: moveTask,
    onDesk: dropOnDesk,
  });
  // A card taken out of the columns folds the board away so the office shows. The dialog's own grips go with it.
  const away = !!drag?.away;
  const folded = away || tray;
  useEffect(() => {
    document.body.classList.toggle('tb-carrying-away', folded);
    return () => document.body.classList.remove('tb-carrying-away');
  }, [folded]);
  const todo = useMemo(() => columns.find((c) => c.stage === 'todo')?.tasks ?? [], [columns]);
  // Nothing left to hand out: the tray has done its job.
  useEffect(() => {
    if (tray && !drag && !todo.length) close();
  }, [tray, drag, todo.length]);

  const focusCard = (id: string | undefined) => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-task-id="${id}"]`)?.focus());
  const onCardKey = useCallback(
    (task: Task, stage: TaskStage, e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      const cards = (s: TaskStage) => [...(root.current?.querySelectorAll<HTMLElement>(`[data-stage="${s}"] [data-task-id]`) ?? [])];
      const here = cards(stage);
      const at = here.findIndex((c) => c.dataset.taskId === task.id);
      const go = (el: HTMLElement | undefined) => {
        e.preventDefault();
        e.stopPropagation();
        el?.focus();
      };
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        open(task);
      } else if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        const to = stageStep(stage, e.key === 'ArrowRight' ? 1 : -1, hiddenStages);
        if (to) {
          moveTask(task, to);
          focusCard(task.id);
        }
      } else if (e.key === 'ArrowDown') go(here[at + 1]);
      else if (e.key === 'ArrowUp') go(here[at - 1]);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const to = stageStep(stage, e.key === 'ArrowRight' ? 1 : -1, hiddenStages);
        const side = to ? cards(to) : [];
        go(side[Math.min(at, side.length - 1)]);
      }
    },
    [open, hiddenStages],
  );

  if (!block) return null;
  if (!board)
    return (
      <div className="scrim" onMouseDown={close}>
        <div className="modal tb tb-bare" role="dialog" aria-label={`${block.name} task board`} data-hud-resize-target="modal-task_board" onMouseDown={(e) => e.stopPropagation()}>
          <header className="tb-head">
            <h2>{block.name}</h2>
            <button type="button" className="tb-icon" aria-label="Close the board" onClick={close}><Close /></button>
          </header>
          <p className="tb-hint tb-bare-note">This block has no board yet. Boards appear as soon as the office has set the block up.</p>
        </div>
      </div>
    );
  const empty = board.kind !== 'quick' && board.sources.length === 0;
  const stageCounts = Object.fromEntries(columns.map((c) => [c.stage, c.tasks.length])) as Record<TaskStage, number>;
  const bar = barOf(aim, drag?.over ?? null, drag?.from ?? 'todo');
  const linearWithoutLogin = board.kind !== 'quick' && board.sources.some((s) => s.provider === 'linear') && connections.linear.kind !== 'ready';

  const carried = (
    <>
      {drag &&
        createPortal(
          <div className={`tb-ghost ${away ? 'away' : ''}`} ref={ghostRef} style={{ width: drag.width, ['--gx' as string]: `${drag.grabX}px`, ['--gy' as string]: `${drag.grabY}px` }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="tb-ghost-in">
              <Card task={drag.task} stage={drag.from} time={times[drag.task.id]} now={now} people={people} selected={false} dragging={false} ghost onOpen={open} onPress={press} onKey={onCardKey} wasDragged={wasDragged} />
            </div>
            {away && (
              <div className={`tb-ghost-aim ${bar.tone}`} data-testid="ghost-aim">
                {bar.chip}
              </div>
            )}
          </div>,
          document.body,
        )}
      {drag?.away
        ? createPortal(<CarryTray bar={bar} from={drag.from} over={drag.over} counts={stageCounts} />, document.body)
        : tray &&
          createPortal(
            <RestTray
              stripRef={strip}
              board={board}
              cards={todo}
              times={times}
              people={people}
              now={now}
              dragging={drag?.task.id ?? null}
              press={press}
              wasDragged={wasDragged}
              onOpen={open}
              onBoard={() => dock({})}
              onClose={close}
            />,
            document.body,
          )}
    </>
  );

  // Folded as a tray, the board is not drawn at all: only the cards still waiting and the way back.
  if (tray)
    return (
      <div className="scrim tb-away" onMouseDown={close}>
        {carried}
      </div>
    );

  return (
    <div className={`scrim ${away ? 'tb-away' : ''}`} onMouseDown={close}>
      <div
        ref={root}
        className="modal wide tb"
        tabIndex={-1}
        role="dialog"
        aria-label={`${block.name} task board`}
        data-hud-resize-target="modal-task_board"
        data-testid="task-board"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // The office's own shortcuts (H, Tab, Enter, WASD) must not fire through an open board. Escape is let through to
          // the document listener below, unless a field inside already took it.
          if (e.key !== 'Escape') e.stopPropagation();
        }}
      >
        <header className="tb-head">
          <div className="tb-title">
            <i className="tb-swatch" style={{ background: block.color }} />
            {(company?.blocks.length ?? 0) > 1 ? (
              <select className="tb-block-pick" aria-label="Project block" value={blockId} onChange={(e) => openBoard(e.target.value as BlockId)}>
                {company?.blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ) : (
              <h2>{block.name}</h2>
            )}
            <span className="tb-stats" data-testid="board-stats">
              {stats.tasks} {stats.tasks === 1 ? 'task' : 'tasks'}
              {stats.running > 0 && <><i className="tb-dotsep" /><span className="tb-running"><i className="tb-live" />{stats.running} running</span></>}
              {stats.ms > 0 && <><i className="tb-dotsep" />{fmtClock(stats.ms)} worked</>}
            </span>
          </div>
          <div className="tb-head-actions">
            {block.whiteboard && (
              <button type="button" className="tb-btn" onClick={() => set({ modal: { kind: 'whiteboard', blockId } })}>
                <Whiteboard size={14} />Whiteboard
              </button>
            )}
            {boardTasks.length > 0 && <span className="tb-tip" data-testid="drag-tip">Drag a card out of the board onto a desk to give it to the person there</span>}
            <SyncStatus board={board} sync={sync} now={now} />
            {board.kind !== 'quick' && (
              <button type="button" className="tb-btn" aria-label="Sync this board" disabled={sync?.kind === 'loading' || board.sources.length === 0} onClick={() => send({ type: 'refresh_board', boardId: board.id })}>
                <Sync size={14} className={sync?.kind === 'loading' ? 'spin' : ''} />Sync
              </button>
            )}
            <button type="button" className={`tb-btn ${settings ? 'on' : ''}`} aria-label="Board settings" aria-pressed={settings} onClick={() => dock(settings ? {} : { settings: true })}>
              <Sliders size={14} />Settings
            </button>
            <button type="button" className="tb-icon" aria-label="Close the board" onClick={close}>
              <Close />
            </button>
          </div>
        </header>

        <BoardTabs blockId={blockId} boards={mine} current={board.id} tasks={blockTasks} times={times} />

        {sync?.kind === 'error' && (
          <div className="tb-banner bad" role="alert" data-testid="sync-error">
            <Alert size={15} />
            <span>{sync.message}</span>
            {linearWithoutLogin && <button type="button" className="tb-btn" onClick={() => send({ type: 'connect_task_provider', provider: 'linear' })}>Connect Linear</button>}
            <button type="button" className="tb-btn" onClick={() => send({ type: 'refresh_board', boardId: board.id })}>Try again</button>
          </div>
        )}
        {empty && (
          <div className="tb-banner" data-testid="no-sources">
            <span>This board has no source yet. Connect Linear or CronoSpark and its tasks land here. You can still add tasks by hand.</span>
            <button type="button" className="tb-btn primary" onClick={() => dock({ settings: true })}>Set up sources</button>
          </div>
        )}

        <div className="tb-main">
          <div className="tb-cols" data-testid="task-board-columns" style={{ ['--cols' as string]: columns.length - hiddenStages.length }}>
            {columns.filter((c) => !hiddenStages.includes(c.stage)).map((c) => (
              <ColumnView
                key={c.stage}
                column={c}
                board={board}
                composing={composing === c.stage}
                dragOver={!!drag && drag.over === c.stage && drag.from !== c.stage}
                dragging={drag?.task.id ?? null}
                selected={selected?.id}
                times={times}
                people={people}
                team={team}
                now={now}
                open={open}
                compose={setComposing}
                press={press}
                wasDragged={wasDragged}
                onKey={onCardKey}
                onHide={foldStep(hiddenStages, c.stage) ? () => foldColumn(board, c.stage) : undefined}
              />
            ))}
          </div>
          <HiddenColumns board={board} columns={columns} />
          {settings ? (
            <Settings key={board.id} board={board} isLast={mine.length === 1} taskCount={boardTasks.length} onClose={() => dock({})} />
          ) : selected ? (
            <Detail key={selected.id} task={selected} board={board} blockPeople={team} people={people} time={times[selected.id]} stage={stageOf(selected, holds, Date.now())} now={now} onClose={() => dock({})} />
          ) : null}
        </div>
      </div>
      {carried}
    </div>
  );
}
