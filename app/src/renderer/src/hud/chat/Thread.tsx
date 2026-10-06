import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Employee } from '../../../../shared/protocol.ts';
import { MAIL_TAIL, type MessageId } from '../../../../shared/mail.ts';
import { send, set, useStore } from '../../store.ts';
import { avatarColor, chainThread, mergeMessages, nameOf, personThread, requestStates, type Item, type Req, type ReqState } from './model.ts';
import { countRender } from './renders.ts';

const hhmm = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function Chip({ state }: { state: ReqState }) {
  switch (state.kind) {
    case 'queued':
      return <span className="cp-chip queued">{state.ahead > 0 ? `queued · ${state.ahead} ahead` : 'queued'}</span>;
    case 'working':
      return <span className="cp-chip working">working</span>;
    case 'settled':
      return <span className={`cp-chip ${state.outcome}`}>{state.outcome}</span>;
    case 'unknown':
      return null;
  }
}

// The one component a streamed token redraws.
function StreamBubble({ id }: { id: string }) {
  countRender('stream');
  const text = useStore((s) => s.streams[id]?.text);
  if (text === undefined) return null;
  return (
    <div className="cp-line them">
      <div className="msg employee cp-streaming" data-stream={id}>
        {text}
        <i className="cp-caret" aria-hidden />
      </div>
    </div>
  );
}

function LiveDot({ id, on }: { id: string; on: boolean }) {
  const streaming = useStore((s) => Boolean(s.streams[id]));
  return on || streaming ? <i className={`cp-live ${streaming ? 'streaming' : ''}`} aria-label={streaming ? 'writing now' : 'working'} /> : null;
}

function Card({ m, state, employees }: { m: Req; state: ReqState; employees: Employee[] }) {
  const to = m.to;
  return (
    <button className="cp-card" data-req={m.id} style={{ ['--who' as string]: avatarColor(to) }} onClick={() => set({ chatSub: m.id })}>
      <i className="cp-av sm" style={{ background: avatarColor(to) }} aria-hidden>{nameOf(employees, to)[0]}</i>
      <span className="cp-card-main">
        <span className="cp-card-who">{nameOf(employees, to)}</span>
        <span className="cp-card-title">{m.title || m.text}</span>
      </span>
      <Chip state={state} />
      <LiveDot id={to} on={state.kind === 'working'} />
    </button>
  );
}

function Tracker({ item, state, employees }: { item: Extract<Item, { t: 'gauntlet' }>; state: ReqState; employees: Employee[] }) {
  const { m, rounds, maxRounds } = item;
  const last = [...rounds].reverse().find((r) => r.verdict)?.verdict;
  const round = Math.max(rounds.length, 1);
  return (
    <button className="cp-card cp-gauntlet" data-gauntlet={m.id} onClick={() => set({ chatSub: m.id })}>
      <span className="cp-card-main">
        <span className="cp-card-who">Gauntlet</span>
        <span className="cp-card-title">{m.title || m.text}</span>
        <span className="cp-rounds">
          <span className="cp-round-now">{maxRounds ? `Round ${round} of ${maxRounds}` : `Round ${round}`}</span>
          {rounds.map((r) => (
            <i key={r.n} className={`cp-pip ${r.verdict ? (r.verdict.pass ? 'pass' : 'fail') : 'run'}`} title={r.verdict ? (r.verdict.pass ? 'Critic passed it' : `Critic: ${r.verdict.findings.length} findings`) : 'In progress'} />
          ))}
          <span className="cp-verdict">{last ? (last.pass ? 'Critic passed it' : `Critic failed it, ${last.findings.length} ${last.findings.length === 1 ? 'finding' : 'findings'}`) : 'No verdict yet'}</span>
        </span>
        <span className="cp-card-who" style={{ fontWeight: 500 }}>
          {m.gauntlet ? `${nameOf(employees, m.gauntlet.builder)} builds, ${nameOf(employees, m.gauntlet.critic)} reviews` : ''}
        </span>
      </span>
      <Chip state={state} />
      <LiveDot id={m.gauntlet?.builder ?? ''} on={state.kind === 'working'} />
    </button>
  );
}

function Line({ item, states, employees, labels, waitingOn }: { item: Item; states: Map<MessageId, ReqState>; employees: Employee[]; labels: boolean; waitingOn: Map<MessageId, string> }) {
  switch (item.t) {
    case 'note':
      return <div className="cp-note">{item.m.text}</div>;
    case 'card':
      return <Card m={item.m} state={states.get(item.m.id) ?? { kind: 'unknown' }} employees={employees} />;
    case 'gauntlet':
      return <Tracker item={item} state={states.get(item.m.id) ?? { kind: 'unknown' }} employees={employees} />;
    case 'bubble': {
      const { m, side } = item;
      const state = m.kind === 'request' && side === 'owner' ? (states.get(m.id) ?? { kind: 'unknown' }) : null;
      return (
        <div className={`cp-line ${side}`}>
          {labels && side === 'them' && <small className="cp-from">{nameOf(employees, m.from)}</small>}
          <div className={`msg ${side === 'owner' ? 'owner' : 'employee'}`}>{m.text}</div>
          <div className="cp-meta">
            {m.kind === 'reply' && m.auto && <span className="cp-auto" title="The office wrote this from the end of the turn">auto</span>}
            {m.kind === 'reply' && m.artifact?.map((a) => (
              <span key={a} className="cp-artifact" title={a}>
                {a}
              </span>
            ))}
            {state && <Chip state={state} />}
            {state?.kind === 'working' && waitingOn.has(m.id) && <span className="cp-chip waiting">waiting on {waitingOn.get(m.id)}</span>}
            {state?.kind === 'queued' && (
              <button className="cp-undo" onClick={() => send({ type: 'cancel_message', messageId: m.id })}>
                Cancel
              </button>
            )}
            <time>{hhmm(m.at)}</time>
          </div>
        </div>
      );
    }
  }
}

export function Thread({ who }: { who: Employee }) {
  countRender('thread');
  const sub = useStore((s) => s.chatSub);
  const mail = useStore((s) => s.mail);
  const history = useStore((s) => s.history);
  const pending = useStore((s) => s.pending);
  const employees = useStore((s) => s.company?.employees) ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  const messages = useMemo(() => mergeMessages(mail.tail, ...Object.values(history).map((h) => h.messages)), [mail.tail, history]);
  const items = useMemo(() => (sub ? chainThread(messages, sub) : personThread(messages, who.id)), [messages, sub, who.id]);
  const states = useMemo(() => requestStates(mail, messages), [mail, messages]);
  const subRoot = sub ? messages.find((m) => m.id === sub) : undefined;
  const speaker = subRoot && subRoot.kind === 'request' ? subRoot.to : who.id;
  const mine = pending.filter((p) => p.to === speaker || (p.to === 'po' && !sub && who.role === 'orchestrator'));
  const convo = `dm:${who.id}` as const;
  const more = history[convo] ? history[convo].hasMore : mail.tail.length >= MAIL_TAIL;

  useLayoutEffect(() => {
    stuck.current = true;
  }, [who.id, sub]);
  // Follow the bottom while the owner is there. A scroll up lets go, and a token never drags the view back.
  useEffect(() => {
    const el = scroller.current;
    const box = content.current;
    if (!el || !box) return;
    const follow = () => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    };
    follow();
    const ro = new ResizeObserver(follow);
    ro.observe(box);
    return () => ro.disconnect();
  }, [who.id, sub]);

  const waitingOn = useMemo(() => {
    const by = new Map<MessageId, string[]>();
    for (const r of mail.open) if (r.parentId && r.life.s !== 'running') by.set(r.parentId, [...(by.get(r.parentId) ?? []), nameOf(employees, r.to)]);
    return new Map([...by].map(([id, names]) => [id, [...new Set(names)].join(', ')]));
  }, [mail.open, employees]);

  const oldest = messages.find((m) => m.kind !== 'event' && (m.from === who.id || m.to === who.id));
  const empty = items.length === 0 && mine.length === 0;
  return (
    <div
      ref={scroller}
      className="thread cp-thread"
      role="log"
      aria-live="polite"
      onScroll={(ev) => {
        const el = ev.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      <div ref={content} className="cp-thread-inner">
        {!sub && more && oldest && (
          <button className="link cp-earlier" onClick={() => send({ type: 'load_history', convo, before: oldest.id, limit: MAIL_TAIL })}>
            Load earlier messages
          </button>
        )}
        {empty && <p className="muted cp-empty">{sub ? 'Nothing in this request yet.' : `Nothing here yet. Ask ${who.name} for something and the reply shows up in this thread.`}</p>}
        {items.map((item) => (
          <Line key={item.m.id} item={item} states={states} employees={employees} labels={Boolean(sub)} waitingOn={waitingOn} />
        ))}
        {mine.map((p) => (
          <div key={p.clientId} className="cp-line owner">
            <div className="msg owner">{p.text}</div>
            <div className="cp-meta">
              <span className="cp-chip sending">sending…</span>
            </div>
          </div>
        ))}
        <StreamBubble id={speaker} />
      </div>
    </div>
  );
}
