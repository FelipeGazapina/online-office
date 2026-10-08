#!/usr/bin/env node
// Stands in for whisper-server in voice-check.ts. It takes the same flags and answers the same two routes. It logs how many
// requests were running when each one started, so the check can see whether the service ever overlapped them, and it can
// take its time to start, so the check can quit the app while a server is still loading.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const port = Number(flag('--port'));
const prefix = flag('--request-path') ?? '';
const delay = Number(process.env.FAKE_WHISPER_DELAY_MS ?? 200);
const startDelay = Number(process.env.FAKE_WHISPER_START_MS ?? 0);
// A server that takes its time to end after SIGTERM, so a check can send a request while the old one is dying.
const dieAfter = Number(process.env.FAKE_WHISPER_DIE_MS ?? 0);
if (dieAfter) process.on('SIGTERM', () => setTimeout(() => process.exit(0), dieAfter));
const log = process.env.FAKE_WHISPER_LOG;
let running = 0;

const server = createServer((req, res) => {
  if (req.url === `${prefix}/health`) return void res.end('{"status":"ok"}');
  if (req.method !== 'POST' || req.url !== `${prefix}/inference`) return void res.writeHead(404).end();
  running++;
  if (log) appendFileSync(log, `start running=${running}\n`);
  req.resume();
  req.on('end', () =>
    setTimeout(() => {
      running--;
      res.end(JSON.stringify({ text: ' fake words' }));
    }, delay),
  );
});
setTimeout(() => server.listen(port, '127.0.0.1'), startDelay);
