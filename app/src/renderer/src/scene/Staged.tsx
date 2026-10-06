import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { yieldToBrowser } from './warmup.ts';

// The whole office used to mount in one React commit, a single task of 50 to 160 ms. A commit cannot be cut short, so Staged
// mounts its children one after another, each in a task of its own. Nothing is drawn until the first draw is ready, so the
// office still appears whole.
let toMount = 0;
let waiting: (() => void)[] = [];

/** Resolves once every Staged child has mounted. */
export const stagesMounted = () =>
  new Promise<void>((resolve) => {
    if (toMount === 0) resolve();
    else waiting.push(resolve);
  });

function mounted(count: number) {
  toMount -= count;
  if (toMount > 0) return;
  for (const resolve of waiting) resolve();
  waiting = [];
}

export function Staged({ children }: { children: ReactNode }) {
  const parts = Children.toArray(children);
  const [shown, setShown] = useState(1);
  // The parts are fixed for the life of the component, so they are counted once.
  const left = useRef(0);
  useLayoutEffect(() => {
    left.current = parts.length - 1;
    toMount += left.current;
    return () => mounted(left.current);
  }, []);
  useLayoutEffect(() => {
    if (shown === 1) return;
    left.current -= 1;
    mounted(1);
  }, [shown]);
  useEffect(() => {
    if (shown >= parts.length) return;
    let live = true;
    void yieldToBrowser().then(() => live && setShown(shown + 1));
    return () => {
      live = false;
    };
  }, [shown, parts.length]);
  return <>{parts.slice(0, shown)}</>;
}
