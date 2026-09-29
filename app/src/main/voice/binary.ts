import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

type Env = { PATH?: string; HOME?: string; SHELL?: string };

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Interactive login shells carry the owner's own PATH at the price of about a second, so it is the last resort.
function loginShellLookup(name: string, shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', `command -v ${name}`], { timeout: 3000 }, (_err, stdout) => {
      const found = stdout.trim().split('\n').pop() ?? '';
      resolve(found.startsWith('/') ? found : null);
    });
  });
}

// A Dock or Finder launch gives PATH=/usr/bin:/bin:/usr/sbin:/sbin, which misses Homebrew, so PATH alone is not enough.
export async function findBinary(name: string, env: Env = process.env): Promise<string | null> {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [...(env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(env.HOME ?? '', '.local/bin')];
  for (const dir of dirs) {
    const candidate = join(dir, exe);
    if (dir && (await isExecutable(candidate))) return candidate;
  }
  if (process.platform === 'win32') return null;
  const found = await loginShellLookup(name, env.SHELL ?? '/bin/zsh');
  return found && (await isExecutable(found)) ? found : null;
}
