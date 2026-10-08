import { useEffect, useRef, useState } from 'react';
import { PROVIDERS, type Employee } from '../../../shared/protocol.ts';
import { routeText, toggleCardMic } from '../talk.ts';
import { set, setSetting, useStore, waitingQueue } from '../store.ts';
import { setVoicesMuted } from '../audio.ts';
import { chipLine, chipOf, type ChipAction } from '../voice/chip.ts';
import { micLevel } from '../voice/mic.ts';
import { fmtWait, useNow } from './hooks.ts';

function useEmployee(id: string | null): Employee | undefined {
  return useStore((s) => (id ? s.company?.employees.find((e) => e.id === id) : undefined));
}

function routeHint(e: Employee, interrupt: string) {
  if (e.status.kind === 'blocked_on_owner') return 'Answers their question';
  if (e.status.kind === 'working') return interrupt === 'now' ? 'Hard stop: they drop everything' : 'Tap on the shoulder: read at their next step';
  return 'Gives them a task';
}

const CHIP_ACTIONS: Record<ChipAction, { label: string; run: () => void }> = {
  check_again: { label: 'Check again', run: () => window.office.voice.recheck() },
  try_again: { label: 'Try again', run: () => window.office.voice.recheck() },
  open_mic_settings: { label: 'Open System Settings', run: () => window.office.voice.mic.openSettings() },
};

// Read on a timer, so the meter moves 20 times a second without React rendering anything.
function Meter() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const timer = setInterval(() => ref.current?.style.setProperty('--level', String(micLevel())), 50);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="meter" ref={ref}>
      <span className="oo:block" />
    </span>
  );
}

function VoiceChip({ name }: { name: string }) {
  const voice = useStore((s) => s.voice);
  const mode = useStore((s) => s.mic);
  const micMuted = useStore((s) => s.micMuted);
  const chip = chipOf(voice, mode, micMuted);
  const action = chip.action && CHIP_ACTIONS[chip.action];
  return (
    <div className={`talk-badge ${chip.tone} oo:rounded-full oo:border oo:border-hud-border oo:bg-hud-card oo:px-3 oo:py-1 oo:text-xs oo:text-hud-text oo:shadow-lg oo:transition-colors oo:duration-150`}>
      <i className={chip.tone === 'live' ? 'live' : ''} />
      Talking to <b>{name}</b>
      <span>
        {chip.text} {chip.command && <code>{chip.command}</code>}
      </span>
      {chip.meter && <Meter />}
      {action && (
        <button type="button" className="chip-btn oo:rounded-full oo:bg-hud-warm oo:px-2 oo:py-1 oo:font-semibold oo:text-hud-surface oo:transition-colors oo:duration-150 oo:hover:bg-hud-accent oo:focus-visible:outline-2 oo:focus-visible:outline-brand oo:focus-visible:outline-offset-2" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

function QuestionCard({ e }: { e: Employee }) {
  const now = useNow(1000);
  const company = useStore((s) => s.company);
  const voice = useStore((s) => s.voice);
  const mode = useStore((s) => s.mic);
  const micMuted = useStore((s) => s.micMuted);
  const chip = chipOf(voice, mode, micMuted);
  const [text, setText] = useState('');
  if (e.status.kind !== 'blocked_on_owner') return null;
  const q = e.status.question;
  const block = company?.blocks.find((b) => b.id === e.blockId);
  const p = PROVIDERS[e.provider];
  const others = waitingQueue(company).length - 1;

  return (
    <form
      className={`qcard ${q.kind} oo:rounded-2xl oo:bg-hud-card oo:text-hud-text oo:shadow-2xl`}
      style={{ ['--pc' as string]: p.color }}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!text.trim()) return;
        routeText(e.id, text);
        setText('');
        (document.activeElement as HTMLElement | null)?.blur();
      }}
    >
      <header className="oo:flex oo:items-center oo:gap-2">
        <i className="pdot" />
        <b>{e.name}</b>
        <span className="in">in {block?.name ?? 'the office'}</span>
        <span className="prov">{p.label}</span>
        {q.kind === 'permission' && <span className="perm-tag">Permission</span>}
        <span className="wait">{fmtWait(now - q.askedAt)}</span>
        <button type="button" className="x oo:rounded-lg oo:bg-hud-surface oo:text-hud-muted oo:hover:text-hud-accent" title="Minimize" onClick={() => set({ cardMinimized: true })}>
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
          <div className="opts oo:flex oo:flex-wrap oo:gap-2">
            <button type="button" className="btn allow oo:rounded-lg oo:transition-colors oo:duration-150 oo:hover:bg-hud-accent oo:focus-visible:outline-2 oo:focus-visible:outline-brand oo:focus-visible:outline-offset-2" onClick={() => routeText(e.id, 'Allow')}>
              Allow
            </button>
            <button type="button" className="btn deny oo:rounded-lg oo:transition-colors oo:duration-150 oo:hover:bg-hud-accent oo:focus-visible:outline-2 oo:focus-visible:outline-brand oo:focus-visible:outline-offset-2" onClick={() => routeText(e.id, 'Deny')}>
              Deny
            </button>
          </div>
        </>
      ) : (
        q.options && (
          <div className="opts oo:flex oo:flex-wrap oo:gap-2">
            {q.options.map((o) => (
              <button type="button" key={o} className="btn primary oo:rounded-lg oo:transition-colors oo:duration-150 oo:hover:bg-hud-accent oo:focus-visible:outline-2 oo:focus-visible:outline-brand oo:focus-visible:outline-offset-2" onClick={() => routeText(e.id, o)}>
                {o}
              </button>
            ))}
          </div>
        )
      )}
      <div className="reply oo:flex oo:items-center oo:gap-2">
        <input
          className="oo:rounded-lg oo:border-hud-border oo:bg-hud-surface oo:px-2 oo:py-1 oo:text-hud-text oo:transition-colors oo:duration-150 oo:focus-visible:outline-2 oo:focus-visible:outline-brand oo:focus-visible:outline-offset-2"
          id="card-input"
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          placeholder={q.kind === 'permission' ? 'Or tell them what to do instead' : 'Or answer in your own words'}
        />
        <button
          type="button"
          className={`btn mic ${voice.cardMic ? 'on' : ''} oo:rounded-lg oo:transition-colors oo:duration-150 oo:hover:bg-hud-accent oo:focus-visible:outline-2 oo:focus-visible:outline-brand oo:focus-visible:outline-offset-2`}
          disabled={chip.tone === 'warn'}
          title={chip.tone === 'warn' ? chipLine(chip) : 'Answer by voice'}
          onClick={toggleCardMic}
        >
          {voice.cardMic ? 'Listening' : 'Mic'}
        </button>
        <button type="submit" className="btn ink oo:rounded-lg oo:transition-colors oo:duration-150 oo:hover:bg-hud-accent oo:focus-visible:outline-2 oo:focus-visible:outline-brand oo:focus-visible:outline-offset-2" disabled={!text.trim()}>
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
      className={`chat ${target ? '' : 'idle'} oo:flex oo:items-center oo:gap-2 oo:rounded-xl oo:border-hud-border oo:bg-hud-surface/90 oo:px-2 oo:py-1 oo:text-hud-text oo:shadow-xl`}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (target && text.trim()) routeText(target.id, text);
        setText('');
        ref.current?.blur();
      }}
    >
      <span className="to">{target ? <>To <b>{target.name}</b></> : 'Nobody in earshot'}</span>
      <input
        className="oo:rounded-lg oo:border-hud-border oo:bg-hud-card oo:px-2 oo:py-1 oo:text-hud-text oo:transition-colors oo:duration-150 oo:focus-visible:outline-2 oo:focus-visible:outline-brand oo:focus-visible:outline-offset-2"
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

// Two switches for working by chat only: the owner's microphone, and the employees' voices. Both stay set across restarts.
function MuteControls() {
  const micMuted = useStore((s) => s.micMuted);
  const voicesMuted = useStore((s) => s.voicesMuted);
  const pill = (muted: boolean) =>
    `mute-btn ${muted ? 'muted' : ''} oo:rounded-full oo:border oo:border-hud-border oo:px-3 oo:py-1 oo:text-xs oo:shadow-lg oo:transition-colors oo:duration-150 oo:focus-visible:outline-2 oo:focus-visible:outline-brand oo:focus-visible:outline-offset-2 ${muted ? 'oo:bg-hud-warm oo:text-hud-surface' : 'oo:bg-hud-card oo:text-hud-text oo:hover:bg-hud-surface'}`;
  return (
    <div className="mute-controls oo:flex oo:gap-2" role="group" aria-label="Voice">
      <button type="button" className={pill(micMuted)} aria-pressed={micMuted} data-testid="mute-mic" title={micMuted ? 'Your mic is off. Click to talk again' : 'Turn your mic off and type instead'} onClick={() => setSetting('micMuted', !micMuted)}>
        {micMuted ? 'Mic muted' : 'Mic on'}
      </button>
      <button type="button" className={pill(voicesMuted)} aria-pressed={voicesMuted} data-testid="mute-voices" title={voicesMuted ? 'Employees only write. Click to hear them again' : 'Stop employees speaking out loud; read them in the chat'} onClick={() => setVoicesMuted(!voicesMuted)}>
        {voicesMuted ? 'Voices muted' : 'Voices on'}
      </button>
    </div>
  );
}

export function Bottom() {
  // Field by field: a whole-store subscription here would redraw the bar on every streamed token.
  const meetingDoor = useStore((s) => s.meetingDoor);
  const cardMinimized = useStore((s) => s.cardMinimized);
  const asker = useEmployee(useStore((s) => s.askerId));
  const talking = useEmployee(useStore((s) => s.talkingTo));
  const selected = useEmployee(useStore((s) => s.selectedId));
  const s = { meetingDoor, cardMinimized };
  const showCard = s.meetingDoor === 'open' && asker && asker.status.kind === 'blocked_on_owner' && !s.cardMinimized;
  const visibleSelected = selected && (s.meetingDoor === 'open' || selected.status.kind !== 'blocked_on_owner') ? selected : undefined;
  const target = talking ?? (s.meetingDoor === 'open' ? asker : undefined) ?? visibleSelected;

  return (
    <div className="bottom" data-hud-resize-target="bottom-talk">
      <MuteControls />
      {talking && <VoiceChip name={talking.name} />}
      {s.meetingDoor === 'open' && asker && s.cardMinimized && asker.status.kind === 'blocked_on_owner' && (
        <button className="qmini" onClick={() => set({ cardMinimized: false })}>
          <b>{asker.name}</b> is waiting for an answer
        </button>
      )}
      {showCard && <QuestionCard e={asker} />}
      {(!showCard || (talking && talking.id !== asker?.id)) && <ChatBar target={target} />}
    </div>
  );
}
