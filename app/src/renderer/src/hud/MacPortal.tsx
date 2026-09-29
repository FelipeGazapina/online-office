import { set, useStore } from '../store.ts';

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
          set({ computerMenu: false, portalMode: true });
          window.office.portal.enter();
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
    window.office.portal.leave();
    set({ portalMode: false });
  };
  return (
    <main className="mac-portal">
      <header className="mac-bar">
        <div className="mac-brand"><span className="mac-logo">R</span><b>Rebolt OS</b></div>
        <span className="mac-live">LIVE MAC PORTAL</span>
        <button className="btn ghost" onClick={leave}>Return to office</button>
      </header>
      <section className="mac-desktop">
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
            </div>
            <p className="mac-footnote">Company configuration will appear as another app here.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
