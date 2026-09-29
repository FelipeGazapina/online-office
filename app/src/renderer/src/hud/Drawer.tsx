import { useEffect, useMemo, useRef, useState } from 'react';
import { DESKS_PER_BLOCK, PROVIDERS, type Employee } from '../../../shared/protocol.ts';
import { get, send, set, useStore } from '../store.ts';
import { fmtWait, useNow } from './hooks.ts';

const STATUS_LABEL = { idle: 'Idle', working: 'Working', blocked_on_owner: 'Waiting on you', error: 'Error' } as const;
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export function Drawer() {
  const id = useStore((s) => s.selectedId);
  const e = useStore((s) => s.company?.employees.find((x) => x.id === id));
  const block = useStore((s) => s.company?.blocks.find((b) => b.id === e?.blockId));
  const logs = useStore((s) => (id ? s.logs[id] : undefined));
  const lines = useStore((s) => (id ? s.chat[id] : undefined)) ?? [];
  const nearbyIds = useStore((s) => s.nearbyIds);
  const company = useStore((s) => s.company);
  const now = useNow(1000);
  const [draft, setDraft] = useState('');
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
  const s = e.status;

  return (
    <aside className="drawer" key={e.id}>
      <header>
        <div>
          <h2>{e.name}</h2>
          <div className="sub">
            <i className="pdot" style={{ background: p.color }} />
            {p.label}
          </div>
        </div>
        <button className="x" title="Close (Esc)" onClick={() => set({ selectedId: null })}>
          ×
        </button>
      </header>

      <div className="facts">
        <span className={`pill ${s.kind}`}>{STATUS_LABEL[s.kind]}</span>
        <span>
          {block?.name ?? 'No block'} · desk {e.desk + 1}/{DESKS_PER_BLOCK}
        </span>
      </div>

      <section>
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
            {l.text}
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
          send({ type: 'interject', employeeId: e.id, text, style: get().interrupt });
          setDraft('');
          input.current?.focus();
        }}
      >
        <input id="drawer-input" ref={input} autoFocus value={draft} onChange={(ev) => setDraft(ev.target.value)} placeholder={`Message ${e.name}`} />
        <button type="submit" className="btn ink" disabled={!draft.trim()}>
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
    <aside className="drawer" key="group">
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
          for (const member of members) send({ type: 'interject', employeeId: member.id, text, style: get().interrupt });
          setDraft('');
        }}
      >
        <input autoFocus value={draft} onChange={(ev) => setDraft(ev.target.value)} placeholder="Message everyone nearby" />
        <button type="submit" className="btn ink" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}
