// The build catalog as data: which tab holds which entry, and what picking an entry does. Furniture entries come from
// the space module's ITEM_DEFS, so a new def with a name here shows up in the catalog and nowhere else needs to change.
import { FLOOR_PAINTS, ITEM_DEFS, WALL_STYLES } from '../../../../shared/space/index.ts';
import type { BuildTool } from '../../store.ts';

export type TabId = 'desks' | 'seating' | 'tables' | 'decor' | 'plants' | 'storage' | 'stairs' | 'walls' | 'floors' | 'openings';

export type Entry =
  | { id: string; name: string; tab: TabId; kind: 'item'; def: string; teamed: boolean }
  | { id: string; name: string; tab: TabId; kind: 'tool'; tool: BuildTool; icon: 'wall' | 'room' | 'door' | 'window' | 'arch' }
  | { id: string; name: string; tab: TabId; kind: 'floor'; paint: number; color: string }
  | { id: string; name: string; tab: TabId; kind: 'style'; style: number; color: string };

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'desks', label: 'Desks & Work' },
  { id: 'seating', label: 'Seating' },
  { id: 'tables', label: 'Tables' },
  { id: 'decor', label: 'Decor' },
  { id: 'plants', label: 'Plants' },
  { id: 'storage', label: 'Storage' },
  { id: 'stairs', label: 'Stairs' },
  { id: 'walls', label: 'Walls' },
  { id: 'floors', label: 'Floors' },
  { id: 'openings', label: 'Doors & Windows' },
];

const furniture: readonly [string, string, TabId, boolean][] = [
  ['bench_desk', 'Team desk', 'desks', true],
  ['po_desk', 'PO desk', 'desks', true],
  ['whiteboard', 'Whiteboard', 'desks', true],
  ['board_terminal', 'Board terminal', 'desks', true],
  ['sofa', 'Sofa', 'seating', false],
  ['chair', 'Chair', 'seating', false],
  ['meeting_table', 'Meeting table', 'tables', false],
  ['coffee_machine', 'Coffee machine', 'decor', false],
  ['rug', 'Rug', 'decor', false],
  ['team_sign', 'Team sign', 'decor', true],
  ['plant', 'Plant', 'plants', false],
  ['bookshelf', 'Bookshelf', 'storage', false],
  ['stairs', 'Stairs', 'stairs', false],
];

const tool = (id: string, name: string, tab: TabId, t: BuildTool, icon: 'wall' | 'room' | 'door' | 'window' | 'arch'): Entry => ({ id, name, tab, kind: 'tool', tool: t, icon });

export const ENTRIES: readonly Entry[] = [
  ...furniture.map(([def, name, tab, teamed]): Entry => ({ id: def, name, tab, kind: 'item', def, teamed })),
  tool('wall', 'Wall', 'walls', { kind: 'wall' }, 'wall'),
  tool('room', 'Room', 'walls', { kind: 'room' }, 'room'),
  ...WALL_STYLES.map((s, style): Entry => ({ id: `style:${style}`, name: label(s.name), tab: 'walls', kind: 'style', style, color: s.color })),
  ...FLOOR_PAINTS.map((p, paint): Entry => ({ id: `floor:${paint}`, name: paint === 0 ? 'No floor' : label(p.name), tab: 'floors', kind: 'floor', paint, color: p.color })),
  tool('door', 'Door', 'openings', { kind: 'opening', open: 'door' }, 'door'),
  tool('window', 'Window', 'openings', { kind: 'opening', open: 'window' }, 'window'),
  tool('arch', 'Archway', 'openings', { kind: 'opening', open: 'arch' }, 'arch'),
];

function label(name: string): string {
  const spaced = name.replaceAll('_', ' ');
  return spaced[0].toUpperCase() + spaced.slice(1);
}

/** Footprint of a furniture entry in meters, for the card caption. */
export function footprintText(def: string): string {
  const d = ITEM_DEFS[def];
  const fmt = (n: number) => String(n / 2);
  return `${fmt(d.w)} × ${fmt(d.d)} m`;
}

/** Entries of a tab, or across every tab matching the search words when there is a search. */
export function visibleEntries(tab: TabId, search: string): readonly Entry[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return ENTRIES.filter((e) => e.tab === tab);
  return ENTRIES.filter((e) => {
    const hay = `${e.name} ${TABS.find((t) => t.id === e.tab)?.label ?? ''} ${e.kind === 'item' ? e.def : ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
