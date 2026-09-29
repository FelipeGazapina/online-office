import { useEffect, useState } from 'react';

export type Diagram =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ok'; svg: string; image: HTMLImageElement | null; width: number; height: number };

type Rendered = { svg: string; width: number; height: number } | { error: string };

// mermaid is large, so it loads on first use. Renders are serialized because
// mermaid.render is not safe to call concurrently.
let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
let chain: Promise<unknown> = Promise.resolve();
const cache = new Map<string, Promise<Rendered>>();
let counter = 0;

function loadMermaid() {
  mermaidReady ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      // No foreignObject labels: an SVG with them taints the canvas and cannot become a texture.
      htmlLabels: false,
      flowchart: { htmlLabels: false, curve: 'basis' },
      themeVariables: {
        fontFamily: 'Helvetica, Arial, sans-serif',
        primaryColor: '#fff1cf',
        primaryBorderColor: '#2b2e44',
        primaryTextColor: '#2b2e44',
        lineColor: '#2b2e44',
        secondaryColor: '#d9ecff',
        tertiaryColor: '#ffffff',
      },
    });
    return m.default;
  });
  return mermaidReady;
}

export function renderDiagram(code: string): Promise<Rendered> {
  const hit = cache.get(code);
  if (hit) return hit;
  const p = new Promise<Rendered>((resolve) => {
    chain = chain.then(async () => {
      const id = `mmd-${++counter}`;
      try {
        const mermaid = await loadMermaid();
        const { svg } = await mermaid.render(id, code);
        const vb = /viewBox="([\d.\s-]+)"/.exec(svg)?.[1].split(/\s+/).map(Number);
        resolve({ svg, width: vb?.[2] ?? 800, height: vb?.[3] ?? 600 });
      } catch (err) {
        resolve({ error: err instanceof Error ? err.message.split('\n')[0] : 'Could not draw this diagram' });
      } finally {
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      }
    });
  });
  cache.set(code, p);
  return p;
}

async function toImage(svg: string, width: number, height: number): Promise<HTMLImageElement | null> {
  if (svg.includes('<foreignObject')) return null;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.removeAttribute('style');
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

export function useDiagram(code: string | undefined, wantImage = false): Diagram {
  const [d, setD] = useState<Diagram>({ state: code ? 'loading' : 'none' });
  useEffect(() => {
    if (!code) {
      setD({ state: 'none' });
      return;
    }
    let live = true;
    setD({ state: 'loading' });
    void renderDiagram(code).then(async (r) => {
      if (!live) return;
      if ('error' in r) return setD({ state: 'error', message: r.error });
      const image = wantImage ? await toImage(r.svg, r.width, r.height) : null;
      if (live) setD({ state: 'ok', svg: r.svg, image, width: r.width, height: r.height });
    });
    return () => {
      live = false;
    };
  }, [code, wantImage]);
  return d;
}
