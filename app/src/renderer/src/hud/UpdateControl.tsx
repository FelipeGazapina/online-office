import type { UpdateState } from '../../../shared/protocol.ts';
import { useStore } from '../store.ts';

type View = { label: string; run?: () => void; note?: string; chip?: 'ready' | 'busy' | 'failed' };

function view(u: UpdateState): View {
  const { check, install } = window.office.update;
  switch (u.status) {
    case 'checking':
      return { label: 'Checking for updates…' };
    case 'current':
      return { label: 'Check again', run: check, note: `You’re on the latest version, v${u.version}.` };
    case 'check-failed':
      return { label: 'Check again', run: check, note: `Could not check: ${u.message}` };
    case 'available':
      return { label: `Update to v${u.version} and restart`, run: install, chip: 'ready' };
    case 'downloading':
      return { label: `Downloading v${u.version} ${Math.round(u.percent)}%`, chip: 'busy' };
    case 'installing':
      return { label: 'Restarting…', chip: 'busy' };
    case 'update-failed':
      return { label: 'Update failed. Check again', run: check, note: u.message, chip: 'failed' };
  }
}

export function UpdateChip() {
  const update = useStore((s) => s.update);
  const v = update && view(update);
  if (!v?.chip) return null;
  return (
    <button className={`btn update-chip ${v.chip}`} disabled={!v.run} title={v.note} onClick={() => v.run?.()}>
      {v.label}
    </button>
  );
}

export function UpdateSetting() {
  const update = useStore((s) => s.update);
  if (!update) return null;
  const v = view(update);
  return (
    <>
      <label>Updates</label>
      <button className="btn ghost update-button" disabled={!v.run} onClick={() => v.run?.()}>
        {v.label}
      </button>
      {v.note && <span className="muted update-note">{v.note}</span>}
    </>
  );
}
