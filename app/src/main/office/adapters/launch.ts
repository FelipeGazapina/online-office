import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export type ProviderBinary = 'codex' | 'hermes';

export type ProviderLaunch = {
  readonly executable: string | null;
  readonly env: NodeJS.ProcessEnv;
};

const resolved = new Map<ProviderBinary, string | null>();

const unique = (paths: readonly string[]) => [...new Set(paths.filter(Boolean))];

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return env.PATH?.split(delimiter).filter(Boolean) ?? [];
}

function userBinDirs(): string[] {
  const home = homedir();
  const dirs = [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  try {
    const root = join(home, '.nvm', 'versions', 'node');
    dirs.push(...readdirSync(root).sort().reverse().map((version) => join(root, version, 'bin')));
  } catch {
    // The common folders are enough when nvm is not installed.
  }
  return dirs;
}

function executableIn(bin: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking. A missing or non-executable candidate is not an installed provider.
    }
  }
  return null;
}

function resolve(bin: ProviderBinary, env: NodeJS.ProcessEnv): string | null {
  if (env === process.env) {
    if (!resolved.has(bin)) resolved.set(bin, executableIn(bin, unique([...pathEntries(env), ...userBinDirs()])));
    return resolved.get(bin)!;
  }
  return executableIn(bin, unique([...pathEntries(env), ...userBinDirs()]));
}

export function providerLaunch(bin: ProviderBinary, baseEnv: NodeJS.ProcessEnv = process.env): ProviderLaunch {
  const executable = resolve(bin, baseEnv);
  const dirs = unique([...pathEntries(baseEnv), ...userBinDirs()]);
  const node = bin === 'codex' ? executableIn('node', dirs) : null;
  const childPath = unique([executable ? dirname(executable) : '', node ? dirname(node) : '', ...dirs]);
  return { executable, env: { ...baseEnv, PATH: childPath.join(delimiter) } };
}

export function resetProviderLaunches() {
  resolved.clear();
}
