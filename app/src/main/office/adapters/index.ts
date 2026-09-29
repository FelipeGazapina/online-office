import { execFile } from 'node:child_process';
import type { HarnessStatus, Provider } from '../../../shared/protocol.ts';
import { createClaudeSession } from './claude.ts';
import type { SessionFactory } from './types.ts';

// One entry per provider, so adding a provider to the contract fails typecheck until it is described here.
// `detect` resolves to the harness version, or null when it is not installed. A harness without a `session`
// factory is installed but not wired: the hire modal shows it, and hiring it is refused.
type Harness = { detect(): Promise<string | null>; session?: SessionFactory };

// The Agent SDK bundles its own Claude Code binary, so there is nothing on PATH to look for.
const claudeVersion = async () => __CLAUDE_SDK_VERSION__;

// Takes the first semver-looking token of the first line. Hermes prints extra lines and update notices after it.
function cliVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = (stdout.split('\n')[0] ?? '').trim();
      resolve(/\d+\.\d+\.\d+\S*/.exec(line)?.[0] ?? (line || 'unknown'));
    });
  });
}

export const HARNESSES: Record<Provider, Harness> = {
  'claude-code': { detect: claudeVersion, session: createClaudeSession },
  codex: { detect: () => cliVersion('codex') },
  hermes: { detect: () => cliVersion('hermes') },
};

async function status(p: Provider): Promise<HarnessStatus> {
  const version = await HARNESSES[p].detect();
  if (version === null) return { kind: 'missing' };
  return HARNESSES[p].session ? { kind: 'ready', version } : { kind: 'not_wired' };
}

export async function detectHarnesses(): Promise<Record<Provider, HarnessStatus>> {
  const [claude, codex, hermes] = await Promise.all([status('claude-code'), status('codex'), status('hermes')]);
  return { 'claude-code': claude, codex, hermes };
}
