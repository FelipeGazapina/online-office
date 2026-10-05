import { arrangeProblem, cancelArranging, placeArranging, turnArranging } from '../arrange.ts';
import { useStore } from '../store.ts';

export function ArrangeBar() {
  const arranging = useStore((s) => s.arranging);
  const company = useStore((s) => s.company);
  const block = arranging && company?.blocks.find((b) => b.id === arranging.blockId);
  if (!arranging || !block) return null;
  const problem = arrangeProblem(arranging, company);
  return (
    <div className="arrange-bar" role="toolbar" aria-label={`Move ${block.name}`}>
      <div className="arrange-text">
        <b>Moving {block.name}</b>
        <span className={problem ? 'err-text' : 'muted'}>{problem ?? 'Drag the floor or use the arrow keys. R turns.'}</span>
      </div>
      <button className="btn ghost turn" title="Turn a quarter to the left (Shift+R)" aria-label="Turn left" onClick={() => turnArranging(-1)}>⟲</button>
      <button className="btn ghost turn" title="Turn a quarter to the right (R)" aria-label="Turn right" onClick={() => turnArranging(1)}>⟳</button>
      <button className="btn ghost" onClick={cancelArranging}>Cancel</button>
      <button className="btn primary" disabled={!!problem} onClick={placeArranging}>Place</button>
    </div>
  );
}
