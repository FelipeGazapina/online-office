// Runs a command while holding the machine-wide run lock (run-lock.mjs), so a measurement that is not an Electron launch, such as the
// voice latency table, gets a machine that no other end-to-end run of ours is loading. It waits for the lock like cdp.mjs does.
// Usage: node verify/with-run-lock.mjs <command> [args...]
import { spawn } from 'node:child_process';
import { acquire, release } from './run-lock.mjs';

const [, , ...command] = process.argv;
if (!command.length) {
  console.error('usage: node verify/with-run-lock.mjs <command> [args...]');
  process.exit(2);
}
await acquire(command.join(' ').slice(0, 80), { exclusive: true });
const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  release();
  process.exit(signal ? 1 : (code ?? 1));
});
