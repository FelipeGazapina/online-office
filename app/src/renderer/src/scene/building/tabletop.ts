// The models of the small things that stand on desks, tables and shelves. Each sits on y = 0, the surface it stands on, with
// its origin at the middle of its footprint (`ItemDef.top`, in 12.5 cm units) and faces +z at rot 0 like every other model:
// a laptop's keys are toward +z, its screen toward -z. They are a few boxes and cylinders each, so one def stays one draw call.
import { BoxGeometry, TorusGeometry, Vector3, type BufferGeometry } from 'three';
import { blob, box, cyl, lathe, lean, merge, paint, rbox } from './parts.ts';

// Every model takes the look it is drawn in: the same footprint and height, another colour or style. `of` wraps round a palette.
const of = <T,>(palette: readonly T[], look: number): T => palette[((look % palette.length) + palette.length) % palette.length];

const SILVER = '#c9cdd8';
const INK = '#2b2e38';
const CREAM = '#f4f0e6';
const GOLD = '#d9b45a';
const SILVER_TROPHY = '#c9ced8';
const LEAF = ['#5f9f6c', '#78b97a', '#4d8a5d', '#8ccb84'];

const laptop = () => {
  // The lid and its lit screen, hinged at the back of the base and leaned away from the keys.
  const lid = merge([paint(new BoxGeometry(0.33, 0.19, 0.01).translate(0, 0.095, 0), SILVER), paint(new BoxGeometry(0.3, 0.165, 0.003).translate(0, 0.095, 0.0065), '#8fb6ff')]);
  return merge([
    box(0.33, 0.014, 0.2, 0, 0.007, 0.0, SILVER),
    box(0.28, 0.003, 0.085, 0, 0.0155, -0.015, INK),
    box(0.1, 0.002, 0.04, 0, 0.015, 0.065, '#aeb3c0'),
    lean(lid, -0.28, 0, 0, 0.014, -0.095),
  ]);
};

// A book: its cover, and its pages showing on three sides.
const book = (w: number, h: number, d: number, x: number, y: number, z: number, yaw: number, cover: string) => [
  rbox(w, h, d, x, y + h / 2, z, yaw, cover),
  rbox(w - 0.008, h - 0.012, d - 0.004, x, y + h / 2, z + 0.003, yaw, CREAM),
];
const BOOK_SETS = [
  ['#b85c4a', '#4f7ea3', GOLD],
  ['#2f5d50', '#e8d9b5', '#9b4f6b'],
  ['#2b2e38', '#e08a4a', '#6aa8a0'],
] as const;
const books = (look: number) => {
  const [a, b, c] = of(BOOK_SETS, look);
  return merge([...book(0.24, 0.036, 0.17, -0.01, 0, 0, 0.05, a), ...book(0.22, 0.03, 0.16, 0.008, 0.036, 0.004, -0.14, b), ...book(0.2, 0.026, 0.14, -0.012, 0.066, 0, 0.1, c)]);
};

const papers = (look: number) =>
  look % 2 === 1
    ? merge([
        rbox(0.3, 0.004, 0.22, 0, 0.002, 0, 0.1, '#cfe3f2'),
        rbox(0.28, 0.003, 0.2, 0.01, 0.0055, -0.004, -0.06, '#f7f4ec'),
        rbox(0.07, 0.01, 0.07, -0.1, 0.0155, 0.04, 0.3, '#f7d94c'),
        lean(cyl(0.004, 0.004, 0.15, 0, 0, 0, '#d95d63', 6), 0, Math.PI / 2 + 0.25, -0.04, 0.033, -0.03),
      ])
    : merge([rbox(0.27, 0.012, 0.2, 0, 0.006, 0, 0.04, '#f7f4ec'), rbox(0.26, 0.007, 0.19, 0.008, 0.0155, 0.004, -0.08, '#e3ecf5'), rbox(0.25, 0.006, 0.185, -0.004, 0.0225, -0.003, 0.12, '#fbf6ec'), lean(cyl(0.004, 0.004, 0.14, 0, 0, 0, '#4f7ea3', 6), 0, Math.PI / 2 + 0.25, 0.04, 0.033, 0.03)]);

const MUGS = ['#eadfc9', '#d95d63', '#4f7ea3', '#6aa36f', '#3a3f4e'] as const;
const mug = (look: number) => {
  const c = of(MUGS, look);
  return merge([
    cyl(0.038, 0.034, 0.088, -0.008, 0.044, 0, c, 12),
    cyl(0.032, 0.032, 0.004, -0.008, 0.087, 0, look % 2 ? '#f4f0e6' : '#4a2f20', 12),
    box(0.012, 0.05, 0.016, 0.037, 0.047, 0, c),
    box(0.014, 0.012, 0.016, 0.03, 0.068, 0, c),
    box(0.014, 0.012, 0.016, 0.03, 0.026, 0, c),
  ]);
};

const frame = () => {
  // Frame, picture and stand leaning back a little, standing on its foot.
  const upright = merge([
    paint(new BoxGeometry(0.2, 0.17, 0.012).translate(0, 0.085, 0), '#8c6a4a'),
    paint(new BoxGeometry(0.17, 0.14, 0.003).translate(0, 0.085, 0.0065), '#9fc4e8'),
    paint(new BoxGeometry(0.17, 0.06, 0.004).translate(0, 0.05, 0.0066), '#6aa36f'),
    blob(0.014, 0.04, 0.12, 0.008, '#f2b84b'),
    paint(new BoxGeometry(0.018, 0.13, 0.008).translate(0, 0.065, -0.01), '#6a4d34'),
  ]);
  return merge([lean(upright, -0.18, 0, 0, 0.006, -0.01), box(0.16, 0.01, 0.07, 0, 0.005, -0.025, '#6a4d34')]);
};

const vase = () =>
  merge([
    lathe(
      [
        [0, 0],
        [0.05, 0],
        [0.055, 0.01],
        [0.08, 0.07],
        [0.082, 0.1],
        [0.06, 0.17],
        [0.032, 0.22],
        [0.036, 0.25],
        [0.028, 0.25],
        [0, 0.24],
      ],
      0,
      0,
      0,
      '#7c9c92',
      12,
    ),
    ...[
      { rx: 0.1, rz: -0.25, len: 0.15, color: '#f1ebe0' },
      { rx: -0.15, rz: 0.1, len: 0.2, color: '#e0a458' },
      { rx: 0.2, rz: 0.32, len: 0.12, color: '#e8828f' },
      { rx: -0.1, rz: -0.08, len: 0.1, color: '#f1ebe0' },
    ].flatMap(({ rx, rz, len, color }) => {
      // The stem leans about its foot at the vase's neck; the bloom sits where its tip goes.
      const tip = [-len * Math.cos(rx) * Math.sin(rz), 0.23 + len * Math.cos(rx) * Math.cos(rz), len * Math.sin(rx)] as const;
      return [lean(cyl(0.004, 0.004, len, 0, len / 2, 0, '#4d8a5d', 5), rx, rz, 0, 0.23, 0), blob(0.025, tip[0], tip[1], tip[2], color)];
    }),
  ]);

const PEN_CUPS = [
  ['#3a3f4e', ['#d95d63', '#4f7ea3', '#f2b84b']],
  ['#c9cdd8', ['#f2b84b', '#f2b84b', '#2b2e38', '#6aa36f']],
  ['#c8745a', ['#4f7ea3', '#d95d63', '#f4f0e6']],
] as const;
const penCup = (look: number) => {
  const [cup, pens] = of(PEN_CUPS, look);
  return merge([
    cyl(0.04, 0.036, 0.095, 0, 0.0475, 0, cup, 12),
    ...pens.map((color, i) => lean(paint(new BoxGeometry(0.009, 0.1, 0.009).translate(0, 0.05, 0), color), [0.18, -0.14, 0.04, -0.06][i], [0.1, -0.08, -0.2, 0.17][i], 0, 0.06, 0)),
  ]);
};

const deskClock = () => {
  const hand = (len: number, rz: number) => lean(paint(new BoxGeometry(0.004, len, 0.002).translate(0, len / 2, 0), INK), 0, rz, 0, 0.065, 0.0215);
  return merge([
    lean(cyl(0.056, 0.056, 0.036, 0, 0, 0, '#e0a458', 14), Math.PI / 2, 0, 0, 0.065, 0),
    lean(cyl(0.047, 0.047, 0.004, 0, 0, 0, CREAM, 14), Math.PI / 2, 0, 0, 0.065, 0.019),
    hand(0.026, 0.9),
    hand(0.038, -0.5),
    box(0.1, 0.012, 0.045, 0, 0.006, 0, INK),
  ]);
};

const trophy = (look: number) => {
  const metal = look % 2 ? SILVER_TROPHY : GOLD;
  return merge([
    box(0.1, 0.02, 0.1, 0, 0.01, 0, INK),
    cyl(0.04, 0.05, 0.016, 0, 0.028, 0, metal, 12),
    cyl(0.01, 0.014, 0.07, 0, 0.07, 0, metal, 8),
    lathe(
      [
        [0, 0],
        [0.026, 0],
        [0.05, 0.05],
        [0.06, 0.12],
        [0.056, 0.125],
        [0, 0.125],
      ],
      0,
      0.1,
      0,
      metal,
      12,
    ),
    box(0.022, 0.05, 0.01, -0.07, 0.17, 0, metal),
    box(0.022, 0.05, 0.01, 0.07, 0.17, 0, metal),
  ]);
};

// ---- flat things other things rest on

const NOTEBOOKS = ['#f2c14e', '#4f7ea3', '#d95d63', '#6aa36f'] as const;
const notebook = (look: number) => {
  const c = of(NOTEBOOKS, look);
  return merge([
    rbox(0.3, 0.02, 0.21, 0, 0.01, 0, 0.02, c),
    rbox(0.286, 0.006, 0.2, 0.004, 0.017, 0, 0.02, CREAM),
    box(0.012, 0.024, 0.2, 0.1, 0.012, 0, '#2b2e38'),
    box(0.08, 0.004, 0.05, 0.03, 0.022, 0.03, '#f4f0e6'),
    ...Array.from({ length: 6 }, (_, n) => cyl(0.006, 0.006, 0.028, -0.147, 0.016, -0.085 + n * 0.034, '#c9cdd8', 6)),
  ]);
};

const FOLDERS = ['#e8c88a', '#4f7ea3', '#d95d63', '#6aa36f'] as const;
const folder = (look: number) => {
  const c = of(FOLDERS, look);
  return merge([
    rbox(0.34, 0.009, 0.24, 0, 0.0045, 0, 0, c),
    rbox(0.33, 0.009, 0.2, 0, 0.0135, 0.016, 0, c),
    rbox(0.1, 0.009, 0.026, -0.08, 0.0135, -0.1, 0, c),
    box(0.1, 0.004, 0.012, -0.08, 0.0205, -0.1, '#f4f0e6'),
    rbox(0.28, 0.008, 0.18, 0.01, 0.022, 0.02, 0.05, '#f7f4ec'),
  ]);
};

const MAGAZINES = [['#d95d63', '#f4f0e6'], ['#4f7ea3', '#f2b84b'], ['#6aa36f', '#f4f0e6'], ['#2b2e38', '#e8828f']] as const;
const magazine = (look: number) => {
  const [c, band] = of(MAGAZINES, look);
  return merge([rbox(0.21, 0.008, 0.3, 0, 0.004, 0, 0.08, c), rbox(0.17, 0.004, 0.05, 0, 0.01, -0.09, 0.08, band), rbox(0.1, 0.004, 0.1, 0.01, 0.01, 0.06, 0.08, '#f2b84b')]);
};

const COASTERS = [['#c8a06a', '#a47f4c'], ['#3a3f4e', '#5a6070'], ['#f4f0e6', '#d6cfbf']] as const;
const coaster = (look: number) => {
  const [c, ring] = of(COASTERS, look);
  return merge([cyl(0.05, 0.05, 0.01, 0, 0.005, 0, c, 14), cyl(0.036, 0.036, 0.002, 0, 0.011, 0, ring, 14)]);
};

const LUNCHBOXES = [['#4f7ea3', '#f4f0e6'], ['#d95d63', '#f2b84b'], ['#6aa36f', '#f4f0e6']] as const;
const lunchbox = (look: number) => {
  const [c, latch] = of(LUNCHBOXES, look);
  return merge([rbox(0.3, 0.05, 0.2, 0, 0.025, 0, 0.03, c), rbox(0.31, 0.026, 0.21, 0, 0.063, 0, 0.03, c), box(0.06, 0.03, 0.018, 0, 0.055, 0.106, latch), box(0.12, 0.006, 0.02, 0.05, 0.078, -0.03, latch)]);
};

// ---- the upright and the small

const SPINES = ['#b85c4a', '#4f7ea3', GOLD, '#6aa36f', '#8e6bbf', '#e08a4a', '#2f5d50', '#d95d63', '#3a3f4e'] as const;
const booksRow = (look: number) => {
  const heights = [0.24, 0.2, 0.26, 0.22, 0.19, 0.25];
  const parts = heights.map((h, n) => {
    const thick = 0.03 + ((n * 7 + look) % 3) * 0.008;
    const x = -0.12 + n * 0.04;
    return n === heights.length - 1 ? lean(paint(new BoxGeometry(thick, h, 0.16).translate(0, h / 2, 0), of(SPINES, n * 2 + look * 3)), 0, -0.26, x + 0.03, 0.006, 0) : box(thick, h, 0.16, x, h / 2, 0, of(SPINES, n * 2 + look * 3));
  });
  return merge([...parts, box(0.01, 0.1, 0.12, -0.15, 0.05, 0, '#3a3f4e'), box(0.05, 0.006, 0.12, -0.15, 0.003, 0, '#3a3f4e')]);
};

const STICKIES = ['#f7d94c', '#f29bb5', '#8fd0f2', '#9fe0a0'] as const;
const stickyNotes = (look: number) => {
  const c = of(STICKIES, look);
  return merge([rbox(0.075, 0.024, 0.075, 0, 0.012, 0, 0.1, c), rbox(0.075, 0.004, 0.075, 0.004, 0.026, -0.002, 0.28, c)]);
};

const HEADPHONES = [['#2b2e38', '#c9cdd8'], ['#f4f0e6', '#c8745a'], ['#d95d63', '#2b2e38']] as const;
const headphones = (look: number) => {
  const [c, trim] = of(HEADPHONES, look);
  // The band is an arch of short boxes over two cups lying on their sides.
  const arch = Array.from({ length: 9 }, (_, n) => {
    const a = Math.PI * (n / 8);
    return paint(new BoxGeometry(0.014, 0.022, 0.03).rotateZ(a).translate(Math.cos(a) * 0.085, 0.045 + Math.sin(a) * 0.05, 0), c);
  });
  return merge([
    ...arch,
    ...[-1, 1].flatMap((sx) => [
      lean(cyl(0.044, 0.044, 0.026, 0, 0, 0, c, 14), 0, Math.PI / 2, sx * 0.1, 0.045, 0),
      lean(cyl(0.04, 0.04, 0.012, 0, 0, 0, '#1c1f27', 14), 0, Math.PI / 2, sx * 0.082, 0.045, 0),
      lean(cyl(0.03, 0.03, 0.004, 0, 0, 0, trim, 12), 0, Math.PI / 2, sx * 0.114, 0.045, 0),
    ]),
  ]);
};

const BOTTLES = [['#4f9bd9', '#f4f0e6'], ['#8fd0b8', '#2b2e38'], ['#c9cdd8', '#2b2e38'], ['#e8828f', '#f4f0e6']] as const;
const waterBottle = (look: number) => {
  const [c, cap] = of(BOTTLES, look);
  return merge([
    lathe(
      [
        [0, 0],
        [0.033, 0],
        [0.035, 0.012],
        [0.035, 0.15],
        [0.028, 0.185],
        [0.016, 0.2],
        [0, 0.2],
      ],
      0,
      0,
      0,
      c,
      12,
    ),
    cyl(0.019, 0.019, 0.03, 0, 0.215, 0, cap, 10),
    box(0.07, 0.04, 0.001, 0, 0.09, 0.0345, cap),
  ]);
};

const TUMBLERS = [['#d95d63', '#f4f0e6'], ['#4f7ea3', '#f4f0e6'], ['#f2b84b', '#2b2e38'], ['#6aa36f', '#f4f0e6']] as const;
const tumbler = (look: number) => {
  const [c, lid] = of(TUMBLERS, look);
  return merge([
    lathe(
      [
        [0, 0],
        [0.028, 0],
        [0.037, 0.14],
        [0, 0.14],
      ],
      0,
      0,
      0,
      c,
      12,
    ),
    cyl(0.039, 0.039, 0.016, 0, 0.148, 0, lid, 12),
    lean(cyl(0.004, 0.004, 0.06, 0, 0, 0, '#2b2e38', 5), 0.08, -0.1, 0.008, 0.14, 0),
  ]);
};

const TAKEAWAY = [['#c8a06a', '#f4f0e6'], ['#d95d63', '#f4f0e6'], ['#4f9aa8', '#2b2e38']] as const;
const takeawayCup = (look: number) => {
  const [sleeve, lid] = of(TAKEAWAY, look);
  return merge([
    lathe(
      [
        [0, 0],
        [0.026, 0],
        [0.036, 0.115],
        [0, 0.115],
      ],
      0,
      0,
      0,
      '#f7f4ec',
      12,
    ),
    cyl(0.034, 0.03, 0.04, 0, 0.055, 0, sleeve, 12),
    cyl(0.039, 0.037, 0.018, 0, 0.124, 0, lid, 12),
  ]);
};

const ORGANIZERS = [['#d8b47d', '#8c6a4a'], ['#3a3f4e', '#5a6070'], ['#f4f0e6', '#c9cdd8']] as const;
const deskOrganizer = (look: number) => {
  const [c, dark] = of(ORGANIZERS, look);
  return merge([
    box(0.32, 0.012, 0.2, 0, 0.006, 0, dark),
    box(0.32, 0.07, 0.012, 0, 0.04, -0.094, c),
    box(0.32, 0.034, 0.012, 0, 0.023, 0.094, c),
    box(0.012, 0.07, 0.2, -0.154, 0.04, 0, c),
    box(0.012, 0.07, 0.2, 0.154, 0.04, 0, c),
    box(0.012, 0.07, 0.19, -0.04, 0.04, 0, c),
    box(0.012, 0.07, 0.19, 0.06, 0.04, 0, c),
    ...[
      ['#f2b84b', -0.12, 0.1, -0.2],
      ['#d95d63', -0.1, 0.12, 0.2],
      ['#4f7ea3', -0.002, 0.13, 0.1],
      ['#2b2e38', 0.03, 0.12, -0.1],
    ].map(([col, x, h, r]) => lean(paint(new BoxGeometry(0.008, h as number, 0.008).translate(0, (h as number) / 2, 0), col as string), 0.1, r as number, x as number, 0.012, -0.03)),
    box(0.07, 0.03, 0.09, 0.105, 0.027, 0.02, '#f7f4ec'),
    box(0.07, 0.012, 0.09, 0.105, 0.048, 0.02, of(STICKIES, look)),
  ]);
};

const FRAMES = [['#8c6a4a', '#9fc4e8', '#6aa36f'], ['#f4f0e6', '#f2b84b', '#d95d63'], ['#2b2e38', '#e8828f', '#4f7ea3'], [GOLD, '#8fd0b8', '#e08a4a']] as const;
const frameSmall = (look: number) => {
  const [rim, sky, hill] = of(FRAMES, look);
  const upright = merge([
    paint(new BoxGeometry(0.11, 0.13, 0.01).translate(0, 0.065, 0), rim),
    paint(new BoxGeometry(0.086, 0.106, 0.003).translate(0, 0.065, 0.0055), sky),
    paint(new BoxGeometry(0.086, 0.044, 0.004).translate(0, 0.04, 0.0058), hill),
    blob(0.011, 0.02, 0.092, 0.008, '#f7d94c'),
  ]);
  return merge([lean(upright, -0.2, 0, 0, 0.004, -0.004), box(0.1, 0.008, 0.05, 0, 0.004, -0.03, rim)]);
};

const POTS = [['#c8745a', '#9a553f'], ['#f1ebe0', '#d6cfbf'], ['#9aa0a6', '#7b8087'], ['#bfe0d6', '#e8e1d0']] as const;
// A rosette: leaves leaned out of a middle, ring by ring, lowest outermost.
const rosette = (cx: number, cy: number, cz: number, r: number, look: number) => [
  ...[
    { n: 8, lean: 1.0, len: r, y: 0 },
    { n: 6, lean: 0.62, len: r * 0.9, y: r * 0.18 },
    { n: 4, lean: 0.3, len: r * 0.75, y: r * 0.34 },
  ].flatMap(({ n, lean: tilt, len, y }, ring) =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + ring * 0.5;
      const leaf = paint(new BoxGeometry(len * 0.34, len, len * 0.1).translate(0, len / 2, 0), of(LEAF, i + ring + look));
      return lean(leaf, Math.sin(a) * tilt, -Math.cos(a) * tilt, cx, cy + y, cz);
    }),
  ),
];
const succulent = (look: number) => {
  const [pot, rim] = of(POTS, look);
  return merge([
    cyl(0.052, 0.038, 0.066, 0, 0.033, 0, pot, 12),
    cyl(0.055, 0.055, 0.012, 0, 0.066, 0, rim, 12),
    cyl(0.046, 0.046, 0.004, 0, 0.07, 0, '#5a4636', 12),
    ...(look === 3 ? [blob(0.012, 0.03, 0.074, 0.01, '#f4f0e6'), blob(0.01, -0.025, 0.074, -0.02, '#d9d2c2')] : []),
    ...rosette(0, 0.07, 0, 0.085, look),
  ]);
};

const succulentTrio = (look: number) =>
  merge([
    box(0.34, 0.012, 0.1, 0, 0.006, 0, look % 2 ? '#2b2e38' : '#d8b47d'),
    ...[-0.11, 0, 0.11].flatMap((x, n) => {
      const pot = of(POTS, n + look * 2)[0];
      return [cyl(0.03, 0.023, 0.04, x, 0.032, 0, pot, 10), ...(n === 1 ? [blob(0.034, x, 0.074, 0, '#78b97a'), blob(0.012, x + 0.01, 0.1, 0.01, '#e8828f')] : rosette(x, 0.052, 0, 0.055, n + look))];
    }),
  ]);

const CABLES = [['#f4f0e6', '#c9cdd8'], ['#2b2e38', '#5a6070']] as const;
const cableTray = (look: number) => {
  const [c, lid] = of(CABLES, look);
  return merge([
    rbox(0.33, 0.048, 0.1, 0, 0.024, 0, 0, c),
    rbox(0.34, 0.012, 0.11, 0, 0.054, 0, 0, lid),
    ...[-0.1, -0.04, 0.02, 0.08].map((x) => box(0.03, 0.004, 0.012, x, 0.061, 0.03, '#1c1f27')),
    lean(cyl(0.004, 0.004, 0.04, 0, 0, 0, '#2b2e38', 5), 0, Math.PI / 2, 0.165, 0.03, 0),
    lean(cyl(0.004, 0.004, 0.04, 0, 0, 0, '#f4f0e6', 5), 0, Math.PI / 2, -0.165, 0.03, 0.01),
  ]);
};

const BOWLS = [['#f1ebe0', '#d95d63'], ['#4f7ea3', '#f2b84b'], ['#d8b47d', '#8e6bbf']] as const;
const snackBowl = (look: number) => {
  const [c, food] = of(BOWLS, look);
  const spots: [number, number, number][] = [[0, 0.06, 0], [0.04, 0.054, 0.03], [-0.035, 0.056, 0.035], [-0.01, 0.052, -0.045], [0.045, 0.05, -0.035]];
  return merge([
    lathe(
      [
        [0, 0],
        [0.05, 0],
        [0.09, 0.04],
        [0.108, 0.07],
        [0.1, 0.07],
        [0.05, 0.016],
        [0, 0.016],
      ],
      0,
      0,
      0,
      c,
      14,
    ),
    ...spots.map(([x, y, z], n) => (look === 2 ? blob(0.014, x, y + 0.012, z, of(['#d95d63', '#f2b84b', '#6aa36f', '#4f7ea3', '#e8828f'], n)) : look === 1 ? blob(0.016, x, y + 0.01, z, n % 2 ? food : '#e8c88a') : blob(0.036, x, y + 0.012, z, n % 3 ? food : '#6aa36f'))),
  ]);
};

const calculator = (look: number) => {
  const body = look % 2 ? CREAM : '#2b2e38';
  const key = look % 2 ? '#c9cdd8' : '#5a6070';
  return merge([
    rbox(0.1, 0.02, 0.17, 0, 0.01, 0, 0, body),
    box(0.08, 0.004, 0.034, 0, 0.022, -0.055, '#9fe0a0'),
    ...Array.from({ length: 12 }, (_, n) => box(0.022, 0.004, 0.02, -0.03 + (n % 3) * 0.03, 0.022, -0.012 + Math.floor(n / 3) * 0.028, n === 11 ? '#f2b84b' : key)),
  ]);
};

const phoneStand = (look: number) => {
  const c = look % 2 ? '#d8b47d' : '#c9cdd8';
  const phone = merge([paint(new BoxGeometry(0.066, 0.13, 0.008).translate(0, 0.065, 0), look % 2 ? '#f4f0e6' : '#1c1f27'), paint(new BoxGeometry(0.058, 0.12, 0.002).translate(0, 0.065, 0.0045), '#7fb6ff')]);
  return merge([cyl(0.05, 0.05, 0.01, 0, 0.005, 0.01, c, 12), lean(phone, -0.28, 0, 0, 0.012, 0), box(0.07, 0.014, 0.012, 0, 0.017, 0.045, c)]);
};

const tablet = (look: number) => {
  const c = look % 2 ? '#a47f4c' : '#2b2e38';
  const slab = merge([paint(new BoxGeometry(0.21, 0.145, 0.01).translate(0, 0.0725, 0), c), paint(new BoxGeometry(0.19, 0.125, 0.002).translate(0, 0.0725, 0.0055), '#8fb6ff'), paint(new BoxGeometry(0.19, 0.03, 0.003).translate(0, 0.04, 0.0057), '#4f7ea3')]);
  return merge([lean(slab, -0.3, 0, 0, 0.008, 0), box(0.16, 0.01, 0.045, 0, 0.005, 0.025, c)]);
};

const CANDLES = [['#e8d6c0', '#f4f0e6'], ['#e8828f', '#fbe3e6'], ['#a7c4a0', '#e8f0e3'], ['#d9a066', '#f7e0b8']] as const;
const candle = (look: number) => {
  const [jar, wax] = of(CANDLES, look);
  return merge([cyl(0.04, 0.04, 0.07, 0, 0.035, 0, jar, 14), cyl(0.034, 0.034, 0.004, 0, 0.069, 0, wax, 14), box(0.003, 0.014, 0.003, 0, 0.078, 0, '#2b2e38'), blob(0.007, 0, 0.088, 0, '#ffd37a')]);
};

const catStatue = (look: number) => {
  const c = look % 2 ? '#2b2e38' : '#f4f0e6';
  const ear = look % 2 ? '#3a3f4e' : '#e8c8c0';
  return merge([
    lathe(
      [
        [0, 0],
        [0.034, 0],
        [0.04, 0.03],
        [0.03, 0.08],
        [0.02, 0.105],
        [0, 0.105],
      ],
      0,
      0,
      0,
      c,
      10,
    ),
    blob(0.026, 0, 0.12, 0.004, c),
    lean(paint(new BoxGeometry(0.014, 0.026, 0.01).translate(0, 0.013, 0), c), 0, 0.3, -0.016, 0.136, 0.004),
    lean(paint(new BoxGeometry(0.014, 0.026, 0.01).translate(0, 0.013, 0), c), 0, -0.3, 0.016, 0.136, 0.004),
    box(0.008, 0.012, 0.002, -0.016, 0.145, 0.0075, ear),
    lean(cyl(0.008, 0.01, 0.08, 0, 0.04, 0, c, 6), 0.1, 0.9, 0.03, 0.01, -0.012),
  ]);
};

const TRAYS = [['#2b2e38', '#c9cdd8'], ['#d8b47d', '#8c6a4a']] as const;
const letterTray = (look: number) => {
  const [c, rail] = of(TRAYS, look);
  return merge([
    box(0.32, 0.01, 0.22, 0, 0.005, 0, c),
    box(0.32, 0.01, 0.22, 0, 0.055, -0.01, c),
    ...[-1, 1].flatMap((sx) => [box(0.01, 0.06, 0.22, sx * 0.155, 0.03, 0, rail), box(0.01, 0.04, 0.22, sx * 0.155, 0.075, -0.01, rail)]),
    box(0.3, 0.036, 0.008, 0, 0.028, 0.105, c),
    rbox(0.27, 0.006, 0.2, 0, 0.013, 0, 0.04, '#f7f4ec'),
    rbox(0.27, 0.006, 0.2, 0.004, 0.063, -0.01, -0.06, '#e3ecf5'),
    rbox(0.26, 0.016, 0.19, 0, 0.074, -0.01, 0.08, '#f7f4ec'),
  ]);
};

const GLASSES = [['#2b2e38', '#c9ced8'], ['#8c6a4a', '#e8d6c0'], ['#d95d63', '#f4f0e6']] as const;
const glasses = (look: number) => {
  const [rim] = of(GLASSES, look);
  const ring = (x: number) => paint(new TorusGeometry(0.026, 0.0035, 6, 16).rotateX(Math.PI / 2).translate(x, 0.004, 0), rim);
  return merge([ring(-0.034), ring(0.034), box(0.014, 0.004, 0.004, 0, 0.006, -0.008, rim), box(0.005, 0.005, 0.07, -0.056, 0.007, 0.034, rim), lean(paint(new BoxGeometry(0.005, 0.005, 0.07).translate(0, 0, 0), rim), 0.05, 0.2, 0.06, 0.012, 0.03)]);
};

const STAPLERS = [['#d95d63', '#2b2e38'], ['#2b2e38', '#c9cdd8'], ['#4f7ea3', '#2b2e38']] as const;
const stapler = (look: number) => {
  const [c, base] = of(STAPLERS, look);
  return merge([rbox(0.15, 0.014, 0.04, 0, 0.007, 0, 0, base), lean(paint(new BoxGeometry(0.15, 0.022, 0.036).translate(0, 0.011, 0), c), 0, 0.07, 0.0, 0.015, 0), box(0.02, 0.012, 0.03, 0.065, 0.02, 0, '#1c1f27')]);
};

const SPEAKERS = [['#2b2e38', '#5a6070'], ['#4f9aa8', '#d8f0f0'], ['#e8828f', '#fbe3e6']] as const;
const speaker = (look: number) => {
  const [c, grille] = of(SPEAKERS, look);
  return merge([cyl(0.045, 0.045, 0.1, 0, 0.05, 0, c, 14), cyl(0.0465, 0.0465, 0.07, 0, 0.05, 0, grille, 14), cyl(0.04, 0.04, 0.008, 0, 0.104, 0, '#1c1f27', 14), box(0.012, 0.004, 0.012, -0.012, 0.109, 0, '#f2b84b'), box(0.012, 0.004, 0.012, 0.012, 0.109, 0, '#9fe0a0')]);
};

// A footprint on a top hugs its model, so each model is centered on it, whatever the parts that stick out to one side do.
const around = (make: (look: number) => BufferGeometry) => (look: number) => {
  const g = make(look);
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new Vector3());
  return g.translate(-c.x, 0, -c.z);
};

export const TABLETOP_MODELS: Readonly<Record<string, (look: number) => BufferGeometry>> = {
  laptop: around(laptop),
  books: around(books),
  papers: around(papers),
  mug: around(mug),
  picture_frame: around(frame),
  vase: around(vase),
  pen_cup: around(penCup),
  desk_clock: around(deskClock),
  trophy: around(trophy),
  notebook: around(notebook),
  folder: around(folder),
  magazine: around(magazine),
  coaster: around(coaster),
  lunchbox: around(lunchbox),
  books_row: around(booksRow),
  sticky_notes: around(stickyNotes),
  headphones: around(headphones),
  water_bottle: around(waterBottle),
  tumbler: around(tumbler),
  takeaway_cup: around(takeawayCup),
  desk_organizer: around(deskOrganizer),
  frame_small: around(frameSmall),
  succulent: around(succulent),
  succulent_trio: around(succulentTrio),
  cable_tray: around(cableTray),
  snack_bowl: around(snackBowl),
  calculator: around(calculator),
  phone_stand: around(phoneStand),
  tablet: around(tablet),
  candle: around(candle),
  cat_statue: around(catStatue),
  letter_tray: around(letterTray),
  glasses: around(glasses),
  stapler: around(stapler),
  speaker: around(speaker),
};
