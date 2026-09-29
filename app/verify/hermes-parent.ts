// The app's side of a process check in hermes-check.ts: starts a stand-in for Hermes the way the adapter does, then waits
// to be killed. Usage: node verify/hermes-parent.ts <profile home> <block folder> <stand-in script>
import { launchHermes } from '../src/main/office/adapters/hermes-process.ts';

const [home, cwd, script] = process.argv.slice(2);
launchHermes({ home: home!, cwd: cwd! }, { bin: process.execPath, args: ['-e', script!] });
console.log('started');
setInterval(() => {}, 1000);
