// The pictures the owner attaches in chat. They live beside company.json, outside every project folder, so an employee can
// open one and no repo ever commits one. Plain Node: the check scripts import it.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, type ImageMime, type ImageUpload } from '../../shared/mail.ts';
import { OfficeError } from './error.ts';

export const attachmentsDir = (dataFile: string) => join(dirname(dataFile), 'attachments');

// Writes each picture and returns where it is, in the order the owner attached them. Nothing is written when one is refused.
export function saveImages(dir: string, images: readonly ImageUpload[]): string[] {
  const files = images.map((image) => {
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length === 0) throw new OfficeError(`${image.name || 'The image'} is empty.`);
    if (bytes.length > MAX_IMAGE_BYTES) throw new OfficeError(`${image.name || 'The image'} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    return { bytes, path: join(dir, `${randomUUID()}.${IMAGE_TYPES[image.mime]}`) };
  });
  if (files.length) mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(f.path, f.bytes);
  return files.map((f) => f.path);
}

// A saved picture as a data URL, for the chat. Null for anything that is not a picture inside `dir`.
export function readImage(dir: string, path: string): string | null {
  const mime = (Object.keys(IMAGE_TYPES) as ImageMime[]).find((m) => `.${IMAGE_TYPES[m]}` === extname(path));
  if (!mime) return null;
  try {
    const real = realpathSync(path);
    if (!real.startsWith(realpathSync(dir) + sep)) return null;
    return `data:${mime};base64,${readFileSync(real).toString('base64')}`;
  } catch {
    return null;
  }
}
