import { useEffect, useState } from 'react';

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// Long paths keep their tail: the folder name is what the owner recognises.
export const tailPath = (path: string, max: number) => (path.length > max ? `…${path.slice(-(max - 1))}` : path);

export function fmtWait(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
