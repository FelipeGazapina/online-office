// The terminal of the employee whose monitor the camera is zoomed into. It sits exactly on the screen the camera looks at and draws what
// the monitor draws (shared/terminal.ts lays both out), except that this one scrolls, takes the owner's typing and answers permission
// cards. What the owner types goes where it goes in the chat: a message to an idle employee is a request, one to someone who is working
// is said to them, and one to someone who asked is the answer.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ALLOW_ANSWER } from '../../../../shared/permissions.ts';
import type { Employee, Question } from '../../../../shared/protocol.ts';
import { layoutLog, MODE_LINE, optionsOf, questionRows, quartersOf, spinnerRows, wrap, type Act, type Plan, type Row, type Span } from '../../../../shared/terminal.ts';
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

// A symbol the monospace font does not have is drawn by another font, wider or narrower than a cell, and every row after it drifts. So each
// one sits in a cell of its own, and a block glyph is drawn by filling its quarters.
const SYMBOL = /[\u2190-\u24ff\u2580-\u2bff]/;
const BLOCKS = /[▘▝▖▗▌▐▀▄▛▜▙▟█▚▞]/;

function SpanView({ s }: { s: Span }) {
  const style = spanStyle(s);
  if (!SYMBOL.test(s.t)) return <span style={style}>{s.t}</span>;
  return (
    <span style={style}>
      {[...s.t].map((ch, i) => {
        if (BLOCKS.test(ch)) return <span key={i} className="qd" style={{ background: quarters(ch) }}>{' '}</span>;
        return SYMBOL.test(ch) && !/[\u2500-\u257f]/.test(ch) ? <span key={i} className="cell">{ch}</span> : ch;
      })}
    </span>
  );
}

function RowView({ row, onAct }: { row: Row; onAct?: (act: Act) => void }) {
  const act = row.act;
  return (
    <div
      className={`term-row${act && onAct ? ' term-act' : ''}`}
      style={{ ...(row.fill ? { background: BGS[row.fill] } : {}), ...(row.old ? { opacity: 0.62 } : {}) }}
      onClick={act && onAct ? () => onAct(act) : undefined}
    >
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

function Spinner({ startedAt, tokens, cols, plan }: { startedAt: number; tokens: number; cols: number; plan: Plan | undefined }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 140);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      {spinnerRows(startedAt, now, tokens, cols, 160, plan).map((row, i) => (
        <RowView key={i} row={row} />
      ))}
    </>
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
  // Tab on a permission dialog opens the words under No, where the owner says what to do instead.
  const [amend, setAmend] = useState(false);
  // What the owner opened in the log: older turns, and calls with all of their result.
  const [open, setOpen] = useState<{ turns: ReadonlySet<number>; calls: ReadonlySet<number> }>({ turns: new Set(), calls: new Set() });
  const [sent, setSent] = useState<{ text: string; at: number }[]>([]);
  const [ready, setReady] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);
  // The log is scrolled, so a row is cut by the top edge.
  const [cut, setCut] = useState(false);
  const status = employee.status;
  const question = status.kind === 'blocked_on_owner' ? status.question : null;
  const permission = question?.kind === 'permission' ? question : null;

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
  useEffect(() => {
    setAmend(false);
    setPicked(0);
  }, [question?.id]);

  // The panel lies on the monitor's screen as the camera frames it. Without a pose (the desk is gone) it is a window in the middle.
  const frame = useMemo(() => {
    const pose = monitorPoses.get(employee.id);
    if (!pose) return { w: size.w * 0.7, h: size.h * 0.7 };
    const f = zoomFrame(pose, size.w / size.h);
    return { w: f.width * size.w, h: f.height * size.h };
  }, [employee.id, size]);

  // The panel is the whole screen the camera looks at, so the text is as large as it can be and still hold a line of a terminal: about
  // 24 rows of generous spacing, not 40 of fine print.
  const px = Math.max(13, Math.min(24, Math.round(frame.h / 35)));
  const lineH = Math.round(px * 1.45);
  const cw = useMemo(() => charWidth(px), [px]);
  const cols = Math.max(30, Math.floor((frame.w - 36) / cw));

  const blocks = terminalBlocks(employee.id);
  const live = terminalLive(employee.id);
  const log = useMemo(() => layoutLog(blocks, cols, open), [blocks, cols, version, open]);
  const rowCount = log.head.length + log.past.length + log.now.length;
  const past = useRef<HTMLDivElement>(null);

  // What the owner sent that the employee has not echoed yet stays on the screen, so a message never vanishes between Enter and delivery.
  const echoed = useMemo(() => new Set(blocks.flatMap((b) => b.lines.map((l) => l.spans.map((s) => s.t).join('').replace(/^❯ /, '')))), [blocks]);
  const waiting = sent.filter((m) => !echoed.has(m.text.split('\n')[0]!) && Date.now() - m.at < 20_000);
  const pendingRows = waiting.flatMap((m) => wrap({ spans: [{ t: '❯ ', c: 'dim', bg: 'user' }, { t: m.text, c: 'bright', bg: 'user' }], hang: 2 }, cols));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    else if (el) setBehind(true);
    if (el) setCut(el.scrollTop > 2);
  }, [log, pendingRows.length, question?.id, status.kind, size]);
  // The turns before this one stay at the top, with the latest of them showing.
  useLayoutEffect(() => {
    if (past.current) past.current.scrollTop = past.current.scrollHeight;
  }, [log.past]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (pinned.current) setBehind(false);
    setCut(el.scrollTop > 2);
  };

  const answer = (text: string, always = false) => {
    if (!question) return;
    send({ type: 'answer', employeeId: employee.id, questionId: question.id, text, ...(always ? { always } : {}) });
    setPicked(0);
    setAmend(false);
  };

  // A pick from the dialog: yes, yes for good, or no. No takes the words typed under it when the owner pressed Tab.
  const choose = (i: number) => {
    if (!question) return;
    const option = optionsOf(question)[i];
    if (!option) return;
    switch (option.kind) {
      case 'pick':
        return answer(option.label);
      case 'allow':
        return answer(ALLOW_ANSWER);
      case 'always':
        return answer(ALLOW_ANSWER, true);
      case 'deny': {
        const why = amend ? draft.trim() : '';
        answer(why ? `No, ${why}` : 'No');
        setDraft('');
      }
    }
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
    if (question && (permission || !draft)) {
      const n = optionsOf(question).length;
      if (permission && e.key === 'Tab') {
        e.preventDefault();
        return setAmend((on) => !on);
      }
      if (permission && amend) {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          return choose(n - 1);
        }
      } else {
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
        // Anything else typed on a permission dialog is the owner saying what to do instead.
        if (permission && e.key.length === 1 && !e.ctrlKey && !e.metaKey) setAmend(true);
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const hint = status.kind === 'working' ? 'esc to interrupt' : question ? 'esc to stop · 1-3 to choose' : 'esc to leave';
  const who = `${employee.name} · ${modelLabel(employee.model)}`;
  const dialog = question ? questionRows(question, cols, { picked: permission && amend ? optionsOf(question).length - 1 : picked, ...(permission ? { ask: live.asks?.find((a) => a.detail === permission.detail) } : {}), who, ...(permission && amend ? { amend: draft } : {}) }) : [];
  const flip = (set: ReadonlySet<number>, n: number) => {
    const next = new Set(set);
    if (!next.delete(n)) next.add(n);
    return next;
  };
  const act = (a: Act) => {
    if ('option' in a) choose(a.option);
    else if ('turn' in a) setOpen((o) => ({ ...o, turns: flip(o.turns, a.turn) }));
    else setOpen((o) => ({ ...o, calls: flip(o.calls, a.block) }));
  };

  return (
    <div
      className={`term-frame${ready ? ' ready' : ''}`}
      data-terminal={employee.id}
      style={{ width: frame.w, height: frame.h, left: (size.w - frame.w) / 2, top: (size.h - frame.h) / 2 }}
    >
      <div className="term-screen" style={{ fontSize: px, lineHeight: `${lineH}px`, background: SCREEN_BG, fontFamily: FONT }} onMouseDown={(e) => e.target === e.currentTarget && field.current?.focus()}>
        <div className={cut && !log.past.length ? 'term-scroll cut' : 'term-scroll'} ref={scroller} onScroll={onScroll} data-rows={rowCount}>
          {log.head.map((r, i) => (
            <RowView key={i} row={r} onAct={act} />
          ))}
          {log.past.length > 0 && (
            <div ref={past} className={open.turns.size ? 'term-past loose' : 'term-past'} style={{ background: SCREEN_BG, ...(open.turns.size ? {} : { maxHeight: lineH * 4 + 8 }) }}>
              {log.past.map((r, i) => (
                <RowView key={i} row={r} onAct={act} />
              ))}
            </div>
          )}
          {log.now.map((r, i) => (
            <RowView key={`n${i}`} row={r} onAct={act} />
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
          {status.kind === 'working' && !question && <Spinner startedAt={status.startedAt} tokens={live.tokens} cols={cols} plan={live.plan} />}
          {status.kind === 'error' && (
            <div className="term-row">
              <span style={{ color: TONES.dim }}>{'  ⎿  '}</span>
              <span style={{ color: TONES.err }}>Error: {status.message}</span>
            </div>
          )}
          {question && (
            <div className="term-dialog" data-picked={picked}>
              {dialog.map((r, i) => (
                <RowView key={i} row={r} onAct={act} />
              ))}
            </div>
          )}
          <div className={permission ? 'term-box term-hidden' : 'term-box'}>
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
              {hint} · {who}
            </span>
          </div>
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
