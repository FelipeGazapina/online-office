import { useEffect, useState } from 'react';
import { headcountCap, MAX_LEVEL, PROVIDERS, XP_FOR_LEVEL, type BlockId, type Employee } from '../../../shared/protocol.ts';
import type { VoiceQuality } from '../../../shared/voice.ts';
import { openChat, send, set, setSetting, useStore, waitingQueue, type CameraMode, type Lang, type MicMode } from '../store.ts';
import { fmtWait, tailPath, useNow } from './hooks.ts';
import { UpdateSetting } from './UpdateControl.tsx';
import { setVoicesMuted } from '../audio.ts';
import { resetHudLayout } from './ResizableHud.tsx';
import { openBoard } from './tasks/actions.ts';
import { ProviderConnections } from './tasks/Providers.tsx';

const URGENT_MS = 2 * 60 * 1000;

function statusClass(e: Employee) {
  return { idle: 'idle', working: 'working', blocked_on_owner: 'blocked', error: 'error' }[e.status.kind];
}

export function CompanyPanel({ allowOverLimit = false }: { allowOverLimit?: boolean }) {
  const company = useStore((s) => s.company);
  const boards = useStore((s) => s.boards);
  const tasks = useStore((s) => s.tasks);
  const taskCount = (blockId: BlockId) => {
    const mine = new Set(boards.filter((board) => board.blockId === blockId).map((board) => board.id));
    return tasks.filter((task) => mine.has(task.boardId)).length;
  };
  const [removing, setRemoving] = useState<BlockId | null>(null);
  if (!company) return <div className="panel company skeleton">Opening the office</div>;

  const lvl = company.level;
  const base = XP_FOR_LEVEL[lvl];
  const next = lvl >= MAX_LEVEL ? null : XP_FOR_LEVEL[lvl + 1];
  const pct = next === null ? 1 : Math.max(0, Math.min(1, (company.xp - base) / (next - base)));
  const cap = headcountCap(lvl);
  const full = company.employees.length >= cap;
  const unlimited = !Number.isFinite(cap);
  const noBlocks = company.blocks.length === 0;

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
          <b>{company.employees.length}</b>/{unlimited ? '∞' : cap} seats
        </span>
        <button
          className="btn primary"
          disabled={(full && !allowOverLimit) || noBlocks}
          title={full && allowOverLimit ? 'Configuration can add an agent beyond the current level limit' : full ? 'Earn XP to level up and open another seat' : noBlocks ? 'Add a project block first' : unlimited ? 'Max level has no headcount limit' : ''}
          onClick={() => set({ modal: { kind: 'hire', ...(allowOverLimit && { bypassLimit: true }) } })}
        >
          Hire
        </button>
      </div>

      {allowOverLimit && full && <p className="muted config-note">Configuration mode can add agents beyond the level seat limit.</p>}
      <div className="blocks-head">
        <h2>Blocks</h2>
        <button className="btn ghost" onClick={() => set({ modal: { kind: 'block' } })}>
          New block
        </button>
      </div>
      {noBlocks && (
        <div className="first-run">
          <b>Add your first project block</b>
          <p>A block is a project folder. Pick one, then hire someone to work in it.</p>
          <button className="btn primary" onClick={() => set({ modal: { kind: 'block' } })}>
            Choose a folder
          </button>
        </div>
      )}
      <ul className="blocks">
        {company.blocks.map((b) => {
          const headcount = company.employees.filter((e) => e.blockId === b.id).length;
          return (
          <li key={b.id}>
            <div className="b-name">
              <i className="swatch" style={{ background: b.color }} />
              <b>{b.name}</b>
              <button className="link reveal" title="Show this folder in Finder" onClick={() => window.office.revealFolder(b.cwd)}>
                Reveal
              </button>
              <button
                className={`link remove ${removing === b.id ? 'armed' : ''}`}
                title="Remove this block from the office. The folder stays on disk."
                onClick={() => {
                  if (removing !== b.id) return setRemoving(b.id);
                  send({ type: 'remove_block', blockId: b.id });
                  setRemoving(null);
                }}
                onBlur={() => setRemoving(null)}
              >
                {removing !== b.id ? 'Remove' : headcount ? `Fire ${headcount} and remove?` : 'Really remove?'}
              </button>
            </div>
            <div className="b-cwd" title={b.cwd}>
              {tailPath(b.cwd, 34)}
            </div>
            <button className="link github-link" onClick={() => set({ modal: { kind: b.githubRepo ? 'github' : 'github_setup', blockId: b.id } })}>
              {b.githubRepo ? 'GitHub board' : 'Connect GitHub'}
            </button>
            <button className="link github-link" data-testid="block-tasks" onClick={() => openBoard(b.id)}>
              Task boards · {taskCount(b.id)}
            </button>
            <div className="b-people">
              {company.employees
                .filter((e) => e.blockId === b.id)
                .map((e) => (
                  <button key={e.id} className={`person ${statusClass(e)}`} onClick={() => openChat(e.id)}>
                    <i className="sdot" />
                    {e.name}{(e.role ?? 'employee') === 'orchestrator' && <small>PO</small>}
                  </button>
                ))}
            </div>
          </li>
          );
        })}
      </ul>
    </div>
  );
}

export function TaskBoardsPanel() {
  const company = useStore((s) => s.company);
  const [blockId, setBlockId] = useState('');
  const [linearUrl, setLinearUrl] = useState('');
  useEffect(() => {
    if (!company || company.blocks.some((candidate) => candidate.id === blockId)) return;
    const block = company.blocks[0];
    if (block) {
      setBlockId(block.id);
      setLinearUrl(block.linearBoardUrl ?? '');
    }
  }, [company, blockId]);
  if (!company) return null;
  const block = company.blocks.find((candidate) => candidate.id === blockId) ?? company.blocks[0];
  if (!block) return <div className="task-config-empty">Add a project block before configuring a task board.</div>;
  return (
    <div className="task-config">
      <div className="task-config-head"><div><span className="task-config-kicker">Task boards</span><h2>Linear and CronoSpark</h2><p className="muted">Connect your accounts here. Each board picks its own sources from the board itself, so open a block's boards to choose what lands on them.</p></div><label className="task-block-picker"><span>Project block</span><select value={block.id} onChange={(event) => { const next = company.blocks.find((candidate) => candidate.id === event.target.value); setBlockId(event.target.value); setLinearUrl(next?.linearBoardUrl ?? ''); }}>{company.blocks.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label></div>
      <div className="task-config-open"><button className="btn primary" onClick={() => openBoard(block.id)}>Open {block.name} task boards</button></div>
      <ProviderConnections />
      <form className="task-credentials linear-board-config" onSubmit={(event) => { event.preventDefault(); if (linearUrl.trim()) send({ type: 'configure_linear_board', blockId: block.id, url: linearUrl.trim() }); }}><div><b>Separate Linear board</b><p className="muted">Shows the full signed-in Linear board in its own 3D board. It does not create or copy tickets into the app task board.</p></div><label><span>Linear board URL</span><input type="url" value={linearUrl} onChange={(event) => setLinearUrl(event.target.value)} placeholder="https://linear.app/acme/team/ENG/active" /></label><button className="btn primary" type="submit" disabled={!/^https?:\/\/(www\.)?linear\.app\//i.test(linearUrl.trim())}>Save Linear board</button></form>
      <p className="muted task-config-note">Linear OAuth is the same remote MCP connection other MCP clients use.</p>
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
  return (
    <div className="panel settings">
      <label>Camera</label>
      <Seg<CameraMode>
        value={s.camera}
        options={[['iso', '2 Top down']]}
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
      <label>My mic</label>
      <Seg<'on' | 'muted'>
        value={s.micMuted ? 'muted' : 'on'}
        options={[
          ['on', 'On'],
          ['muted', 'Muted'],
        ]}
        onChange={(v) => setSetting('micMuted', v === 'muted')}
      />
      <label>Employees' voices</label>
      <Seg<'on' | 'muted'>
        value={s.voicesMuted ? 'muted' : 'on'}
        options={[
          ['on', 'On'],
          ['muted', 'Muted'],
        ]}
        onChange={(v) => setVoicesMuted(v === 'muted')}
      />
      <label>Language</label>
      <Seg<Lang>
        value={s.lang}
        options={[
          ['en-US', 'English'],
          ['pt-BR', 'Português'],
          ['auto', 'Auto'],
        ]}
        onChange={(v) => setSetting('lang', v)}
      />
      <label>Voice</label>
      <Seg<VoiceQuality>
        value={s.voiceQuality}
        options={[
          ['fast', 'Fast'],
          ['accurate', 'Accurate'],
        ]}
        onChange={(v) => setSetting('voiceQuality', v)}
      />
      <UpdateSetting />
    </div>
  );
}

// The take-a-number board. The single loud element in the HUD, on purpose.
export function WaitingMeter() {
  const company = useStore((s) => s.company);
  const meetingDoor = useStore((s) => s.meetingDoor);
  const now = useNow(1000);
  const queue = meetingDoor === 'open' ? waitingQueue(company) : [];
  const waits = queue.map((e) => (e.status.kind === 'blocked_on_owner' ? now - e.status.question.askedAt : 0));
  const longest = Math.max(0, ...waits);
  const urgent = longest > URGENT_MS;

  return (
    <>
      <div className={`vignette ${urgent ? 'urgent' : ''}`} />
      <div data-hud-resize-target="waiting-meter" className={`waiting ${queue.length ? 'some' : 'none'} ${urgent ? 'urgent' : ''} ${meetingDoor === 'closed' ? 'door-closed' : ''} oo:flex oo:flex-col oo:items-center oo:gap-1`}>
        <div className="ticket oo:flex oo:items-center oo:gap-2 oo:rounded-xl oo:border oo:border-hud-border oo:bg-hud-surface/95 oo:px-2 oo:py-1.5 oo:text-hud-text oo:shadow-2xl">
          <span className="num oo:min-w-10 oo:rounded-lg oo:bg-hud-card oo:px-2 oo:py-1 oo:font-hud-display oo:text-3xl oo:text-hud-warm">{queue.length}</span>
          <span className="lab oo:font-hud-display oo:text-sm">
            {meetingDoor === 'closed' ? 'Meeting room door closed' : queue.length === 0 ? 'Nobody waiting on you' : queue.length === 1 ? 'person waiting on you' : 'people waiting on you'}
            {queue.length > 0 && <em className="oo:text-hud-muted">longest {fmtWait(longest)}</em>}
          </span>
        </div>
        {queue.length > 0 && (
          <div className="chips oo:flex oo:flex-wrap oo:items-center oo:justify-center oo:gap-1">
            {queue.map((e, i) => (
              <button key={e.id} className={`${waits[i] > URGENT_MS ? 'late' : ''} oo:inline-flex oo:items-center oo:gap-1 oo:rounded-full oo:border oo:border-hud-border oo:bg-hud-card/90 oo:px-2 oo:py-0.5 oo:text-xs oo:font-semibold oo:text-hud-text oo:shadow-lg oo:transition-colors oo:duration-150 oo:hover:border-hud-accent oo:hover:bg-hud-surface`} onClick={() => openChat(e.id)}>
                <i style={{ background: PROVIDERS[e.provider].color }} />
                {e.name}
                <span className="oo:text-hud-muted">{fmtWait(waits[i])}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" data-hud-resize-target="toasts">
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

export function ComputerPrompt() {
  const near = useStore((s) => s.nearComputer);
  const nearTaskBoard = useStore((s) => s.nearTaskBoard);
  const seated = useStore((s) => s.computerState === 'seated');
  if (nearTaskBoard && !seated) return <div className="computer-prompt" data-hud-resize-target="computer-prompt"><kbd>F</kbd><span>open the task board</span></div>;
  if (!near || seated) return null;
  return <div className="computer-prompt" data-hud-resize-target="computer-prompt"><kbd>F</kbd><span>sit at your computer</span></div>;
}

const KEYS: [string, string][] = [
  ['W A S D / arrows', 'Walk, relative to the camera. Cancels a click walk'],
  ['Shift', 'Run'],
  ['Q / E', 'Turn the camera (90 degree steps in overview)'],
  ['Drag / wheel', 'Turn and zoom the top-down camera'],
  ['2', 'Top-down camera'],
  ['Enter', 'Type to the nearest employee, or whoever is asking'],
  ['Hold V', 'Push to talk (when the mic is set to Hold V)'],
  ['Click an employee', 'Open a menu: chat, or walk to them'],
  ['Click the floor', 'Walk there (overview camera)'],
  ['F near a board', 'Open the task board or project computer'],
  ['Click the whiteboard', 'Open the diagram large'],
  ['B', 'Build mode: move furniture and whole blocks. Works in first person too'],
  ['Esc', 'Close whatever is open'],
  ['H', 'This help'],
];

export function HelpOverlay() {
  const open = useStore((s) => s.helpOpen);
  if (!open) return null;
  return (
    <div className="scrim" onClick={() => set({ helpOpen: false })}>
      <div className="modal help" data-hud-resize-target="help-overlay" onClick={(e) => e.stopPropagation()}>
        <h2 className="hud-help-title">
          Keys
          <button type="button" className="hud-reset-layout" title="Move every panel back and reset its size" onClick={resetHudLayout}>Reset HUD layout</button>
        </h2>
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
