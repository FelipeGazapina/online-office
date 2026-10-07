// What the desks wear (`shared/space/dressing.ts`), drawn as one mesh per story: every thing's model turned and set on its desk, merged, so
// a dressed office costs one draw call per story however many things there are. Nothing here is clickable: the owner's own things are the
// ones that can be picked, and the desk under these is what a click lands on.
import { memo, useEffect, useMemo } from 'react';
import type { MeshStandardMaterial } from 'three';
import { dressingOf, ITEM_DEFS, lookOf, poseIn, type FloorGeometry, type Item, type ItemDef, type TopItem, type TopPose } from '../../../../shared/space/index.ts';
import { merge, modelOf } from './models.ts';

export type Worn = { item: TopItem; def: ItemDef; pose: TopPose };

const cache = new WeakMap<FloorGeometry, readonly Worn[]>();

/** Where each thing a story's desks wear stands, in meters from the story's floor. */
export function wornOn(geom: FloorGeometry): readonly Worn[] {
  const hit = cache.get(geom);
  if (hit) return hit;
  const wear = dressingOf(geom.story);
  const items = new Map<string, Item>([...geom.story.items, ...wear].map((i) => [i.id, i]));
  const out = wear.flatMap((item) => {
    const pose = poseIn(items, item);
    return pose ? [{ item, def: ITEM_DEFS[item.def], pose }] : [];
  });
  cache.set(geom, out);
  return out;
}

export const Dressing = memo(function Dressing({ geom, material }: { geom: FloorGeometry; material: MeshStandardMaterial }) {
  const merged = useMemo(() => {
    const worn = wornOn(geom);
    if (!worn.length) return null;
    const g = merge(worn.map(({ item, def, pose }) => modelOf(item.def, lookOf(item, def)).clone().rotateY(pose.yaw).translate(pose.x, pose.y, pose.z)));
    g.computeBoundingBox();
    return g;
  }, [geom]);
  useEffect(() => () => merged?.dispose(), [merged]);
  return merged && <mesh geometry={merged} material={material} frustumCulled={false} receiveShadow userData={{ probe: 'dressing', box: merged.boundingBox, things: wornOn(geom).length, digest: wornOn(geom).map(({ item }) => `${item.on}/${item.def}#${item.look ?? 0}@${item.u},${item.v}`).join(' ') }} />;
});
