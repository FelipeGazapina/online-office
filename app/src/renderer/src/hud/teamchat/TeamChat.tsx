// The Chat app on the owner's Mac, at the desk and on the laptop alike. It reads like a team chat: the projects down the left,
// then the people of the open project, then one conversation. A direct message is the owner and one employee. A team thread
// is two teammates talking to each other, one private thread per pair, which the owner reads along. Everything comes from the
// mailroom, and the owner's words go into it as `post`, the same way the chat drawer in the office sends them.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PROVIDERS, type Employee, type EmployeeId, type ProjectBlock } from '../../../../shared/protocol.ts';
import { betweenPair, pairKey, pairOf, type ConvoKey, type Message, type MessageId } from '../../../../shared/mail.ts';
import { send, set, useStore } from '../../store.ts';
import { avatarColor, chainThread, clock, isPo, liveState, mergeMessages, nameOf, pairThread, personThread, requestStates, rosterOf, teamPairs, textOf, unreadSince, type Item, type PairRow, type ReqState } from '../chat/model.ts';
import './teamchat.css';

const HISTORY = 200;
const GROUP_MS = 5 * 60_000;
const dmKey = (id: EmployeeId): ConvoKey => `dm:${id}`;
const hhmm = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function useMessages() {
  const tail = useStore((s) => s.mail.tail);
  const history = useStore((s) => s.history);
  return useMemo(() => mergeMessages(tail, ...Object.values(history).map((h) => h.messages)), [tail, history]);
}

// What the owner has not read from one employee: their own words to the owner since the owner last opened the conversation.
const dmUnread = (messages: Message[], id: EmployeeId, seen: Record<string, number>) =>
  unreadSince(messages.filter((m) => m.from === id && m.to === 'owner'), seen[dmKey(id)] ?? 0);

// The count on the Chat tab: unread direct messages over every project.
export function useChatUnread() {
  const messages = useMessages();
  const employees = useStore((s) => s.company?.employees);
  const seen = useStore((s) => s.chatSeen);
  return useMemo(() => (employees ?? []).reduce((n, e) => n + dmUnread(messages, e.id, seen), 0), [messages, employees, seen]);
}

// Every conversation of the project once when it opens, so the sidebar knows its threads, then the open one again as the mail
// moves (at most every 1.5 s), so a busy hour never scrolls its lines out of the live tail.
function useHistory(people: Employee[], convo: ConvoKey | null) {
  const seq = useStore((s) => s.mail.seq);
  const ids = people.map((e) => e.id).join(',');
  useEffect(() => {
    for (const e of people) send({ type: 'load_history', convo: dmKey(e.id), limit: HISTORY });
    for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) send({ type: 'load_history', convo: pairKey(people[i]!.id, people[j]!.id), limit: HISTORY });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const last = useRef(0);
  useEffect(() => {
    if (!convo) return;
    const t = setTimeout(() => {
      last.current = Date.now();
      send({ type: 'load_history', convo, limit: HISTORY });
    }, Math.max(0, last.current + 1500 - Date.now()));
    return () => clearTimeout(t);
  }, [convo, seq]);
}

export function TeamChat() {
  const blocks = useStore((s) => s.company?.blocks) ?? [];
  const employees = useStore((s) => s.company?.employees) ?? [];
  const tc = useStore((s) => s.teamChat);
  const seen = useStore((s) => s.chatSeen);
  const messages = useMessages();
  const block = blocks.find((b) => b.id === tc.blockId) ?? blocks.find((b) => employees.some((e) => e.blockId === b.id)) ?? blocks[0];
  const people = useMemo(() => (block ? rosterOf(employees, block.id, []).map((r) => r.employee) : []), [employees, block?.id]);
  const pairs = useMemo(() => (block ? teamPairs(employees, block.id, messages) : []), [employees, block?.id, messages]);
  const po = people.find(isPo) ?? people[0];
  const pair = tc.convo && pairOf(tc.convo);
  const valid = tc.convo && (pair ? pair.every((id) => people.some((e) => e.id === id)) : people.some((e) => dmKey(e.id) === tc.convo));
  const convo = valid ? tc.convo : po ? dmKey(po.id) : null;
  useHistory(people, convo);
  useEffect(() => {
    if (convo) set((s) => ({ chatSeen: { ...s.chatSeen, [convo]: Date.now() } }));
  }, [convo, messages.length]);

  return (
    <div className="tc-app" data-block={block?.id ?? ''} data-convo={convo ?? ''}>
      <nav className="tc-rail" aria-label="Projects">
        {blocks.map((b) => {
          const unread = employees.filter((e) => e.blockId === b.id).reduce((n, e) => n + dmUnread(messages, e.id, seen), 0);
          return (
            <button key={b.id} className={`tc-ws ${b.id === block?.id ? 'on' : ''}`} data-ws={b.id} title={b.name} aria-current={b.id === block?.id} style={{ background: b.color }} onClick={() => set({ teamChat: { blockId: b.id, convo: null, thread: null } })}>
              {b.name.slice(0, 2).toUpperCase()}
              {unread > 0 && b.id !== block?.id && <i className="tc-ws-badge">{unread}</i>}
            </button>
          );
        })}
      </nav>
      {!block ? (
        <Empty title="No projects yet" body="Choose a project folder in Configuration, then hire a team for it. Each project gets its own chat." />
      ) : (
        <>
          <Sidebar block={block} people={people} pairs={pairs} messages={messages} convo={convo} />
          {convo ? <Conversation key={convo} convo={convo} people={people} employees={employees} messages={messages} /> : <Empty title={`Nobody works on ${block.name} yet`} body="Hire a team for this project in Configuration. Its PO is the first person you talk to here." />}
          {tc.thread && <ThreadPane rootId={tc.thread} employees={employees} messages={messages} />}
        </>
      )}
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <section className="tc-main tc-empty">
      <b>{title}</b>
      <p>{body}</p>
    </section>
  );
}

function Sidebar({ block, people, pairs, messages, convo }: { block: ProjectBlock; people: Employee[]; pairs: PairRow[]; messages: Message[]; convo: ConvoKey | null }) {
  const seen = useStore((s) => s.chatSeen);
  const open = (c: ConvoKey) => set((s) => ({ teamChat: { ...s.teamChat, blockId: block.id, convo: c, thread: null } }));
  return (
    <aside className="tc-side" aria-label={`${block.name} conversations`}>
      <header className="tc-side-head">
        <b>{block.name}</b>
        <small>{people.length} {people.length === 1 ? 'teammate' : 'teammates'}</small>
      </header>
      <div className="tc-side-scroll">
        <h4>Direct messages</h4>
        {people.map((e) => (
          <PersonRow key={e.id} e={e} on={convo === dmKey(e.id)} unread={dmUnread(messages, e.id, seen)} onOpen={() => open(dmKey(e.id))} />
        ))}
        <h4>Team threads</h4>
        {pairs.length === 0 && <p className="tc-side-note">When teammates talk to each other, each pair gets its own thread here.</p>}
        {pairs.map((p) => {
          const unread = unreadSince(messages.filter((m) => betweenPair(m, p.a.id, p.b.id)), seen[p.key] ?? 0);
          return (
            <button key={p.key} className={`tc-row tc-pair ${convo === p.key ? 'on' : ''} ${unread ? 'unread' : ''}`} data-convo={p.key} onClick={() => open(p.key)}>
              <span className="tc-duo" aria-hidden>
                <i style={{ background: avatarColor(p.a.id) }}>{p.a.name[0]}</i>
                <i style={{ background: avatarColor(p.b.id) }}>{p.b.name[0]}</i>
              </span>
              <span className="tc-row-name">{p.a.name} ↔ {p.b.name}</span>
              <small className="tc-row-meta">{clock(p.last.at)}</small>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

const PersonRow = memo(function PersonRow({ e, on, unread, onOpen }: { e: Employee; on: boolean; unread: number; onOpen: () => void }) {
  const streaming = useStore((s) => Boolean(s.streams[e.id]));
  const actor = useStore((s) => s.mail.actors[e.id]);
  const openReqs = useStore((s) => s.mail.open);
  const live = liveState(e, actor, openReqs, streaming);
  return (
    <button className={`tc-row ${on ? 'on' : ''} ${unread ? 'unread' : ''}`} data-convo={dmKey(e.id)} title={live.text} onClick={onOpen}>
      <span className={`tc-presence ${live.kind}`} aria-hidden />
      <span className="tc-row-name">{e.name}</span>
      {isPo(e) && <small className="tc-tag po">PO</small>}
      {e.subagents.length > 0 && <small className="tc-tag sub" title={`${e.subagents.length} subagents running`}>⚡{e.subagents.length}</small>}
      {unread > 0 && <i className="tc-count">{unread}</i>}
    </button>
  );
});

function Conversation({ convo, people, employees, messages }: { convo: ConvoKey; people: Employee[]; employees: Employee[]; messages: Message[] }) {
  const mail = useStore((s) => s.mail);
  const states = useMemo(() => requestStates(mail, messages), [mail, messages]);
  const pair = pairOf(convo);
  const who = pair ? undefined : people.find((e) => dmKey(e.id) === convo);
  const a = pair && people.find((e) => e.id === pair[0]);
  const b = pair && people.find((e) => e.id === pair[1]);
  const items = useMemo(() => (pair ? pairThread(messages, pair[0], pair[1]) : who ? personThread(messages, who.id) : []), [messages, convo]);
  if (pair && a && b) {
    const [first, second] = isPo(b) ? [b, a] : [a, b];
    return (
      <section className="tc-main" aria-label={`${first.name} and ${second.name}`}>
        <header className="tc-head">
          <span className="tc-duo lg" aria-hidden>
            <i style={{ background: avatarColor(first.id) }}>{first.name[0]}</i>
            <i style={{ background: avatarColor(second.id) }}>{second.name[0]}</i>
          </span>
          <div className="tc-head-main">
            <h2>{first.name} ↔ {second.name}</h2>
            <div className="tc-head-sub">Private thread between two teammates · {items.length} {items.length === 1 ? 'message' : 'messages'}</div>
          </div>
          <Status e={first} />
          <Status e={second} />
        </header>
        <Feed items={items} states={states} employees={employees} empty={`${first.name} and ${second.name} have not talked yet.`} />
        <footer className="tc-readonly">
          <span>You are reading along. Teammates talk one to one here, so this thread is theirs.</span>
          <button className="tc-btn" onClick={() => set((s) => ({ teamChat: { ...s.teamChat, convo: dmKey(first.id), thread: null } }))}>Message {first.name}</button>
          <button className="tc-btn" onClick={() => set((s) => ({ teamChat: { ...s.teamChat, convo: dmKey(second.id), thread: null } }))}>Message {second.name}</button>
        </footer>
      </section>
    );
  }
  if (!who) return <Empty title="This conversation is gone" body="Pick someone on the left." />;
  return (
    <section className="tc-main" aria-label={`Chat with ${who.name}`}>
      <header className="tc-head">
        <i className="tc-av lg" style={{ background: avatarColor(who.id) }} aria-hidden>{who.name[0]}</i>
        <div className="tc-head-main">
          <h2>
            {who.name} <small className="tc-tag ai">AI</small> {isPo(who) && <small className="tc-tag po">PO</small>}
          </h2>
          <div className="tc-head-sub">
            {isPo(who) ? 'Product owner · gives the work to the team' : 'Employee'} · {PROVIDERS[who.provider].label} · {who.model}
          </div>
        </div>
        <Status e={who} />
      </header>
      <Subagents e={who} />
      <Feed items={items} states={states} employees={employees} who={who} empty={isPo(who) ? `Give ${who.name} a goal. The PO splits it, hands the pieces to the team and reports back here.` : `Ask ${who.name} for something and the reply shows up here.`} />
      <Ask e={who} />
      <Composer key={who.id} who={who} />
    </section>
  );
}

function Status({ e }: { e: Employee }) {
  const streaming = useStore((s) => Boolean(s.streams[e.id]));
  const actor = useStore((s) => s.mail.actors[e.id]);
  const open = useStore((s) => s.mail.open);
  const live = liveState(e, actor, open, streaming);
  const queued = actor?.queued ?? 0;
  return (
    <span className={`tc-status ${live.kind}`} data-status={e.id}>
      <i className={`tc-presence ${live.kind}`} aria-hidden />
      {e.name.split(' ')[0]}: {live.text}
      {queued > 0 && <em>{queued} queued</em>}
    </span>
  );
}

// The helpers an employee started for their own piece, while they run. A subagent a subagent started sits under its parent.
function Subagents({ e }: { e: Employee }) {
  if (e.subagents.length === 0) return null;
  const depth = (id: string | null, n = 0): number => (id ? depth(e.subagents.find((s) => s.id === id)?.parentId ?? null, n + 1) : n);
  return (
    <div className="tc-subagents" data-subagents={e.id}>
      <b>⚡ {e.subagents.length} {e.subagents.length === 1 ? 'subagent' : 'subagents'} running</b>
      {e.subagents.map((s) => (
        <span key={s.id} className="tc-sub" style={{ marginLeft: depth(s.parentId) * 10 }}>{s.label}</span>
      ))}
    </div>
  );
}

type Row = { item: Item; author: Message['from']; compact: boolean };

// Slack-style lines: a name and time over the first of a run, and the next lines of the same person within five minutes under it.
function rows(items: Item[]): Row[] {
  const out: Row[] = [];
  for (const item of items) {
    const prev = out.at(-1);
    const author = item.m.from;
    const plain = item.t === 'bubble';
    const compact = Boolean(prev && plain && prev.item.t === 'bubble' && prev.author === author && item.m.at - prev.item.m.at < GROUP_MS);
    out.push({ item, author, compact });
  }
  return out;
}

function Feed({ items, states, employees, who, empty }: { items: Item[]; states: Map<MessageId, ReqState>; employees: Employee[]; who?: Employee; empty: string }) {
  const pending = useStore((s) => s.pending);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const mine = who ? pending.filter((p) => p.to === who.id || (p.to === 'po' && isPo(who))) : [];
  const list = useMemo(() => rows(items), [items]);
  useLayoutEffect(() => {
    stuck.current = true;
  }, [who?.id]);
  // Follow the bottom while the owner is there. A scroll up lets go.
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
  }, []);
  return (
    <div ref={scroller} className="tc-feed" role="log" aria-live="polite" onScroll={(ev) => (stuck.current = ev.currentTarget.scrollHeight - ev.currentTarget.scrollTop - ev.currentTarget.clientHeight < 48)}>
      <div ref={content} className="tc-feed-inner">
        {list.length === 0 && mine.length === 0 && <p className="tc-feed-empty">{empty}</p>}
        {list.map((r) => (
          <Line key={r.item.m.id} row={r} states={states} employees={employees} />
        ))}
        {mine.map((p) => (
          <div key={p.clientId} className="tc-msg pending">
            <i className="tc-av owner" aria-hidden>Y</i>
            <div className="tc-msg-body">
              <div className="tc-msg-head"><b>You</b><time>sending…</time></div>
              <div className="tc-text">{p.text}</div>
            </div>
          </div>
        ))}
        {who && <Typing e={who} />}
      </div>
    </div>
  );
}

function Typing({ e }: { e: Employee }) {
  const text = useStore((s) => s.streams[e.id]?.text);
  if (text === undefined) return null;
  return (
    <div className="tc-msg streaming" data-stream={e.id}>
      <i className="tc-av" style={{ background: avatarColor(e.id) }} aria-hidden>{e.name[0]}</i>
      <div className="tc-msg-body">
        <div className="tc-msg-head"><b>{e.name}</b><time>typing…</time></div>
        <div className="tc-text">{text}<i className="tc-caret" aria-hidden /></div>
      </div>
    </div>
  );
}

function Chip({ state }: { state: ReqState | undefined }) {
  if (!state || state.kind === 'unknown') return null;
  if (state.kind === 'queued') return <span className="tc-chip queued">{state.ahead > 0 ? `queued · ${state.ahead} ahead` : 'queued'}</span>;
  if (state.kind === 'working') return <span className="tc-chip working">working</span>;
  return <span className={`tc-chip ${state.outcome}`}>{state.outcome}</span>;
}

function Avatar({ who, employees }: { who: Message['from']; employees: Employee[] }) {
  if (who === 'owner') return <i className="tc-av owner" aria-hidden>Y</i>;
  if (who === 'mailroom') return <i className="tc-av office" aria-hidden>⚙</i>;
  return <i className="tc-av" style={{ background: avatarColor(who) }} aria-hidden>{nameOf(employees, who)[0]}</i>;
}

function Line({ row, states, employees }: { row: Row; states: Map<MessageId, ReqState>; employees: Employee[] }) {
  const { item, author, compact } = row;
  if (item.t === 'note') return <div className="tc-note">{item.m.text}</div>;
  const m = item.m;
  const name = nameOf(employees, author);
  const bot = author !== 'owner';
  const openThread = (id: MessageId) => set((s) => ({ teamChat: { ...s.teamChat, thread: id } }));
  return (
    <div className={`tc-msg ${compact ? 'compact' : ''}`} data-msg={m.id} data-kind={m.kind}>
      {compact ? <time className="tc-gutter">{hhmm(m.at)}</time> : <Avatar who={author} employees={employees} />}
      <div className="tc-msg-body">
        {!compact && (
          <div className="tc-msg-head">
            <b>{name}</b>
            {bot && author !== 'mailroom' && <small className="tc-tag ai">AI</small>}
            {m.to !== 'owner' && m.to !== 'mailroom' && item.t !== 'bubble' && <span className="tc-to">→ {nameOf(employees, m.to)}</span>}
            <time>{hhmm(m.at)}</time>
          </div>
        )}
        {item.t === 'bubble' && (
          <>
            {m.kind === 'request' && m.title && m.title !== m.text && <b className="tc-title">{m.title}</b>}
            <div className="tc-text">{m.kind === 'request' ? m.text : textOf(m)}</div>
            {(m.kind === 'reply' || (m.kind === 'request' && m.from === 'owner')) && (
              <div className="tc-meta">
                {m.kind === 'reply' && <span className={`tc-chip ${m.outcome}`}>{m.outcome}</span>}
                {m.kind === 'reply' && m.auto && <span className="tc-auto" title="The office wrote this from the end of the turn">auto</span>}
                {m.kind === 'reply' && m.artifact?.map((x) => <code key={x} className="tc-artifact">{x}</code>)}
                {m.kind === 'request' && <Chip state={states.get(m.id)} />}
                {m.kind === 'request' && <button className="tc-link" onClick={() => openThread(m.id)}>View thread</button>}
                {m.kind === 'request' && states.get(m.id)?.kind === 'queued' && <button className="tc-link" onClick={() => send({ type: 'cancel_message', messageId: m.id })}>Cancel</button>}
              </div>
            )}
          </>
        )}
        {item.t === 'card' && (
          <button className="tc-card" data-req={item.m.id} style={{ ['--who' as string]: item.m.to === 'mailroom' ? '#8a8fa8' : avatarColor(item.m.to) }} onClick={() => openThread(item.m.id)}>
            <span className="tc-card-kind">{item.m.intent === 'help' ? 'Question' : item.m.intent === 'review' ? 'Review' : 'Task'} for {nameOf(employees, item.m.to)}</span>
            <b>{item.m.title || item.m.text}</b>
            {item.m.title && item.m.text !== item.m.title && <span className="tc-card-text">{item.m.text}</span>}
            {item.m.bar && item.m.bar.length > 0 && (
              <ul>
                {item.m.bar.slice(0, 3).map((x) => <li key={x}>{x}</li>)}
              </ul>
            )}
            <span className="tc-card-foot"><Chip state={states.get(item.m.id)} /><span className="tc-link">View thread ›</span></span>
          </button>
        )}
        {item.t === 'gauntlet' && (
          <button className="tc-card gauntlet" data-gauntlet={item.m.id} onClick={() => openThread(item.m.id)}>
            <span className="tc-card-kind">Gauntlet · {item.m.gauntlet ? `${nameOf(employees, item.m.gauntlet.builder)} builds, ${nameOf(employees, item.m.gauntlet.critic)} reviews` : 'builder and critic'}</span>
            <b>{item.m.title || item.m.text}</b>
            <span className="tc-rounds">
              {item.rounds.map((r) => <i key={r.n} className={`tc-pip ${r.verdict ? (r.verdict.pass ? 'pass' : 'fail') : 'run'}`} title={`Round ${r.n}`} />)}
              <small>Round {Math.max(item.rounds.length, 1)}{item.maxRounds ? ` of ${item.maxRounds}` : ''}</small>
            </span>
            <span className="tc-card-foot"><Chip state={states.get(item.m.id)} /><span className="tc-link">View thread ›</span></span>
          </button>
        )}
      </div>
    </div>
  );
}

// The question an employee is waiting on, answered from here: the owner does not have to walk over.
function Ask({ e }: { e: Employee }) {
  if (e.status.kind !== 'blocked_on_owner') return null;
  const q = e.status.question;
  const answer = (text: string) => send({ type: 'answer', employeeId: e.id, questionId: q.id, text });
  const options = q.kind === 'permission' ? ['Allow', 'Deny'] : (q.options ?? []);
  return (
    <div className="tc-ask" data-ask={e.id}>
      <b>{e.name} is waiting on you</b>
      <p>{q.text}</p>
      {q.kind === 'permission' && <code>{q.tool}: {q.detail}</code>}
      {options.length > 0 && (
        <div className="tc-ask-options">
          {options.map((o) => <button key={o} className="tc-btn" onClick={() => answer(o)}>{o}</button>)}
        </div>
      )}
    </div>
  );
}

function Composer({ who }: { who: Employee }) {
  const interrupt = useStore((s) => s.interrupt);
  const [draft, setDraft] = useState('');
  const [steer, setSteer] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const busy = who.status.kind === 'working';
  const asking = who.status.kind === 'blocked_on_owner';
  useEffect(() => field.current?.focus(), [who.id]);
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    const clientId = crypto.randomUUID();
    if (who.status.kind === 'blocked_on_owner') send({ type: 'answer', employeeId: who.id, questionId: who.status.question.id, text });
    else if (steer && busy) send({ type: 'post', to: who.id, clientId, as: 'say', text, urgency: interrupt });
    else send({ type: 'post', to: who.id, clientId, as: 'request', text });
    setDraft('');
    setSteer(false);
  };
  return (
    <form className="tc-compose" onSubmit={(ev) => (ev.preventDefault(), submit())}>
      <textarea
        ref={field}
        id="teamchat-input"
        rows={2}
        value={draft}
        placeholder={asking ? `Answer ${who.name}` : isPo(who) ? `Give ${who.name} a goal for the team` : `Message ${who.name}`}
        onChange={(ev) => setDraft(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
            ev.preventDefault();
            submit();
          }
        }}
      />
      <div className="tc-compose-bar">
        <small>{asking ? 'Your answer goes straight to the question.' : busy ? (steer ? `Interrupts ${who.name} now.` : `Queues after what ${who.name} is doing.`) : 'Enter sends · Shift+Enter for a new line'}</small>
        {busy && <button type="button" className={`tc-btn ${steer ? 'on' : ''}`} aria-pressed={steer} onClick={() => setSteer(!steer)}>{steer ? 'Steering now' : 'Steer instead'}</button>}
        <button type="submit" className="tc-btn send" disabled={!draft.trim()}>Send</button>
      </div>
    </form>
  );
}

// A request and everything under it: who said what about it and the work it was split into, beside the conversation.
function ThreadPane({ rootId, employees, messages }: { rootId: MessageId; employees: Employee[]; messages: Message[] }) {
  const mail = useStore((s) => s.mail);
  const states = useMemo(() => requestStates(mail, messages), [mail, messages]);
  const items = useMemo(() => chainThread(messages, rootId), [messages, rootId]);
  const root = messages.find((m) => m.id === rootId);
  return (
    <aside className="tc-thread" aria-label="Thread" data-thread={rootId}>
      <header className="tc-head">
        <div className="tc-head-main">
          <h2>Thread</h2>
          <div className="tc-head-sub">{root ? textOf(root) : 'Request'}</div>
        </div>
        <button className="tc-x" title="Close the thread" onClick={() => set((s) => ({ teamChat: { ...s.teamChat, thread: null } }))}>×</button>
      </header>
      <Feed items={items} states={states} employees={employees} empty="Nothing in this thread yet." />
    </aside>
  );
}
