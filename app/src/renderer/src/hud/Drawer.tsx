import { useEffect, useRef, useState } from 'react';
import { DESKS_PER_BLOCK, PROVIDERS } from '../../../shared/protocol.ts';
import { send, set, useStore } from '../store.ts';
import { fmtWait, useNow } from './hooks.ts';

const STATUS_LABEL = { idle: 'Idle', working: 'Working', blocked_on_owner: 'Waiting on you', error: 'Error' } as const;
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export function Drawer() {
  const id = useStore((s) => s.selectedId);
  const e = useStore((s) => s.company?.employees.find((x) => x.id === id));
  const block = useStore((s) => s.company?.blocks.find((b) => b.id === e?.blockId));
  const logs = useStore((s) => (id ? s.logs[id] : undefined));
  const now = useNow(1000);
  const [task, setTask] = useState('');
  const [confirm, setConfirm] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [logs?.length, id]);
  useEffect(() => setConfirm(false), [id]);

  if (!e) return null;
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

      <section className="grow">
        <h3>Live log</h3>
        <div className="log">
          {(logs ?? []).length === 0 && <p className="muted">Nothing yet.</p>}
          {logs?.map((l, i) => (
            <div key={i} className={l.line.startsWith('says:') ? 'say' : ''}>
              <time>{time(l.at)}</time>
              <span>{l.line}</span>
            </div>
          ))}
          <div ref={end} />
        </div>
      </section>

      <form
        className="assign"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!task.trim()) return;
          send({ type: 'assign', employeeId: e.id, task: task.trim() });
          setTask('');
        }}
      >
        <input value={task} onChange={(ev) => setTask(ev.target.value)} placeholder={`Give ${e.name} a task`} />
        <button className="btn ink" disabled={!task.trim()}>
          Assign
        </button>
      </form>

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
