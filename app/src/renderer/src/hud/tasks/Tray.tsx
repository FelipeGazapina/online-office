import { useCallback, useEffect, type KeyboardEvent, type RefObject } from 'react';
import type { Employee, EmployeeId } from '../../../../shared/protocol.ts';
import { STAGES, type Board, type Task, type TaskId, type TaskStage, type TaskTime } from '../../../../shared/tasks.ts';
import { STAGE_LABEL, isRunning } from '../../boardView.ts';
import type { Bar } from '../../carry.ts';
import { Card } from './Card.tsx';
import { Close, StageIcon } from './icons.tsx';
import type { useCardDrag } from './drag.ts';

// What is left of the board while a card is out in the office: what letting go does, the four stages as drop targets so the
// card can still go to a column, and the way out. The chips carry `data-stage`, which is what the drag looks for under the
// pointer. The bar is a live region and keeps one width, so the chips do not move as its words change.
export function CarryTray({ bar, from, over, counts }: { bar: Bar; from: TaskStage; over: TaskStage | null; counts: Readonly<Record<TaskStage, number>> }) {
  return (
    <div className="tb-tray" data-testid="carry-tray" data-carry-avoid onMouseDown={(e) => e.stopPropagation()}>
      <p className={`tb-tray-hint ${bar.tone}`} data-testid="carry-bar" data-tone={bar.tone} aria-live="polite">
        <span>
          {bar.text} <kbd>Esc</kbd> puts it back.
        </span>
      </p>
      {STAGES.map((stage) => (
        <span key={stage} className={`tb-tray-chip ${over === stage && stage !== from ? 'over' : ''} ${stage === from ? 'here' : ''}`} data-stage={stage} data-tray-stage={stage}>
          <StageIcon stage={stage} />
          {STAGE_LABEL[stage]}
          <b>{counts[stage]}</b>
        </span>
      ))}
    </div>
  );
}

type RestProps = {
  stripRef: RefObject<HTMLDivElement | null>;
  board: Board;
  cards: readonly Task[];
  times: Readonly<Record<TaskId, TaskTime>>;
  people: ReadonlyMap<EmployeeId, Employee>;
  now: number;
  dragging: TaskId | null;
  press: ReturnType<typeof useCardDrag>['press'];
  wasDragged: () => boolean;
  onOpen: (task: Task) => void;
  onBoard: () => void;
  onClose: () => void;
};

// The board folded after a card went to a desk: the cards still waiting in Todo, ready to be picked up and carried to the
// next desk, and the way back to the whole board. Esc closes it; the Tasks chip opens the board.
export function RestTray({ stripRef, board, cards, times, people, now, dragging, press, wasDragged, onOpen, onBoard, onClose }: RestProps) {
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('.tb-card')?.focus({ preventScroll: true });
  }, [stripRef]);
  const onKey = useCallback(
    (task: Task, _stage: TaskStage, e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      const here = [...(stripRef.current?.querySelectorAll<HTMLElement>('.tb-card') ?? [])];
      const at = here.findIndex((c) => c.dataset.taskId === task.id);
      if (e.key === 'Enter' || e.key === ' ') onOpen(task);
      else if (e.key === 'ArrowRight') here[at + 1]?.focus();
      else if (e.key === 'ArrowLeft') here[at - 1]?.focus();
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    [onOpen, stripRef],
  );
  return (
    <div
      className="tb-tray rest"
      role="region"
      aria-label={`Tasks left to hand out from ${board.name}`}
      data-testid="task-tray"
      data-carry-avoid
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') e.stopPropagation();
      }}
    >
      <div className="tb-tray-lead">
        <b>Next up</b>
        <span data-testid="tray-count">
          {cards.length} to hand out. Drag a card onto a desk.
        </span>
      </div>
      <div className="tb-tray-cards" ref={stripRef}>
        {cards.map((task) => (
          <Card
            key={task.id}
            task={task}
            stage="todo"
            time={times[task.id]}
            now={isRunning(times[task.id]) ? now : 0}
            people={people}
            selected={false}
            dragging={dragging === task.id}
            onOpen={onOpen}
            onPress={press}
            onKey={onKey}
            wasDragged={wasDragged}
          />
        ))}
      </div>
      <button type="button" className="tb-btn primary" data-testid="tray-open" onClick={onBoard}>
        Open board
      </button>
      <button type="button" className="tb-icon" aria-label="Close the tray" title="Close" data-testid="tray-close" onClick={onClose}>
        <Close />
      </button>
    </div>
  );
}
