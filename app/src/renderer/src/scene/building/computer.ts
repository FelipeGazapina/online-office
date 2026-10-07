// What a desk carries on its top besides what the owner puts there: the computer, in one of eight setups (`setupsOf` says which desk
// wears which). Everything is in meters, in the desk's own frame: the middle of its footprint, the sitter on the -z side, the desk top
// at y = TOP. Every setup keeps to what `ITEM_DEFS.bench_desk.surface.blocked` declares (the keyboard end at x -0.375..0.5, z -0.375..0, the
// screen end at x -0.375..0.375, z 0.125..0.25) so a thing the owner puts down never stands in it, and keeps its panels under a seated
// sitter's eyes (the top of a screen at 1.19 m at the most) so faces read across the desk.
import { BufferGeometry, Float32BufferAttribute, PlaneGeometry } from 'three';
import { bbox, box, cyl, lean, merge } from './parts.ts';

const TOP = 0.72;
const INK = '#1c1f27';
const GRAPHITE = '#2b2e38';
const SILVER = '#c9cdd8';
const CREAM = '#f1ebe0';

type Screen = { x: number; y: number; z: number; w: number; h: number; yaw: number; tilt: number };
type Piece = { parts: BufferGeometry[]; screens: Screen[] };
const piece = (...parts: BufferGeometry[]): Piece => ({ parts, screens: [] });
const join = (...pieces: Piece[]): Piece => ({ parts: pieces.flatMap((p) => p.parts), screens: pieces.flatMap((p) => p.screens) });
const turned = (g: BufferGeometry, yaw: number, x: number, y: number, z: number) => g.rotateY(yaw).translate(x, y, z);

type Monitor = { w: number; h: number; x: number; z: number; yaw?: number; bezel?: string; edge?: number; depth?: number; clear?: number; foot?: string; footW?: number; arm?: boolean };

/** A flat screen on a foot (or an arm), `clear` above the desk, turned by `yaw`; its lit screen is inset on the sitter's side. */
function monitor({ w, h, x, z, yaw = 0, bezel = INK, edge = 0.012, depth = 0.026, clear = 0.08, foot = GRAPHITE, footW = 0.2, arm = false }: Monitor): Piece {
  const y = TOP + clear + h / 2;
  const front = [-Math.sin(yaw), -Math.cos(yaw)] as const;
  const lift = depth / 2 + 0.0012;
  const stand = arm
    ? piece(
        box(0.07, 0.07, 0.06, x, TOP + 0.03, 0.5, GRAPHITE),
        cyl(0.016, 0.016, y - TOP + 0.02, x, TOP + (y - TOP + 0.02) / 2, 0.5, SILVER, 10),
        box(0.03, 0.026, 0.5 - z + 0.02, x, y + 0.02, (0.5 + z) / 2 + 0.02, SILVER),
      )
    : piece(bbox(footW, 0.012, 0.1, x, TOP + 0.006, z, foot, 0.005), box(0.045, clear + 0.03, 0.022, x, TOP + 0.012 + (clear + 0.03) / 2, z + 0.016, foot));
  return join(piece(turned(bbox(w, h, depth, 0, 0, 0, bezel, 0.008), yaw, x, y, z)), stand, {
    parts: [],
    screens: [{ x: x + front[0] * lift, y, z: z + front[1] * lift, w: w - edge * 2, h: h - edge * 2, yaw, tilt: 0 }],
  });
}

type Keys = { w?: number; base?: string; key?: string; accent?: string; legend?: string };

/** Rows of keys on a slim board: 15 units across, five rows, the space bar along the bottom. `accent` colours a few of the keys. */
function keyboard(x: number, z: number, yaw: number, { w = 0.4, base = INK, key = GRAPHITE, accent = key, legend = SILVER }: Keys = {}): Piece {
  const rows: number[][] = [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
    [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5],
    [1.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.25],
    [2.25, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.75],
    [1.25, 1.25, 1.25, 6.25, 1.25, 1.25, 1.25, 1.25],
  ];
  const pitch = (w - 0.02) / 15;
  const rowPitch = pitch * 1.02;
  const depth = rows.length * rowPitch + 0.02;
  const parts: BufferGeometry[] = [bbox(w, 0.014, depth, 0, 0.007, 0, base, 0.004)];
  rows.forEach((row, r) => {
    let at = -w / 2 + 0.01;
    const kz = -depth / 2 + 0.01 + (r + 0.5) * rowPitch;
    row.forEach((units, n) => {
      const kw = units * pitch;
      const special = (r === 0 && n === 0) || (r === 2 && n === row.length - 1);
      parts.push(box(kw - 0.0035, 0.007, rowPitch - 0.004, at + kw / 2, 0.0175, kz, special ? accent : units > 1.2 ? legend : key));
      at += kw;
    });
  });
  // The board stands a little taller at the back, as one on its feet does.
  return piece(turned(merge(parts).rotateX(-0.07), yaw, x, TOP + 0.006, z));
}

/** A mouse: a soft body, the split of its buttons and a wheel. */
function mouse(x: number, z: number, yaw: number, color = INK, wheel = '#d97757'): Piece {
  return piece(turned(merge([bbox(0.062, 0.03, 0.104, 0, 0.015, 0, color, 0.022), box(0.0016, 0.002, 0.042, 0, 0.0305, 0.027, GRAPHITE), box(0.008, 0.004, 0.017, 0, 0.031, 0.03, wheel)]), yaw, x, TOP + 0.005, z));
}

/** A flat pad a hand rests on: its colour, a thin band along the front and a patch in a corner. */
const pad = (x: number, z: number, w: number, d: number, color: string, band: string): Piece =>
  piece(box(w, 0.004, d, x, TOP + 0.002, z, color), box(w, 0.0046, 0.012, x, TOP + 0.0023, z - d / 2 + 0.008, band), box(0.04, 0.0049, 0.04, x + w / 2 - 0.035, TOP + 0.00245, z + d / 2 - 0.035, band));

/** A trackpad: a pale slab with a thin line round it. */
const trackpad = (x: number, z: number): Piece => piece(box(0.13, 0.006, 0.1, x, TOP + 0.003, z, SILVER), box(0.12, 0.0066, 0.09, x, TOP + 0.0033, z, CREAM));

/** Square notes stuck to a bezel, a little off true. */
const notes = (x: number, y: number, z: number, colors: readonly string[]): Piece =>
  piece(...colors.map((c, n) => turned(box(0.06, 0.06, 0.004, 0, 0, 0, c), n % 2 ? -0.03 : 0.04, x + n * 0.07, y - (n % 2) * 0.03, z)));

/** A cable from the foot of a panel at `x` to the back edge. */
const cable = (x: number, from: number, color = INK): Piece => piece(box(0.008, 0.004, 0.5 - from, x, TOP + 0.002, (0.5 + from) / 2, color));

/** A laptop whose base stands at (x, y, z) with the lid at its back, leaned away from the keys; its screen is a lit plane on the lid. */
function laptop(x: number, y: number, z: number, color = SILVER): Piece {
  const tilt = 0.28;
  const hinge = { y: y + 0.014, z: z + 0.1 };
  const lid = bbox(0.33, 0.215, 0.011, 0, 0, 0, color, 0.004).rotateX(tilt).translate(x, hinge.y + 0.1075 * Math.cos(tilt), hinge.z + 0.1075 * Math.sin(tilt));
  const base = merge([bbox(0.33, 0.014, 0.225, 0, 0.007, 0, color, 0.004), box(0.29, 0.003, 0.09, 0, 0.0155, -0.015, INK), box(0.1, 0.002, 0.045, 0, 0.015, 0.06, '#aeb3c0')]);
  const lift = 0.0065;
  return {
    parts: [base.translate(x, y, z), lid],
    screens: [{ x, y: hinge.y + 0.1075 * Math.cos(tilt) + Math.sin(tilt) * lift, z: hinge.z + 0.1075 * Math.sin(tilt) - Math.cos(tilt) * lift, w: 0.3, h: 0.19, yaw: 0, tilt }],
  };
}

/** A riser of brushed metal under a laptop, tall enough for a keyboard to slide under. */
const riser = (x: number, z: number, h: number): Piece => piece(box(0.3, 0.012, 0.22, x, TOP + h, z, SILVER), box(0.018, h, 0.2, x - 0.13, TOP + h / 2, z, SILVER), box(0.018, h, 0.2, x + 0.13, TOP + h / 2, z, SILVER));

/** A webcam on top of a bezel. */
const webcam = (x: number, y: number, z: number): Piece => piece(box(0.06, 0.02, 0.025, x, y, z, INK), cyl(0.006, 0.006, 0.004, 0, 0, 0, '#6aa8ff', 8).rotateX(Math.PI / 2).translate(x, y, z - 0.014));

// Eight computers. They differ in the screen (one, two, a laptop, an arm, a tall one beside a wide one, an all in one), in the keys and the
// hand's side (a mouse on a pad, on a mat, a trackpad) and in what is stuck to them, so a row of desks reads as a row of different people.
const RECIPES: readonly (() => Piece)[] = [
  // 0: a 24 inch screen on a foot, dark keys, a mouse on a small pad, two notes on the bezel
  () => join(monitor({ w: 0.62, h: 0.36, x: 0, z: 0.2 }), keyboard(0, -0.22, 0.02), mouse(0.36, -0.2, -0.1), pad(0.36, -0.2, 0.2, 0.18, '#3a3f4e', '#d97757'), notes(-0.18, 1.1, 0.18, ['#f7d94c', '#f29bb5']), cable(0, 0.2)),
  // 1: a wide screen with a thin silver bezel, a felt mat under keys and mouse, pale keys
  () => join(monitor({ w: 0.74, h: 0.32, x: 0, z: 0.2, bezel: SILVER, edge: 0.008, foot: SILVER, footW: 0.26 }), pad(0.1, -0.2, 0.55, 0.22, '#8c6a4a', '#d8b47d'), keyboard(0.14, -0.21, -0.03, { base: '#c9cdd8', key: CREAM, accent: '#d97757', legend: '#dfe3ea' }), mouse(-0.22, -0.2, 0.2, GRAPHITE, '#f2b84b'), cable(0.1, 0.2, '#f4f0e6')),
  // 2: two screens in a V, a cream keyboard and a mouse on a blue pad
  () => join(monitor({ w: 0.4, h: 0.27, x: 0.19, z: 0.21, yaw: 0.38, edge: 0.01, footW: 0.14 }), monitor({ w: 0.4, h: 0.27, x: -0.19, z: 0.21, yaw: -0.38, edge: 0.01, footW: 0.14 }), keyboard(0.02, -0.22, 0, { base: '#d6cfbf', key: CREAM, accent: '#4f7ea3', legend: '#e8e1d0' }), mouse(0.33, -0.2, -0.15, CREAM, '#4f7ea3'), pad(0.33, -0.2, 0.18, 0.16, '#4f7ea3', '#f4f0e6'), webcam(0.19, TOP + 0.08 + 0.27 + 0.01, 0.21)),
  // 3: a laptop on a riser in the keyboard end, a mouse on a pad, and the back of the desk left bare
  () => join(riser(0.12, -0.17, 0.07), laptop(0.12, TOP + 0.076, -0.17), mouse(0.4, -0.2, 0.12, '#e8e6e0', '#8fb6ff'), pad(0.4, -0.2, 0.18, 0.16, '#5a6070', '#8fb6ff'), notes(0.12, TOP + 0.076 + 0.2, -0.07, ['#8fd0f2'])),
  // 4: a screen on an arm over the back edge, keys with pink accents, a grey mat, a webcam
  () => join(monitor({ w: 0.6, h: 0.34, x: 0, z: 0.2, bezel: GRAPHITE, edge: 0.008, depth: 0.02, arm: true }), keyboard(0.02, -0.21, 0.04, { base: INK, key: '#3a3f4e', accent: '#e8828f', legend: '#6aa8a0' }), mouse(0.36, -0.19, -0.2, INK, '#8fd0b8'), pad(0.12, -0.2, 0.46, 0.2, '#5a6070', '#8fd0b8'), webcam(0, TOP + 0.08 + 0.34 + 0.01, 0.2)),
  // 5: a tall screen beside a wide one, a mouse on an orange pad
  () => join(monitor({ w: 0.24, h: 0.4, x: 0.24, z: 0.2, clear: 0.05, edge: 0.01, footW: 0.14 }), monitor({ w: 0.44, h: 0.27, x: -0.14, z: 0.2, bezel: GRAPHITE, edge: 0.01 }), keyboard(0, -0.23, -0.02, { base: '#2b2e38', key: '#3a3f4e', accent: '#f2b84b', legend: '#c9cdd8' }), mouse(0.34, -0.2, 0, GRAPHITE, '#f2b84b'), pad(0.34, -0.2, 0.18, 0.18, '#d97757', '#f4f0e6'), cable(0.24, 0.2)),
  // 6: an all in one with a pale chin, a white keyboard, a trackpad and two notes
  () => join(monitor({ w: 0.56, h: 0.4, x: 0, z: 0.2, bezel: '#e8e6e0', edge: 0.012, depth: 0.022, clear: 0.05, foot: SILVER, footW: 0.22 }), keyboard(0, -0.22, 0, { base: '#d6d2c8', key: '#f7f4ec', accent: '#f2b84b', legend: '#e8e6e0' }), trackpad(0.33, -0.2), notes(0.14, TOP + 0.05 + 0.4 - 0.03, 0.17, ['#9fe0a0', '#f7d94c'])),
  // 7: a dark wide screen, a big pad, a mouse, keys lit teal
  () => join(monitor({ w: 0.72, h: 0.31, x: 0, z: 0.2, depth: 0.03, edge: 0.007, foot: INK, footW: 0.3 }), pad(0, -0.2, 0.52, 0.24, '#1c1f27', '#4f9aa8'), keyboard(0.08, -0.2, 0, { base: '#14161c', key: '#252a35', accent: '#4f9aa8', legend: '#4f9aa8' }), mouse(-0.2, -0.18, 0.1, '#14161c', '#4f9aa8'), cable(-0.2, 0.2)),
];

const at = (setup: number) => RECIPES[((setup % RECIPES.length) + RECIPES.length) % RECIPES.length]();
const cache = new Map<string, BufferGeometry>();

/** What a desk carries in setup `setup`, merged into one model, with the planner a PO's desk adds. */
export function computerOf(po: boolean, setup: number): BufferGeometry {
  const key = `${po}:${setup}`;
  let g = cache.get(key);
  if (!g) {
    const planner = po
      ? [bbox(0.3, 0.024, 0.2, -0.5, TOP + 0.012, -0.23, '#d97757', 0.008), box(0.27, 0.016, 0.185, -0.48, TOP + 0.014, -0.23, '#f7f4ec'), box(0.02, 0.026, 0.19, -0.635, TOP + 0.013, -0.23, '#b85c43'), lean(cyl(0.004, 0.004, 0.14, 0, 0, 0, '#2b2e38', 6), 0, Math.PI / 2 + 0.3, -0.45, TOP + 0.03, -0.2)]
      : [];
    cache.set(key, (g = merge([...at(setup).parts, ...planner])));
  }
  return g;
}

const planes = new Map<number, BufferGeometry>();

/** The screen of a setup that shows the terminal: the biggest one. */
const primaryOf = (screens: readonly Screen[]) => screens.reduce((best, s, i) => (s.w * s.h > screens[best]!.w * screens[best]!.h ? i : best), 0);

/** The lit screens of setup `setup`, planes that face the sitter, for the instanced mesh that shows what the sitter is doing. `aTerm` is 1 on the
 * screen that shows the sitter's terminal and 0 on any other. */
export function screensOf(setup: number): BufferGeometry {
  let g = planes.get(setup);
  if (!g) {
    const { screens } = at(setup);
    const main = primaryOf(screens);
    planes.set(
      setup,
      (g = merge(
        screens.map((s, i) => {
          const plane = new PlaneGeometry(s.w, s.h).rotateY(Math.PI).rotateX(s.tilt).rotateY(s.yaw).translate(s.x, s.y, s.z);
          plane.setAttribute('aTerm', new Float32BufferAttribute(new Array<number>(plane.getAttribute('position').count).fill(i === main ? 1 : 0), 1));
          return plane;
        }),
      )),
    );
  }
  return g;
}

/** Where the terminal screen of a setup stands in the desk's own frame: its middle, the way it faces, and its size in meters. */
export function terminalScreenOf(setup: number): { x: number; y: number; z: number; nx: number; ny: number; nz: number; w: number; h: number } {
  const { screens } = at(setup);
  const s = screens[primaryOf(screens)]!;
  // The plane faces -z, leans back by `tilt` and turns by `yaw`.
  const ny = Math.sin(s.tilt);
  const nz = -Math.cos(s.tilt);
  return { x: s.x, y: s.y, z: s.z, nx: Math.sin(s.yaw) * nz, ny, nz: Math.cos(s.yaw) * nz, w: s.w, h: s.h };
}
