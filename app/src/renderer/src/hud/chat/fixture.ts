// Test-only: a small company with a conversation in every state the chat can show, so a test needs no real agent.
import type { BlockId, Company, Employee, EmployeeId, ModelId } from '../../../../shared/protocol.ts';
import type { ItemId } from '../../../../shared/space/index.ts';
import type { ActorView, MailView, Message, MessageId, RequestView } from '../../../../shared/mail.ts';
import { set } from '../../store.ts';

const mid = (s: string) => s as MessageId;
const eid = (s: string) => s as EmployeeId;

export const FIXTURE = {
  block: 'fx-block' as BlockId,
  po: eid('fx-po'),
  ana: eid('fx-ana'),
  bruno: eid('fx-bruno'),
  caio: eid('fx-caio'),
  owner: mid('fx-m1'),
  liveCard: mid('fx-m3'),
  doneCard: mid('fx-m4'),
  queued: mid('fx-m6'),
  gauntlet: mid('fx-g'),
};

export function loadMailFixture(company: Company) {
  const F = FIXTURE;
  const t0 = Date.now() - 12 * 60_000;
  const at = (min: number) => t0 + min * 60_000;
  const person = (id: EmployeeId, name: string, desk: number, status: Employee['status'], role?: Employee['role']): Employee => ({
    id, name, provider: 'claude-code', role, blockId: F.block, seat: `${F.block}:${role === 'orchestrator' ? 'po_desk' : 'bench_desk'}:${String(desk).padStart(2, '0')}` as ItemId, status, activity: 'typing', model: 'fake' as ModelId,
    permissions: { mode: company.settings.defaultPermissions, alwaysAllow: [] }, subagents: [], hiredAt: t0,
  });
  const working = (task: string): Employee['status'] => ({ kind: 'working', task, startedAt: t0 });
  const employees = [
    person(F.po, 'Maya', 0, working('CSV export'), 'orchestrator'),
    person(F.ana, 'Ana', 1, working('Backend: GET /reports.csv')),
    person(F.bruno, 'Bruno', 2, { kind: 'idle' }),
    person(F.caio, 'Caio', 3, working('Export button polish')),
  ];

  const base = (id: string, rootId: string, parentId: string | null, from: Message['from'], to: Message['to'], min: number, hops = 0) =>
    ({ id: mid(id), rootId: mid(rootId), parentId: parentId ? mid(parentId) : null, from, to, at: at(min), hops });
  const tail: Message[] = [
    { ...base('fx-m1', 'fx-m1', null, 'owner', F.po, 0), kind: 'request', intent: 'work', title: 'CSV export', text: 'Add CSV export to the reports page, with tests', key: 'fx-key-1' },
    { ...base('fx-m2', 'fx-m1', 'fx-m1', F.po, 'owner', 0.1, 1), kind: 'say', wake: false, urgency: 'queue', text: "On it. I'll split this into the API and the UI, Ana on the API." },
    { ...base('fx-e1', 'fx-m1', 'fx-m1', 'mailroom', 'owner', 0.3, 1), kind: 'event', event: 'hired', subject: F.bruno, text: 'Maya hired Bruno' },
    { ...base('fx-m3', 'fx-m1', 'fx-m1', F.po, F.ana, 0.5, 1), kind: 'request', intent: 'work', title: 'Backend: GET /reports.csv', text: 'Expose GET /reports.csv returning RFC4180 CSV, with a test for quoting.', bar: ['route returns RFC4180 CSV'] },
    { ...base('fx-m4', 'fx-m1', 'fx-m1', F.po, F.bruno, 0.6, 1), kind: 'request', intent: 'work', title: 'UI: Export button', text: 'Add an Export button on /reports wired to the endpoint.' },
    { ...base('fx-m9', 'fx-m1', 'fx-m3', F.ana, F.po, 1, 2), kind: 'say', wake: false, urgency: 'queue', text: 'Starting with the route handler.' },
    { ...base('fx-m5', 'fx-m1', 'fx-m4', F.bruno, F.po, 3, 2), kind: 'reply', requestId: mid('fx-m4'), outcome: 'done', auto: true, text: 'Button is on /reports and downloads the file.' },
    { ...base('fx-g', 'fx-m1', 'fx-m1', F.po, 'mailroom', 4, 1), kind: 'request', intent: 'gauntlet', title: 'Gauntlet: export button polish', text: 'Polish the export button until the critic passes it.', bar: ['button matches the design'], gauntlet: { builder: F.caio, critic: F.bruno, maxRounds: 6 } },
    { ...base('fx-gw1', 'fx-m1', 'fx-g', 'mailroom', F.caio, 4.1, 2), kind: 'request', intent: 'work', title: 'Round 1', text: 'Build it.' },
    { ...base('fx-gr1', 'fx-m1', 'fx-g', 'mailroom', F.bruno, 5, 2), kind: 'request', intent: 'review', title: 'Review round 1', text: 'Review against the bar.' },
    { ...base('fx-gv1', 'fx-m1', 'fx-gr1', F.bruno, 'mailroom', 6, 3), kind: 'reply', requestId: mid('fx-gr1'), outcome: 'done', text: 'Fails the bar.', verdict: { pass: false, findings: ['Button label is clipped', 'No focus ring'] } },
    { ...base('fx-gw2', 'fx-m1', 'fx-g', 'mailroom', F.caio, 6.1, 2), kind: 'request', intent: 'work', title: 'Round 2', text: 'Fix the findings.' },
    { ...base('fx-m6', 'fx-m6', null, 'owner', F.caio, 7), kind: 'request', intent: 'work', title: 'Update the changelog', text: 'Add the CSV export to the changelog', key: 'fx-key-6' },
    { ...base('fx-m7', 'fx-m7', null, F.po, F.caio, 6.5, 0), kind: 'request', intent: 'work', title: 'Fix the flaky date test', text: 'The date test fails on CI.' },
    { ...base('fx-m8', 'fx-m8', null, F.po, F.caio, 6.6, 0), kind: 'request', intent: 'work', title: 'Bump the lint rules', text: 'Bump the lint rules.' },
  ];

  const req = (id: string, from: Message['from'], to: Message['to'], title: string, life: RequestView['life'], ahead = 0, parent: string | null = null): RequestView => {
    const m = tail.find((x) => x.id === id) as Extract<Message, { kind: 'request' }>;
    return { id: mid(id), rootId: m.rootId, parentId: parent ? mid(parent) : null, from, to, intent: m.intent, title, at: m.at, life, ahead };
  };
  const delivered = { s: 'delivered', turn: 'fx-turn' } as RequestView['life'];
  const open: RequestView[] = [
    req('fx-m1', 'owner', F.po, 'CSV export', delivered),
    req('fx-m3', F.po, F.ana, 'Backend: GET /reports.csv', delivered, 0, 'fx-m1'),
    req('fx-g', F.po, 'mailroom', 'Gauntlet: export button polish', { s: 'running' }, 0, 'fx-m1'),
    req('fx-gw2', 'mailroom', F.caio, 'Round 2', delivered, 0, 'fx-g'),
    req('fx-m6', 'owner', F.caio, 'Update the changelog', { s: 'queued', redelivered: false }, 2),
    req('fx-m7', F.po, F.caio, 'Fix the flaky date test', { s: 'queued', redelivered: false }, 0),
    req('fx-m8', F.po, F.caio, 'Bump the lint rules', { s: 'queued', redelivered: false }, 1),
  ];
  const actor = (state: ActorView['state'], queued: number, serving: string | null): ActorView => ({ state, queued, serving: serving ? mid(serving) : null, awaiting: [] });
  const mail: MailView = {
    seq: 1,
    actors: { [F.po]: actor('running', 0, 'fx-m1'), [F.ana]: actor('running', 0, 'fx-m3'), [F.bruno]: actor('idle', 0, null), [F.caio]: actor('running', 3, 'fx-gw2') },
    open,
    tail,
  };

  set({
    company: { ...company, blocks: [{ id: F.block, name: 'Acme reports', cwd: '/tmp/fixture', color: '#3d85c6', slot: 0 }], employees },
    mail,
    pending: [],
    history: {},
    streams: { [F.ana]: { text: 'Route is in. Writing the quoting test now', replyingTo: mid('fx-m3'), at: Date.now() } },
    selectedId: F.po,
    chatSub: null,
    chatToPo: false,
    chatDetails: false,
  });
  return F;
}
