// A scripted office for the mailroom checks: five people in two blocks, and ports that record instead of running harnesses.
import type { BlockId, EmployeeId } from '../src/shared/protocol.ts';
import type { ActorId, LedgerEntry } from '../src/shared/mail.ts';
import { Mailroom, type Hired, type HireSpec, type Member } from '../src/main/office/mail.ts';

export const B1 = 'b1' as BlockId;
export const B2 = 'b2' as BlockId;
export const id = (s: string) => s as EmployeeId;
export const PO = id('po');
export const ANA = id('ana');
export const BRUNO = id('bruno');
export const CLEO = id('cleo');
export const OUTSIDER = id('zed');

const roster = (): Member[] => [
  { id: PO, name: 'Pia', role: 'orchestrator', blockId: B1, status: 'idle' },
  { id: ANA, name: 'Ana', role: 'employee', blockId: B1, status: 'idle' },
  { id: BRUNO, name: 'Bruno', role: 'employee', blockId: B1, status: 'idle' },
  { id: CLEO, name: 'Cleo', role: 'employee', blockId: B1, status: 'idle' },
  { id: OUTSIDER, name: 'Zed', role: 'employee', blockId: B2, status: 'idle' },
];

export type Acknowledge = NonNullable<ConstructorParameters<typeof Mailroom>[0]['acknowledge']>;

// `after` is the count of ids an earlier office already used, so a reopened one does not mint the same ids again.
export function world(ledger: readonly LedgerEntry[] = [], acknowledge?: Acknowledge, clock?: () => number, after = 0) {
  const streams: { who: string; delta: string; done: boolean }[] = [];
  const members = roster();
  const prompts = new Map<string, string[]>();
  const steers: { to: string; text: string; style: string }[] = [];
  const persisted: LedgerEntry[] = [...ledger];
  const hires: HireSpec[] = [];
  let n = after;
  let failDeliver: EmployeeId | undefined;
  // What the folder holds. A ref in `fresh` changed since the request, a ref in `stale` did not, any other is missing.
  const fresh = new Set<string>();
  const stale = new Set<string>();
  // Files a turn leaves behind. Most checks assume the work happened.
  let dirty = ['out.txt'];
  const nameOf = (a: ActorId) => (a === 'owner' ? 'the owner' : a === 'mailroom' ? 'the office' : (members.find((m) => m.id === a)?.name ?? a));
  const room = new Mailroom(
    {
      members: () => members,
      nameOf,
      deliver: (to, prompt, _title) => {
        if (failDeliver === to) throw new Error('folder is gone');
        prompts.set(to, [...(prompts.get(to) ?? []), prompt]);
      },
      steer: (to, text, style) => void steers.push({ to, text, style }),
      hire: (_from, spec): Hired => {
        hires.push(spec);
        const hired = { id: id(`new${hires.length}`), name: spec.name ?? `New${hires.length}` };
        members.push({ id: hired.id, name: hired.name, role: 'employee', blockId: B1, status: 'idle' });
        return { ok: true, ...hired };
      },
      artifacts: {
        check: (_who, refs) => refs.map((r) => (fresh.has(r) ? 'changed' : stale.has(r) ? 'unchanged' : 'missing')),
        changed: () => dirty,
      },
      persist: (entry) => void persisted.push(entry),
      changed: () => {},
      stream: (who, _to, delta, done) => void streams.push({ who, delta, done }),
      ...(acknowledge ? { acknowledge } : {}),
      now: clock ?? (() => 1_000 + n),
      newId: () => `m${String(++n).padStart(4, '0')}`,
    },
    ledger,
  );
  return { room, streams, prompts, steers, persisted, hires, members, fresh, stale, setDirty: (d: string[]) => void (dirty = d), failDeliver: (e?: EmployeeId) => void (failDeliver = e) };
}


export type World = ReturnType<typeof world>;
