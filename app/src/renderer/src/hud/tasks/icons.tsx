import type { ReactNode } from 'react';
import type { TaskProvider } from '../../../../shared/protocol.ts';
import type { Board, Priority, TaskStage } from '../../../../shared/tasks.ts';

type P = { size?: number };
const Svg = ({ size = 16, children, className }: P & { children: ReactNode; className?: string }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

// The same four marks a status column has in a tracker: empty, half, nearly, done.
export function StageIcon({ stage, size = 16 }: P & { stage: TaskStage }) {
  const color = { todo: '#9b9db3', doing: '#e8920f', review: '#5457e0', done: '#2f9e6e' }[stage];
  const pie = { todo: '', doing: 'M8 8V3.2A4.8 4.8 0 0 1 8 12.8z', review: 'M8 8V3.2A4.8 4.8 0 1 1 3.2 8z', done: '' }[stage];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={{ color }}>
      {stage === 'done' ? (
        <>
          <circle cx="8" cy="8" r="6.4" fill="currentColor" />
          <path d="M5.2 8.2l2 2 3.6-4.1" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={stage === 'todo' ? '2.2 2.2' : undefined} />
          {pie && <path d={pie} fill="currentColor" />}
        </>
      )}
    </svg>
  );
}

export const KindIcon = ({ kind, size }: P & { kind: Board['kind'] }) =>
  kind === 'feature' ? (
    <Svg size={size}><path d="M8 2l1.5 3.8L13.3 7.3 9.5 8.8 8 12.6 6.5 8.8 2.7 7.3 6.5 5.8z" /></Svg>
  ) : kind === 'bug' ? (
    <Svg size={size}><ellipse cx="8" cy="9.2" rx="3" ry="3.8" /><path d="M8 5.4v7.6M5 9.2H2.6M13.4 9.2H11M5.6 6.2L3.6 4.4M10.4 6.2l2-1.8M5.5 12.2l-2 1.4M10.5 12.2l2 1.4M6.4 4.4a1.7 1.7 0 0 1 3.2 0" /></Svg>
  ) : (
    <Svg size={size}><path d="M9.2 1.8L4 9h3.7l-.9 5.2L12 7H8.3z" /></Svg>
  );

// A small tile the way a tracker marks where a card came from.
export function OriginTile({ kind }: { kind: 'manual' | TaskProvider }) {
  return (
    <span className={`tb-origin-tile ${kind}`} aria-hidden="true">
      {kind === 'linear' ? (
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M2.4 9.6l4 4M2.4 6l7.6 7.6M4 3.2l8.8 8.8M7.2 2.2l6.6 6.6M10.8 2.2l3 3" /></svg>
      ) : kind === 'cronospark' ? (
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="5.6" /><path d="M8 4.6V8l2.2 1.4" /></svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13l.7-3L11 2.7a1.5 1.5 0 0 1 2.1 2.1L5.8 12.2z" /></svg>
      )}
    </span>
  );
}

export const Plus = ({ size }: P) => <Svg size={size}><path d="M8 3v10M3 8h10" /></Svg>;
export const Close = ({ size }: P) => <Svg size={size}><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
export const Sync = ({ size, className }: P & { className?: string }) => <Svg size={size} className={className}><path d="M13 7a5 5 0 0 0-9.2-2M3 2.6V5h2.4M3 9a5 5 0 0 0 9.2 2M13 13.4V11h-2.4" /></Svg>;
export const Sliders = ({ size }: P) => <Svg size={size}><path d="M2.5 4.5h6M12 4.5h1.5M2.5 11.5h1.5M7.5 11.5h6" /><circle cx="10.2" cy="4.5" r="1.7" /><circle cx="5.8" cy="11.5" r="1.7" /></Svg>;
export const External = ({ size }: P) => <Svg size={size}><path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5M9 2.5h4.5V7M13.5 2.5L7.5 8.5" /></Svg>;
export const Check = ({ size }: P) => <Svg size={size}><path d="M3.5 8.4l3 3 6-6.6" /></Svg>;
export const Alert = ({ size }: P) => <Svg size={size}><path d="M8 2.2L14 13H2z" /><path d="M8 6.6v3M8 11.3v.2" /></Svg>;
export const Whiteboard = ({ size }: P) => <Svg size={size}><rect x="2" y="2.5" width="12" height="8" rx="1.2" /><path d="M8 10.5v3M5.5 13.5h5" /></Svg>;
export const Clock = ({ size }: P) => <Svg size={size}><circle cx="8" cy="8" r="5.6" /><path d="M8 4.8V8l2.1 1.4" /></Svg>;
export const Notes = ({ size }: P) => <Svg size={size}><path d="M3 4.5h10M3 8h10M3 11.5h6" /></Svg>;
export const Chevron = ({ size }: P) => <Svg size={size}><path d="M4.5 6.5L8 10l3.5-3.5" /></Svg>;

// Bars for how pressing it is, the way a tracker draws it. Urgent is a red square with a mark. No priority is three faint bars.
export function PriorityIcon({ priority, size = 15 }: P & { priority: Priority | undefined }) {
  if (priority === 'urgent')
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.4" fill="#e5484d" />
        <path d="M8 4.6v4.2M8 11.2v.1" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  const level = priority ? { high: 3, medium: 2, low: 1 }[priority] : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {[4, 7.5, 11].map((x, i) => (
        <rect key={x} x={x - 1.4} y={11.5 - (i + 1) * 3.1} width="2.8" height={(i + 1) * 3.1} rx="0.9" fill={i < level ? '#2a2c47' : '#cfd0de'} />
      ))}
    </svg>
  );
}
