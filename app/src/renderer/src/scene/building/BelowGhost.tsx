// The floor underneath, drawn as a pale ghost on the floor being built: its walls as thin bands and its furniture as
// footprints. It shows where the rooms and stairs below sit, so the upper floor can be laid out over them.
import { useMemo } from 'react';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, MeshBasicMaterial } from 'three';
import { floorItems, footprint, ITEM_DEFS, STORY_H, type Story } from '../../../../shared/space/index.ts';
import { useStore } from '../../store.ts';

export const GHOST_OPACITY = 0.3;
const WALL_BAND = 0.16;

const quad = (out: number[], x0: number, z0: number, x1: number, z1: number) => out.push(x0, 0, z0, x0, 0, z1, x1, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z1);
const toGeometry = (pos: number[]) => new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pos, 3));

function bandsOf(story: Story) {
  const walls: number[] = [];
  const items: number[] = [];
  const h = WALL_BAND / 2;
  for (const w of story.walls) {
    if (w.d === 'e') quad(walls, w.x - h, w.z - h, w.x + 1 + h, w.z + h);
    else quad(walls, w.x - h, w.z - h, w.x + h, w.z + 1 + h);
  }
  for (const it of floorItems(story)) {
    const def = ITEM_DEFS[it.def];
    if (!def || def.walkable) continue;
    const f = footprint(def, it.rot);
    quad(items, it.x / 2, it.z / 2, it.x / 2 + f.w / 2, it.z / 2 + f.d / 2);
  }
  return { walls: toGeometry(walls), items: toGeometry(items) };
}

const material = (color: string) => new MeshBasicMaterial({ color, transparent: true, opacity: GHOST_OPACITY, depthWrite: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
const WALL_MATERIAL = material('#8fbaff');
const ITEM_MATERIAL = material('#ffffff');

export function BelowGhost() {
  const level = useStore((s) => s.build?.level ?? 0);
  const mode = useStore((s) => s.build?.wallsMode ?? 'cutaway');
  const below = useStore((s) => (s.build && s.build.level > 0 ? s.building?.stories[s.build.level - 1] : undefined));
  const bands = useMemo(() => (below ? bandsOf(below) : null), [below]);
  if (!bands || mode === 'up') return null;
  return (
    <group position-y={level * STORY_H + 0.045}>
      <mesh geometry={bands.walls} material={WALL_MATERIAL} renderOrder={4} userData={{ probe: 'below-ghost', opacity: GHOST_OPACITY }} />
      <mesh geometry={bands.items} material={ITEM_MATERIAL} renderOrder={4} />
    </group>
  );
}
