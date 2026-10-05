import { useEffect, useMemo, useState } from 'react';
import { PROVIDERS, type Employee } from '../../../shared/protocol.ts';
import { get, send, set, useStore } from '../store.ts';
import { Composer } from './chat/Composer.tsx';
import { avatarColor, isPo, liveState, mergeMessages, rosterOf, textOf } from './chat/model.ts';
import { countRender } from './chat/renders.ts';
import { Roster } from './chat/Roster.tsx';
import { Thread } from './chat/Thread.tsx';
import { fmtWait, useNow } from './hooks.ts';

const STATUS_LABEL = { idle: 'Idle', working: 'Working', blocked_on_owner: 'Waiting on you', error: 'Error' } as const;
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

// Cmd+K opens the chat on the PO if it is closed and puts the cursor in the composer. Enter does the same for the keyboard
// walker, ahead of the global handler that would send it to the talk bar.
function useChatKeys() {
  useEffect(() => {
    const focusComposer = () => requestAnimationFrame(() => document.getElementById('drawer-input')?.focus());
    const onKey = (ev: KeyboardEvent) => {
      const s = get();
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        if (!s.selectedId) {
          const first = s.company?.employees.find((e) => (e.role ?? 'employee') === 'orchestrator') ?? s.company?.employees[0];
          if (!first) return;
          set({ selectedId: first.id });
        }
        set({ chatDetails: false });
        focusComposer();
        return;
      }
      if (ev.code !== 'Enter' || ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey || !s.selectedId || s.modal) return;
      const el = ev.target;
      if (el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(el.tagName))) return;
      ev.preventDefault();
      ev.stopPropagation();
      set({ chatDetails: false });
      focusComposer();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
}

export function Drawer() {
  countRender('drawer');
  useChatKeys();
  const id = useStore((s) => s.selectedId);
  const employees = useStore((s) => s.company?.employees);
  const blocks = useStore((s) => s.company?.blocks);
  const tail = useStore((s) => s.mail.tail);
  const history = useStore((s) => s.history);
  const e = employees?.find((x) => x.id === id);
  const block = blocks?.find((b) => b.id === e?.blockId);
  const messages = useMemo(() => mergeMessages(tail, ...Object.values(history).map((h) => h.messages)), [tail, history]);
  const roster = useMemo(() => (employees && e ? rosterOf(employees, e.blockId, messages) : []), [employees, e?.blockId, messages]);
  const people = useMemo(() => roster.map((r) => r.employee), [roster]);
  const lasts = useMemo(() => roster.map((r) => r.last), [roster]);

  if (!e) return null;
  const po = people.find(isPo);
  return (
    <aside className="drawer cp" data-hud-resize-target="drawer" aria-label="Chat">
      <Roster people={people} lasts={lasts} blockName={block?.name ?? 'No block'} />
      <Main who={e} po={po} />
    </aside>
  );
}

function Main({ who, po }: { who: Employee; po: Employee | undefined }) {
  const sub = useStore((s) => s.chatSub);
  const details = useStore((s) => s.chatDetails);
  const root = useStore((s) => (s.chatSub ? s.mail.tail.find((m) => m.id === s.chatSub) ?? Object.values(s.history).flatMap((h) => h.messages).find((m) => m.id === s.chatSub) : undefined));
  const assignee = useStore((s) => (root?.kind === 'request' ? s.company?.employees.find((x) => x.id === root.to) : undefined));
  return (
    <section className="cp-main">
      <Head who={who} sub={sub ? { title: root ? textOf(root) : 'Request', assignee } : null} details={details} />
      {details ? (
        <Details e={who} />
      ) : (
        <>
          <Thread who={who} />
          <Composer key={who.id} who={who} po={po} assignee={sub ? assignee : undefined} />
        </>
      )}
    </section>
  );
}

function Head({ who, sub, details }: { who: Employee; sub: { title: string; assignee: Employee | undefined } | null; details: boolean }) {
  const streaming = useStore((s) => Boolean(s.streams[who.id]));
  const actor = useStore((s) => s.mail.actors[who.id]);
  const open = useStore((s) => s.mail.open);
  const live = liveState(who, actor, open, streaming);
  return (
    <div className="cp-head">
      {sub ? (
        <button className="cp-back" onClick={() => set({ chatSub: null })} title="Back to the thread (Esc)">
          ‹ {who.name}
        </button>
      ) : (
        <i className={`cp-av lg ${live.kind}`} style={{ background: avatarColor(who.id) }} aria-hidden>{who.name[0]}</i>
      )}
      <div className="cp-head-main">
        <h2>{sub ? sub.title : who.name}</h2>
        <div className="sub">
          {sub ? (
            <>assigned to {sub.assignee?.name ?? 'a teammate'}</>
          ) : (
            <>
              {isPo(who) ? 'Product owner' : PROVIDERS[who.provider].label} · <span className={`cp-live-state ${live.kind}`}>{live.text}</span>
            </>
          )}
        </div>
      </div>
      <button className={`link cp-details-btn ${details ? 'on' : ''}`} aria-pressed={details} onClick={() => set({ chatDetails: !details })}>
        {details ? 'Back to chat' : 'Details'}
      </button>
      <button className="x" title="Close (Esc)" onClick={() => set({ selectedId: null })}>
        ×
      </button>
    </div>
  );
}

// Everything about the person except the conversation: settings, the current task, the tool log, firing.
function Details({ e }: { e: Employee }) {
  const block = useStore((s) => s.company?.blocks.find((b) => b.id === e.blockId));
  const logs = useStore((s) => s.logs[e.id]);
  const catalogs = useStore((s) => s.catalogs);
  const now = useNow(1000);
  const [confirm, setConfirm] = useState(false);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    setConfirm(false);
    setShowLog(false);
  }, [e.id]);
  const p = PROVIDERS[e.provider];
  const catalog = catalogs?.[e.provider];
  const s = e.status;

  return (
    <div className="cp-details">
      <div className="facts">
        <span className={`pill ${s.kind}`}>{STATUS_LABEL[s.kind]}</span>
        <span>
          <i className="pdot" style={{ background: p.color }} /> {p.label} · {block?.name ?? 'No block'} · desk {e.desk + 1}
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
    </div>
  );
}
