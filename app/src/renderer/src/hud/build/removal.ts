// Deleting a whole block from build mode: it takes its people with it, so the owner confirms first, with their names.
import { create } from 'zustand';
import { get, send } from '../../store.ts';
import { setTool } from './actions.ts';

/** The block waiting for the owner's yes, or null. */
export const removal = create<{ blockId: string | null }>(() => ({ blockId: null }));

export const askToRemove = (blockId: string) => removal.setState({ blockId });
export const keepBlock = () => removal.setState({ blockId: null });

/** Who would be fired, and what goes with them, for the question and for the test of it. */
export function consequences(blockId: string): { name: string; people: string[] } | null {
  const company = get().company;
  const block = company?.blocks.find((b) => b.id === blockId);
  if (!company || !block) return null;
  return { name: block.name, people: company.employees.filter((e) => e.blockId === blockId).map((e) => e.name) };
}

/** The yes: main fires the team, takes every piece of the block out of the building and forgets the block. */
export function removeBlock() {
  const { blockId } = removal.getState();
  keepBlock();
  const block = get().company?.blocks.find((b) => b.id === blockId);
  if (!block) return;
  send({ type: 'remove_block', blockId: block.id });
  setTool({ kind: 'block', carry: null });
}
