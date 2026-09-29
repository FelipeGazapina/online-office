// Builds the app, then opens it the way Finder would, so Electron.app itself is the process macOS asks about the
// microphone. Started from a terminal, the terminal's app is the "responsible process" instead, and one that cannot show
// the permission dialog (an editor's built-in terminal) makes macOS hand the app silence.
// Usage: pnpm beta [electron flags]     pnpm beta --dry-run   checks the bundle and prints the command, builds and opens nothing.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const electronFlags = process.argv.slice(2).filter((arg) => arg !== '--dry-run');

if (process.platform !== 'darwin') {
  console.error('pnpm beta opens the app through macOS LaunchServices. On other systems, use pnpm start.');
  process.exit(1);
}

// `open` hands its own environment to the app, and editor terminals export this. With it set, Electron starts as plain Node.
const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;

const bundle = resolve(createRequire(import.meta.url)('electron'), '../../..');
const usage = spawnSync('plutil', ['-extract', 'NSMicrophoneUsageDescription', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' });
if (usage.status !== 0) {
  console.error(`${bundle} has no NSMicrophoneUsageDescription, so macOS would end the app the moment it asks for the microphone.`);
  process.exit(1);
}

// Nothing shows a launched app's console, so its output goes to a file.
const log = join(homedir(), 'Library/Logs/Online Office/beta.log');
const openArgs = ['-n', bundle, '--stdout', log, '--stderr', log, '--args', appDir, ...electronFlags];
console.log(['open', ...openArgs.map((a) => (a.includes(' ') ? JSON.stringify(a) : a))].join(' '));
if (dryRun) process.exit(0);

const build = spawnSync('pnpm', ['run', 'build'], { cwd: appDir, env, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(dirname(log), { recursive: true });
writeFileSync(log, '', { flag: 'a' });
const opened = spawnSync('open', openArgs, { env, stdio: 'inherit' });
if (opened.status === 0) console.log(`Opened Online Office. Its console output is in ${log}`);
process.exit(opened.status ?? 1);
