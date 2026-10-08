import { useEffect, useMemo, useRef, useState } from 'react';
import type { Company } from '../../../../shared/protocol.ts';
import { ITEM_DEFS, missingEssentials, placementOf, type Missing } from '../../../../shared/space/index.ts';
import { get, useStore, type BuildTool } from '../../store.ts';
import { addFloor, canTurn, chooseEntry, clearBuild, discardBuild, enterBuild, isActive, saveBuild, patchBuild, peek, redo, rotate, selectTab, setLevel, setTool, stepBack, undo } from './actions.ts';
import { ENTRIES, footprintText, TABS, visibleEntries, type Entry } from './catalog.ts';
import { BlockIcon, BuildIcon, FillIcon, FloorIcon, PieceIcon, Redo, Search, TabIcon, ToolIcon, Turn, Undo, WALL_MODES, WallsIcon } from './icons.tsx';
import { consequences, keepBlock, removal, removeBlock } from './removal.ts';
import { spaceContext } from './state.ts';
import { floorSwatch, wallSwatch } from './swatches.ts';
import { useThumbs } from './thumbs.ts';
import './build.css';

// A key, what it does, and `danger` for the one that destroys something. Esc puts a piece back; only Delete deletes it.
type Hint = [key: string, does: string, danger?: true];
const HINTS: Record<BuildTool['kind'], (t: BuildTool) => Hint[]> = {
  select: () => [['Click or drag', 'move furniture'], ['Shift-click', 'move its whole block'], ['E', 'copy it'], ['Delete', 'delete the piece under the pointer', true]],
  block: (t) => (t.kind === 'block' && t.carry ? [['Click', 'drop the block here'], [', .', 'turn'], ['PgUp PgDn', 'change floor'], ['Esc', 'put it back'], ['Delete', 'remove the block and its people', true]] : [['Click or drag', 'pick up a block'], ['Esc', 'back to furniture']]),
  wall: () => [['Drag', 'draw a wall'], ['Ctrl-drag', 'delete walls']],
  room: () => [['Drag', 'draw a room'], ['Ctrl-drag', 'delete its walls'], ['Shift', 'wall tool']],
  floor: () => [['Click or drag', 'paint'], ['Shift', 'fill the room']],
  wallpaint: () => [['Click', 'paint a wall'], ['Shift', 'paint the room']],
  opening: (t) => [['Click', `put a ${t.kind === 'opening' ? t.open : ''} on a wall`]],
  item: (t) => (t.kind === 'item' && t.carry ? [['Click', 'drop it here'], [', .', 'turn'], ['Esc', 'put it back'], ['Delete', 'delete the piece', true]] : [['Click', 'place'], [', .', 'turn'], ['Esc', 'stop']]),
};

function Mover() {
  // Neither switch lights while a wall, floor or catalog tool is in hand: they say what a click on a placed piece picks up.
  const mode = useStore((s) => {
    const t = s.build?.tool;
    return t?.kind === 'block' ? 'block' : t?.kind === 'select' || (t?.kind === 'item' && t.carry) ? 'piece' : null;
  });
  return (
    <div className="bh-mover" role="group" aria-label="What a click picks up">
      <button className="bh-mode" aria-pressed={mode === 'piece'} onClick={(e) => { setTool({ kind: 'select' }); e.currentTarget.blur(); }} title="Pick up one piece of furniture" data-testid="mode-piece">
        <PieceIcon /> Furniture
      </button>
      <button className="bh-mode" aria-pressed={mode === 'block'} onClick={(e) => { setTool({ kind: 'block', carry: null }); e.currentTarget.blur(); }} title="Pick up a whole block, desks and board together (Shift-click does the same)" data-testid="mode-block">
        <BlockIcon /> Block
      </button>
    </div>
  );
}

function TopBar() {
  return (
    <div className="bh-top" role="toolbar" aria-label="Build mode">
      <span className="bh-title">Build</span>
      <span className="bh-sep" />
      <Mover />
      <span className="bh-sep" />
      <button className="bh-ico" onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo /></button>
      <button className="bh-ico" onClick={redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Redo /></button>
      <span className="bh-sep" />
      <ClearAll />
      <button className="bh-discard" onClick={discardBuild} title="Leave without keeping the changes" data-testid="build-discard">Discard</button>
      <button className="bh-done" onClick={saveBuild} title="Keep the changes and go back to the office (B)" data-testid="build-save">Save <kbd>B</kbd></button>
    </div>
  );
}

// A second click within a few seconds clears, so one stray click never empties the office.
function ClearAll() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`bh-discard danger${armed ? ' armed' : ''}`}
      onClick={(e) => {
        e.currentTarget.blur();
        if (!armed) return setArmed(true);
        setArmed(false);
        clearBuild();
      }}
      title="Take everything out and start from an empty lot. Discard still brings it all back"
      data-testid="build-clear"
    >
      {armed ? 'Really clear everything?' : 'Clear all'}
    </button>
  );
}

type Row = { key: string; label: string; ok: boolean; detail?: string };

const DESK_NAME = { po_desk: 'PO desk', bench_desk: 'team desk' } as const;
const TEAM_ITEM_NAME = { whiteboard: 'Team whiteboard', board_terminal: 'Board computer' } as const;

function essentialRows(company: Company | null, missing: readonly Missing[]): Row[] {
  const find = <K extends Missing['kind']>(kind: K) => missing.filter((m): m is Extract<Missing, { kind: K }> => m.kind === kind);
  const ownerFar = find('owner_desk_unreachable').length > 0;
  const far = find('desks_unreachable')[0];
  const rows: Row[] = [
    { key: 'entrance', label: 'A door in the outer wall', ok: !find('entrance').length },
    { key: 'owner', label: 'Your desk', ok: !find('owner_desk').length && !ownerFar, detail: ownerFar ? 'No way to walk to it from the door' : undefined },
  ];
  for (const b of company?.blocks ?? []) {
    const short = find('desks').filter((m) => m.blockId === b.id);
    rows.push({
      key: `${b.id}:desks`,
      label: `${b.name}: a desk for each person`,
      ok: !short.length,
      detail: short.length ? `Needs ${short.map((m) => `${m.count} more ${DESK_NAME[m.desk]}${m.count === 1 ? '' : 's'}`).join(' and ')}` : undefined,
    });
    for (const def of ['whiteboard', 'board_terminal'] as const) {
      rows.push({ key: `${b.id}:${def}`, label: `${b.name}: ${TEAM_ITEM_NAME[def]}`, ok: !find('team_item').some((m) => m.blockId === b.id && m.def === def) });
    }
  }
  rows.push({ key: 'reach', label: 'Every desk within reach of the door', ok: !far, detail: far ? `${far.ids.length} desk${far.ids.length === 1 ? ' is' : 's are'} walled off` : undefined });
  return rows;
}

// What the office needs before it can be saved, ticked off live as it is built. A complete office folds it to one line so
// it does not cover the lot.
function Essentials() {
  const building = useStore((s) => s.building);
  const company = useStore((s) => s.company);
  const rows = useMemo(() => essentialRows(company, building ? missingEssentials(building, spaceContext(company)) : []), [building, company]);
  const left = rows.filter((r) => !r.ok).length;
  return (
    <div className={`bh-essentials${left ? '' : ' done'}`} data-testid="build-essentials" data-missing={left}>
      <b>{left ? `Needed to save (${left} left)` : '✓ Ready to save'}</b>
      <ul hidden={!left}>
        {rows.map((r) => (
          <li key={r.key} className={r.ok ? 'ok' : 'todo'} data-essential={r.key} data-ok={r.ok}>
            <i aria-hidden="true">{r.ok ? '✓' : '•'}</i>
            <span>
              {r.label}
              {r.detail && <small>{r.detail}</small>}
            </span>
          </li>
        ))}
      </ul>
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
          <i className={`bh-chip${entry.kind === 'floor' && entry.paint === 0 ? ' none' : ''}`} data-material={entry.id} style={entry.kind === 'floor' ? floorSwatch(entry.paint) : wallSwatch(entry.style)} />
        )}
        {entry.kind === 'item' && <span className="bh-badge" data-testid="footprint-badge">{footprintText(entry.def)}</span>}
      </span>
      <span className="bh-name">{entry.name}</span>
      {search && <span className="bh-sub">{tab}</span>}
    </button>
  );
}

function FillToggle() {
  const on = useStore((s) => s.build?.fill ?? false);
  return (
    <button type="button" className="bh-fill" data-testid="fill-toggle" aria-pressed={on} onClick={() => patchBuild({ fill: !on })} title="Paint the whole room in one click (Shift does the same while held)">
      <FillIcon /> Fill room
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
      <span>{ITEM_DEFS[tool.def].seat ? 'Seat for' : 'For team'}</span>
      <i style={{ background: blocks.find((b) => b.id === tool.blockId)?.color ?? '#999' }} />
      <select
        aria-label="Team the piece belongs to"
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

const CANCELS: ReadonlySet<BuildTool['kind']> = new Set(['item', 'wall', 'room', 'floor', 'wallpaint', 'opening']);

// What the tool in hand needs the owner to know, and the way out of it: the keys, the team it is for, the turn button and Cancel.
function Hints({ tool, compact = false }: { tool: BuildTool; compact?: boolean }) {
  // A piece picked up from the floor says what Esc does in words; a tool or a small thing in hand has the Cancel button, which says it as plainly.
  const carrying = tool.kind === 'item' && !!tool.carry;
  const cancel = CANCELS.has(tool.kind) && (compact || !carrying);
  const hint = HINTS[tool.kind](tool).filter(([k]) => !(cancel && k === 'Esc'));
  return (
    <>
      {hint.map(([k, v, danger]) => (
        <span key={k}><kbd className={danger ? 'danger' : undefined}>{k}</kbd> {v}</span>
      ))}
      <TeamPick />
      {(tool.kind === 'floor' || tool.kind === 'wallpaint') && <FillToggle />}
      {canTurn(tool) && (
        <button type="button" className="bh-turn" data-testid="rotate-handle" onClick={() => rotate(1)} title="Turn it a quarter (. key)" aria-label="Turn it">
          <Turn /> Turn
        </button>
      )}
      {cancel && (
        <button type="button" className="bh-cancel" data-testid="cancel-tool" onClick={stepBack} title="Put it down (Esc)">
          Cancel <kbd>Esc</kbd>
        </button>
      )}
    </>
  );
}

// A small thing in hand is for a desk, a table or a shelf, which sit anywhere on screen. The catalog folds down to this bar, so the top
// the owner points at is never under a panel; the pointer over the bar brings the catalog back above it.
function Held({ tool, thumb }: { tool: Extract<BuildTool, { kind: 'item' }>; thumb: string | undefined }) {
  const name = ENTRIES.find((e) => e.kind === 'item' && e.def === tool.def)?.name ?? tool.def;
  return (
    <div className="bh-held" data-testid="held-bar">
      <span className="bh-held-item">
        {thumb && <img src={thumb} alt="" draggable={false} />}
        <b>{name}</b>
        <small>{footprintText(tool.def)}</small>
      </span>
      <span className="bh-held-hints bh-hint-row">
        <Hints tool={tool} compact />
      </span>
      <span className="bh-held-more">Catalog <i aria-hidden="true">▴</i></span>
    </div>
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
  const input = useRef<HTMLInputElement>(null);
  const held = tool.kind === 'item' && !!ITEM_DEFS[tool.def] && placementOf(ITEM_DEFS[tool.def]) !== 'floor' ? tool : null;
  return (
    <div className={`bh-dock${held ? ' held' : ''}`} data-testid="build-catalog">
      {!held && (
        <div className="bh-hint" aria-live="polite">
          <Hints tool={tool} />
        </div>
      )}
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
      {held && <Held tool={held} thumb={thumbs.get(held.def)} />}
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

// In first person the pointer is locked to the view, so the key is the way in; Esc or C frees the pointer to click instead.
function EnterButton() {
  const ready = useStore((s) => !!s.building);
  const first = useStore((s) => s.camera === 'first');
  return (
    <button className={`bh-enter${first ? ' key-first' : ''}`} onClick={(e) => { enterBuild(); e.currentTarget.blur(); }} disabled={!ready} title={first ? 'Press B to build. Esc or C frees the pointer to click this button' : 'Build mode: move furniture and whole blocks (B)'} data-testid="build-enter">
      <BuildIcon />
      Build <kbd>B</kbd>
    </button>
  );
}

// The question asked before a block is deleted: who would be fired. Enter says yes, Esc says no.
function RemoveBlockDialog() {
  const blockId = removal((s) => s.blockId);
  const ask = blockId ? consequences(blockId) : null;
  if (!ask) return null;
  const { name, people } = ask;
  const who = people.length === 0 ? 'Nobody works there.' : `${people.join(', ')} would be fired.`;
  return (
    <div className="bh-confirm-veil" role="presentation">
      <div className="bh-confirm" role="alertdialog" aria-labelledby="bh-confirm-title" data-testid="remove-block-dialog">
        <b id="bh-confirm-title">Remove {name}?</b>
        <p data-testid="remove-block-people">{who} Every piece of the block goes with it: its desks, board, rug and decor. This cannot be undone.</p>
        <div className="bh-confirm-row">
          <button className="bh-confirm-keep" onClick={keepBlock} data-testid="remove-block-keep">Keep it <kbd>Esc</kbd></button>
          <button className="bh-confirm-yes" onClick={removeBlock} data-testid="remove-block-yes">
            {people.length ? `Fire ${people.length} and remove` : 'Remove'} <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

export function BuildHud() {
  const on = useStore((s) => !!s.build);
  useEffect(() => {
    if (on) document.documentElement.dataset.building = '1';
    return () => void delete document.documentElement.dataset.building;
  }, [on]);
  if (!on) return <EnterButton />;
  return (
    <>
      <TopBar />
      <Essentials />
      <Levels />
      <Dock />
      <Readout />
      <RemoveBlockDialog />
    </>
  );
}
