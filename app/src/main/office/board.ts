import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { Whiteboard } from '../../shared/protocol.ts';

export async function boardPage(cwd: string, target: string): Promise<NonNullable<Whiteboard['page']>> {
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target);
    if (url.username || url.password) throw new Error('Board URLs must not contain credentials.');
    return { kind: 'url', url: url.href };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) throw new Error('Use an HTTP(S) URL or an HTML path inside the project.');
  const root = await realpath(cwd);
  const file = await realpath(resolve(root, target));
  const path = relative(root, file);
  if (path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path)) throw new Error('HTML must be inside the project folder.');
  if (!['.html', '.htm'].includes(extname(file).toLowerCase())) throw new Error('Choose an HTML file.');
  const info = await stat(file);
  if (!info.isFile() || info.size > 512 * 1024) throw new Error('Choose an HTML file smaller than 512 KB.');
  const html = await readFile(file, 'utf8');
  if (Buffer.byteLength(html) > 512 * 1024) throw new Error('HTML exceeds 512 KB.');
  return { kind: 'html', html, source: path };
}
