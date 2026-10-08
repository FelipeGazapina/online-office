import { execFile } from 'node:child_process';
import type { HarnessStatus, ModelId, Provider } from '../../../shared/protocol.ts';
import { claudeCodeExecutable, createClaudeSession, listClaudeModels } from './claude.ts';
import { codexDefaultModel, createCodexSession, listCodexModels, setCodexRoot } from './codex.ts';
import { createCursorSession, cursorDefaultModel, cursorStatus, detectCursor, listCursorModels } from './cursor.ts';
import { createHermesSession, hermesDefaultModel, listHermesModels } from './hermes.ts';
import { providerLaunch, type ProviderBinary } from './launch.ts';
import type { Harness } from './types.ts';

// The Agent SDK bundles its own Claude Code binary, so there is nothing on PATH to look for.
const claudeVersion = async () => (claudeCodeExecutable() ? __CLAUDE_SDK_VERSION__ : null);

// Takes the first semver-looking token of the first line. Hermes prints extra lines and update notices after it.
function cliVersion(bin: ProviderBinary): Promise<string | null> {
  const launch = providerLaunch(bin);
  if (!launch.executable) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(launch.executable!, ['--version'], { env: launch.env, timeout: 5000 }, (err, stdout) => {
      // Hermes can spend longer than the probe timeout in its synchronous update check.
      // The child was successfully spawned in this case, so the executable is installed;
      // keep detection useful and let the ACP session report any real startup failure.
      if (err) return resolve(bin === 'hermes' && err.code === 'ETIMEDOUT' ? 'installed' : null);
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
    listModels: listClaudeModels,
    session: createClaudeSession,
  },
  codex: { detect: () => cliVersion('codex'), defaultModel: codexDefaultModel, listModels: listCodexModels, session: createCodexSession },
  hermes: { detect: () => cliVersion('hermes'), defaultModel: hermesDefaultModel, listModels: listHermesModels, session: createHermesSession },
  cursor: { detect: detectCursor, status: cursorStatus, defaultModel: cursorDefaultModel, listModels: listCursorModels, session: createCursorSession },
};

export { setCodexRoot };

async function status(p: Provider): Promise<HarnessStatus> {
  const custom = HARNESSES[p].status;
  if (custom) return custom();
  const version = await HARNESSES[p].detect();
  if (version === null) return { kind: 'missing' };
  return HARNESSES[p].session ? { kind: 'ready', version } : { kind: 'not_wired' };
}

export async function detectHarnesses(): Promise<Record<Provider, HarnessStatus>> {
  const providers = Object.keys(HARNESSES) as Provider[];
  const found = await Promise.all(providers.map(async (provider) => [provider, await status(provider)] as const));
  return Object.fromEntries(found) as Record<Provider, HarnessStatus>;
}
