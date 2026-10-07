// What every employee's terminal holds in this window, kept from the pushes main sends (shared/terminal.ts). It lives outside the
// store on purpose: a model writing a paragraph pushes ten times a second, and nothing but the monitors and the open terminal reads it.
// It subscribes to the office by itself, the way hud/tasks/live.ts does.
import { useSyncExternalStore } from 'react';
import { applyPush, modelName, type TermBlock, type TermLive, type TerminalPush } from '../../../../shared/terminal.ts';

type Held = { blocks: Map<number, TermBlock>; sorted: readonly TermBlock[]; live: TermLive; version: number };

const held = new Map<string, Held>();
const listeners = new Set<() => void>();
const NONE: readonly TermBlock[] = [];
const NO_LIVE: TermLive = { tokens: 0 };
let started = false;

const emit = () => listeners.forEach((l) => l());

function apply(employeeId: string, push: TerminalPush) {
  const h = held.get(employeeId) ?? { blocks: new Map<number, TermBlock>(), sorted: NONE, live: NO_LIVE, version: 0 };
  applyPush(h.blocks, push);
  h.sorted = [...h.blocks.values()].sort((a, b) => a.n - b.n);
  h.live = push.live;
  h.version++;
  held.set(employeeId, h);
  emit();
}

export function startTerminalFeed() {
  if (started) return;
  started = true;
  window.office.subscribe((m) => {
    if (m.type === 'terminal') {
      apply(m.employeeId, m);
    } else if (m.type === 'snapshot') {
      const ids = new Set(m.company.employees.map((e) => e.id as string));
      let gone = false;
      for (const id of held.keys()) if (!ids.has(id)) gone = held.delete(id) || gone;
      if (gone) emit();
    }
  });
  // For the tests, which cannot make main push to people main does not know.
  (window as unknown as { __officeTerminalPush: unknown }).__officeTerminalPush = (m: { employeeId: string } & TerminalPush) => apply(m.employeeId, m);
  window.office.send({ type: 'load_terminal' });
}

export const terminalVersion = (id: string): number => held.get(id)?.version ?? 0;
export const terminalBlocks = (id: string): readonly TermBlock[] => held.get(id)?.sorted ?? NONE;
export const terminalLive = (id: string): TermLive => held.get(id)?.live ?? NO_LIVE;

export function subscribeTerminal(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

// Re-renders when anything on this employee's terminal changed.
export function useTerminalVersion(id: string): number {
  return useSyncExternalStore(subscribeTerminal, () => terminalVersion(id));
}

// What the status line says of a model.
export const modelLabel = (model: string): string => modelName(model);
