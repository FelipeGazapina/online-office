// Turns the pointer into build gestures. Every tool answers the same two questions for the current pointer and drag: what
// would this change (`ops`), and what does the ghost look like. The ghost's colour is main's own verdict (`checkOps`),
// and a click or a release sends exactly the ops the ghost was checked with.
import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { Vector3 } from 'three';
import { blockAt, blockItems, floorItems, blockPose, CELL, checkOps, FLOOR_PAINTS, ITEM_DEFS, moveBlockOps, placeBlock, rectWalls, STORY_H, WALL_STYLES, type Building, type BuildOp, type Item, type ItemId, type Vec2 } from '../../../../shared/space/index.ts';
import {
  floodRoom,
  itemAt,
  itemOrigin,
  nearestWall,
  openingOp,
  paintFloorOp,
  paintWallsOp,
  putItemOp,
  roomOps,
  roomRect,
  runEnd,
  wallOp,
  wallRun,
  wallsAround,
  wallsToDelete,
  wallsToPut,
} from '../../../../shared/space/buildersGesture.ts';
import { pickUpBlock, rotate, sendOps, setTool, stepBack, toolItem } from '../../hud/build/actions.ts';
import { buildView, draft, modifiers, setGhost, spaceContext, VIOLATION_TEXT, type Ghost } from '../../hud/build/state.ts';
import { get, set, useStore, type BuildCursor, type BuildState, type BuildTool } from '../../store.ts';
import { groundPoint, tileOf, vertexOf } from './Picking.ts';

type Drag = { tool: 'wall' | 'room' | 'floor'; a: Vec2; erase: boolean; tiles: Map<string, Vec2>; flood: boolean; lastTile: Vec2 | null };
// `anchor` pins the readout to a spot of the floor, like the edge being dragged, instead of the pointer.
type Plan = { ops: BuildOp[]; ghost: (ok: boolean) => Ghost | null; readout: string | null; anchor?: Vec2 };
type Verdict = { ok: boolean; text: string };

const CLICK_PX = 5;
const EDGE_PX = 6;
const same = (a: Vec2, b: Vec2) => a.x === b.x && a.z === b.z;
const tkey = (t: Vec2) => `${t.x},${t.z}`;

function lineTiles(a: Vec2, b: Vec2): Vec2[] {
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z), 1);
  return Array.from({ length: n + 1 }, (_, i) => ({ x: Math.round(a.x + ((b.x - a.x) * i) / n), z: Math.round(a.z + ((b.z - a.z) * i) / n) }));
}

/** The story that holds the block's pieces, or -1 when it has none. */
function storyOf(b: Building, blockId: string): number {
  return b.stories.findIndex((st) => blockItems(st, blockId).length > 0);
}

function storyItem(b: Building, level: number, id: ItemId | null): Item | null {
  return id ? (b.stories[level]?.items.find((i) => i.id === id) ?? null) : null;
}

function peekTool(def: string): Extract<BuildTool, { kind: 'item' }> {
  return { kind: 'item', def, rot: 0, carry: null, blockId: ITEM_DEFS[def].seat ? (get().company?.blocks[0]?.id ?? null) : null };
}

function plan(b: Building, build: BuildState, p: Vec2, drag: Drag | null, shift: boolean, ctrl: boolean): Plan | null {
  const level = build.level;
  const story = b.stories[level];
  if (!story) return null;
  // A furniture card under the pointer stands in for whatever tool is in hand, so hovering shows the piece as the cursor ghost.
  const peeked = !drag && build.peek && ITEM_DEFS[build.peek] ? peekTool(build.peek) : null;
  const tool = peeked ?? build.tool;
  const kind = drag?.tool ?? (tool.kind === 'room' && shift ? 'wall' : tool.kind);
  switch (kind) {
    case 'select':
      return { ops: [], ghost: () => null, readout: null };
    case 'wall': {
      const v = vertexOf(p);
      if (!drag) return { ops: [], ghost: () => ({ kind: 'vertex', at: v }), readout: null };
      const refs = wallRun(drag.a, v);
      const op = drag.erase ? wallOp(level, [], wallsToDelete(story, refs)) : wallOp(level, wallsToPut(story, refs, build.style), []);
      return {
        ops: op ? [op] : [],
        ghost: (ok) => ({ kind: 'run', refs, start: drag.a, end: runEnd(drag.a, v), erase: drag.erase, ok }),
        readout: refs.length ? `${drag.erase ? 'Delete ' : ''}${refs.length} m` : null,
        anchor: { x: (drag.a.x + runEnd(drag.a, v).x) / 2, z: (drag.a.z + runEnd(drag.a, v).z) / 2 },
      };
    }
    case 'room': {
      const v = vertexOf(p);
      if (!drag) return { ops: [], ghost: () => ({ kind: 'vertex', at: v }), readout: null };
      const rect = roomRect(drag.a, v);
      if (!rect) return { ops: [], ghost: () => ({ kind: 'vertex', at: v }), readout: null };
      const ops = drag.erase ? [wallOp(level, [], wallsToDelete(story, rectWalls(rect)))].filter((o): o is BuildOp => !!o) : roomOps(b, story, level, rect, build.style, build.paint || 1);
      return { ops, ghost: (ok) => ({ kind: 'room', rect, ok }), readout: `${rect.w} × ${rect.h} m`, anchor: { x: rect.x + (v.x > drag.a.x ? rect.w / 2 : rect.w / 2), z: v.z } };
    }
    case 'floor': {
      const here = tileOf(p);
      let tiles: Vec2[];
      if (drag && !drag.flood) tiles = [...drag.tiles.values()];
      else tiles = (shift || build.fill ? floodRoom(b, story, here) : null) ?? [here];
      const op = paintFloorOp(b, story, level, tiles, build.paint);
      return { ops: op ? [op] : [], ghost: (ok) => ({ kind: 'tiles', tiles, ok, color: build.paint ? FLOOR_PAINTS[build.paint]?.color : undefined }), readout: tiles.length > 1 ? `${tiles.length} m²` : null };
    }
    case 'wallpaint': {
      const w = nearestWall(story, p);
      if (!w) return { ops: [], ghost: () => null, readout: null };
      const sides: Vec2[] = w.d === 'e' ? [{ x: w.x, z: w.z - 1 }, { x: w.x, z: w.z }] : [{ x: w.x - 1, z: w.z }, { x: w.x, z: w.z }];
      // The cursor's side of the wall, or the smaller room when the cursor is on the wall itself.
      const off = w.d === 'e' ? p.z - w.z : p.x - w.x;
      const rooms = shift || build.fill ? sides.map((t) => floodRoom(b, story, t)) : [];
      const room = Math.abs(off) > 0.15 && rooms[off < 0 ? 0 : 1] ? rooms[off < 0 ? 0 : 1] : (rooms.filter((r): r is Vec2[] => !!r).sort((x, y) => x.length - y.length)[0] ?? null);
      const walls = room ? wallsAround(story, room) : [w];
      const op = paintWallsOp(level, walls.length ? walls : [w], build.style);
      return { ops: op ? [op] : [], ghost: (ok) => ({ kind: 'walls', walls: walls.length ? walls : [w], ok, color: WALL_STYLES[build.style]?.color }), readout: null };
    }
    case 'opening': {
      const w = nearestWall(story, p);
      if (tool.kind !== 'opening' || !w) return { ops: [], ghost: () => null, readout: null };
      const op = openingOp(story, level, w, tool.open);
      return { ops: op ? [op] : [], ghost: (ok) => ({ kind: 'walls', walls: [w], ok }), readout: null };
    }
    case 'item': {
      if (tool.kind !== 'item') return null;
      const at = itemOrigin(tool.def, tool.rot, p);
      const item = toolItem(tool, at, storyItem(b, level, tool.carry));
      return { ops: [putItemOp(level, item)], ghost: (ok) => ({ kind: 'item', item, ok }), readout: null };
    }
    case 'block': {
      if (tool.kind !== 'block') return null;
      const carry = tool.carry;
      if (!carry) {
        const id = blockAt(story, p);
        const items = id ? blockItems(story, id) : [];
        return { ops: [], ghost: () => (items.length ? { kind: 'blockSelect', items } : null), readout: null };
      }
      // A block lives on one story: the one it was picked up from. The floor the owner is looking at is where it would land.
      const from = storyOf(b, carry.blockId);
      if (from < 0) return null;
      const items = blockItems(b.stories[from], carry.blockId);
      const pose = blockPose(items, carry.quarter, { x: p.x / CELL - carry.grab.x, z: p.z / CELL - carry.grab.z });
      const ops = moveBlockOps(b.stories[from], from, carry.blockId, pose, level);
      const placed = placeBlock(items, pose);
      const name = get().company?.blocks.find((x) => x.id === carry.blockId)?.name ?? 'Block';
      const floor = level === from ? '' : ` · to floor ${level + 1}`;
      return { ops, ghost: (ok) => ({ kind: 'block', items: placed, ok }), readout: `${name} · ${items.length} pieces${floor}` };
    }
  }
}

function pickAt(b: Building, build: BuildState, p: Vec2, whole: boolean): boolean {
  const story = b.stories[build.level];
  if (build.tool.kind === 'block') {
    const id = blockAt(story, p);
    return !!id && pickUpBlock(id, p);
  }
  const item = itemAt(story, p);
  if (!item || !ITEM_DEFS[item.def]) return false;
  if (whole && item.blockId) return pickUpBlock(item.blockId, p);
  setTool({ kind: 'item', def: item.def, rot: item.rot, carry: item.id, blockId: item.blockId ?? null });
  return true;
}

export function BuildInput() {
  const { gl, camera } = useThree();
  const on = useStore((s) => !!s.build);

  useEffect(() => {
    if (!on) return;
    const el = gl.domElement;
    let last: { x: number; y: number } | null = null;
    // Where the pointer last was over the scene, so a card hovered afterwards still previews its piece there.
    let seen: { x: number; y: number } | null = null;
    let drag: Drag | null = null;
    let down: { x: number; y: number; button: number } | null = null;
    // The press that picked something up. Released where it started it keeps the piece in hand; dragged away, it drops it.
    let grabbed = false;
    let verdictKey = '';
    let verdictValue: Verdict = { ok: true, text: '' };

    const verdictOf = (b: Building, ops: BuildOp[]): Verdict => {
      if (!ops.length) return { ok: true, text: '' };
      const key = `${b.stories.map((s) => s.rev).join('.')}|${JSON.stringify(ops)}`;
      if (key !== verdictKey) {
        const found = checkOps(b, ops, spaceContext(get().company));
        verdictKey = key;
        verdictValue = found.length ? { ok: false, text: VIOLATION_TEXT[found[0].kind] } : { ok: true, text: '' };
      }
      return verdictValue;
    };

    const publish = (next: BuildCursor) => {
      const cur = get().buildCursor;
      const r = cur.readout;
      const n = next.readout;
      const sameReadout = r === n || (!!r && !!n && r.text === n.text && r.x === n.x && r.y === n.y && r.bad === n.bad);
      const sameVerdict = cur.verdict === next.verdict || (!!cur.verdict && !!next.verdict && cur.verdict.ok === next.verdict.ok && cur.verdict.text === next.verdict.text);
      if (sameReadout && sameVerdict && cur.hover === next.hover) return;
      set({ buildCursor: next });
    };

    const screenOf = (at: Vec2, level: number) => {
      const r = el.getBoundingClientRect();
      const p = new Vector3(at.x, level * STORY_H, at.z).project(camera);
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    };

    const current = () => {
      const s = get();
      if (!s.build || !s.building) return null;
      const r = el.getBoundingClientRect();
      const from = last ?? (s.build.peek ? (seen ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 }) : null);
      if (!from) return null;
      const p = groundPoint(camera, el, from.x, from.y, s.build.level);
      return p ? { s, build: s.build, b: s.building, p } : null;
    };

    const refresh = () => {
      const c = current();
      if (!c) {
        draft.cursor.valid = false;
        setGhost(null);
        publish({ readout: null, verdict: null, hover: null });
        return;
      }
      const { build, b, p } = c;
      draft.cursor = { x: p.x, z: p.z, valid: true };
      const story = b.stories[build.level];
      const hover = story ? (itemAt(story, p)?.id ?? null) : null;
      const pl = plan(b, build, p, drag, modifiers.shift, modifiers.ctrl);
      let ghost: Ghost | null = null;
      let verdict: BuildCursor['verdict'] = null;
      let readout: BuildCursor['readout'] = null;
      if (pl) {
        const v = verdictOf(b, pl.ops);
        ghost = pl.ghost(v.ok);
        if (ghost) verdict = { ok: v.ok, text: v.text };
        const text = !v.ok ? v.text : pl.readout;
        if (text && (last ?? seen)) {
          const spot = drag && pl.anchor ? screenOf(pl.anchor, build.level) : null;
          const at = (last ?? seen)!;
          readout = spot ? { text, x: spot.x, y: spot.y, bad: !v.ok, anchored: true } : { text, x: at.x, y: at.y, bad: !v.ok };
        }
      }
      if (!ghost && build.tool.kind === 'select' && hover && story) {
        const item = floorItems(story).find((i) => i.id === hover);
        const whole = item?.blockId && modifiers.shift ? blockItems(story, item.blockId) : [];
        if (whole.length) ghost = { kind: 'blockSelect', items: whole };
        else if (item) ghost = { kind: 'outline', item };
      }
      setGhost(ghost, build.level);
      publish({ readout, verdict, hover });
    };

    const track = (e: PointerEvent) => {
      last = seen = { x: e.clientX, y: e.clientY };
      modifiers.shift = e.shiftKey || modifiers.shift;
      const r = el.getBoundingClientRect();
      buildView.edge.x = e.clientX - r.left < EDGE_PX ? -1 : r.right - e.clientX < EDGE_PX ? 1 : 0;
      buildView.edge.z = e.clientY - r.top < EDGE_PX ? -1 : r.bottom - e.clientY < EDGE_PX ? 1 : 0;
    };

    const onDown = (e: PointerEvent) => {
      track(e);
      grabbed = false;
      down = { x: e.clientX, y: e.clientY, button: e.button };
      if (e.button !== 0) return;
      const c = current();
      if (!c) return;
      const tool = c.build.tool;
      const kind = tool.kind === 'room' && modifiers.shift ? 'wall' : tool.kind;
      if (kind === 'select' || (tool.kind === 'block' && !tool.carry)) {
        grabbed = pickAt(c.b, c.build, c.p, modifiers.shift);
      } else if (kind === 'wall' || kind === 'room') {
        drag = { tool: kind, a: vertexOf(c.p), erase: modifiers.ctrl, tiles: new Map(), flood: false, lastTile: null };
      } else if (kind === 'floor') {
        const t = tileOf(c.p);
        drag = { tool: 'floor', a: t, erase: false, tiles: new Map([[tkey(t), t]]), flood: modifiers.shift || c.build.fill, lastTile: t };
      }
      refresh();
    };

    const onMove = (e: PointerEvent) => {
      track(e);
      const c = current();
      if (drag?.lastTile && c) {
        const t = tileOf(c.p);
        if (!same(t, drag.lastTile)) {
          for (const x of lineTiles(drag.lastTile, t)) drag.tiles.set(tkey(x), x);
          drag.lastTile = t;
        }
      }
      refresh();
    };

    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      const wasGrab = grabbed;
      grabbed = false;
      if (!start) return;
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) >= CLICK_PX;
      if (start.button === 2) {
        if (!moved) stepBack();
        return;
      }
      if (start.button !== 0) return;
      track(e);
      const c = current();
      const finished = drag;
      drag = null;
      if (!c) return;
      const { build, b, p } = c;
      const tool = build.tool;
      if (wasGrab && !moved) {
        refresh();
        return;
      }
      if (tool.kind === 'select' || (tool.kind === 'block' && !tool.carry)) return;
      if ((tool.kind === 'wall' || tool.kind === 'room' || tool.kind === 'floor') && !finished) return;
      if (finished && finished.tool !== 'floor' && !moved) {
        refresh();
        return;
      }
      const pl = plan(b, build, p, finished, modifiers.shift, modifiers.ctrl);
      const fits = !!pl && verdictOf(b, pl.ops).ok;
      if (pl && fits && pl.ops.length) sendOps(pl.ops);
      // A piece or block that is dropped lets go, whether or not it moved. A drag that ends somewhere it does not fit puts it back.
      if ((tool.kind === 'item' || tool.kind === 'block') && tool.carry && (fits || wasGrab)) {
        if (tool.kind === 'block') setTool({ kind: 'block', carry: null });
        else setTool({ kind: 'select' });
      }
      refresh();
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey && !modifiers.shift) return;
      const tool = get().build?.tool;
      if (tool?.kind !== 'item' && !(tool?.kind === 'block' && tool.carry)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      rotate((e.deltaY || e.deltaX) > 0 ? 1 : -1);
    };

    const onLeave = () => {
      buildView.edge.x = buildView.edge.z = 0;
      if (drag) return;
      last = null;
      refresh();
    };

    // The scene's own click handlers walk the owner and pick furniture. In build mode a click is a build gesture only.
    const eatClick = (e: MouseEvent) => e.stopImmediatePropagation();
    const onKey = () => refresh();
    const unsub = useStore.subscribe((s, prev) => {
      if (s.build !== prev.build || s.building !== prev.building) refresh();
    });

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('click', eatClick, true);
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      unsub();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('click', eatClick, true);
      el.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      buildView.edge.x = buildView.edge.z = 0;
      setGhost(null);
    };
  }, [on, gl, camera]);
  return null;
}
