import { useEffect, useMemo, useState } from 'react';

const CLOCK_KEY = 'online-office.timezones';
const LEGACY_CLOCK_KEY = 'online-office.secondary-clock';
const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Lisbon',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;

function labelFor(timeZone: string) {
  return timeZone.replaceAll('_', ' ').replace(/^America\//, '').replace(/^Europe\//, '').replace(/^Asia\//, '').replace(/^Australia\//, '');
}

function formatTime(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizeZones(value: unknown, localZone: string) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(values.filter((zone): zone is string => typeof zone === 'string' && zone !== localZone && isTimeZone(zone)))];
}

function loadZones(localZone: string) {
  const saved = localStorage.getItem(CLOCK_KEY);
  if (saved) {
    try {
      return normalizeZones(JSON.parse(saved), localZone);
    } catch {
      return [];
    }
  }
  return normalizeZones(localStorage.getItem(LEGACY_CLOCK_KEY), localZone);
}

export function Clock() {
  const localZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const [zones, setZones] = useState<string[]>(() => loadZones(localZone));
  const [now, setNow] = useState(() => new Date());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem(CLOCK_KEY, JSON.stringify(zones));
    localStorage.removeItem(LEGACY_CLOCK_KEY);
  }, [zones]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  const addZone = (zone: string) => {
    if (!zone || zone === localZone) return;
    setZones((current) => (current.includes(zone) ? current : [...current, zone]));
  };
  const removeZone = (zone: string) => setZones((current) => current.filter((value) => value !== zone));
  const available = TIMEZONES.filter((zone) => zone !== localZone && !zones.includes(zone));

  return (
    <div className="clock-bar" aria-label="World clocks">
      <button className="clock-toggle" type="button" aria-expanded={open} aria-controls="clock-popover" onClick={() => setOpen((value) => !value)}>
        <span className="clock-toggle-zone">{labelFor(localZone)} · local</span>
        <strong>{formatTime(now, localZone)}</strong>
        {zones.length > 0 && <span className="clock-count">+{zones.length}</span>}
        <span className="clock-chevron" aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {open && (
        <div className="clock-popover" id="clock-popover">
          <div className="clock-popover-head"><b>World clocks</b><button className="clock-close" type="button" aria-label="Close world clocks" onClick={() => setOpen(false)}>×</button></div>
          <div className="clock-list">
            <div className="clock-card clock-local"><span className="clock-zone">{labelFor(localZone)} · local</span><strong>{formatTime(now, localZone)}</strong></div>
            {zones.map((zone) => (
              <div className="clock-card" key={zone}>
                <span className="clock-zone">{labelFor(zone)}</span>
                <strong>{formatTime(now, zone)}</strong>
                <button className="clock-remove" type="button" aria-label={`Remove ${labelFor(zone)} timezone`} onClick={() => removeZone(zone)}>×</button>
              </div>
            ))}
          </div>
          {available.length > 0 ? (
            <label className="clock-add-select"><span>Add timezone</span><select value="" onChange={(event) => addZone(event.target.value)}><option value="" disabled>Add timezone…</option>{available.map((zone) => <option key={zone} value={zone}>{labelFor(zone)}</option>)}</select></label>
          ) : <p className="clock-empty">All available timezones are added.</p>}
        </div>
      )}
    </div>
  );
}
