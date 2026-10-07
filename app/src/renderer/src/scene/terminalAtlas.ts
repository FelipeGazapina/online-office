// The terminals on the monitors, as one texture. Every employee who sits at a desk gets a tile of the atlas. A tile is a small canvas
// the terminal is drawn into, and only a tile that changed and is worth drawing goes to the GPU, alone, by `copyTextureToTexture`:
// the atlas itself is never uploaded again. Pure drawing and bookkeeping: when to draw is the scene's call (MonitorScreens.tsx).
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, Texture, UnsignedByteType, Vector2, type WebGLRenderer } from 'three';
import type { EmployeeStatus, PermissionMode } from '../../../shared/protocol.ts';
import { quartersOf, rowText, screenOf, type Row, type TermBlock, type TermLive } from '../../../shared/terminal.ts';
import { BGS, FONT, SCREEN_BG, TONES } from '../hud/terminal/theme.ts';

// A cell of the atlas holds one tile. The picture sits inside it, and the rim round it is the screen's own colour, so the mip levels
// of a far away screen blend with the bezel and never with the tile next door.
export const CELL_W = 320;
export const CELL_H = 192;
const RIM = 8;
const INNER_W = CELL_W - RIM * 2;
const INNER_H = CELL_H - RIM * 2;
export const ATLAS_COLS = 8;
// Rows of text on a monitor. The columns follow from the shape of the screen, so a character is as tall as it is on the terminal in the panel.
export const SCREEN_ROWS = 15;
const CHAR_ASPECT = 0.5;

/** How many columns of text a screen of this shape holds. */
export const columnsFor = (aspect: number): number => Math.max(24, Math.round((aspect * SCREEN_ROWS) / CHAR_ASPECT));

export type TileView = { blocks: readonly TermBlock[]; live: TermLive; status: EmployeeStatus; who: string; model: string; mode: PermissionMode; cols: number; now: number };

type Tile = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: Texture; slot: number; key: string; drawnAt: number; rows: string[]; needsUpload: boolean; cols: number };

const bg = new Vector2();

function blank(rows: number): DataTexture {
  const data = new Uint8Array(ATLAS_COLS * CELL_W * rows * CELL_H * 4);
  // The colour of the screen, so a tile nobody drew yet is dark glass and not a hole.
  const [r, g, b] = [0x1d, 0x1d, 0x1f];
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  const t = new DataTexture(data, ATLAS_COLS * CELL_W, rows * CELL_H, RGBAFormat, UnsignedByteType);
  t.colorSpace = SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 4;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

const ASCII = /^[\x20-\x7e]*$/;

// Draws a screen's rows into a tile. Every character takes one cell of the grid, so the text lines up whatever the font does with a glyph
// it has to borrow.
function paint(ctx: CanvasRenderingContext2D, screen: readonly Row[], cols: number) {
  const nrows = screen.length;
  const charW = INNER_W / cols;
  const charH = INNER_H / nrows;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = SCREEN_BG;
  ctx.fillRect(0, 0, CELL_W, CELL_H);
  const px = charH * 0.84;
  ctx.textBaseline = 'alphabetic';
  let font = '';
  let sx = 1;
  const use = (bold: boolean, italic: boolean) => {
    const next = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${px.toFixed(2)}px ${FONT}`;
    if (next === font) return;
    font = next;
    ctx.font = font;
    sx = charW / Math.max(1, ctx.measureText('0').width);
  };
  screen.forEach((row, r) => {
    const y = RIM + r * charH;
    if (row.fill) {
      ctx.fillStyle = BGS[row.fill];
      ctx.fillRect(RIM, y, INNER_W, charH);
    }
    let col = 0;
    for (const span of row.spans) {
      const x = RIM + col * charW;
      if (span.bg) {
        ctx.fillStyle = BGS[span.bg];
        ctx.fillRect(x, y, span.t.length * charW, charH);
      }
      ctx.fillStyle = TONES[span.c ?? 'fg'];
      use(!!span.b, !!span.i);
      if (ASCII.test(span.t)) {
        ctx.setTransform(sx, 0, 0, 1, x, y);
        ctx.fillText(span.t, 0, charH * 0.78);
      } else {
        [...span.t].forEach((ch, i) => {
          const cx = x + i * charW;
          const q = quartersOf(ch);
          if (q) {
            q.forEach((on, k) => on && ctx.fillRect(cx + (k % 2) * (charW / 2), y + Math.floor(k / 2) * (charH / 2), charW / 2 + 0.5, charH / 2 + 0.5));
            return;
          }
          ctx.setTransform(sx, 0, 0, 1, cx, y);
          ctx.fillText(ch, 0, charH * 0.78);
        });
      }
      col += [...span.t].length;
    }
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export class TerminalAtlas {
  texture: DataTexture;
  // Counts the times the texture was made again, so a mesh knows to read the rectangles again.
  revision = 0;
  private rows = 2;
  private readonly tiles = new Map<string, Tile>();
  private initialized: WebGLRenderer | undefined;

  constructor() {
    this.texture = blank(this.rows);
  }

  private tile(id: string): Tile {
    let t = this.tiles.get(id);
    if (!t) {
      const canvas = document.createElement('canvas');
      canvas.width = CELL_W;
      canvas.height = CELL_H;
      const ctx = canvas.getContext('2d', { alpha: false })!;
      const used = new Set([...this.tiles.values()].map((x) => x.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      t = { canvas, ctx, texture: new Texture(canvas), slot, key: '', drawnAt: 0, rows: [], needsUpload: false, cols: 0 };
      this.tiles.set(id, t);
      while (slot >= ATLAS_COLS * this.rows) this.grow();
    }
    return t;
  }

  // A bigger atlas has the same tiles in the same cells, so a tile is only drawn again to be uploaded again.
  private grow() {
    this.rows += 2;
    this.texture.dispose();
    this.texture = blank(this.rows);
    this.revision++;
    this.initialized = undefined;
    for (const t of this.tiles.values()) t.needsUpload = t.key !== '';
  }

  /** The rectangle of this employee's picture in the atlas, in texture coordinates measured from the top: u, v, width, height. */
  rectOf(id: string): [number, number, number, number] {
    const t = this.tile(id);
    const col = t.slot % ATLAS_COLS;
    const row = Math.floor(t.slot / ATLAS_COLS);
    const W = ATLAS_COLS * CELL_W;
    const H = this.rows * CELL_H;
    return [(col * CELL_W + RIM) / W, (row * CELL_H + RIM) / H, INNER_W / W, INNER_H / H];
  }

  keyOf(id: string): string | undefined {
    return this.tiles.get(id)?.key;
  }

  drawnAt(id: string): number {
    return this.tiles.get(id)?.drawnAt ?? 0;
  }

  /** Draws the terminal of `id` into its tile. `key` says what it was drawn from, so the caller can tell when it is out of date. */
  draw(id: string, key: string, v: TileView) {
    const t = this.tile(id);
    const screen = screenOf({ blocks: v.blocks, live: v.live, status: v.status, now: v.now, cols: v.cols, rows: SCREEN_ROWS, compact: true, who: v.who, model: v.model, mode: v.mode });
    paint(t.ctx, screen, v.cols);
    t.key = key;
    t.cols = v.cols;
    t.drawnAt = performance.now();
    t.rows = screen.map(rowText);
    t.needsUpload = true;
  }

  /** Sends the tiles that were drawn since the last call to the GPU. */
  flush(gl: WebGLRenderer) {
    if (this.initialized !== gl) {
      gl.initTexture(this.texture);
      this.initialized = gl;
    }
    for (const t of this.tiles.values()) {
      if (!t.needsUpload) continue;
      t.needsUpload = false;
      gl.copyTextureToTexture(t.texture, this.texture, null, bg.set((t.slot % ATLAS_COLS) * CELL_W, Math.floor(t.slot / ATLAS_COLS) * CELL_H));
    }
  }

  /** For the tests: what each screen shows, as the rows of text last drawn on it. */
  probe(): Record<string, { slot: number; cols: number; rows: string[]; key: string; drawnAt: number }> {
    return Object.fromEntries([...this.tiles].map(([id, t]) => [id, { slot: t.slot, cols: t.cols, rows: t.rows, key: t.key, drawnAt: t.drawnAt }]));
  }

  forget(keep: ReadonlySet<string>) {
    for (const id of [...this.tiles.keys()]) if (!keep.has(id)) this.tiles.delete(id);
  }
}

let shared: TerminalAtlas | undefined;
export const atlas = (): TerminalAtlas => {
  if (!shared) {
    shared = new TerminalAtlas();
    // For the tests: what each monitor shows, as the rows of text last drawn on it.
    (window as unknown as { __officeTerminals: unknown }).__officeTerminals = () => shared!.probe();
  }
  return shared;
};
