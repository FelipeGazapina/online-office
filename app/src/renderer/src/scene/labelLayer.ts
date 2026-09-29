import type { RefObject } from 'react';

// A fixed DOM layer for in-world labels. drei's Html re-mounts its React root when its default
// target changes, which logs a React 19 error at startup; a stable portal target avoids that.
// drei types `portal` as a non-null ref, but the element only exists after the first commit.
export const labelLayer = { current: null } as unknown as RefObject<HTMLElement>;

export function setLabelLayer(el: HTMLElement | null) {
  (labelLayer as { current: HTMLElement | null }).current = el;
}
