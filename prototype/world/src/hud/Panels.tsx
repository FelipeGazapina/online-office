import { headcountCap, MAX_LEVEL, PROVIDERS, XP_FOR_LEVEL, type Employee } from '../../../shared/protocol.ts';
import { set, setSetting, useStore, waitingQueue, type CameraMode, type Lang, type MicMode } from '../store.ts';
import { fmtWait, useNow } from './hooks.ts';

const URGENT_MS = 2 * 60 * 1000;

function statusClass(e: Employee) {
  return { idle: 'idle', working: 'working', blocked_on_owner: 'blocked', error: 'error' }[e.status.kind];
}

export function CompanyPanel() {
  const company = useStore((s) => s.company);
  if (!company) return <div className="panel company skeleton">Waiting for the bridge</div>;

  const lvl = company.level;
  const base = XP_FOR_LEVEL[lvl];
  const next = lvl >= MAX_LEVEL ? null : XP_FOR_LEVEL[lvl + 1];
  const pct = next === null ? 1 : Math.max(0, Math.min(1, (company.xp - base) / (next - base)));
  const cap = headcountCap(lvl);
  const full = company.employees.length >= cap;

  return (
    <div className="panel company">
      <div className="co-head">
        <h1>{company.name}</h1>
        <span className="lvl">Level {lvl}</span>
      </div>
      <div className="xp" title={next === null ? 'Max level' : `${company.xp} of ${next} XP to level ${lvl + 1}`}>
        <div className="xp-bar">
          <i style={{ width: `${pct * 100}%` }} />
        </div>
        <span>{next === null ? 'Max level' : `${company.xp} / ${next} XP`}</span>
      </div>
      <div className="co-row">
        <span className="seats">
          <b>{company.employees.length}</b>/{cap} seats
        </span>
        <button className="btn primary" disabled={full} title={full ? 'Earn XP to level up and open another seat' : ''} onClick={() => set({ modal: { kind: 'hire' } })}>
          Hire
        </button>
      </div>

      <div className="blocks-head">
        <h2>Blocks</h2>
        <button className="btn ghost" onClick={() => set({ modal: { kind: 'block' } })}>
          New block
        </button>
      </div>
      <ul className="blocks">
        {company.blocks.map((b) => (
          <li key={b.id}>
            <div className="b-name">
              <i className="swatch" style={{ background: b.color }} />
              <b>{b.name}</b>
            </div>
            <div className="b-cwd" title={b.cwd}>
              {b.cwd.length > 34 ? `…${b.cwd.slice(-33)}` : b.cwd}
            </div>
            <div className="b-people">
              {company.employees
                .filter((e) => e.blockId === b.id)
                .map((e) => (
                  <button key={e.id} className={`person ${statusClass(e)}`} onClick={() => set({ selectedId: e.id })}>
                    <i className="sdot" />
                    {e.name}
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPanel() {
  const s = useStore();
  const conn = s.demo ? 'demo' : s.conn;
  const label = { open: 'Bridge live', connecting: 'Connecting', offline: 'Bridge offline', demo: 'Demo data' }[conn];
  return (
    <div className="panel settings">
      <div className={`conn ${conn}`}>
        <i />
        {label}
      </div>
      <label>Camera</label>
      <Seg<CameraMode>
        value={s.camera}
        options={[
          ['follow', '1 Follow'],
          ['iso', '2 Overview'],
          ['first', '3 First person'],
        ]}
        onChange={(v) => setSetting('camera', v)}
      />
      <label>Interrupt</label>
      <Seg
        value={s.interrupt}
        options={[
          ['next', 'Tap on shoulder'],
          ['now', 'Hard stop'],
        ]}
        onChange={(v) => setSetting('interrupt', v)}
      />
      <label>Microphone</label>
      <Seg<MicMode>
        value={s.mic}
        options={[
          ['proximity', 'Proximity'],
          ['push', 'Hold V'],
        ]}
        onChange={(v) => setSetting('mic', v)}
      />
      <label>Language</label>
      <Seg<Lang>
        value={s.lang}
        options={[
          ['en-US', 'English'],
          ['pt-BR', 'Português'],
        ]}
        onChange={(v) => setSetting('lang', v)}
      />
    </div>
  );
}

// The take-a-number board. The single loud element in the HUD, on purpose.
export function WaitingMeter() {
  const company = useStore((s) => s.company);
  const now = useNow(1000);
  const queue = waitingQueue(company);
  const waits = queue.map((e) => (e.status.kind === 'blocked_on_owner' ? now - e.status.question.askedAt : 0));
  const longest = Math.max(0, ...waits);
  const urgent = longest > URGENT_MS;

  return (
    <>
      <div className={`vignette ${urgent ? 'urgent' : ''}`} />
      <div className={`waiting ${queue.length ? 'some' : 'none'} ${urgent ? 'urgent' : ''}`}>
        <div className="ticket">
          <span className="num">{queue.length}</span>
          <span className="lab">
            {queue.length === 0 ? 'Nobody waiting on you' : queue.length === 1 ? 'person waiting on you' : 'people waiting on you'}
            {queue.length > 0 && <em>longest {fmtWait(longest)}</em>}
          </span>
        </div>
        {queue.length > 0 && (
          <div className="chips">
            {queue.map((e, i) => (
              <button key={e.id} className={waits[i] > URGENT_MS ? 'late' : ''} onClick={() => set({ selectedId: e.id })}>
                <i style={{ background: PROVIDERS[e.provider].color }} />
                {e.name}
                <span>{fmtWait(waits[i])}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const isDown = (s: { conn: string; demo: boolean }) => s.conn !== 'open' && !s.demo;

export function OfflineScrim() {
  return useStore(isDown) ? <div className="down-scrim" /> : null;
}

export function OfflineCard() {
  const { conn, retryAt } = useStore();
  const down = useStore(isDown);
  const now = useNow(500);
  if (!down) return null;
  const secs = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  return (
    <div className="down-wrap">
      <div className="offline-card">
        <h2>{conn === 'connecting' ? 'Connecting to the bridge' : 'Bridge offline'}</h2>
        <p>
          The office is empty until the bridge is up. Start it with <code>pnpm bridge</code>.
          {conn === 'offline' && <> Retrying {secs > 0 ? `in ${secs}s` : 'now'}.</>}
        </p>
        <button className="btn ghost" onClick={() => (location.search = '?demo=1')}>
          Preview with demo data
        </button>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const note = useStore((s) => s.voice.note);
  return (
    <div className="toasts">
      {note && <div className="toast warn">{note}</div>}
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
      <button className="hint" onClick={() => set((s) => ({ helpOpen: !s.helpOpen }))}>
        <kbd>H</kbd> keys
      </button>
    </div>
  );
}

const KEYS: [string, string][] = [
  ['W A S D / arrows', 'Walk, relative to the camera'],
  ['Shift', 'Run'],
  ['Q / E', 'Turn the camera (90 degree steps in overview)'],
  ['Drag / wheel', 'Orbit and zoom (follow), look (first person), zoom (overview)'],
  ['1 / 2 / 3', 'Follow, overview, first person'],
  ['Enter', 'Type to the nearest employee, or whoever is asking'],
  ['Hold V', 'Push to talk (when the mic is set to Hold V)'],
  ['Click an employee', 'Open their drawer'],
  ['Click the whiteboard', 'Open the diagram large'],
  ['Esc', 'Close whatever is open'],
  ['H', 'This help'],
];

export function HelpOverlay() {
  const open = useStore((s) => s.helpOpen);
  if (!open) return null;
  return (
    <div className="scrim" onClick={() => set({ helpOpen: false })}>
      <div className="modal help" onClick={(e) => e.stopPropagation()}>
        <h2>Keys</h2>
        <dl>
          {KEYS.map(([k, d]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
        <p className="muted">Walk within 1.5 m of someone and just talk. What you say depends on what they are doing: answer, new task, or interruption.</p>
      </div>
    </div>
  );
}
