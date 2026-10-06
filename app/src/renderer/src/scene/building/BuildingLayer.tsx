import { useMemo } from 'react';
import { deriveFloors } from '../../../../shared/space/index.ts';
import { useStore } from '../../store.ts';
import { StoryView } from './StoryView.tsx';

/** Every story of the persisted building, drawn from deriveFloors. */
export function BuildingLayer() {
  const building = useStore((s) => s.building);
  const floors = useMemo(() => (building ? deriveFloors(building) : []), [building]);
  return (
    <>
      {floors.map((g) => (
        <StoryView key={g.index} geom={g} />
      ))}
    </>
  );
}
