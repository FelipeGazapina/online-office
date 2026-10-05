import type { BuildOp, Item, ItemId, Rot } from '../../../../shared/space/index.ts';
import { runtime } from '../../runtime.ts';
import { get, send, set, setSetting, useStore, type BuildState, type BuildTool } from '../../store.ts';
import { ENTRIES, type Entry, type TabId } from './catalog.ts';
import { buildView, modifiers, setGhost } from './state.ts';

const FRESH: Omit<BuildState, 'level'> = { tool: { kind: 'select' }, tab: 'desks', search: '', paint: 1, style: 0, wallsMode: 'cutaway' };

export function patchBuild(patch: Partial<BuildState>) {
  const build = get().build;
  if (build) set({ build: { ...build, ...patch } });
}

export function enterBuild() {
  const s = get();
  if (s.build || !s.building || s.portalMode || s.computerState === 'seated' || s.modal) return;
  if (s.camera !== 'iso') setSetting('camera', 'iso');
  const level = Math.min(s.story, s.building.stories.length - 1);
  buildView.x = runtime.owner.pos.x;
  buildView.z = runtime.owner.pos.z;
  runtime.keys.clear();
  set({ build: { ...FRESH, level }, story: level, selectedId: null, menu: null });
}

export function exitBuild() {
  if (!get().build) return;
  setGhost(null);
  buildView.keys.clear();
  set({ build: null, buildCursor: { readout: null, verdict: null, hover: null } });
}

export const toggleBuild = () => (get().build ? exitBuild() : enterBuild());

export function setTool(tool: BuildTool) {
  setGhost(null);
  patchBuild({ tool });
}

export function selectTab(tab: TabId) {
  patchBuild({ tab, search: '' });
}

export function chooseEntry(entry: Entry) {
  const s = get();
  const build = s.build;
  if (!build) return;
  switch (entry.kind) {
    case 'item': {
      const blockId = entry.teamed ? (build.tool.kind === 'item' && build.tool.blockId) || (s.company?.blocks[0]?.id ?? null) : null;
      return setTool({ kind: 'item', def: entry.def, rot: 0, carry: null, blockId });
    }
    case 'tool':
      return setTool(entry.tool);
    case 'floor':
      setGhost(null);
      return patchBuild({ paint: entry.paint, tool: { kind: 'floor' } });
    case 'style':
      setGhost(null);
      return patchBuild({ style: entry.style, tool: { kind: 'wallpaint' } });
  }
}

/** Whether an entry is the one currently in the owner's hand. */
export function isActive(entry: Entry, build: BuildState): boolean {
  const t = build.tool;
  switch (entry.kind) {
    case 'item':
      return t.kind === 'item' && t.def === entry.def;
    case 'tool':
      return t.kind === entry.tool.kind && (t.kind !== 'opening' || (entry.tool.kind === 'opening' && t.open === entry.tool.open));
    case 'floor':
      return t.kind === 'floor' && build.paint === entry.paint;
    case 'style':
      return t.kind === 'wallpaint' && build.style === entry.style;
  }
}

export const sendOps = (ops: BuildOp[]) => {
  if (ops.length) send({ type: 'build', ops });
};

export const undo = () => send({ type: 'undo' });
export const redo = () => send({ type: 'redo' });

export function setLevel(level: number) {
  const s = get();
  if (!s.build || !s.building) return;
  const next = Math.max(0, Math.min(s.building.stories.length - 1, level));
  if (next === s.build.level) return;
  setGhost(null);
  // A moved item belongs to the story it was picked up on.
  const tool: BuildTool = s.build.tool.kind === 'item' && s.build.tool.carry ? { kind: 'select' } : s.build.tool;
  set({ build: { ...s.build, level: next, tool }, story: next });
}

let wantNewFloor = false;
export function addFloor() {
  const b = get().building;
  if (!b || b.stories.length >= 4) return;
  wantNewFloor = true;
  send({ type: 'build', ops: [{ t: 'stories', count: b.stories.length + 1 }] });
}
useStore.subscribe((s, prev) => {
  if (wantNewFloor && s.build && s.building && prev.building && s.building.stories.length > prev.building.stories.length) {
    wantNewFloor = false;
    setLevel(s.building.stories.length - 1);
  }
});

export function rotate(step: 1 | -1) {
  const tool = get().build?.tool;
  if (tool?.kind !== 'item') return;
  patchBuild({ tool: { ...tool, rot: (((tool.rot + step) % 4) + 4) % 4 as Rot } });
  setGhost(null);
}

let serial = 0;
export function newItemId(def: string): ItemId {
  return `${def}:b${Date.now().toString(36)}${(serial++).toString(36)}` as ItemId;
}

/** The item as the tool would put it at the cell, new or moved. */
export function toolItem(tool: Extract<BuildTool, { kind: 'item' }>, at: { x: number; z: number }, existing: Item | null): Item {
  const item: Item = { id: tool.carry ?? newItemId(tool.def), def: tool.def, x: at.x, z: at.z, rot: tool.rot };
  if (tool.blockId) item.blockId = tool.blockId;
  if (existing?.tint !== undefined) item.tint = existing.tint;
  return item;
}

export function entryOfDef(def: string): Entry | undefined {
  return ENTRIES.find((e) => e.kind === 'item' && e.def === def);
}

export function holdModifier(code: string, down: boolean) {
  if (code === 'ShiftLeft' || code === 'ShiftRight') modifiers.shift = down;
  if (code === 'ControlLeft' || code === 'ControlRight' || code === 'MetaLeft' || code === 'MetaRight') modifiers.ctrl = down;
}
