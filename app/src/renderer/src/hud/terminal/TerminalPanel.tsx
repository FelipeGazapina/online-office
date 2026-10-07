// The terminal of the employee whose monitor the camera is zoomed into. It sits exactly on the screen the camera looks at and draws what
// the monitor draws (shared/terminal.ts lays both out), except that this one scrolls, takes the owner's typing and answers permission
// cards. What the owner types goes where it goes in the chat: a message to an idle employee is a request, one to someone who is working
// is said to them, and one to someone who asked is the answer.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ALLOW_ANSWER } from '../../../../shared/permissions.ts';
import type { Employee, Question } from '../../../../shared/protocol.ts';
import { layoutBlocks, MODE_LINE, optionsOf, questionTitle, quartersOf, spinnerRow, wrap, type Row, type Span } from '../../../../shared/terminal.ts';
import { escapeMonitor, leaveMonitor, useMonitor } from '../../computer.ts';
import { monitorPoses, zoomFrame } from '../../scene/monitorPose.ts';
import { get, send, useStore } from '../../store.ts';
import { modelLabel, terminalBlocks, terminalLive, useTerminalVersion } from './feed.ts';
import { BGS, FONT, SCREEN_BG, TONES } from './theme.ts';
import './terminal.css';

const spanStyle = (s: Span) => ({
  color: TONES[s.c ?? 'fg'],
  ...(s.b ? { fontWeight: 700 } : {}),
  ...(s.i ? { fontStyle: 'italic' } : {}),
  ...(s.bg ? { background: BGS[s.bg] } : {}),
});

// A block glyph is drawn by filling the quarters of its cell, so the mascot is one piece whatever the font does at the edge of a line.
const quarters = (ch: string) => {
  const q = quartersOf(ch);
  if (!q) return undefined;
  const at = ['0 0', '100% 0', '0 100%', '100% 100%'];
  return q.flatMap((on, i) => (on ? [`linear-gradient(currentColor, currentColor) ${at[i]} / 50% 50% no-repeat`] : [])).join(', ');
};

function SpanView({ s }: { s: Span }) {
  const style = spanStyle(s);
  if (!/[▘▝▖▗▌▐▀▄▛▜▙▟█▚▞]/.test(s.t)) return <span style={style}>{s.t}</span>;
  return (
    <span style={style}>
      {[...s.t].map((ch, i) => {
        const bg = quarters(ch);
        return bg ? <span key={i} className="qd" style={{ background: bg }}>{' '}</span> : ch;
      })}
    </span>
  );
}

function RowView({ row }: { row: Row }) {
  return (
    <div className="term-row" style={row.fill ? { background: BGS[row.fill] } : undefined}>
      {row.spans.length ? row.spans.map((s, i) => <SpanView key={i} s={s} />) : ' '}
    </div>
  );
}

// The width of a character at the size the panel draws at, so the layout knows how many columns fit.
function charWidth(px: number): number {
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = `${px}px ${FONT}`;
  return ctx.measureText('0').width;
}

function Spinner({ startedAt, tokens }: { startedAt: number; tokens: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 140);
    return () => clearInterval(t);
  }, []);
  return <RowView row={spinnerRow(startedAt, now, tokens)} />;
}

function Dialog({ q, picked, choose }: { q: Question; picked: number; choose: (i: number) => void }) {
  const options = optionsOf(q);
  return (
    <div className="term-dialog">
      <div className="term-title">{questionTitle(q)}</div>
      {q.kind === 'permission' ? (
        <>
          <div className="term-detail">{q.detail}</div>
          <div className="term-ask">Do you want to proceed?</div>
        </>
      ) : (
        <div className="term-detail">{q.text}</div>
      )}
      {options.map((o, i) => (
        <button key={o.key} type="button" className={`term-option${i === picked ? ' on' : ''}`} onClick={() => choose(i)}>
          <span>{i === picked ? '❯' : ' '}</span> {o.key}. {o.label}
        </button>
      ))}
    </div>
  );
}

export function TerminalPanel() {
  const id = useMonitor((s) => s.open);
  const employee = useStore((s) => s.company?.employees.find((e) => e.id === id));
  // Someone who was fired while their terminal was open takes the monitor with them.
  useEffect(() => {
    if (id && !employee) leaveMonitor();
  }, [id, employee]);
  if (!id || !employee) return null;
  return <Panel key={id} employee={employee} />;
}

function Panel({ employee }: { employee: Employee }) {
  const version = useTerminalVersion(employee.id);
  // The rest of the HUD steps back while the owner looks into a screen.
  useEffect(() => {
    document.body.dataset.monitor = 'open';
    return () => void delete document.body.dataset.monitor;
  }, []);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState(0);
  const [sent, setSent] = useState<{ text: string; at: number }[]>([]);
  const [ready, setReady] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);
  const status = employee.status;
  const question = status.kind === 'blocked_on_owner' ? status.question : null;

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    // The panel fades in as the camera arrives.
    const t = setTimeout(() => setReady(true), 380);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(t);
    };
  }, []);
  useEffect(() => {
    if (ready) field.current?.focus();
  }, [ready]);

  // The panel lies on the monitor's screen as the camera frames it. Without a pose (the desk is gone) it is a window in the middle.
  const frame = useMemo(() => {
    const pose = monitorPoses.get(employee.id);
    if (!pose) return { w: size.w * 0.7, h: size.h * 0.7 };
    const f = zoomFrame(pose, size.w / size.h);
    return { w: f.width * size.w, h: f.height * size.h };
  }, [employee.id, size]);

  const px = Math.max(11, Math.min(15, Math.round(frame.h / 40)));
  const lineH = Math.round(px * 1.32);
  const cw = useMemo(() => charWidth(px), [px]);
  const cols = Math.max(30, Math.floor((frame.w - 36) / cw));

  const blocks = terminalBlocks(employee.id);
  const live = terminalLive(employee.id);
  const rows = useMemo(() => layoutBlocks(blocks, cols), [blocks, cols, version]);

  // What the owner sent that the employee has not echoed yet stays on the screen, so a message never vanishes between Enter and delivery.
  const echoed = useMemo(() => new Set(blocks.flatMap((b) => b.lines.map((l) => l.spans.map((s) => s.t).join('').replace(/^❯ /, '')))), [blocks]);
  const waiting = sent.filter((m) => !echoed.has(m.text.split('\n')[0]!) && Date.now() - m.at < 20_000);
  const pendingRows = waiting.flatMap((m) => wrap({ spans: [{ t: '❯ ', c: 'dim', bg: 'user' }, { t: m.text, c: 'bright', bg: 'user' }], hang: 2 }, cols));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    else if (el) setBehind(true);
  }, [rows, pendingRows.length, question?.id, status.kind, size]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (pinned.current) setBehind(false);
  };

  const answer = (text: string, always = false) => {
    if (!question) return;
    send({ type: 'answer', employeeId: employee.id, questionId: question.id, text, ...(always ? { always } : {}) });
    setPicked(0);
  };

  // A pick from the card: yes, yes for good, or no. With words typed, the third choice sends them as the reason.
  const choose = (i: number) => {
    if (!question) return;
    const option = optionsOf(question)[i];
    if (!option) return;
    if (question.kind === 'ask') return answer(option.label);
    if (option.label === 'Yes') return answer(ALLOW_ANSWER);
    if (option.always) return answer(ALLOW_ANSWER, true);
    answer(draft.trim() ? `No, ${draft.trim()}` : 'No');
    setDraft('');
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (question) {
      answer(question.kind === 'permission' ? `No, ${text}` : text);
    } else {
      const clientId = crypto.randomUUID();
      if (status.kind === 'working') send({ type: 'post', to: employee.id, clientId, as: 'say', text, urgency: get().interrupt });
      else send({ type: 'post', to: employee.id, clientId, as: 'request', text });
      setSent((list) => [...list.filter((m) => Date.now() - m.at < 20_000), { text, at: Date.now() }]);
    }
    setDraft('');
    pinned.current = true;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The office's own keys (walking, the camera, F to leave) must not fire while the owner types.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      return escapeMonitor();
    }
    if (question && !draft) {
      const n = optionsOf(question).length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        return setPicked((p) => (p + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      }
      if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) {
        e.preventDefault();
        return choose(Number(e.key) - 1);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        return choose(picked);
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const hint = status.kind === 'working' ? 'esc to interrupt' : question ? 'esc to stop · 1-3 to choose' : 'esc to leave';

  return (
    <div
      className={`term-frame${ready ? ' ready' : ''}`}
      data-terminal={employee.id}
      style={{ width: frame.w, height: frame.h, left: (size.w - frame.w) / 2, top: (size.h - frame.h) / 2 }}
    >
      <div className="term-screen" style={{ fontSize: px, lineHeight: `${lineH}px`, background: SCREEN_BG, fontFamily: FONT }} onMouseDown={(e) => e.target === e.currentTarget && field.current?.focus()}>
        <div className="term-scroll" ref={scroller} onScroll={onScroll} data-rows={rows.length}>
          {rows.map((r, i) => (
            <RowView key={i} row={r} />
          ))}
          {pendingRows.map((r, i) => (
            <RowView key={`p${i}`} row={r} />
          ))}
          {status.kind === 'working' && <div className="term-gap" />}
        </div>
        {behind && (
          <button type="button" className="term-latest" onClick={() => ((pinned.current = true), setBehind(false), scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight))}>
            ↓ latest
          </button>
        )}
        <div className="term-foot">
          {status.kind === 'working' && !question && <Spinner startedAt={status.startedAt} tokens={live.tokens} />}
          {status.kind === 'error' && (
            <div className="term-row">
              <span style={{ color: TONES.dim }}>{'  ⎿  '}</span>
              <span style={{ color: TONES.err }}>Error: {status.message}</span>
            </div>
          )}
          {question && <Dialog q={question} picked={picked} choose={choose} />}
          <div className="term-rule" />
          <div className="term-prompt">
            <span className="term-caret">❯</span>
            <textarea
              ref={field}
              value={draft}
              rows={1}
              spellCheck={false}
              placeholder={question ? (question.kind === 'permission' ? 'or tell them what to do differently' : 'or type an answer') : `Message ${employee.name}…`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              autoFocus
              aria-label={`Message to ${employee.name}`}
            />
          </div>
          <div className="term-rule" />
          <div className="term-status">
            <span style={{ color: TONES[MODE_LINE[employee.permissions.mode].tone] }}>
              {MODE_LINE[employee.permissions.mode].glyph} {MODE_LINE[employee.permissions.mode].text}{' '}
              <span className="term-dim">{employee.permissions.mode === 'ask' ? '· ? for shortcuts' : '(shift+tab to cycle)'}</span>
            </span>
            <span className="term-who">
              {hint} · {employee.name} · {modelLabel(employee.model)}
            </span>
          </div>
        </div>
      </div>
      <button type="button" className="term-leave" onClick={() => leaveMonitor()} title="Leave the monitor (F)">
        Leave
      </button>
    </div>
  );
}

// "F  open Ana's terminal" while the owner stands at a desk.
export function MonitorPrompt() {
  const near = useMonitor((s) => s.near);
  const open = useMonitor((s) => s.open);
  const seated = useStore((s) => s.computerState === 'seated' || s.portalMode || !!s.modal || !!s.build);
  const name = useStore((s) => s.company?.employees.find((e) => e.id === near)?.name);
  if (!near || open || seated || !name) return null;
  return (
    <div className="computer-prompt" data-monitor-prompt={near}>
      <kbd>F</kbd>
      <span>open {name}'s terminal</span>
    </div>
  );
}
