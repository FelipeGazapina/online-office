import { useEffect, useMemo, useState } from 'react';
const CLOCK_KEY = 'online-office.secondary-clock';
const TIMEZONES = ['America/Los_Angeles','America/Denver','America/Chicago','America/New_York','America/Sao_Paulo','Europe/London','Europe/Berlin','Europe/Lisbon','Asia/Dubai','Asia/Kolkata','Asia/Shanghai','Asia/Tokyo','Australia/Sydney'] as const;
function labelFor(timeZone: string) { return timeZone.replaceAll('_', ' ').replace(/^America\//, '').replace(/^Europe\//, '').replace(/^Asia\//, '').replace(/^Australia\//, ''); }
function formatTime(date: Date, timeZone: string) { return new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date); }
export function Clock() {
  const localZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const [secondary, setSecondary] = useState<string | null>(() => localStorage.getItem(CLOCK_KEY));
  const [now, setNow] = useState(() => new Date());
  const [editing, setEditing] = useState(false);
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []);
  const updateSecondary = (value: string) => { const next = value || null; setSecondary(next); setEditing(false); if (next) localStorage.setItem(CLOCK_KEY, next); else localStorage.removeItem(CLOCK_KEY); };
  return <div className="clock-bar" aria-label="World clocks">
    <div className="clock-card"><span className="clock-zone">{labelFor(localZone)} · local</span><strong>{formatTime(now, localZone)}</strong></div>
    {secondary ? <div className="clock-card clock-secondary"><span className="clock-zone">{labelFor(secondary)}</span><strong>{formatTime(now, secondary)}</strong><button className="clock-remove" onClick={() => updateSecondary('')} aria-label="Remove second clock">×</button></div> : editing ? <label className="clock-add-select"><span className="sr-only">Choose a timezone</span><select autoFocus defaultValue="" onChange={(event) => updateSecondary(event.target.value)} onBlur={() => setEditing(false)}><option value="" disabled>Add timezone…</option>{TIMEZONES.filter((zone) => zone !== localZone).map((zone) => <option key={zone} value={zone}>{labelFor(zone)}</option>)}</select></label> : <button className="clock-add" onClick={() => setEditing(true)}>＋ Add timezone</button>}
  </div>;
}
