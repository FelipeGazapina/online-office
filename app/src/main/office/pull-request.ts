// A task's pull request, through the GitHub CLI. Nothing here knows about tasks or stages: it finds, opens and reads one
// pull request for one branch, and says in words why it could not. Every call is safe to repeat, so a restart or a retry
// converges on the one pull request the branch has.
//
// Plain Node: verify scripts put a fake `gh` on PATH, or pass their own `Gh`.
import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';
import type { PrState, TaskPr } from '../../shared/tasks.ts';

export type GhRun = { ok: boolean; out: string; err: string; missing?: boolean };
export type Gh = (cwd: string, args: string[]) => Promise<GhRun>;

// A GUI app does not inherit the shell's PATH, and Homebrew's gh lives outside the system one. Appended, so a gh earlier on PATH wins.
const pathWithBrew = () => [process.env.PATH ?? '', '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(delimiter);

export const runGh: Gh = (cwd, args) =>
  new Promise((done) => {
    const child = spawn('gh', args, { cwd, env: { ...process.env, PATH: pathWithBrew(), GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ ok: false, out: '', err: e.message, missing: e.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, out: out.trim(), err: err.trim() });
    });
  });

export type PrResult = { kind: 'pr'; pr: TaskPr } | { kind: 'none'; note: string };

const JSON_FIELDS = 'number,url,state,isDraft';

// What the owner reads on the card when gh could not do it.
export function whyNot(r: GhRun): string {
  if (r.missing) return 'The GitHub CLI (gh) is not installed, so there is no pull request. Install it from cli.github.com, then run gh auth login.';
  if (/none of the git remotes|known GitHub host|no git remotes/i.test(r.err)) return 'This repository has no GitHub remote, so there is no pull request.';
  if (/gh auth login|not logged in|GH_TOKEN|authentication/i.test(r.err)) return 'gh is not signed in to GitHub, so there is no pull request. Run gh auth login.';
  const line = r.err.split('\n').find((l) => l.trim()) ?? r.out.split('\n').find((l) => l.trim()) ?? 'gh failed';
  return `GitHub did not open the pull request: ${line.trim()}`;
}

type Raw = { number?: unknown; url?: unknown; state?: unknown; isDraft?: unknown };

const stateOf = (raw: Raw): PrState | undefined => {
  switch (typeof raw.state === 'string' ? raw.state.toUpperCase() : '') {
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    case 'OPEN':
      return raw.isDraft ? 'draft' : 'open';
    default:
      return undefined;
  }
};

const prOf = (raw: Raw): TaskPr | undefined => {
  const state = stateOf(raw);
  return typeof raw.number === 'number' && typeof raw.url === 'string' && state ? { number: raw.number, url: raw.url, state } : undefined;
};

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// The pull request a branch is the head of. An open one wins over a finished one, and the newest wins among equals.
async function find(gh: Gh, cwd: string, branch: string): Promise<PrResult | undefined> {
  const listed = await gh(cwd, ['pr', 'list', '--head', branch, '--state', 'all', '--json', JSON_FIELDS, '--limit', '20']);
  if (!listed.ok) return { kind: 'none', note: whyNot(listed) };
  const found = (Array.isArray(parse(listed.out)) ? (parse(listed.out) as Raw[]) : []).map(prOf).filter((p): p is TaskPr => !!p);
  const rank = (p: TaskPr) => (p.state === 'draft' || p.state === 'open' ? 1e9 : 0) + p.number;
  const best = found.sort((a, b) => rank(b) - rank(a))[0];
  return best ? { kind: 'pr', pr: best } : undefined;
}

// Finds the branch's pull request, or opens a draft one. Two calls make one pull request, not two.
export async function ensurePr(gh: Gh, cwd: string, spec: { branch: string; base: string; title: string; body: string }): Promise<PrResult> {
  const known = await find(gh, cwd, spec.branch);
  if (known) return known;
  const made = await gh(cwd, ['pr', 'create', '--draft', '--base', spec.base, '--head', spec.branch, '--title', spec.title, '--body', spec.body]);
  if (!made.ok) {
    // Someone else opened it between the look and the create.
    const raced = await find(gh, cwd, spec.branch);
    return raced ?? { kind: 'none', note: whyNot(made) };
  }
  const url = /https?:\/\/\S+\/pull\/(\d+)/.exec(made.out);
  if (url) return { kind: 'pr', pr: { number: Number(url[1]), url: url[0], state: 'draft' } };
  return (await find(gh, cwd, spec.branch)) ?? { kind: 'none', note: `GitHub did not say where the pull request is: ${made.out.slice(0, 120) || 'no output'}` };
}

// Where a pull request stands now.
export async function readPr(gh: Gh, cwd: string, number: number): Promise<PrResult> {
  const viewed = await gh(cwd, ['pr', 'view', String(number), '--json', JSON_FIELDS]);
  if (!viewed.ok) return { kind: 'none', note: whyNot(viewed) };
  const pr = prOf((parse(viewed.out) ?? {}) as Raw);
  return pr ? { kind: 'pr', pr } : { kind: 'none', note: `GitHub's answer for pull request ${number} could not be read.` };
}
