import { useStore } from '../../store.ts';
import { BuildInput } from './BuildInput.tsx';
import { GhostLayer } from './Ghost.tsx';
import { GridOverlay } from './GridOverlay.tsx';

/** Everything build mode adds to the scene: the grid, the ghost under the cursor, and the pointer that drives them. */
export function BuildLayer() {
  const on = useStore((s) => !!s.build);
  if (!on) return null;
  return (
    <>
      <BuildInput />
      <GridOverlay />
      <GhostLayer />
    </>
  );
}
