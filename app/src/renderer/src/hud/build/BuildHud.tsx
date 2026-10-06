import { useEffect, useRef } from 'react';
import { ITEM_DEFS } from '../../../../shared/space/index.ts';
import { get, useStore, type BuildTool } from '../../store.ts';
import { addFloor, chooseEntry, exitBuild, isActive, patchBuild, peek, redo, rotate, selectTab, setLevel, undo } from './actions.ts';
import { footprintText, TABS, visibleEntries, type Entry } from './catalog.ts';
import { FloorIcon, Redo, Search, TabIcon, ToolIcon, Turn, Undo, WALL_MODES, WallsIcon } from './icons.tsx';
import { useThumbs } from './thumbs.ts';
import './build.css';

const HINTS: Record<BuildTool['kind'], (t: BuildTool) => string[][]> = {
  select: () => [['Click', 'pick up furniture'], ['E', 'copy it'], ['Delete', 'remove it']],
  wall: () => [['Drag', 'draw a wall'], ['Ctrl-drag', 'delete walls']],
  room: () => [['Drag', 'draw a room'], ['Ctrl-drag', 'delete its walls'], ['Shift', 'wall tool']],
  floor: () => [['Click or drag', 'paint'], ['Shift', 'fill the room']],
  wallpaint: () => [['Click', 'paint a wall'], ['Shift', 'paint the room']],
  opening: (t) => [['Click', `put a ${t.kind === 'opening' ? t.open : ''} on a wall`]],
  item: (t) => (t.kind === 'item' && t.carry ? [['Click', 'drop it here'], [', .', 'turn'], ['Delete', 'remove']] : [['Click', 'place'], [', .', 'turn'], ['Esc', 'stop']]),
};

function TopBar() {
  return (
    <div className="bh-top" role="toolbar" aria-label="Build mode">
      <span className="bh-title">Build</span>
      <span className="bh-sep" />
      <button className="bh-ico" onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo /></button>
      <button className="bh-ico" onClick={redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Redo /></button>
      <span className="bh-sep" />
      <button className="bh-done" onClick={exitBuild} title="Back to the office (B)">Done <kbd>B</kbd></button>
    </div>
  );
}

function Levels() {
  const level = useStore((s) => s.build?.level ?? 0);
  const count = useStore((s) => s.building?.stories.length ?? 1);
  const mode = useStore((s) => s.build?.wallsMode ?? 'cutaway');
  return (
    <div className="bh-levels">
      <div className="bh-floors" role="tablist" aria-label="Floors" data-testid="build-level">
        {Array.from({ length: count }, (_, i) => count - 1 - i).map((i) => (
          <button key={i} role="tab" className="bh-floor-tab" data-floor={i} aria-selected={level === i} onClick={() => setLevel(i)} title={`Floor ${i + 1} (Page ${i > level ? 'Up' : 'Down'})`}>
            <FloorIcon />
            Floor {i + 1}
          </button>
        ))}
      </div>
      <button className="bh-add" onClick={addFloor} disabled={count >= 4}><i aria-hidden="true">+</i> Add floor</button>
      <div className="bh-walls" role="group" aria-label="Walls">
        {WALL_MODES.map((m) => (
          <button key={m.mode} className="bh-ico" aria-pressed={mode === m.mode} title={m.label} aria-label={m.label} onClick={() => patchBuild({ wallsMode: m.mode })}>
            <WallsIcon mode={m.mode} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Card({ entry, thumb, search }: { entry: Entry; thumb: string | undefined; search: boolean }) {
  const active = useStore((s) => (s.build ? isActive(entry, s.build) : false));
  const tab = TABS.find((t) => t.id === entry.tab)?.label ?? '';
  const swatch = entry.kind === 'floor' || entry.kind === 'style';
  const item = entry.kind === 'item';
  return (
    <button
      className={`bh-card${swatch ? ' bh-swatch' : ''}`}
      aria-pressed={active}
      onClick={() => chooseEntry(entry)}
      onPointerEnter={() => item && peek(entry.def)}
      onPointerLeave={() => item && peek(null)}
      title={entry.name}
      data-entry={entry.id}
    >
      <span className="bh-thumb">
        {entry.kind === 'item' && (thumb ? <img src={thumb} alt="" draggable={false} /> : <i className="bh-thumb-wait" />)}
        {entry.kind === 'tool' && <ToolIcon icon={entry.icon} />}
        {swatch && (
          <i className={`bh-chip${entry.kind === 'floor' && entry.paint === 0 ? ' none' : ''}`} style={{ background: entry.color }} />
        )}
        {entry.kind === 'item' && <span className="bh-badge" data-testid="footprint-badge">{footprintText(entry.def)}</span>}
      </span>
      <span className="bh-name">{entry.name}</span>
      {search && <span className="bh-sub">{tab}</span>}
    </button>
  );
}

function TeamPick() {
  const tool = useStore((s) => s.build?.tool);
  const blocks = useStore((s) => s.company?.blocks);
  if (tool?.kind !== 'item' || !ITEM_DEFS[tool.def] || !blocks?.length) return null;
  const teamed = tool.blockId !== null || ['bench_desk', 'po_desk'].includes(tool.def);
  if (!teamed) return null;
  return (
    <label className="bh-team">
      <span>Seat for</span>
      <i style={{ background: blocks.find((b) => b.id === tool.blockId)?.color ?? '#999' }} />
      <select
        aria-label="Team the desk belongs to"
        value={tool.blockId ?? ''}
        onChange={(e) => {
          const t = get().build?.tool;
          if (t?.kind === 'item') patchBuild({ tool: { ...t, blockId: e.target.value } });
        }}
      >
        {blocks.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
    </label>
  );
}

function Dock() {
  const tab = useStore((s) => s.build?.tab ?? 'desks');
  const search = useStore((s) => s.build?.search ?? '');
  const searching = useStore((s) => s.build?.searching ?? false);
  const tool = useStore((s) => s.build?.tool ?? { kind: 'select' as const });
  const thumbs = useThumbs();
  const entries = visibleEntries(tab as never, search, searching);
  const listing = searching || !!search.trim();
  const hint = HINTS[tool.kind](tool);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="bh-dock" data-testid="build-catalog">
      <div className="bh-hint" aria-live="polite">
        {hint.map(([k, v]) => (
          <span key={k}><kbd>{k}</kbd> {v}</span>
        ))}
        <TeamPick />
        {tool.kind === 'item' && ITEM_DEFS[tool.def]?.kind !== 'stairs' && (
          <button type="button" className="bh-turn" data-testid="rotate-handle" onClick={() => rotate(1)} title="Turn it a quarter (. key)" aria-label="Turn it">
            <Turn /> Turn
          </button>
        )}
      </div>
      <div className="bh-panel">
        <div className="bh-head">
          <label className="bh-search">
            <Search />
            <input ref={input} value={search} onChange={(e) => patchBuild({ search: e.target.value })} onFocus={() => patchBuild({ searching: true })} onBlur={() => patchBuild({ searching: false })} placeholder="Search catalog" aria-label="Search the catalog" spellCheck={false} />
            {search && <button type="button" className="bh-clear" onClick={() => { patchBuild({ search: '' }); input.current?.focus(); }} aria-label="Clear search">×</button>}
          </label>
          <div className="bh-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" data-tab={t.id} aria-selected={!listing && tab === t.id} className="bh-tab" onClick={() => selectTab(t.id)} title={t.label}>
                <TabIcon tab={t.id} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="bh-strip" onMouseDown={(e) => searching && e.preventDefault()}>
          {entries.length === 0 ? (
            <p className="bh-empty">Nothing called “{search.trim()}”. Try desk, plant or window.</p>
          ) : (
            entries.map((e) => <Card key={e.id} entry={e} thumb={e.kind === 'item' ? thumbs.get(e.def) : undefined} search={listing} />)
          )}
        </div>
      </div>
    </div>
  );
}

function Readout() {
  const r = useStore((s) => s.buildCursor.readout);
  if (!r) return null;
  return (
    <div className={`bh-readout${r.bad ? ' bad' : ''}${r.anchored ? ' anchored' : ''}`} style={r.anchored ? { left: r.x, top: r.y } : { left: r.x + 18, top: r.y + 20 }} data-testid="build-readout">
      {r.text}
    </div>
  );
}

export function BuildHud() {
  const on = useStore((s) => !!s.build);
  useEffect(() => {
    if (on) document.documentElement.dataset.building = '1';
    return () => void delete document.documentElement.dataset.building;
  }, [on]);
  if (!on) return null;
  return (
    <>
      <TopBar />
      <Levels />
      <Dock />
      <Readout />
    </>
  );
}
