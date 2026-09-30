import { useEffect, useRef, useState } from 'react';
import { set, useStore } from '../store.ts';
import { CompanyPanel, SettingsPanel, TaskBoardsPanel } from './Panels.tsx';
import { enterComputer, leaveComputer, openMirror } from '../computer.ts';

type DisplayCaptureVideoConstraints = MediaTrackConstraints & { cursor: 'never' };
const DISPLAY_CAPTURE_VIDEO: DisplayCaptureVideoConstraints = { frameRate: { ideal: 30, max: 60 }, cursor: 'never' };
type MirrorBarVisibility = 'visible' | 'hidden';
const MIRROR_BAR_HIDE_DELAY_MS = 3500;
const MIRROR_BAR_REVEAL_ZONE = 24;

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

function OfficeDesktop() {
  const company = useStore((s) => s.company);
  return (
    <main className="mac-portal">
      <header className="mac-bar"><div className="mac-brand"><span className="mac-logo">⌘</span><b>My Mac</b></div><span className="mac-live">OFFICE DESKTOP</span><button className="btn ghost" onClick={() => leaveComputer()}>Stand up (F)</button></header>
      <section className="mac-desktop"><div className="mac-workspace">
        <div className="mac-app-window"><div className="mac-window-head"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><b>My Mac</b></div><div className="mac-window-body"><p className="mac-kicker">Your computer</p><h1>My Mac</h1><p className="muted">Manage your office here, or open the live view of your native Mac when you need it.</p><div className="mac-actions"><button className="mac-action" onClick={() => document.getElementById('mac-configuration')?.scrollIntoView({ block: 'start' })}><span>⚙️</span><b>Configuration</b><small>Hiring and blocks</small></button><button className="mac-action" onClick={openMirror}><span>🖥️</span><b>Live Mac mirror</b><small>Open your native desktop</small></button></div></div></div>
        <div id="mac-configuration" className="mac-app-window mac-office-window"><div className="mac-window-head"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><b>Configuration · {company?.name ?? 'Company'}</b></div><CompanyPanel allowOverLimit /></div>
        <div className="mac-app-window mac-settings-window"><div className="mac-window-head"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><b>Office settings</b></div><SettingsPanel /></div>
      </div></section>
    </main>
  );
}

function MirrorDesktop() {
  const video = useRef<HTMLVideoElement>(null);
  const hideTimer = useRef<number | null>(null);
  const [state, setState] = useState<'starting' | 'live' | 'blocked'>('starting');
  const [barVisibility, setBarVisibility] = useState<MirrorBarVisibility>('visible');

  useEffect(() => {
    let stream: MediaStream | undefined;
    let disposed = false;
    void navigator.mediaDevices.getDisplayMedia({ video: DISPLAY_CAPTURE_VIDEO, audio: false }).then((next) => {
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

  useEffect(() => {
    const clearHideTimer = () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
    const scheduleHide = () => {
      clearHideTimer();
      hideTimer.current = window.setTimeout(() => {
        hideTimer.current = null;
        setBarVisibility('hidden');
      }, MIRROR_BAR_HIDE_DELAY_MS);
    };

    if (state !== 'live') {
      clearHideTimer();
      setBarVisibility('visible');
      return clearHideTimer;
    }

    scheduleHide();
    return clearHideTimer;
  }, [state]);

  useEffect(() => {
    const revealBar = (event: MouseEvent) => {
      if (event.clientY > MIRROR_BAR_REVEAL_ZONE || barVisibility !== 'hidden') return;
      setBarVisibility('visible');
      if (state !== 'live') return;
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        hideTimer.current = null;
        setBarVisibility('hidden');
      }, MIRROR_BAR_HIDE_DELAY_MS);
    };
    window.addEventListener('mousemove', revealBar);
    return () => window.removeEventListener('mousemove', revealBar);
  }, [barVisibility, state]);

  return (
    <main className="mac-portal mac-mirror-portal">
      <video ref={video} className="mac-mirror-video" autoPlay muted playsInline aria-label="Live view of this Mac" />
      <div className="mac-mirror-shade" aria-hidden="true" />
      <header className={`mac-mirror-bar ${barVisibility}`} data-visibility={barVisibility} aria-hidden={barVisibility === 'hidden'}>
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
  const computerView = useStore((s) => s.computerView);
  if (projectComputerId) {
    return (
      <main className="mac-portal project-task-portal">
        <header className="mac-bar"><div className="mac-brand"><span className="mac-logo">⌘</span><b>Project computer</b></div><span className="mac-live">TASK BOARD CONFIGURATION</span><button className="btn ghost" onClick={() => leaveComputer()}>Stand up (F)</button></header>
        <section className="mac-desktop"><div className="mac-workspace project-task-workspace"><div className="mac-app-window mac-task-window"><div className="mac-window-head"><span className="traffic red" /><span className="traffic amber" /><span className="traffic green" /><b>Project task boards</b></div><TaskBoardsPanel /></div></div></section>
      </main>
    );
  }
  return computerView === 'office' ? <OfficeDesktop /> : <MirrorDesktop />;
}
