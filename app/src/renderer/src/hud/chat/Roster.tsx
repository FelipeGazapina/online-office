import { memo } from 'react';
import type { Employee } from '../../../../shared/protocol.ts';
import type { ActorView, Message, RequestView } from '../../../../shared/mail.ts';
import { openChat, useStore } from '../../store.ts';
import { avatarColor, clock, isPo, liveState, nameOf, textOf } from './model.ts';
import { countRender } from './renders.ts';

type RowProps = { employee: Employee; employees: Employee[]; actor: ActorView | undefined; open: RequestView[]; last: Message | null; active: boolean };

// Rows subscribe to one boolean of the streams, so a token never reaches them. Only the first and last token of a bubble do.
const Row = memo(function Row({ employee, employees, actor, open, last, active }: RowProps) {
  countRender(`row:${employee.name}`);
  const streaming = useStore((s) => Boolean(s.streams[employee.id]));
  const live = liveState(employee, actor, open, streaming);
  const queued = actor?.queued ?? 0;
  const preview = last ? `${last.from === employee.id ? '' : `${nameOf(employees, last.from)}: `}${textOf(last)}` : 'No messages yet';
  return (
    <button className={`cp-person ${active ? 'on' : ''}`} data-emp={employee.id} aria-current={active} onClick={() => openChat(employee.id, { chatSub: null, chatDetails: false })}>
      <i className={`cp-av ${live.kind}`} style={{ background: avatarColor(employee.id) }} aria-hidden>{employee.name[0]}</i>
      <span className="cp-person-main">
        <span className="cp-person-top">
          <b>{employee.name}</b>
          {isPo(employee) && <small className="cp-badge">PO</small>}
          {last && <time>{clock(last.at)}</time>}
        </span>
        <span className="cp-state-line">
          <span className={`cp-live-state ${live.kind}`}>{live.text}</span>
          {queued > 0 && <span className="cp-queue">{queued} queued</span>}
        </span>
        <span className="cp-preview">{preview}</span>
      </span>
    </button>
  );
});

export function Roster({ people, lasts, blockName }: { people: Employee[]; lasts: (Message | null)[]; blockName: string }) {
  countRender('roster');
  const selectedId = useStore((s) => s.selectedId);
  const actors = useStore((s) => s.mail.actors);
  const open = useStore((s) => s.mail.open);
  return (
    <nav className="cp-roster" aria-label={`People in ${blockName}`}>
      <div className="cp-roster-head">{blockName}</div>
      <div className="cp-roster-list">
        {people.map((employee, i) => (
          <Row key={employee.id} employee={employee} employees={people} actor={actors[employee.id]} open={open} last={lasts[i]} active={employee.id === selectedId} />
        ))}
      </div>
    </nav>
  );
}
