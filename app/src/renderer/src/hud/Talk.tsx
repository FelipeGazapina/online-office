import { useEffect, useRef, useState } from 'react';
import { PROVIDERS, type Employee } from '../../../shared/protocol.ts';
import { routeText, cardMicOn, speechSupported, toggleCardMic } from '../talk.ts';
import { set, useStore, waitingQueue } from '../store.ts';
import { fmtWait, useNow } from './hooks.ts';

function useEmployee(id: string | null): Employee | undefined {
  return useStore((s) => (id ? s.company?.employees.find((e) => e.id === id) : undefined));
}

function routeHint(e: Employee, interrupt: string) {
  if (e.status.kind === 'blocked_on_owner') return 'Answers their question';
  if (e.status.kind === 'working') return interrupt === 'now' ? 'Hard stop: they drop everything' : 'Tap on the shoulder: read at their next step';
  return 'Gives them a task';
}

function QuestionCard({ e }: { e: Employee }) {
  const now = useNow(1000);
  const company = useStore((s) => s.company);
  const micActive = useStore((s) => s.voice.active);
  const supported = useStore((s) => s.voice.supported);
  const [text, setText] = useState('');
  const [micOn, setMicOn] = useState(false);
  useEffect(() => {
    if (!micActive) setMicOn(false);
  }, [micActive]);
  if (e.status.kind !== 'blocked_on_owner') return null;
  const q = e.status.question;
  const block = company?.blocks.find((b) => b.id === e.blockId);
  const p = PROVIDERS[e.provider];
  const others = waitingQueue(company).length - 1;

  return (
    <form
      className={`qcard ${q.kind}`}
      style={{ ['--pc' as string]: p.color }}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!text.trim()) return;
        routeText(e.id, text);
        setText('');
        (document.activeElement as HTMLElement | null)?.blur();
      }}
    >
      <header>
        <i className="pdot" />
        <b>{e.name}</b>
        <span className="in">in {block?.name ?? 'the office'}</span>
        <span className="prov">{p.label}</span>
        {q.kind === 'permission' && <span className="perm-tag">Permission</span>}
        <span className="wait">{fmtWait(now - q.askedAt)}</span>
        <button type="button" className="x" title="Minimize" onClick={() => set({ cardMinimized: true })}>
          –
        </button>
      </header>
      <p className="question">{q.text}</p>
      {q.kind === 'permission' ? (
        <>
          <pre className="cmd">
            <span>{q.tool}</span>
            {q.detail}
          </pre>
          <div className="opts">
            <button type="button" className="btn allow" onClick={() => routeText(e.id, 'Allow')}>
              Allow
            </button>
            <button type="button" className="btn deny" onClick={() => routeText(e.id, 'Deny')}>
              Deny
            </button>
          </div>
        </>
      ) : (
        q.options && (
          <div className="opts">
            {q.options.map((o) => (
              <button type="button" key={o} className="btn primary" onClick={() => routeText(e.id, o)}>
                {o}
              </button>
            ))}
          </div>
        )
      )}
      <div className="reply">
        <input
          id="card-input"
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          placeholder={q.kind === 'permission' ? 'Or tell them what to do instead' : 'Or answer in your own words'}
        />
        <button
          type="button"
          className={`btn mic ${micOn ? 'on' : ''}`}
          disabled={!supported}
          title={supported ? 'Answer by voice' : 'Voice input is not available yet. Type instead.'}
          onClick={() => {
            toggleCardMic();
            setMicOn(cardMicOn());
          }}
        >
          {micOn ? 'Listening' : 'Mic'}
        </button>
        <button type="submit" className="btn ink" disabled={!text.trim()}>
          Answer
        </button>
      </div>
      {others > 0 && <footer>{others} more waiting behind {e.name}</footer>}
    </form>
  );
}

function ChatBar({ target }: { target: Employee | undefined }) {
  const interrupt = useStore((s) => s.interrupt);
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  return (
    <form
      className={`chat ${target ? '' : 'idle'}`}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (target && text.trim()) routeText(target.id, text);
        setText('');
        ref.current?.blur();
      }}
    >
      <span className="to">{target ? <>To <b>{target.name}</b></> : 'Nobody in earshot'}</span>
      <input
        id="chat-input"
        ref={ref}
        value={text}
        disabled={!target}
        onChange={(ev) => setText(ev.target.value)}
        placeholder={target ? 'Press Enter to type' : 'Walk up to someone, then talk or press Enter to type'}
      />
      {target && <span className="route">{routeHint(target, interrupt)}</span>}
    </form>
  );
}

export function Bottom() {
  const s = useStore();
  const asker = useEmployee(s.askerId);
  const talking = useEmployee(s.talkingTo);
  const selected = useEmployee(s.selectedId);
  const showCard = asker && asker.status.kind === 'blocked_on_owner' && !s.cardMinimized;
  const target = talking ?? asker ?? selected;

  return (
    <div className="bottom">
      {talking && (
        <div className="talk-badge">
          <i className={s.voice.active ? 'live' : ''} />
          Talking to <b>{talking.name}</b>
          <span>
            {s.voice.active
              ? 'listening'
              : !speechSupported || s.voice.note
                ? 'mic unavailable, press Enter to type'
                : s.mic === 'push'
                  ? 'hold V to talk'
                  : 'mic starting'}
          </span>
        </div>
      )}
      {s.voice.interim && <div className="interim">“{s.voice.interim}”</div>}
      {asker && s.cardMinimized && asker.status.kind === 'blocked_on_owner' && (
        <button className="qmini" onClick={() => set({ cardMinimized: false })}>
          <b>{asker.name}</b> is waiting for an answer
        </button>
      )}
      {showCard && <QuestionCard e={asker} />}
      {(!showCard || (talking && talking.id !== asker?.id)) && <ChatBar target={target} />}
    </div>
  );
}
