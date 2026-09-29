import { execFile } from 'node:child_process';
import type { HarnessStatus, ModelId, Provider } from '../../../shared/protocol.ts';
import { createClaudeSession } from './claude.ts';
import { codexDefaultModel, createCodexSession, listCodexModels, setCodexRoot } from './codex.ts';
import { createHermesSession, hermesDefaultModel, listHermesModels } from './hermes.ts';
import type { Harness } from './types.ts';

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

// The Codex and Hermes defaults are what each starts on with no model given (docs/research). U2 and U3 replace them
// with the default of the model list they fetch.
export const HARNESSES: Record<Provider, Harness> = {
  'claude-code': {
    detect: claudeVersion,
    defaultModel: () => (process.env.OFFICE_CLAUDE_MODEL ?? 'claude-sonnet-5-5') as ModelId,
    session: createClaudeSession,
  },
  codex: { detect: () => cliVersion('codex'), defaultModel: codexDefaultModel, listModels: listCodexModels, session: createCodexSession },
  hermes: { detect: () => cliVersion('hermes'), defaultModel: hermesDefaultModel, listModels: listHermesModels, session: createHermesSession },
};

export { setCodexRoot };

async function status(p: Provider): Promise<HarnessStatus> {
  const version = await HARNESSES[p].detect();
  if (version === null) return { kind: 'missing' };
  return HARNESSES[p].session ? { kind: 'ready', version } : { kind: 'not_wired' };
}

export async function detectHarnesses(): Promise<Record<Provider, HarnessStatus>> {
  const [claude, codex, hermes] = await Promise.all([status('claude-code'), status('codex'), status('hermes')]);
  return { 'claude-code': claude, codex, hermes };
}
