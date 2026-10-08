// Reads a copy of an office's data folder (company.json, company.mail.jsonl, tasks.json) and prints, for each task that has
// runs, who is doing what and the activity log. Nothing is written. Point it at a scratch copy, never at the real folder.
// Run from app/: node verify/activity-dump.ts <folder> [task title fragment]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activityIndexOf, liveOf, logOf, type ActivityEntry, type PersonLive } from '../src/shared/activity.ts';
import type { LedgerEntry } from '../src/shared/mail.ts';
import type { Employee } from '../src/shared/protocol.ts';
import type { Task } from '../src/shared/tasks.ts';

const [dir, fragment] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node verify/activity-dump.ts <folder> [task title fragment]');
  process.exit(2);
}

const company = JSON.parse(readFileSync(join(dir, 'company.json'), 'utf8')) as { employees: Employee[] };
const tasks = (JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')) as { tasks: Task[] }).tasks;
const ledger = readFileSync(join(dir, 'company.mail.jsonl'), 'utf8')
  .split('\n')
  .flatMap((line) => (line ? [JSON.parse(line) as LedgerEntry] : []));
const ix = activityIndexOf(ledger);
const name = (id: string) => (id === 'owner' ? 'owner' : id === 'mailroom' ? 'office' : (company.employees.find((e) => e.id === id)?.name ?? id));
const short = (t: string, n = 110) => {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const clock = (at: number) => new Date(at).toISOString().slice(11, 19);

function sayPerson(p: PersonLive): string {
  switch (p.state) {
    case 'working':
      return `working on "${short(p.piece.title, 60)}" since ${clock(p.since)}${p.on.length ? `, and waiting on ${p.on.map((w) => name(w.who)).join(', ')}` : ''}`;
    case 'waiting':
      return `waiting on ${p.on.length ? p.on.map((w) => `${name(w.who)} (${w.state}${w.round ? ` round ${w.round}` : ''}) for "${short(w.piece.title, 50)}"`).join('; ') : 'nobody in particular'} since ${clock(p.since)}`;
    case 'queued':
      return `queued: "${short(p.piece.title, 60)}"${p.behind ? ` behind "${short(p.behind, 40)}"` : ''}`;
    case 'blocked':
      return `blocked: ${short(p.question.text, 100)}`;
    case 'done':
      return `done "${short(p.piece.title, 50)}"${p.artifact?.length ? ` (${p.artifact.length} files)` : ''}`;
    case 'stopped':
      return `${p.outcome} "${short(p.piece.title, 50)}"`;
    case 'idle':
      return 'idle';
  }
}

function sayEntry(e: ActivityEntry): string {
  const at = clock(e.at);
  switch (e.kind) {
    case 'created':
      return `${at} task created by ${e.by}`;
    case 'request':
      return `${at} ${name(e.from)} asks ${name(e.to)} [${e.intent}${e.round ? ` ${e.round.role} ${e.round.n}` : ''}] "${short(e.title, 70)}"${e.answers ? ' (answers a question)' : ''}`;
    case 'started':
      return `${at} ${name(e.who)} starts "${short(e.title, 60)}"${e.again ? ' again' : ''}`;
    case 'say':
      return `${at} ${name(e.from)} to ${name(e.to)}: ${short(e.text)}`;
    case 'reply':
      return `${at} ${name(e.from)} to ${name(e.to)}: ${e.outcome}${e.verdict ? ` (${e.verdict.pass ? 'PASS' : 'FAIL'})` : ''}${e.artifact?.length ? ` files: ${e.artifact.join(', ')}` : ''} - ${short(e.text, 90)}`;
    case 'event':
      return `${at} ${e.text}`;
    case 'recovered':
      return `${at} restart: ${e.requeued.map((r) => `${name(r.who)}'s "${short(r.title, 40)}"`).join(', ')} back in the queue`;
    case 'stage':
      return `${at} stage ${e.from} to ${e.to} by ${e.by === 'mailroom' ? 'the office' : e.by}`;
    case 'assign':
      return `${at} ${name(e.by)} gave it to ${name(e.employeeId)}`;
    case 'hours':
      return `${at} ${e.hours} h for ${name(e.employeeId)} on ${e.date}${e.error ? ` failed: ${e.error}` : ' sent'}`;
    case 'handoff':
      return `${at} handoff ${e.step}: ${name(e.from)} to ${name(e.to)}, by ${name(e.by)}`;
  }
}

for (const task of tasks) {
  if (!task.runs.length || (fragment && !task.title.toLowerCase().includes(fragment.toLowerCase()))) continue;
  const live = liveOf(task, ix);
  console.log(`\n## ${task.title} [${task.stage}]`);
  for (const p of live.people) console.log(`  ${name(p.employeeId)}: ${sayPerson(p)}`);
  for (const q of live.questions) console.log(`  ? ${name(q.asker)} asks ${name(q.to)}: ${short(q.text, 120)}`);
  if (fragment) for (const e of logOf(task, ix)) console.log(`    ${sayEntry(e)}`);
}
