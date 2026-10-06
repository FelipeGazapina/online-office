import { useMemo } from 'react';
import type { BlockId } from '../../../../shared/protocol.ts';
import { isRunning } from '../../boardView.ts';
import { useStore } from '../../store.ts';
import { openBoard } from './actions.ts';

// The way into the boards from anywhere in the office. It opens the block the owner is nearest to, else the block of the
// person they have selected, else the first one. The board itself has a block picker.
export function TasksChip() {
  const blocks = useStore((s) => s.company?.blocks);
  const employees = useStore((s) => s.company?.employees);
  const tasks = useStore((s) => s.tasks);
  const times = useStore((s) => s.taskTime);
  const selectedId = useStore((s) => s.selectedId);
  const nearBoard = useStore((s) => s.nearTaskBoard);
  const nearComputer = useStore((s) => s.nearProjectComputer);
  const running = useMemo(() => tasks.filter((t) => isRunning(times[t.id])).length, [tasks, times]);
  if (!blocks?.length) return null;
  const target: BlockId = nearBoard ?? nearComputer ?? employees?.find((e) => e.id === selectedId)?.blockId ?? blocks[0]!.id;
  return (
    <button type="button" className="btn tasks-chip" style={{ left: 316 }} title="Task boards" data-testid="tasks-chip" onClick={() => openBoard(target)}>
      Tasks
      <span className="tb-count">{tasks.length}</span>
      {running > 0 && <i className="tb-live" aria-label={`${running} running`} />}
    </button>
  );
}
