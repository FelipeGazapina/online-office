import { useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDERS, type Employee } from '../../../shared/protocol.ts';
import { attachChatImage, send, set, useStore } from '../store.ts';
import { tell } from '../talk.ts';
import { fmtWait, useNow } from './hooks.ts';

const STATUS_LABEL = { idle: 'Idle', working: 'Working', blocked_on_owner: 'Waiting on you', error: 'Error' } as const;
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

async function readImage(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Images must be smaller than 8 MB.');
  return await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read image.')); reader.readAsDataURL(file); });
}

export function Drawer() {
  const id = useStore((s) => s.selectedId);
  const e = useStore((s) => s.company?.employees.find((x) => x.id === id));
  const block = useStore((s) => s.company?.blocks.find((b) => b.id === e?.blockId));
  const logs = useStore((s) => (id ? s.logs[id] : undefined));
  const lines = useStore((s) => (id ? s.chat[id] : undefined)) ?? [];
  const nearbyIds = useStore((s) => s.nearbyIds);
  const company = useStore((s) => s.company);
  const catalogs = useStore((s) => s.catalogs);
  const now = useNow(1000);
  const [draft, setDraft] = useState('');
  const [image, setImage] = useState<{ data: string; name: string }>();
  const [confirm, setConfirm] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const groupMembers = useMemo(
    () =>
      nearbyIds
        .map((nearbyId) => company?.employees.find((employee) => employee.id === nearbyId))
        .filter((employee): employee is Employee => Boolean(employee)),
    [company, nearbyIds],
  );

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end' });
  }, [lines.length, id]);
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [logs?.length, showLog]);
  useEffect(() => {
    setConfirm(false);
    setShowLog(false);
    setDraft('');
  }, [id]);

  if (!e) return null;
  if (groupMembers.length > 1) return <GroupDrawer members={groupMembers} />;
  const p = PROVIDERS[e.provider];
  const catalog = catalogs?.[e.provider];
  const s = e.status;

  return (
    <aside className="drawer" data-hud-resize-target="drawer" key={e.id}>
      <header>
        <div>
          <h2>{e.name}</h2>
          <div className="sub">
            <i className="pdot" style={{ background: p.color }} />
            {p.label} · {(e.role ?? 'employee') === 'orchestrator' ? 'Block orchestrator' : 'Employee'}
          </div>
        </div>
        <button className="x" title="Close (Esc)" onClick={() => set({ selectedId: null })}>
          ×
        </button>
      </header>

      <div className="facts">
        <span className={`pill ${s.kind}`}>{STATUS_LABEL[s.kind]}</span>
        <span>
          {block?.name ?? 'No block'} · desk {e.desk + 1}
        </span>
      </div>

      <section className="agent-settings">
        <h3>Agent settings</h3>
        <label className="field"><span>Permission mode</span><select value={e.permissions.mode} onChange={(event) => send({ type: 'set_permissions', employeeId: e.id, mode: event.target.value as 'inherit' | 'ask' | 'auto' | 'yolo' })}>
          <option value="inherit">Inherit</option><option value="ask">Ask</option><option value="auto">Auto</option><option value="yolo">Yolo</option>
        </select></label>
        {catalog?.kind === 'ready' && <label className="field"><span>Model</span><select value={e.model} onChange={(event) => send({ type: 'set_model', employeeId: e.id, model: event.target.value as Employee['model'] })}>
          {catalog.models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select></label>}
        <button className="link" onClick={() => send({ type: 'fresh_session', employeeId: e.id })}>Start fresh session</button>
      </section>

      <section className="task">
        <h3>Current task</h3>
        <p>{s.kind === 'working' || s.kind === 'blocked_on_owner' ? s.task : s.kind === 'error' ? s.message : 'Nothing assigned.'}</p>
        {s.kind === 'working' && <p className="muted">{e.activity} · {fmtWait(now - s.startedAt)}</p>}
        {s.kind === 'blocked_on_owner' && (
          <p className="ask">
            “{s.question.text}” <span className="muted">waiting {fmtWait(now - s.question.askedAt)}</span>
          </p>
        )}
      </section>

      <div className="thread" role="log">
        {lines.length === 0 && <p className="muted">Nothing said yet. Type below and it reaches {e.name} as if you stood at their desk.</p>}
        {lines.map((l, i) => (
          <div key={i} className={`msg ${l.from}`}>
            {l.image && <img className="chat-image" src={l.image} alt={l.imageName ?? 'Shared image'} />}
            {l.text && <span>{l.text}</span>}
          </div>
        ))}
        <div ref={threadEnd} />
      </div>

      <form
        className="compose"
        onSubmit={(ev) => {
          ev.preventDefault();
          const text = draft.trim() || (image ? `Shared image: ${image.name}` : '');
          if (!text) return;
          tell(e.id, text);
          if (image) attachChatImage(e.id, text, image.data, image.name);
          setDraft('');
          setImage(undefined);
          input.current?.focus();
        }}
      >
        <label className="attach-image" title="Share an image"><input type="file" accept="image/*" onChange={async (ev) => { const file = ev.target.files?.[0]; if (!file) return; try { setImage({ data: await readImage(file), name: file.name }); } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); } ev.currentTarget.value = ''; }} /><span>＋</span></label><input id="drawer-input" ref={input} value={draft} onChange={(ev) => setDraft(ev.target.value)} placeholder={image ? image.name : `Message ${e.name}`} />
        <button type="submit" className="btn ink" disabled={!draft.trim() && !image}>
          Send
        </button>
      </form>

      <button className="link" onClick={() => setShowLog(!showLog)}>
        {showLog ? 'Hide tool log' : `Tool log (${logs?.length ?? 0})`}
      </button>
      {showLog && (
        <div className="log tool-log">
          {(logs ?? []).length === 0 && <p className="muted">Nothing yet.</p>}
          {logs?.map((l, i) => (
            <div key={i} className={l.line.startsWith('says:') ? 'say' : ''}>
              <time>{time(l.at)}</time>
              <span>{l.line}</span>
            </div>
          ))}
          <div ref={logEnd} />
        </div>
      )}

      <button
        className={`btn danger ${confirm ? 'armed' : ''}`}
        onClick={() => {
          if (!confirm) return setConfirm(true);
          send({ type: 'fire', employeeId: e.id });
          set({ selectedId: null });
        }}
        onBlur={() => setConfirm(false)}
      >
        {confirm ? `Really fire ${e.name}?` : 'Fire'}
      </button>
    </aside>
  );
}

function GroupDrawer({ members }: { members: Employee[] }) {
  const [draft, setDraft] = useState('');
  const threadEnd = useRef<HTMLDivElement>(null);
  const chats = useStore((s) => s.chat);
  const lines = useMemo(
    () =>
      members
        .flatMap((member) => (chats[member.id] ?? []).map((line) => ({ ...line, employee: member.name })))
        .sort((a, b) => a.at - b.at),
    [chats, members],
  );
  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);

  return (
    <aside className="drawer" data-hud-resize-target="drawer" key="group">
      <header>
        <div>
          <h2>Nearby team</h2>
          <div className="sub">{members.map((member) => member.name).join(' · ')}</div>
        </div>
        <button className="x" title="Close (Esc)" onClick={() => set({ selectedId: null })}>
          ×
        </button>
      </header>
      <div className="facts">
        <span className="pill working">Group chat</span>
        <span>{members.length} employees in earshot</span>
      </div>
      <div className="thread" role="log">
        {lines.length === 0 && <p className="muted">Nothing said yet. Messages here reach everyone nearby.</p>}
        {lines.map((line, i) => (
          <div key={`${line.at}-${i}`} className={`msg ${line.from}`}>
            <small className="group-speaker">{line.employee}</small>
            {line.text}
          </div>
        ))}
        <div ref={threadEnd} />
      </div>
      <form
        className="compose"
        onSubmit={(ev) => {
          ev.preventDefault();
          const text = draft.trim();
          if (!text) return;
          for (const member of members) tell(member.id, text);
          setDraft('');
        }}
      >
        <input value={draft} onChange={(ev) => setDraft(ev.target.value)} placeholder="Message everyone nearby" />
        <button type="submit" className="btn ink" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}
