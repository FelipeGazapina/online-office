import type { BuildOp, FloorCell, PaintId, WallRef, WallSeg } from './types.ts';

export type TileRect = { x: number; z: number; w: number; h: number };

/** Wall segments around a tile rectangle. */
export function rectWalls(r: TileRect, style = 0): WallSeg[] {
  const segs: WallSeg[] = [];
  for (let i = 0; i < r.w; i++) {
    segs.push({ x: r.x + i, z: r.z, d: 'e', style }, { x: r.x + i, z: r.z + r.h, d: 'e', style });
  }
  for (let j = 0; j < r.h; j++) {
    segs.push({ x: r.x, z: r.z + j, d: 's', style }, { x: r.x + r.w, z: r.z + j, d: 's', style });
  }
  return segs;
}

export function paintRect(story: number, r: TileRect, paint: PaintId): BuildOp {
  const cells: FloorCell[] = [];
  for (let z = r.z; z < r.z + r.h; z++) for (let x = r.x; x < r.x + r.w; x++) cells.push({ x, z, half: 0, paint });
  return { t: 'floor', story, cells };
}

/** The gesture "draw a room": walls around the rectangle, plus floor paint when given. */
export function drawRoom(story: number, r: TileRect, opts: { style?: number; paint?: PaintId } = {}): BuildOp[] {
  const ops: BuildOp[] = [];
  if (opts.paint !== undefined) ops.push(paintRect(story, r, opts.paint));
  ops.push({ t: 'walls', story, put: rectWalls(r, opts.style ?? 0), del: [] });
  return ops;
}

export function removeWalls(story: number, refs: readonly WallRef[]): BuildOp {
  return { t: 'walls', story, put: [], del: refs };
}
