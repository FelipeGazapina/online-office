import { STAGE_LABEL } from '../../boardView.ts';
import { STAGES, type TaskStage } from '../../../../shared/tasks.ts';
import { StageIcon } from './icons.tsx';

// What is left of the board while a card is out in the office: the four stages as drop targets, so the card can still go to a
// column, and the way out. The chips carry `data-stage`, which is what the drag looks for under the pointer.
export function CarryTray({ from, over, counts }: { from: TaskStage; over: TaskStage | null; counts: Readonly<Record<TaskStage, number>> }) {
  return (
    <div className="tb-tray" data-testid="carry-tray" onMouseDown={(e) => e.stopPropagation()}>
      <p className="tb-tray-hint">Drop it on a desk to give it to the person there, or on a stage to move it. <kbd>Esc</kbd> puts it back.</p>
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
