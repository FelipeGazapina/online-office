import { useEffect, useRef, useState } from 'react';
import { set, useStore } from '../store.ts';
import { CompanyPanel, SettingsPanel, TaskBoardsPanel } from './Panels.tsx';
import { enterComputer, leaveComputer } from '../computer.ts';
import { testRun } from '../testRun.ts';

/** The prompt shown before the owner sits down. */
export function ComputerMenu() {
  const open = useStore((s) => s.computerMenu);
  if (!open) return null;
  return (
    <div className="computer-menu panel">
      <div className="computer-title"><span className="computer-dot" /><b>My Mac</b></div>
      <p className="muted">Sit down to use the same Mac, apps, and files you use every day.</p>
      <button className="btn primary" onClick={() => enterComputer()}>Open MacBook</button>
      <button className="link" onClick={() => set({ computerMenu: false })}>Cancel</button>
    </div>
  );
}

function TestPortal() {
  const company = useStore((s) => s.company);
  return (
    <main className="mac-portal">
      <header className="mac-bar"><div className="mac-brand"><span className="mac-logo">⌘</span><b>My Mac</b></div><span className="mac-live">AUTOMATED TEST DESKTOP</span><button className="btn ghost" onClick={() => leaveComputer()}>Stand up (F)</button></header>
      <section className="mac-desktop"><div className="mac-workspace">
        <div className="mac-app-window"><div className="mac-window-head"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><b>My Mac</b></div><div className="mac-window-body"><p className="mac-kicker">Your computer</p><h1>My Mac</h1><p className="muted">The real Mac desktop is mirrored here for the owner.</p><button className="mac-action"><span>⚙️</span><b>Configuration</b><small>Office settings</small></button></div></div>
        <div id="mac-configuration" className="mac-app-window mac-office-window"><div className="mac-window-head"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><b>Configuration · {company?.name ?? 'Company'}</b></div><CompanyPanel allowOverLimit /></div>
        <div className="mac-app-window mac-settings-window"><div className="mac-window-head"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><b>Office settings</b></div><SettingsPanel /></div>
      </div></section>
    </main>
  );
}

function MirrorDesktop() {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'starting' | 'live' | 'blocked'>('starting');

  useEffect(() => {
    let stream: MediaStream | undefined;
    let disposed = false;
    void navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false }).then((next) => {
      stream = next;
      if (disposed) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      if (video.current) video.current.srcObject = next;
      setState('live');
      next.getVideoTracks()[0]?.addEventListener('ended', () => setState('blocked'), { once: true });
    }).catch(() => {
      if (!disposed) setState('blocked');
    });
    return () => {
      disposed = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => window.office.portal.onExit(() => leaveComputer()), []);

  return (
    <main className="mac-portal mac-mirror-portal">
      <video ref={video} className="mac-mirror-video" autoPlay muted playsInline aria-label="Live view of this Mac" />
      <div className="mac-mirror-shade" aria-hidden="true" />
      <header className="mac-mirror-bar">
        <div className="mac-brand"><span className="mac-logo">⌘</span><b>My Mac</b></div>
        <span className="mac-mirror-app">Desktop</span>
        <span className={`mac-mirror-state ${state}`}><i />{state === 'live' ? 'Live desktop' : state === 'starting' ? 'Connecting to this Mac…' : 'Screen Recording permission required'}</span>
        <span className="mac-mirror-shortcut">Press <kbd>F</kbd> here or <kbd>⌘⇧O</kbd> after opening a native app</span>
      </header>
      {state === 'blocked' && <div className="mac-mirror-blocked"><b>Allow Screen Recording for Online Office</b><span>macOS protects your desktop until this permission is enabled in System Settings → Privacy & Security → Screen Recording. Then sit down again.</span></div>}
      <footer className="mac-mirror-footer"><span><i className="mirror-dot" /> Your real Mac is underneath this view</span><span>Mouse, keyboard, Safari, Slack, Finder, Terminal — everything stays native.</span></footer>
    </main>
  );
}

export function MacPortal() {
  const projectComputerId = useStore((s) => s.projectComputerId);
  if (projectComputerId) {
    return (
      <main className="mac-portal project-task-portal">
        <header className="mac-bar"><div className="mac-brand"><span className="mac-logo">⌘</span><b>Project computer</b></div><span className="mac-live">TASK BOARD CONFIGURATION</span><button className="btn ghost" onClick={() => leaveComputer()}>Stand up (F)</button></header>
        <section className="mac-desktop"><div className="mac-workspace project-task-workspace"><div className="mac-app-window mac-task-window"><div className="mac-window-head"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><b>Project task boards</b></div><TaskBoardsPanel /></div></div></section>
      </main>
    );
  }
  return testRun ? <TestPortal /> : <MirrorDesktop />;
}
