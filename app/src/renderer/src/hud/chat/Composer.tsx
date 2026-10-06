import { useEffect, useRef, useState } from 'react';
import type { Employee } from '../../../../shared/protocol.ts';
import { get, send, set, useStore } from '../../store.ts';
import { isPo } from './model.ts';

const MAX_ROWS = 6;

// Where the next message goes: the person whose thread is open, or the PO of their block with one click.
export function Composer({ who, po, assignee }: { who: Employee; po: Employee | undefined; assignee: Employee | undefined }) {
  const toPo = useStore((s) => s.chatToPo);
  const sub = useStore((s) => s.chatSub);
  const interrupt = useStore((s) => s.interrupt);
  const [draft, setDraft] = useState('');
  const [steer, setSteer] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  const base = assignee ?? who;
  const target = toPo && po ? po : base;
  const viaPo = target.id === po?.id && target.id !== base.id;
  const canSwitch = Boolean(po) && !isPo(base);
  const busy = target.status.kind === 'working';

  // A thread opens ready to type in, unless a dialog is open: walking past someone must not take the cursor out of it.
  useEffect(() => {
    if (!get().modal) field.current?.focus();
  }, [who.id, sub]);
  useEffect(() => {
    setSteer(false);
  }, [target.id]);

  const grow = () => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    const row = parseFloat(getComputedStyle(el).lineHeight) || 18;
    const max = row * MAX_ROWS + 14;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  };
  useEffect(grow, [draft]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    const clientId = crypto.randomUUID();
    const status = target.status;
    if (status.kind === 'blocked_on_owner' && !viaPo) send({ type: 'answer', employeeId: target.id, questionId: status.question.id, text });
    else if (viaPo) send({ type: 'post', to: 'po', blockId: target.blockId, clientId, as: 'request', text });
    else if (steer && busy) send({ type: 'post', to: target.id, clientId, as: 'say', text, urgency: interrupt });
    else send({ type: 'post', to: target.id, clientId, as: 'request', text });
    setDraft('');
    setSteer(false);
    requestAnimationFrame(() => {
      if (field.current) field.current.style.height = 'auto';
    });
  };

  return (
    <form
      className="cp-compose"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
    >
      <div className="cp-compose-top">
        <button
          type="button"
          className={`cp-target ${viaPo ? 'po' : ''}`}
          data-target={target.id}
          disabled={!canSwitch}
          title={canSwitch ? (viaPo ? `Back to ${base.name}` : 'Send this to the PO instead') : undefined}
          onClick={() => set({ chatToPo: !toPo })}
        >
          To <b>{viaPo ? 'PO' : target.name}</b>
          {canSwitch && <span aria-hidden>{viaPo ? ' · change' : ' · ask PO'}</span>}
        </button>
        {busy && !viaPo && (
          <button type="button" className={`cp-steer ${steer ? 'on' : ''}`} aria-pressed={steer} title="Interrupt the current turn instead of waiting in line" onClick={() => setSteer(!steer)}>
            {steer ? 'Steering now' : 'Steer instead of queueing'}
          </button>
        )}
      </div>
      <div className="cp-compose-row">
        <textarea
          id="drawer-input"
          ref={field}
          rows={1}
          value={draft}
          placeholder={viaPo ? 'Give the PO a task' : `Message ${target.name}`}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              ev.preventDefault();
              if (sub) set({ chatSub: null });
              else set({ selectedId: null });
            } else if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
              ev.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" className="btn ink" disabled={!draft.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}
