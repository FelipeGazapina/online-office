// Pictures in the owner's messages: the ones waiting in a composer, and the ones a sent message carries.
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { IMAGE_TYPES, MAX_IMAGES, MAX_IMAGE_BYTES, type ImageMime, type ImageUpload } from '../../../../shared/mail.ts';
import { toast } from '../../store.ts';

export type DraftImage = ImageUpload & { id: string; url: string };

const isImage = (f: File) => f.type in IMAGE_TYPES;
const read = (f: File) =>
  new Promise<DraftImage>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const url = String(r.result);
      resolve({ id: crypto.randomUUID(), name: f.name, mime: f.type as ImageMime, data: url.slice(url.indexOf(',') + 1), url });
    };
    r.readAsDataURL(f);
  });

// The pictures of one composer. Paste, drop and the attach button all end in `add`. With `on` false nothing is taken, and
// the paste or drop goes where it would have gone.
export function useImageDraft(on = true) {
  const [images, setImages] = useState<DraftImage[]>([]);
  const count = useRef(0);
  count.current = images.length;

  const add = async (files: readonly File[]) => {
    const room = MAX_IMAGES - count.current;
    const fit = files.filter((f) => isImage(f) && f.size <= MAX_IMAGE_BYTES);
    if (files.some((f) => !isImage(f))) toast('Only PNG, JPEG, GIF and WebP images can be attached.', 'warn');
    else if (fit.length < files.length) toast(`An image can be up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`, 'warn');
    else if (fit.length > room) toast(`A message takes up to ${MAX_IMAGES} images.`, 'warn');
    const taken = fit.slice(0, Math.max(room, 0));
    count.current += taken.length;
    const drafts = await Promise.all(taken.map((f) => read(f).catch(() => null)));
    setImages((list) => [...list, ...drafts.filter((i) => i !== null)].slice(0, MAX_IMAGES));
  };

  const filesOf = (data: DataTransfer | null) => [...(data?.files ?? [])];
  return {
    images,
    uploads: images.map(({ name, mime, data }): ImageUpload => ({ name, mime, data })),
    add,
    remove: (id: string) => setImages((list) => list.filter((i) => i.id !== id)),
    clear: () => setImages([]),
    // Text on the clipboard pastes as text. A copied screenshot or file is attached instead.
    onPaste: (ev: ClipboardEvent) => {
      const files = filesOf(ev.clipboardData).filter(isImage);
      if (!on || files.length === 0) return;
      ev.preventDefault();
      void add(files);
    },
    onDragOver: (ev: DragEvent) => {
      if (on && ev.dataTransfer.types.includes('Files')) ev.preventDefault();
    },
    onDrop: (ev: DragEvent) => {
      const files = filesOf(ev.dataTransfer);
      if (!on || files.length === 0) return;
      ev.preventDefault();
      void add(files);
    },
  };
}

export type ImageDraft = ReturnType<typeof useImageDraft>;

export function AttachButton({ draft, className, disabled }: { draft: ImageDraft; className: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={Object.keys(IMAGE_TYPES).join(',')}
        data-attach-input
        onChange={(ev) => {
          void draft.add([...(ev.target.files ?? [])]);
          ev.target.value = '';
        }}
      />
      <button type="button" className={className} data-attach disabled={disabled} title="Attach an image. You can also paste or drop one." aria-label="Attach an image" onClick={() => input.current?.click()}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="2" />
          <circle cx="5.6" cy="6.4" r="1.2" />
          <path d="M2.2 11.6l3.4-3 2.4 2 2.6-2.8 3.2 3.4" />
        </svg>
      </button>
    </>
  );
}

// What is attached and not sent yet.
export function ImageTray({ draft }: { draft: ImageDraft }) {
  if (draft.images.length === 0) return null;
  return (
    <div className="img-tray" data-image-tray>
      {draft.images.map((i) => (
        <span key={i.id} className="img-thumb">
          <img src={i.url} alt={i.name} />
          <button type="button" title={`Remove ${i.name}`} aria-label={`Remove ${i.name}`} onClick={() => draft.remove(i.id)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

// A saved picture is read from the office once, however many threads show it.
const loaded = new Map<string, Promise<string | null>>();
const load = (path: string) => {
  if (!loaded.has(path)) loaded.set(path, window.office.readImage(path).catch(() => null));
  return loaded.get(path)!;
};

function Saved({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void load(path).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [path]);
  if (url === null) return <span className="img-missing" title={path}>image not found</span>;
  return url ? <img src={url} alt="Attached image" title={path} /> : <span className="img-missing">…</span>;
}

// The pictures of a message: `paths` are files the office saved, `urls` are the ones of a post still on its way.
export function Attached({ paths = [], urls = [] }: { paths?: readonly string[]; urls?: readonly string[] }) {
  if (paths.length + urls.length === 0) return null;
  return (
    <div className="img-attached" data-attached={paths.length + urls.length}>
      {paths.map((p) => (
        <Saved key={p} path={p} />
      ))}
      {urls.map((u, i) => (
        <img key={i} src={u} alt="Attached image" />
      ))}
    </div>
  );
}
