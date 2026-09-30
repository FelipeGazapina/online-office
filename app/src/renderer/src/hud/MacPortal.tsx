import { set, useStore } from '../store.ts';
import { CompanyPanel, SettingsPanel } from './Panels.tsx';
import { enterComputer, leaveComputer } from '../computer.ts';

export function ComputerMenu() {
  const open = useStore((s) => s.computerMenu);
  if (!open) return null;
  return (
    <div className="computer-menu panel">
      <div className="computer-title">
        <span className="computer-dot" />
        <b>Rebolt computer</b>
      </div>
      <p className="muted">Sit down and use the computer.</p>
      <button
        className="btn primary"
        onClick={() => {
          enterComputer();
        }}
      >
        Access computer
      </button>
      <button className="link" onClick={() => set({ computerMenu: false })}>
        Cancel
      </button>
    </div>
  );
}

export function MacPortal() {
  const company = useStore((s) => s.company);
  const leave = () => {
    leaveComputer();
  };
  const openConfiguration = () => document.getElementById('mac-configuration')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <main className="mac-portal">
      <header className="mac-bar">
        <div className="mac-brand"><span className="mac-logo">R</span><b>Rebolt OS</b></div>
        <span className="mac-live">OFFICE DESKTOP</span>
        <button className="btn ghost" onClick={leave}>Stand up (F)</button>
      </header>
      <section className="mac-desktop">
        <div className="mac-workspace">
        <div className="mac-app-window">
          <div className="mac-window-head">
            <span className="traffic red" /><span className="traffic amber" /><span className="traffic green" />
            <b>My Mac</b>
          </div>
          <div className="mac-window-body">
            <p className="mac-kicker">Your computer</p>
            <h1>My Mac</h1>
            <p className="muted">This portal stays connected to the real Mac while the office is in the background.</p>
            <div className="mac-actions">
              <button className="mac-action" onClick={() => window.office.revealFolder(company?.blocks[0]?.cwd ?? '.') }>
                <span>📁</span><b>Open project folder</b><small>Finder</small>
              </button>
              <button className="mac-action" onClick={() => window.office.portal.openHome()}>
                <span>🏠</span><b>Open home folder</b><small>Finder</small>
              </button>
              <button className="mac-action" onClick={() => window.office.portal.openTerminal()}>
                <span>⌘</span><b>Open Terminal</b><small>Terminal</small>
              </button>
              <button className="mac-action" onClick={openConfiguration}>
                <span>👥</span><b>Agents</b><small>Hire and edit</small>
              </button>
              <button className="mac-action" onClick={openConfiguration}>
                <span>⚙️</span><b>Configuration</b><small>Agents and office</small>
              </button>
            </div>

          </div>
        </div>
        <div id="mac-configuration" className="mac-app-window mac-office-window">
          <div className="mac-window-head"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><b>Configuration · {company?.name ?? 'Company'}</b></div>
          <CompanyPanel allowOverLimit />
        </div>
        <div className="mac-app-window mac-settings-window">
          <div className="mac-window-head"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><b>Office settings</b></div>
          <SettingsPanel />
        </div>
        </div>
      </section>
    </main>
  );
}
