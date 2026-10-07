import { blockItems, cellBounds, CELL, ITEM_DEFS, missingEssentials, type BuildOp, type Item, type ItemId, type Rot, type Vec2 } from '../../../../shared/space/index.ts';
import { leaveComputer } from '../../computer.ts';
import { runtime } from '../../runtime.ts';
import { get, send, set, setSetting, toast, useStore, type BuildState, type BuildTool } from '../../store.ts';
import { ENTRIES, type Entry, type TabId } from './catalog.ts';
import { BUILD_DIST, buildView, modifiers, setGhost, spaceContext } from './state.ts';

const FRESH: Omit<BuildState, 'level'> = { tool: { kind: 'select' }, tab: 'desks', search: '', searching: false, peek: null, fill: false, paint: 1, style: 0, wallsMode: 'cutaway' };

export function patchBuild(patch: Partial<BuildState>) {
  const build = get().build;
  if (build) set({ build: { ...build, ...patch } });
}

export function enterBuild() {
  const s = get();
  if (s.build || !s.building || s.portalMode || s.modal) return;
  // Sitting at the owner's computer is not a reason to refuse: the Build button must always do something.
  if (s.computerState === 'seated') leaveComputer();
  if (s.camera !== 'iso') setSetting('camera', 'iso');
  const level = Math.min(s.story, s.building.stories.length - 1);
  buildView.x = runtime.owner.pos.x;
  buildView.z = runtime.owner.pos.z;
  runtime.keys.clear();
  buildView.dist = runtime.view.isoDist;
  runtime.view.isoDist = Math.min(runtime.view.isoDist, BUILD_DIST);
  set({ build: { ...FRESH, level }, story: level, selectedId: null, menu: null });
  send({ type: 'build_begin' });
}

function leaveBuild() {
  if (!get().build) return;
  setGhost(null);
  buildView.keys.clear();
  runtime.view.isoDist = buildView.dist || runtime.view.isoDist;
  set({ build: null, buildCursor: { readout: null, verdict: null, hover: null } });
}

/** Keeps the draft and leaves, or stays and says what is missing. Main checks the same rules again before it saves. */
export function saveBuild() {
  const s = get();
  if (!s.build || !s.building) return;
  const missing = missingEssentials(s.building, spaceContext(s.company));
  if (missing.length) {
    toast('The office cannot be saved yet. The checklist shows what is missing.', 'warn');
    return;
  }
  send({ type: 'build_save' });
  leaveBuild();
}

/** Leaves without keeping anything done since build mode opened. */
export function discardBuild() {
  if (!get().build) return;
  send({ type: 'build_discard' });
  leaveBuild();
}

export const clearBuild = () => send({ type: 'build_clear' });

export const toggleBuild = () => (get().build ? saveBuild() : enterBuild());

/** Esc and a right click. A block in hand goes back and the block tool stays, so the next block is one click away. */
export function stepBack() {
  const tool = get().build?.tool;
  if (tool?.kind === 'block' && tool.carry) setTool({ kind: 'block', carry: null });
  else if (tool && tool.kind !== 'select') setTool({ kind: 'select' });
}

export function pickUpBlock(blockId: string, at: Vec2): boolean {
  const s = get();
  const box = s.build && s.building ? cellBounds(blockItems(s.building.stories[s.build.level], blockId)) : null;
  if (!box) return false;
  setTool({ kind: 'block', carry: { blockId, quarter: 0, grab: { x: at.x / CELL - (box.x0 + box.x1) / 2, z: at.z / CELL - (box.z0 + box.z1) / 2 } } });
  return true;
}

export function setTool(tool: BuildTool) {
  setGhost(null);
  patchBuild({ tool });
}

/** The furniture card under the pointer, or null once it leaves: the scene draws it as the cursor ghost. */
export const peek = (def: string | null) => patchBuild({ peek: def });

export function selectTab(tab: TabId) {
  patchBuild({ tab, search: '', searching: false });
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
  // A moved item belongs to the story it was picked up on. A block in hand goes with the owner to the new floor: that is how it changes floors.
  const t = s.build.tool;
  const tool: BuildTool = t.kind === 'item' && t.carry ? { kind: 'select' } : t;
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

const turned = (rot: Rot, step: 1 | -1) => (((rot + step) % 4) + 4) % 4 as Rot;

export const canTurn = (tool: BuildTool) => (tool.kind === 'item' && ITEM_DEFS[tool.def]?.kind !== 'stairs') || (tool.kind === 'block' && !!tool.carry);

export function rotate(step: 1 | -1) {
  const tool = get().build?.tool;
  if (tool?.kind === 'block' && tool.carry) {
    const { grab } = tool.carry;
    // The hold point turns with the block, by the same quarter turn the pieces make.
    const held = step === 1 ? { x: -grab.z, z: grab.x } : { x: grab.z, z: -grab.x };
    patchBuild({ tool: { kind: 'block', carry: { ...tool.carry, quarter: turned(tool.carry.quarter, step), grab: held } } });
    setGhost(null);
    return;
  }
  if (tool?.kind !== 'item') return;
  patchBuild({ tool: { ...tool, rot: turned(tool.rot, step) } });
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
