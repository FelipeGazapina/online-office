// A stand-in for the GitHub CLI that never leaves this machine. `installFakeGh(dir)` writes a `gh` shim into dir/bin, and a
// test puts that folder first on PATH. Every call is logged. Pull requests live in a JSON file next to it, so a test plays
// the owner on GitHub by editing that file: merge one, close one, or sign gh out. Like GitHub, it refuses to open a pull
// request for a branch that has no commit its base lacks, or that origin does not have.
//
// The shim runs this same file with node, so the CLI half and the test half stay in one place.
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FakePr = { number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; isDraft: boolean; head: string; base: string; title: string; body: string };
export type FakeGhState = { mode: 'ok' | 'logged-out' | 'no-github-remote'; next: number; prs: FakePr[] };

const here = fileURLToPath(import.meta.url);

// ───────────────────────────── the test half ─────────────────────────────

export function installFakeGh(dir: string) {
  const bin = join(dir, 'bin');
  const stateFile = join(dir, 'gh-state.json');
  const logFile = join(dir, 'gh-calls.jsonl');
  mkdirSync(bin, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ mode: 'ok', next: 1, prs: [] } satisfies FakeGhState));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexport FAKE_GH_STATE='${stateFile}' FAKE_GH_LOG='${logFile}'\nexec node '${here}' "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const read = (): FakeGhState => JSON.parse(readFileSync(stateFile, 'utf8')) as FakeGhState;
  const write = (s: FakeGhState) => writeFileSync(stateFile, JSON.stringify(s));
  return {
    bin,
    // Every call, as the arguments gh received.
    calls: (): string[][] => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[] }).map((c) => c.args) : []),
    state: read,
    prs: (): FakePr[] => read().prs,
    mode: (mode: FakeGhState['mode']) => write({ ...read(), mode }),
    // What the owner does on GitHub.
    setState: (number: number, state: FakePr['state']) => write({ ...read(), prs: read().prs.map((p) => (p.number === number ? { ...p, state, ...(state === 'MERGED' ? { isDraft: false } : {}) } : p)) }),
    markReady: (number: number) => write({ ...read(), prs: read().prs.map((p) => (p.number === number ? { ...p, isDraft: false } : p)) }),
  };
}

// ───────────────────────────── the gh half ─────────────────────────────

const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

function main(args: string[]) {
  const stateFile = process.env.FAKE_GH_STATE!;
  appendFileSync(process.env.FAKE_GH_LOG!, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
  const lock = `${stateFile}.lock`;
  for (let i = 0; i < 100; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    run(args, stateFile);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const fail = (message: string, code = 1): never => {
  writeSync(2, `${message}\n`);
  process.exit(code);
};

const pick = (pr: FakePr, fields: string) => Object.fromEntries(fields.split(',').map((f) => [f, pr[f as keyof FakePr]]));

function run(args: string[], stateFile: string) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as FakeGhState;
  const save = () => {
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
    renameSync(`${stateFile}.tmp`, stateFile);
  };
  if (state.mode === 'logged-out') fail('To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.', 4);
  if (state.mode === 'no-github-remote') fail('none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`');
  const [group, verb] = args;
  const fields = flag(args, '--json') ?? 'number,url,state,isDraft';

  if (group === 'pr' && verb === 'list') {
    const head = flag(args, '--head');
    writeSync(1, `${JSON.stringify(state.prs.filter((p) => !head || p.head === head).map((p) => pick(p, fields)))}\n`);
    return;
  }
  if (group === 'pr' && verb === 'view') {
    const pr = state.prs.find((p) => String(p.number) === args[2]);
    return pr ? void writeSync(1, `${JSON.stringify(pick(pr, fields))}\n`) : fail(`GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}. (repository.pullRequest)`);
  }
  if (group === 'pr' && verb === 'create') {
    const head = flag(args, '--head') ?? fail('--head is required here');
    const base = flag(args, '--base') ?? fail('--base is required here');
    const origin = (() => {
      try {
        return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
      } catch {
        return fail('none of the git remotes configured for this repository point to a known GitHub host.');
      }
    })();
    const ahead = (() => {
      try {
        return Number(execFileSync('git', ['--git-dir', origin, 'rev-list', '--count', `refs/heads/${base}..refs/heads/${head}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      } catch {
        return fail(`pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between ${base} and ${head}, Head ref must be a branch (createPullRequest)`);
      }
    })();
    if (!ahead) fail(`pull request create failed: GraphQL: No commits between ${base} and ${head} (createPullRequest)`);
    const open = state.prs.find((p) => p.head === head && p.state === 'OPEN');
    if (open) fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${open.url}`);
    const number = state.next++;
    const url = `https://github.com/fake-owner/fake-repo/pull/${number}`;
    state.prs.push({ number, url, state: 'OPEN', isDraft: args.includes('--draft'), head, base, title: flag(args, '--title') ?? '', body: flag(args, '--body') ?? '' });
    save();
    writeSync(1, `${url}\n`);
    return;
  }
  fail(`fake gh does not know: gh ${args.join(' ')}`);
}

if (process.argv[1] === here) main(process.argv.slice(2));
