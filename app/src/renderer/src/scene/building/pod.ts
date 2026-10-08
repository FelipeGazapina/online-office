// The models of the pieces a team's pod is made of. Each was a part of the static pod, drawn around the block's middle by code;
// now each is a def of its own whose model is the same boxes and cylinders, moved so that its origin is the middle of its
// footprint, which is how every other def's model sits. `middle` is that point in meters from the block's middle, so a piece
// placed by `shellItems` at rot 0 draws exactly where the static pod drew it.
import { Color, type BufferGeometry } from 'three';
import { art, shelf } from './decorParts.ts';
import { bbox, box, cyl, merge } from './parts.ts';

const placed = (parts: BufferGeometry[], middle: readonly [number, number]) => merge(parts.map((g) => g.translate(-middle[0], 0, -middle[1])));

/** The team's trim color: the block's color pulled toward slate. The boundary and the huddle chairs wear it. */
export const trimOf = (blockColor: string): Color => new Color(blockColor).lerp(new Color('#738195'), 0.5);

/** The rug of a block: the color of a team's carpet, the block's color pulled toward cream. */
export const rugOf = (blockColor: string): Color => new Color(blockColor).lerp(new Color('#f1cd8e'), 0.9);

const SLAT_TONES = ['#c08a5a', '#b27a4c', '#cb9768', '#a96f42'];
// Behind the whiteboard: a walnut slat wall with two framed pictures, so the board stands against a finished wall and not against glass.
function slatWall(): BufferGeometry {
  const z = -4.45;
  const parts: BufferGeometry[] = [box(6.4, 2.8, 0.04, 0.25, 1.4, z - 0.02, '#7a5a3e'), box(6.5, 0.08, 0.1, 0.25, 2.84, z - 0.05, '#2b2e38'), box(6.5, 0.1, 0.1, 0.25, 0.05, z - 0.05, '#2b2e38')];
  for (let i = 0; i < 42; i++) parts.push(box(0.09, 2.7, 0.06 + (i % 3) * 0.015, 0.25 - 3.1 + i * 0.15, 1.4, z - 0.07, SLAT_TONES[i % 4]));
  parts.push(...art(-2.65, 1.7, z + 0.02, 0.6, 0.9, 1, 2), ...art(3.15, 1.7, z + 0.02, 0.6, 0.9, 1, 3));
  return placed(parts, [0.25, -4.5]);
}

const credenza = () =>
  placed(
    [
      bbox(0.9, 0.7, 2.4, 4.3, 0.35, 0.3, '#efe0c6', 0.05),
      bbox(0.96, 0.06, 2.46, 4.3, 0.73, 0.3, '#c59e73', 0.025),
      ...[-0.8, 0, 0.8].map((dz) => box(0.02, 0.5, 0.7, 3.84, 0.37, 0.3 + dz, '#d8c4a4')),
    ],
    [4.5, 0.5],
  );

// A printer on its table.
const printer = () =>
  placed(
    [
      box(0.9, 0.04, 0.55, 2.8, 0.7, -3.5, '#efe0c6'),
      ...[-0.4, 0.4].map((dx) => box(0.05, 0.68, 0.5, 2.8 + dx, 0.34, -3.5, '#3a3f4e')),
      box(0.5, 0.22, 0.4, 2.8, 0.83, -3.5, '#e8ecee'),
      box(0.4, 0.03, 0.3, 2.8, 0.96, -3.5, '#f7f4ec'),
    ],
    [2.75, -3.75],
  );

const cooler = () => placed([cyl(0.17, 0.17, 0.95, -2.8, 0.48, -3.6, '#e8ecee', 12), cyl(0.15, 0.15, 0.4, -2.8, 1.15, -3.6, '#9fd0ee', 12)], [-2.75, -3.75]);
const bin = () => placed([cyl(0.14, 0.12, 0.34, -1.6, 0.17, -3.6, '#3a3f4e', 10)], [-1.75, -3.75]);

// A low shelf of books with a framed picture hung above it on the side of the pod.
const podShelf = () => placed([...shelf(-4.7, 0.6, 2.2, 0), ...art(0, 1.35, 0, 0.5, 0.6, 1, 3).map((g) => g.rotateY(Math.PI / 2).translate(-4.55, 0, 1.4))], [-4.75, 0.75]);

const boxes = () => placed([box(0.5, 0.35, 0.4, -4.5, 0.18, -1.3, '#c9a77c'), box(0.42, 0.3, 0.36, -4.5, 0.5, -1.3, '#d8b88a')], [-4.75, -1.25]);
const pouf = () => placed([cyl(0.5, 0.5, 0.3, 2.4, 0.15, 3.3, '#b08a5e', 40), cyl(0.46, 0.5, 0.08, 2.4, 0.34, 3.3, '#d2b58a', 40)], [2, 3.5]);

// The low boundary is one color that the instance takes: white here, the trim color on the back rail. The sides are pale slate.
const WHITE: [number, number, number] = [1, 1, 1];
const railBack = () => merge([box(9.6, 0.56, 0.08, 0, 0.28, 0.03, WHITE)]);
// A side rail turned a quarter lies along z; its model sits 3 cm off its cell so the west rail (turn 1) and the east rail (turn 3) both land where the static pod drew them.
const railSide = () => merge([box(7.4, 0.56, 0.08, 0, 0.28, -0.03, '#d2d8dd')]);

// Pieces that React draws with their own materials and textures. These flat stand-ins are what the build ghost and the
// catalog thumbnail show for them.
const rugStandIn = () => merge([box(9.5, 0.02, 7.5, 0, 0.01, 0, '#d9c9a8'), box(9, 0.025, 7, 0, 0.014, 0, '#e0c9a0')]);
const glassRailStandIn = () =>
  merge([
    box(3.1, 0.04, 0.06, 0, 0.02, 0, '#c9ced4'),
    box(3.1, 0.03, 0.05, 0, 0.76, 0, '#c9ced4'),
    box(0.04, 0.78, 0.05, -1.55, 0.39, 0, '#c9ced4'),
    box(0.04, 0.78, 0.05, 1.55, 0.39, 0, '#c9ced4'),
    box(3.1, 0.72, 0.02, 0, 0.4, 0, '#dcefff'),
  ]);
const huddleTableStandIn = () =>
  merge([cyl(1.25, 1.25, 0.06, 0, 0.035, 0, '#9aa6b5', 40), cyl(0.8, 0.8, 0.05, 0, 0.7, 0, '#eadfc9', 40), cyl(0.07, 0.1, 0.65, 0, 0.35, 0, '#3a3f4e', 12)]);
const dailySignStandIn = () => merge([box(1.5, 0.64, 0.03, 0, 1.05, 0, '#fffdf7')]);

export const POD_MODELS: Readonly<Record<string, () => BufferGeometry>> = {
  pod_slat_wall: slatWall,
  pod_credenza: credenza,
  pod_printer: printer,
  pod_cooler: cooler,
  pod_bin: bin,
  pod_shelf: podShelf,
  pod_boxes: boxes,
  pod_pouf: pouf,
  pod_rail_back: railBack,
  pod_rail_side: railSide,
  pod_rug: rugStandIn,
  pod_glass_rail: glassRailStandIn,
  pod_huddle_table: huddleTableStandIn,
  pod_daily_sign: dailySignStandIn,
};

/** Defs React draws one by one, because they carry a texture or a material that depends on their team. */
export const POD_DYNAMIC: readonly string[] = ['pod_rug', 'pod_glass_rail', 'pod_huddle_table', 'pod_daily_sign'];
/** Defs whose instance color is the team's trim color rather than a fixed one. */
export const TRIMMED: ReadonlySet<string> = new Set(['pod_rail_back', 'chair']);
