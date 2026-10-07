// The build catalog as data: which tab holds which entry, and what picking an entry does. Furniture entries come from
// the space module's ITEM_DEFS, so a new def with a name here shows up in the catalog and nowhere else needs to change.
import { FLOOR_PAINTS, ITEM_DEFS, VIGNETTES, WALL_STYLES, placementOf } from '../../../../shared/space/index.ts';
import type { BuildTool } from '../../store.ts';

export type TabId = 'desks' | 'seating' | 'tables' | 'decor' | 'plants' | 'storage' | 'tabletop' | 'stairs' | 'walls' | 'floors' | 'openings';

export type Entry =
  | { id: string; name: string; tab: TabId; kind: 'item'; def: string; teamed: boolean }
  | { id: string; name: string; tab: TabId; kind: 'tool'; tool: BuildTool; icon: 'wall' | 'room' | 'door' | 'window' | 'arch' }
  | { id: string; name: string; tab: TabId; kind: 'floor'; paint: number; color: string }
  | { id: string; name: string; tab: TabId; kind: 'style'; style: number; color: string };

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'desks', label: 'Desks' },
  { id: 'seating', label: 'Seating' },
  { id: 'tables', label: 'Tables' },
  { id: 'decor', label: 'Decor' },
  { id: 'plants', label: 'Plants' },
  { id: 'storage', label: 'Storage' },
  { id: 'tabletop', label: 'Tabletop' },
  { id: 'stairs', label: 'Stairs' },
  { id: 'walls', label: 'Walls' },
  { id: 'floors', label: 'Floors' },
  { id: 'openings', label: 'Doors' },
];

const furniture: readonly [string, string, TabId, boolean][] = [
  ['bench_desk', 'Team desk', 'desks', true],
  ['po_desk', 'PO desk', 'desks', true],
  ['standing_desk', 'Standing desk', 'desks', false],
  ['l_desk', 'L-desk', 'desks', false],
  ['corner_desk', 'Corner desk', 'desks', false],
  ['pair_desk', 'Pair desk', 'desks', false],
  ['reception_desk', 'Reception desk', 'desks', false],
  ['meeting_pod', 'Meeting pod', 'desks', false],
  ['chair', 'Office chair', 'seating', false],
  ['sofa', 'Sofa', 'seating', false],
  ['loveseat', 'Loveseat', 'seating', false],
  ['armchair', 'Armchair', 'seating', false],
  ['bench', 'Bench', 'seating', false],
  ['beanbag', 'Beanbag', 'seating', false],
  ['stool', 'Stool', 'seating', false],
  ['pod_pouf', 'Pouf', 'seating', false],
  ['ottoman', 'Ottoman', 'seating', false],
  ['meeting_table', 'Meeting table', 'tables', false],
  ['meeting_round', 'Round table', 'tables', false],
  ['meeting_long', 'Long table', 'tables', false],
  ['coffee_table', 'Coffee table', 'tables', false],
  ['side_table', 'Side table', 'tables', false],
  ['high_table', 'High table', 'tables', false],
  ['cafe_table', 'Cafe table', 'tables', false],
  ['folding_table', 'Folding table', 'tables', false],
  ['pod_huddle_table', 'Huddle table', 'tables', true],
  ['coffee_machine', 'Coffee machine', 'decor', false],
  ['lamp_floor', 'Floor lamp', 'decor', false],
  ['lamp_desk', 'Desk lamp', 'decor', false],
  ['wall_art', 'Framed art', 'decor', false],
  ['clock', 'Clock', 'decor', false],
  ['divider', 'Divider screen', 'decor', false],
  ['rug', 'Large rug', 'decor', false],
  ['rug_small', 'Small rug', 'decor', false],
  ['rug_round', 'Round rug', 'decor', false],
  ['pod_rug', 'Team rug', 'decor', true],
  ['pod_rail_back', 'Long rail', 'decor', false],
  ['pod_rail_side', 'Side rail', 'decor', false],
  ['pod_glass_rail', 'Glass rail', 'decor', true],
  ['pod_slat_wall', 'Slat wall', 'decor', false],
  ['pod_daily_sign', 'Daily sign', 'decor', true],
  ['pod_printer', 'Printer table', 'decor', false],
  ['pod_cooler', 'Water cooler', 'decor', false],
  ['pod_bin', 'Bin', 'decor', false],
  ['plant_small', 'Small plant', 'plants', false],
  ['plant', 'Plant', 'plants', false],
  ['plant_large', 'Large plant', 'plants', false],
  ['plant_tree', 'Indoor tree', 'plants', false],
  ['plant_cactus', 'Cactus', 'plants', false],
  ['plant_fern', 'Fern', 'plants', false],
  ['plant_planter', 'Planter box', 'plants', false],
  ['plant_hedge', 'Hedge', 'plants', false],
  ['bookshelf', 'Bookshelf', 'storage', false],
  ['cabinet', 'Cabinet', 'storage', false],
  ['lockers', 'Lockers', 'storage', false],
  ['filing', 'Filing cabinet', 'storage', false],
  ['shelf_low', 'Low shelf', 'storage', false],
  ['wardrobe', 'Wardrobe', 'storage', false],
  ['sideboard', 'Sideboard', 'storage', false],
  ['cubby', 'Cubbies', 'storage', false],
  ['pod_credenza', 'Credenza', 'storage', false],
  ['pod_shelf', 'Book shelf', 'storage', false],
  ['pod_boxes', 'Supply boxes', 'storage', false],
  ['laptop', 'Laptop', 'tabletop', false],
  ['books', 'Books', 'tabletop', false],
  ['papers', 'Papers', 'tabletop', false],
  ['mug', 'Mug', 'tabletop', false],
  ['picture_frame', 'Picture frame', 'tabletop', false],
  ['vase', 'Vase', 'tabletop', false],
  ['pen_cup', 'Pen cup', 'tabletop', false],
  ['desk_clock', 'Desk clock', 'tabletop', false],
  ['trophy', 'Trophy', 'tabletop', false],
  ['notebook', 'Notebook', 'tabletop', false],
  ['folder', 'Folder', 'tabletop', false],
  ['magazine', 'Magazine', 'tabletop', false],
  ['coaster', 'Coaster', 'tabletop', false],
  ['lunchbox', 'Lunchbox', 'tabletop', false],
  ['books_row', 'Books upright', 'tabletop', false],
  ['sticky_notes', 'Sticky notes', 'tabletop', false],
  ['headphones', 'Headphones', 'tabletop', false],
  ['water_bottle', 'Water bottle', 'tabletop', false],
  ['tumbler', 'Tumbler', 'tabletop', false],
  ['takeaway_cup', 'Coffee to go', 'tabletop', false],
  ['desk_organizer', 'Desk organizer', 'tabletop', false],
  ['frame_small', 'Small frame', 'tabletop', false],
  ['succulent', 'Succulent', 'tabletop', false],
  ['succulent_trio', 'Succulent trio', 'tabletop', false],
  ['potted_plant', 'Potted plant', 'tabletop', false],
  ['cable_tray', 'Cable tray', 'tabletop', false],
  ['snack_bowl', 'Snack bowl', 'tabletop', false],
  ['calculator', 'Calculator', 'tabletop', false],
  ['phone_stand', 'Phone on stand', 'tabletop', false],
  ['tablet', 'Tablet', 'tabletop', false],
  ['candle', 'Candle', 'tabletop', false],
  ['cat_statue', 'Cat statue', 'tabletop', false],
  ['letter_tray', 'Letter tray', 'tabletop', false],
  ['glasses', 'Glasses', 'tabletop', false],
  ['stapler', 'Stapler', 'tabletop', false],
  ['speaker', 'Speaker', 'tabletop', false],
  ['tray', 'Tray', 'tabletop', false],
  ['runner', 'Table runner', 'tabletop', false],
  ['stairs', 'Stairs', 'stairs', false],
];

// Furniture that also stands on a surface is listed in the Tabletop tab as well as under its own, so the owner finds a lamp or a plant where
// they look for things to put on a desk. The second entry is the same def; a search lists each def once.
export const TOP_PREFIX = 'tabletop:';
const ALSO_ON_TOPS: readonly string[] = furniture.map(([def]) => def).filter((def) => placementOf(ITEM_DEFS[def]) === 'both' && ITEM_DEFS[def].top!.w * ITEM_DEFS[def].top!.d <= 16);

const tool = (id: string, name: string, tab: TabId, t: BuildTool, icon: 'wall' | 'room' | 'door' | 'window' | 'arch'): Entry => ({ id, name, tab, kind: 'tool', tool: t, icon });

export const ENTRIES: readonly Entry[] = [
  // The sets come first in the Tabletop tab: one card, several things, put down together.
  ...VIGNETTES.map((v): Entry => ({ id: v.id, name: v.name, tab: 'tabletop', kind: 'item', def: v.id, teamed: false })),
  ...ALSO_ON_TOPS.map((def): Entry => ({ id: `${TOP_PREFIX}${def}`, name: furniture.find(([d]) => d === def)![1], tab: 'tabletop', kind: 'item', def, teamed: false })),
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
  if (d.group) return `${d.group.length} pieces`;
  // What only stands on a surface is measured on it, in centimeters: a mug is 13 by 13.
  if (d.top && placementOf(d) === 'surface') return `${Math.round(d.top.w * 12.5)} × ${Math.round(d.top.d * 12.5)} cm`;
  const fmt = (n: number) => String(n / 2);
  return `${fmt(d.w)} × ${fmt(d.d)} m`;
}

/** Entries of a tab. While the search box is open every entry is listed, and the words narrow them as they are typed. */
export function visibleEntries(tab: TabId, search: string, searching: boolean): readonly Entry[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!searching && !words.length) return ENTRIES.filter((e) => e.tab === tab);
  return ENTRIES.filter((e) => !e.id.startsWith(TOP_PREFIX)).filter((e) => {
    const hay = `${e.name} ${TABS.find((t) => t.id === e.tab)?.label ?? ''} ${e.kind === 'item' ? e.def : ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
