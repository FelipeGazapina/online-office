import { useState, type ReactNode } from 'react';
import { DESKS_PER_BLOCK, PROVIDERS, type BlockId, type HarnessStatus, type Provider } from '../../../shared/protocol.ts';
import { useDiagram } from '../scene/whiteboard.ts';
import { send, set, useStore } from '../store.ts';
import { tailPath } from './hooks.ts';

const close = () => set({ modal: null });

function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="scrim" onMouseDown={close}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

const PROVIDER_LIST = Object.keys(PROVIDERS) as Provider[];

function harnessNote(h: HarnessStatus): string {
  switch (h.kind) {
    case 'ready':
      return `Ready · v${h.version}`;
    case 'missing':
      return 'Not installed on this machine';
    case 'not_wired':
      return 'Installed, but the office cannot drive it yet';
  }
}

function HireModal() {
  const company = useStore((s) => s.company);
  const harnesses = useStore((s) => s.harnesses);
  const [provider, setProvider] = useState<Provider>(() => PROVIDER_LIST.find((p) => harnesses?.[p].kind === 'ready') ?? 'claude-code');
  const [blockId, setBlockId] = useState<BlockId | ''>(company?.blocks[0]?.id ?? '');
  const [name, setName] = useState('');
  if (!company || !harnesses) return null;
  const used = (id: BlockId) => company.employees.filter((e) => e.blockId === id).length;
  const ready = harnesses[provider].kind === 'ready';

  return (
    <Modal title="Hire someone">
      <div className="providers">
        {PROVIDER_LIST.map((p) => {
          const h = harnesses[p];
          return (
            <button
              key={p}
              type="button"
              className={`prov-card ${provider === p ? 'on' : ''} ${h.kind}`}
              disabled={h.kind !== 'ready'}
              onClick={() => setProvider(p)}
            >
              <i style={{ background: PROVIDERS[p].color }} />
              <b>{PROVIDERS[p].label}</b>
              <span className="prov-note">{harnessNote(h)}</span>
            </button>
          );
        })}
      </div>
      {company.blocks.length === 0 ? (
        <p className="muted">
          There is no block to sit in yet.{' '}
          <button type="button" className="link" onClick={() => set({ modal: { kind: 'block' } })}>
            Add a project block
          </button>
        </p>
      ) : (
        <label className="field">
          <span>Block</span>
          <select value={blockId} onChange={(e) => setBlockId(e.target.value as BlockId)}>
            {company.blocks.map((b) => (
              <option key={b.id} value={b.id} disabled={used(b.id) >= DESKS_PER_BLOCK}>
                {b.name} ({used(b.id)}/{DESKS_PER_BLOCK} desks)
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>
          Name <span className="muted">optional</span>
        </span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave empty for a fresh name" />
      </label>
      <div className="actions">
        <button className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!blockId || !ready}
          onClick={() => {
            if (!blockId) return;
            send({ type: 'hire', provider, blockId, ...(name.trim() && { name: name.trim() }) });
            close();
          }}
        >
          Hire
        </button>
      </div>
    </Modal>
  );
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function BlockModal() {
  const blocks = useStore((s) => s.company?.blocks ?? []);
  const [cwd, setCwd] = useState<string | null>(null);
  const [name, setName] = useState('');
  // Once the owner types a name, picking another folder must not overwrite it.
  const [renamed, setRenamed] = useState(false);
  const clash = cwd ? blocks.find((b) => b.cwd === cwd) : undefined;

  const choose = async () => {
    const picked = await window.office.pickFolder();
    if (!picked) return;
    setCwd(picked);
    if (!renamed) setName(basename(picked));
  };

  return (
    <Modal title="New block">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!cwd || clash) return;
          send({ type: 'create_block', cwd, ...(name.trim() && { name: name.trim() }) });
          close();
        }}
      >
        <div className="field">
          <span>Folder</span>
          <div className="folder-row">
            <button type="button" className="btn ink" autoFocus onClick={() => void choose()}>
              Choose folder…
            </button>
            <code className="folder-path" title={cwd ?? undefined}>
              {cwd ? tailPath(cwd, 40) : 'No folder chosen yet'}
            </code>
          </div>
        </div>
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setRenamed(true);
            }}
            placeholder="Defaults to the folder name"
          />
        </label>
        {clash && <p className="err-text">{clash.name} already works in this folder.</p>}
        <p className="muted">A block is a project. Everyone sitting in it works in that folder.</p>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!cwd || !!clash}>
            Create block
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WhiteboardModal({ blockId }: { blockId: BlockId }) {
  const block = useStore((s) => s.company?.blocks.find((b) => b.id === blockId));
  const author = useStore((s) => s.company?.employees.find((e) => e.id === block?.whiteboard?.by)?.name);
  const d = useDiagram(block?.whiteboard?.mermaid);
  const [source, setSource] = useState(false);
  const wb = block?.whiteboard;

  return (
    <div className="scrim" onMouseDown={close}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <div className="wb-head">
          <div>
            <h2>{wb?.title ?? 'Whiteboard'}</h2>
            <p className="muted">
              {block?.name}
              {author ? ` · drawn by ${author}` : ''}
            </p>
          </div>
          <div className="actions">
            {wb && (
              <button className="btn ghost" onClick={() => setSource((v) => !v)}>
                {source ? 'Show diagram' : 'Show source'}
              </button>
            )}
            <button className="btn ink" onClick={close}>
              Close
            </button>
          </div>
        </div>
        <div className="wb-body">
          {!wb && <p className="muted">Nothing on this board yet. Agents draw diagrams here as they learn the project.</p>}
          {wb && source && <pre>{wb.mermaid}</pre>}
          {wb && !source && d.state === 'loading' && <p className="muted">Drawing…</p>}
          {wb && !source && d.state === 'error' && (
            <div>
              <p className="err-text">This diagram has a syntax error: {d.message}</p>
              <pre>{wb.mermaid}</pre>
            </div>
          )}
          {wb && !source && d.state === 'ok' && <div className="svg" dangerouslySetInnerHTML={{ __html: d.svg }} />}
        </div>
      </div>
    </div>
  );
}

export function Modals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  if (modal.kind === 'hire') return <HireModal />;
  if (modal.kind === 'block') return <BlockModal />;
  return <WhiteboardModal blockId={modal.blockId} />;
}
