// One `hermes acp` process, started so that it cannot outlive the app. Plain Node: the check script runs it.
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { withoutHermesVars } from './hermes-profile.ts';

export type HermesProcess = {
  // The ACP wire, newline-delimited JSON over the process's stdin and stdout.
  readonly stream: acp.Stream;
  // Resolves once the process is gone, with a sentence the owner can read. Never rejects.
  readonly exited: Promise<string>;
  // What the process last wrote to stderr, where Hermes says why it failed.
  stderrTail(): string;
  // Ends the process and every command it started. Safe to call twice.
  kill(): void;
};

// Where a process starts: `home` is its profile, `cwd` the block folder. `accept_edits` resolves a relative path against the
// process's own folder, not the session's, so the process must start in the block.
export type Launch = (spec: { home: string; cwd: string }) => HermesProcess;

// Hermes stops when its stdin closes, but not while a tool is running, so a killed app used to leave it and the command it
// was running behind. This runs beside it and owns the other end of a pipe: when the app closes the pipe, or dies, it
// takes down Hermes and everything under it. A command Hermes starts leads its own process group, so it walks the tree.
const REAP = `
child=$1
while read -r _; do :; done
kill -0 "$child" 2>/dev/null || exit 0
tree() { for p in $(pgrep -P "$1" 2>/dev/null); do tree "$p"; echo "$p"; done; }
all="$(tree "$child") $child"
kill -TERM $all 2>/dev/null
i=0
while [ $i -lt 3 ] && kill -0 "$child" 2>/dev/null; do sleep 0.2; i=$((i+1)); done
kill -KILL $all 2>/dev/null
`;

const TAIL_BYTES = 2000;

export function launchHermes(spec: { home: string; cwd: string }, command = { bin: 'hermes', args: ['acp'] }): HermesProcess {
  const child = spawn(command.bin, command.args, {
    cwd: spec.cwd,
    env: { ...withoutHermesVars(process.env), HERMES_HOME: spec.home },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own session, so a signal aimed at the app's process group does not reach it before the reaper acts.
    detached: true,
  });
  const reaper =
    child.pid === undefined ? undefined : spawn('/bin/sh', ['-c', REAP, 'sh', String(child.pid)], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  reaper?.unref();
  reaper?.on('error', () => {});
  for (const pipe of [child.stdin, child.stdout, reaper?.stdin]) pipe?.on('error', () => {});

  let tail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-TAIL_BYTES);
  });
  let gone = false;
  const stderrTail = () => tail.trim().split('\n').at(-1) ?? '';
  const exited = new Promise<string>((resolve) => {
    child.once('error', (err) => resolve(`Could not start Hermes: ${err.message}`));
    child.once('close', (code, signal) => {
      gone = true;
      const how = signal ? `was stopped (${signal})` : `exited with code ${code}`;
      resolve(`Hermes ${how}${stderrTail() ? `: ${stderrTail()}` : ''}`);
    });
  });

  return {
    stream: acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
    exited,
    stderrTail,
    kill() {
      if (reaper) reaper.stdin?.end();
      else child.kill('SIGTERM');
      // The reaper finishes within a second. This is for a machine where it could not start, or a Hermes that ignores it.
      setTimeout(() => {
        if (!gone) child.kill('SIGKILL');
      }, 3000).unref();
    },
  };
}
