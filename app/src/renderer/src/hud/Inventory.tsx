// What the owner carries everywhere. For now that is the laptop, which runs the same desktop as the Mac at their desk: Esc with
// nothing open, or a click on its slot, takes it out.
import { openLaptop, useLaptop } from '../computer.ts';
import { useStore } from '../store.ts';
import './laptop.css';

function LaptopIcon() {
  return (
    <svg viewBox="0 0 40 30" aria-hidden="true">
      <rect x="7" y="3" width="26" height="17.5" rx="2.4" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <rect x="10.2" y="6.2" width="19.6" height="11" rx="1" fill="#f5b84c" />
      <path d="M2.5 23h35l-2.6 3.3a2 2 0 0 1-1.6.7H6.7a2 2 0 0 1-1.6-.7z" fill="currentColor" />
    </svg>
  );
}

export function Inventory() {
  const out = useLaptop((s) => s.open);
  const building = useStore((s) => !!s.build);
  if (building) return null;
  return (
    <div className="inventory" data-hud-resize-target="inventory" aria-label="Inventory">
      <button type="button" className={out ? 'inv-slot out' : 'inv-slot'} onClick={() => openLaptop()} title="Laptop: your Mac's desktop, wherever you are" aria-label="Take out your laptop (Esc)">
        <kbd>Esc</kbd>
        <LaptopIcon />
        <span className="inv-name">Laptop</span>
      </button>
    </div>
  );
}
