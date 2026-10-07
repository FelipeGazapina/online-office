// The colours of the terminal on a monitor and in the zoomed panel: one palette, so what the owner reads on a desk and what opens
// when they zoom in are the same screen.
import type { Bg, Tone } from '../../../../shared/terminal.ts';

export const FONT = '"SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, "DejaVu Sans Mono", monospace';
export const SCREEN_BG = '#1d1d1f';

export const TONES: Record<Tone, string> = {
  fg: '#d6d6d8',
  dim: '#8e8e93',
  bright: '#f5f5f7',
  accent: '#d97757',
  ok: '#5fc977',
  err: '#ff6b81',
  warn: '#e5a64a',
  info: '#a9b8ff',
  rule: '#4a4a52',
  violet: '#b4a7f5',
};

export const BGS: Record<Bg, string> = { user: '#37373b', add: '#16402a', del: '#4a1d27' };
