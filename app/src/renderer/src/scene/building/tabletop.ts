// The models of the small things that stand on desks, tables and shelves. Each sits on y = 0, the surface it stands on, with
// its origin at the middle of its footprint (`ItemDef.top`, in 12.5 cm units) and faces +z at rot 0 like every other model:
// a laptop's keys are toward +z, its screen toward -z. They are a few boxes and cylinders each, so one def stays one draw call.
import { BoxGeometry, Vector3, type BufferGeometry } from 'three';
import { blob, box, cyl, lathe, lean, merge, paint, rbox } from './parts.ts';

const SILVER = '#c9cdd8';
const INK = '#2b2e38';
const CREAM = '#f4f0e6';
const GOLD = '#d9b45a';

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
const books = () => merge([...book(0.24, 0.036, 0.17, -0.01, 0, 0, 0.05, '#b85c4a'), ...book(0.22, 0.03, 0.16, 0.008, 0.036, 0.004, -0.14, '#4f7ea3'), ...book(0.2, 0.026, 0.14, -0.012, 0.066, 0, 0.1, GOLD)]);

const papers = () =>
  merge([rbox(0.27, 0.012, 0.2, 0, 0.006, 0, 0.04, '#f7f4ec'), rbox(0.26, 0.007, 0.19, 0.008, 0.0155, 0.004, -0.08, '#e3ecf5'), rbox(0.25, 0.006, 0.185, -0.004, 0.0225, -0.003, 0.12, '#fbf6ec'), lean(cyl(0.004, 0.004, 0.14, 0, 0, 0, '#4f7ea3', 6), 0, Math.PI / 2 + 0.25, 0.04, 0.033, 0.03)]);

const mug = () =>
  merge([
    cyl(0.038, 0.034, 0.088, -0.008, 0.044, 0, '#eadfc9', 12),
    cyl(0.032, 0.032, 0.004, -0.008, 0.087, 0, '#4a2f20', 12),
    box(0.012, 0.05, 0.016, 0.037, 0.047, 0, '#eadfc9'),
    box(0.014, 0.012, 0.016, 0.03, 0.068, 0, '#eadfc9'),
    box(0.014, 0.012, 0.016, 0.03, 0.026, 0, '#eadfc9'),
  ]);

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

const penCup = () =>
  merge([
    cyl(0.04, 0.036, 0.095, 0, 0.0475, 0, '#3a3f4e', 12),
    ...[
      ['#d95d63', 0.18, 0.1],
      ['#4f7ea3', -0.14, -0.08],
      ['#f2b84b', 0.04, -0.2],
    ].map(([color, rx, rz]) => lean(paint(new BoxGeometry(0.009, 0.1, 0.009).translate(0, 0.05, 0), color as string), rx as number, rz as number, 0, 0.06, 0)),
  ]);

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

const trophy = () =>
  merge([
    box(0.1, 0.02, 0.1, 0, 0.01, 0, INK),
    cyl(0.04, 0.05, 0.016, 0, 0.028, 0, GOLD, 12),
    cyl(0.01, 0.014, 0.07, 0, 0.07, 0, GOLD, 8),
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
      GOLD,
      12,
    ),
    box(0.022, 0.05, 0.01, -0.07, 0.17, 0, GOLD),
    box(0.022, 0.05, 0.01, 0.07, 0.17, 0, GOLD),
  ]);

// A footprint on a top hugs its model, so each model is centered on it, whatever the parts that stick out to one side do.
const around = (make: () => BufferGeometry) => () => {
  const g = make();
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new Vector3());
  return g.translate(-c.x, 0, -c.z);
};

export const TABLETOP_MODELS: Readonly<Record<string, () => BufferGeometry>> = {
  laptop: around(laptop),
  books: around(books),
  papers: around(papers),
  mug: around(mug),
  picture_frame: around(frame),
  vase: around(vase),
  pen_cup: around(penCup),
  desk_clock: around(deskClock),
  trophy: around(trophy),
};
