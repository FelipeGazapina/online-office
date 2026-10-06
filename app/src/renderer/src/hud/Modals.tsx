import { useEffect, useState, type ReactNode } from 'react';
import {
  DESKS_PER_BLOCK,
  headcountCap,
  PROVIDERS,
  type BlockId,
  type HarnessStatus,
  type ModelId,
  type Provider,
} from '../../../shared/protocol.ts';
import { useDiagram } from '../scene/whiteboard.ts';
import { send, set, useStore } from '../store.ts';
import { tailPath } from './hooks.ts';
import { TaskBoardModal } from './tasks/TaskBoard.tsx';

const close = () => set({ modal: null });

function Modal({ kind, title, children }: { kind: string; title: string; children: ReactNode }) {
  return (
    <div className="scrim" onMouseDown={close}>
      <div
        className="modal"
        data-hud-resize-target={`modal-${kind}`}
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
const EMPTY_BLOCKS: NonNullable<ReturnType<typeof useStore.getState>['company']>['blocks'] = [];

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
  const bypassLimit = useStore((s) => s.modal?.kind === 'hire' && s.modal.bypassLimit === true);
  const harnesses = useStore((s) => s.harnesses);
  const [provider, setProvider] = useState<Provider>(() => PROVIDER_LIST.find((p) => harnesses?.[p].kind === 'ready') ?? 'claude-code');
  const [blockId, setBlockId] = useState<BlockId | ''>(company?.blocks[0]?.id ?? '');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'employee' | 'orchestrator'>('employee');
  const [model, setModel] = useState<ModelId | ''>('');
  const catalogs = useStore((s) => s.catalogs);
  const catalog = catalogs?.[provider];

  // Model discovery can start the provider CLI, so do it only for the provider
  // the owner is looking at and reuse a catalog that is already in the snapshot.
  useEffect(() => {
    if (!catalog || catalog.kind === 'unknown' || catalog.kind === 'error') send({ type: 'load_models', provider });
    setModel('');
  }, [provider]);

  useEffect(() => {
    if (catalog?.kind === 'ready' && !model) setModel(catalog.defaultModel);
  }, [catalog, model]);
  if (!company || !harnesses) return null;
  const used = (id: BlockId) => company.employees.filter((e) => e.blockId === id).length;
  const ready = harnesses[provider].kind === 'ready';
  const unlimited = bypassLimit || !Number.isFinite(headcountCap(company.level));

  return (
    <Modal kind="hire" title="Hire someone">
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
              <option key={b.id} value={b.id} disabled={!unlimited && used(b.id) >= DESKS_PER_BLOCK}>
                {b.name} ({used(b.id)}/{unlimited ? '∞' : DESKS_PER_BLOCK} desks)
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Model</span>
        {catalog?.kind === 'ready' ? (
          <select value={model} onChange={(e) => setModel(e.target.value as ModelId)} disabled={catalog.models.length === 0}>
            {catalog.models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        ) : catalog?.kind === 'loading' ? (
          <span className="muted">Loading models from {PROVIDERS[provider].label}…</span>
        ) : catalog?.kind === 'error' ? (
          <span className="muted">Could not load models: {catalog.message}</span>
        ) : (
          <span className="muted">Using the provider default model</span>
        )}
      </label>
      <label className="field">
        <span>Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value as 'employee' | 'orchestrator')}>
          <option value="employee">Employee</option>
          <option value="orchestrator">Block orchestrator / PO</option>
        </select>
      </label>
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
            send({ type: 'hire', provider, blockId, role, ...(bypassLimit && { bypassLimit: true }), ...(name.trim() && { name: name.trim() }), ...(model && { model }) });
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
  const blocks = useStore((s) => s.company?.blocks ?? EMPTY_BLOCKS);
  const [cwd, setCwd] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
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
    <Modal kind="block" title="New block">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!cwd || clash) return;
          send({ type: 'create_block', cwd, ...(name.trim() && { name: name.trim() }), ...(githubRepo.trim() && { githubRepo: githubRepo.trim() }) });
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
        <label className="field">
          <span>
            GitHub repository <span className="muted">optional</span>
          </span>
          <input value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} placeholder="https://github.com/owner/repository" type="url" />
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

type GithubItem = { id: number; title: string; html_url: string; state: 'open' | 'closed'; user?: { login: string }; pull_request?: unknown };

function GithubSetupModal({ blockId }: { blockId: BlockId }) {
  const block = useStore((s) => s.company?.blocks.find((b) => b.id === blockId));
  const [repo, setRepo] = useState(block?.githubRepo ?? '');
  if (!block) return null;
  return (
    <Modal kind="github_setup" title={`Connect GitHub to ${block.name}`}>
      <form onSubmit={(event) => {
        event.preventDefault();
        const value = repo.trim();
        if (!value) return;
        send({ type: 'update_block', blockId, githubRepo: value });
        set({ modal: { kind: 'github', blockId } });
      }}>
        <label className="field">
          <span>Repository URL</span>
          <input autoFocus type="url" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="https://github.com/owner/repository" />
        </label>
        <p className="muted">The board reads public pull requests and issues from GitHub.</p>
        <div className="actions"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn primary" disabled={!repo.trim()}>Connect</button></div>
      </form>
    </Modal>
  );
}

function GithubBoardModal({ blockId }: { blockId: BlockId }) {
  const block = useStore((s) => s.company?.blocks.find((b) => b.id === blockId));
  const [items, setItems] = useState<GithubItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!block?.githubRepo) return;
    const repo = block.githubRepo.replace(/\/$/, '');
    let apiUrl: string;
    try {
      const url = new URL(repo);
      if (url.hostname !== 'github.com') throw new Error('Use a github.com repository URL');
      const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
      if (path.split('/').length !== 2) throw new Error('Use a repository URL like https://github.com/owner/repository');
      apiUrl = `https://api.github.com/repos/${path}/issues?state=all&per_page=100`;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setState('error');
      return;
    }
    setState('loading');
    fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        return (await response.json()) as GithubItem[];
      })
      .then((next) => {
        setItems(next);
        setState('ready');
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
        setState('error');
      });
  }, [block?.githubRepo]);

  if (!block) return null;
  const prs = items.filter((item) => item.pull_request);
  const issues = items.filter((item) => !item.pull_request);
  const open = items.filter((item) => item.state === 'open');
  const closed = items.filter((item) => item.state === 'closed');
  const cards = (list: GithubItem[]) => list.map((item) => <a className="github-card" key={item.id} href={item.html_url} target="_blank" rel="noreferrer">
    <b>{item.title}</b>
    <span>{item.pull_request ? 'Pull request' : 'Issue'} · #{item.id} · {item.user?.login ?? 'unknown'}</span>
  </a>);

  return (
    <div className="scrim" onMouseDown={close}>
      <div className="modal wide github-board" data-hud-resize-target="modal-github" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <div className="wb-head"><div><h2>GitHub board</h2><p className="muted">{block.name} · {block.githubRepo}</p></div><button className="btn ink" onClick={close}>Close</button></div>
        {state === 'loading' && <p className="muted">Loading pull requests and issues…</p>}
        {state === 'error' && <p className="err-text">Could not load GitHub data: {message}</p>}
        {state === 'ready' && <>
          <div className="github-summary"><span>{prs.length} pull requests</span><span>{issues.length} issues</span><span>{open.length} open</span><span>{closed.length} closed</span></div>
          <div className="github-columns"><section><h3>Open</h3>{cards(open)}</section><section><h3>Closed</h3>{cards(closed)}</section></div>
        </>}
      </div>
    </div>
  );
}

function WhiteboardModal({ blockId }: { blockId: BlockId }) {
  const block = useStore((s) => s.company?.blocks.find((b) => b.id === blockId));
  const author = useStore((s) => s.company?.employees.find((e) => e.id === block?.whiteboard?.by)?.name);
  const d = useDiagram(block?.whiteboard?.mermaid);
  const [source, setSource] = useState(false);
  const wb = block?.whiteboard;

  if (wb?.page) {
    const page = wb.page;
    return (
      <div className="scrim" onMouseDown={close}>
        <div className="modal wide board-page" data-hud-resize-target="modal-whiteboard" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && close()}>
          <div className="wb-head"><div><h2>{wb.title}</h2><p className="muted">{block?.name} · {page.kind === 'html' ? page.source : page.url}</p></div><button className="btn ink" onClick={close}>Close</button></div>
          {page.kind === 'html' ? <iframe title={wb.title} sandbox="allow-scripts" srcDoc={page.html} /> : <iframe title={wb.title} sandbox="allow-scripts allow-forms allow-popups" src={page.url} />}
        </div>
      </div>
    );
  }

  return (
    <div className="scrim" onMouseDown={close}>
      <div className="modal wide" data-hud-resize-target="modal-whiteboard" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && close()}>
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

function LinearBoardModal({ blockId }: { blockId: BlockId }) {
  const block = useStore((s) => s.company?.blocks.find((candidate) => candidate.id === blockId));
  if (!block?.linearBoardUrl) return null;
  return <div className="scrim" onMouseDown={close}><div className="modal wide board-page" data-hud-resize-target="modal-linear_board" onMouseDown={(event) => event.stopPropagation()}><div className="wb-head"><div><h2>Linear board</h2><p className="muted">{block.name} · live view from Linear</p></div><button className="btn ink" onClick={close}>Close</button></div><iframe title="Linear board" src={block.linearBoardUrl} allow="clipboard-read; clipboard-write" /></div></div>;
}

export function Modals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  if (modal.kind === 'hire') return <HireModal />;
  if (modal.kind === 'block') return <BlockModal />;
  if (modal.kind === 'github_setup') return <GithubSetupModal blockId={modal.blockId} />;
  if (modal.kind === 'github') return <GithubBoardModal blockId={modal.blockId} />;
  if (modal.kind === 'task_board') return <TaskBoardModal blockId={modal.blockId} />;
  if (modal.kind === 'linear_board') return <LinearBoardModal blockId={modal.blockId} />;
  return <WhiteboardModal blockId={modal.blockId} />;
}
