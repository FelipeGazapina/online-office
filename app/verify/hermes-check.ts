// No model, no Hermes. The Hermes adapter's own logic: the profiles the office keeps, the config each permission mode
// writes, what an employee session tells the office over a scripted ACP agent, and what happens to a process when the app dies.
// Nothing here starts `hermes`, and the owner's ~/.hermes is never opened: every path is under a scratch folder.
// Run from app/: node verify/hermes-check.ts   Exits 1 on any failed check.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { launchHermes } from '../src/main/office/adapters/hermes-process.ts';
import { termTool } from '../src/main/office/adapters/hermes.ts';
import {
  CATALOG_PROFILE,
  HOOK_FILE,
  MODES,
  applyMode,
  defaultModel,
  employeeProfile,
  ensureProfile,
  officeConfig,
  profileHome,
  readOwner,
  removeProfile,
  withoutHermesVars,
  type Hermes,
} from '../src/main/office/adapters/hermes-profile.ts';
import type { EmployeeId, PermissionMode } from '../src/shared/protocol.ts';
import { check, finish, sleep, until } from './check.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-check-')));
const yaml11 = (text: string) => parse(text, { version: '1.1' }) as Record<string, any>;

// The owner's install as this check sees it. Hermes makes a profile with these files, so the stand-in for its CLI does the same.
const OWNER_CONFIG = `model:
  default: claude-opus-4-7
  provider: anthropic
  base_url: https://api.anthropic.com
approvals:
  mode: "off"
  timeout: 6000
command_allowlist:
  - pipe remote content to shell
  - script execution via -e/-c flag
mcp_servers:
  linear:
    url: https://example.invalid/mcp
memory:
  memory_enabled: true
`;
const FRESH_CONFIG = `model:
  default: claude-opus-4-7
  provider: anthropic
  base_url: https://api.anthropic.com
  api_mode: anthropic_messages
_config_version: 46
`;

function ownerInstall(root: string, config = OWNER_CONFIG) {
  mkdirSync(join(root, 'profiles'), { recursive: true });
  mkdirSync(join(root, 'memories'));
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(root, 'config.yaml'), config);
  writeFileSync(join(root, 'SOUL.md'), 'You are the owner\'s agent.\n');
  writeFileSync(join(root, '.env'), 'API_KEY=not-a-real-key\n');
  writeFileSync(join(root, 'auth.json'), '{"token":"not-a-real-token"}');
  writeFileSync(join(root, 'memories', 'MEMORY.md'), 'The owner likes tea.\n');
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '# demo\n');
  mkdirSync(join(root, 'profiles', 'helena-pm'));
  writeFileSync(join(root, 'profiles', 'helena-pm', 'config.yaml'), 'model: {default: kimi-k3}\n');
}

// Everything under `root` except the office's own profiles, as name and content hash. If the office touched any owner file
// or made any file outside profiles/office-*, this changes.
function fingerprint(root: string): string {
  const rows: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (/^profiles\/(office-[^/]+|\.deleted)(\/|$)/.test(rel)) continue;
      if (entry.isDirectory()) walk(path);
      else rows.push(`${rel} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  };
  walk(root);
  return rows.sort().join('\n');
}

type Call = string[];
// `before` fails a command without doing it. `after` does it and then reports a failure, which is what Hermes does when it
// removes a profile's folder but cannot settle the profile's routing rows.
function fakeHermes(root: string, calls: Call[], { before, after }: { before?: (args: Call) => Error | undefined; after?: (args: Call) => Error | undefined } = {}): Hermes {
  return {
    root,
    async cli(args) {
      calls.push(args);
      const failure = before?.(args);
      if (failure) throw failure;
      const [group, verb] = args;
      if (group !== 'profile') throw new Error(`unexpected hermes ${args.join(' ')}`);
      if (verb === 'create') {
        const home = join(root, 'profiles', args[2]!);
        mkdirSync(join(home, 'skills'), { recursive: true });
        writeFileSync(join(home, 'config.yaml'), FRESH_CONFIG);
        writeFileSync(join(home, '.env'), '# Per-profile secrets for this Hermes profile.\n');
        writeFileSync(join(home, 'SOUL.md'), 'default soul\n');
      } else if (verb === 'delete') {
        rmSync(join(root, 'profiles', args[3]!), { recursive: true, force: true });
        mkdirSync(join(root, 'profiles', '.deleted'), { recursive: true });
        writeFileSync(join(root, 'profiles', '.deleted', args[3]!), 'deleted');
      }
      const late = after?.(args);
      if (late) throw late;
    },
  };
}

console.log('# names and paths');
const ana = 'e1a2b3c4-1111-4222-8333-944455556666' as EmployeeId;
const ben = 'f9e8d7c6-1111-4222-8333-944455556666' as EmployeeId;
check(employeeProfile(ana) === 'office-e1a2b3c4' && employeeProfile(ben) === 'office-f9e8d7c6', 'an employee profile is office- and the first eight hex digits of the id');
const root = join(scratch, 'owner-hermes');
ownerInstall(root);
const calls: Call[] = [];
const h = fakeHermes(root, calls);
const refused = (name: string) => {
  try {
    profileHome(h, name);
    return false;
  } catch {
    return true;
  }
};
check(['default', 'helena-pm', 'office-', 'office-UPPER', 'office-a/../../x', '../office-a', 'office-a b', ''].every(refused), 'a name that is not office- and lowercase letters or digits never becomes a path, so a write cannot leave profiles/office-*');
check(profileHome(h, CATALOG_PROFILE) === join(root, 'profiles', 'office-catalog'), 'the catalog profile lives beside the employee ones');
const before = fingerprint(root);

console.log('\n# hermes environment');
const env = withoutHermesVars({ PATH: '/bin', HOME: '/home/x', HERMES_HOME: '/elsewhere', HERMES_YOLO_MODE: '1', HERMES_ACCEPT_HOOKS: '1', ANTHROPIC_API_KEY: 'k' });
check(JSON.stringify(env) === JSON.stringify({ PATH: '/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'k' }), 'every HERMES_ variable of the owner\'s shell is dropped and the rest passes');

console.log('\n# making and finding profiles');
const anaHome = await ensureProfile(h, employeeProfile(ana), { kind: 'employee', employeeId: ana });
const created = calls.filter((c) => c[1] === 'create');
check(anaHome === join(root, 'profiles', 'office-e1a2b3c4') && created.length === 1, 'the first call makes the profile with Hermes\'s own command');
check(created[0]!.includes('--no-alias') && created[0]!.includes('--no-skills') && !created[0]!.some((a) => a.startsWith('--clone')) && created[0]!.includes('--description'), 'without an alias or skills, never as a clone of the owner\'s, and with a description that says it is not a worker');
check(existsSync(join(anaHome, 'gateway.parked')) && existsSync(join(anaHome, 'online-office.json')), 'it is parked, so the owner\'s gateway does not serve it, and marked as the office\'s');
const hook = join(anaHome, HOOK_FILE);
check((statSync(hook).mode & 0o111) !== 0 && readFileSync(hook, 'utf8').startsWith('#!/usr/bin/perl'), 'the ask hook is there and can run');
const stamp = (file: string) => statSync(file).ino;
const inodes = [hook, join(anaHome, 'gateway.parked')].map(stamp);
await ensureProfile(h, employeeProfile(ana), { kind: 'employee', employeeId: ana });
check(calls.filter((c) => c[1] === 'create').length === 1 && [hook, join(anaHome, 'gateway.parked')].every((f, i) => stamp(f) === inodes[i]), 'a second call finds it, runs nothing and rewrites nothing');
rmSync(hook);
await ensureProfile(h, employeeProfile(ana), { kind: 'employee', employeeId: ana });
check(existsSync(hook), 'and a file that went missing comes back');
const rejects = async (run: () => Promise<unknown>) => run().then(() => false, () => true);
check(await rejects(() => ensureProfile(h, employeeProfile(ana), { kind: 'employee', employeeId: ben })), 'a profile made for another employee is not taken over');
check(await rejects(() => ensureProfile(h, employeeProfile(ana), { kind: 'catalog' })) && calls.filter((c) => c[1] === 'create').length === 1, 'nor is an employee profile used as the catalog one');
mkdirSync(join(root, 'profiles', 'office-cafe0000'));
check(await rejects(() => ensureProfile(h, 'office-cafe0000', { kind: 'catalog' })) && calls.filter((c) => c[1] === 'create').length === 1, 'a folder the office did not make is left alone and Hermes is not asked to overwrite it');
rmSync(join(root, 'profiles', 'office-cafe0000'), { recursive: true });
const failing = fakeHermes(root, [], { before: () => new Error('hermes profile create failed: disk full') });
check(await rejects(() => ensureProfile(failing, 'office-deadbeef', { kind: 'catalog' })) && !existsSync(join(root, 'profiles', 'office-deadbeef')), 'when Hermes cannot make the profile nothing is left behind');

console.log('\n# what each permission mode writes');
type Written = Record<string, any>;
const configOf = (home: string): Written => yaml11(readFileSync(join(home, 'config.yaml'), 'utf8'));
const rawOf = (home: string) => readFileSync(join(home, 'config.yaml'), 'utf8');
const hookEntry = { matcher: 'terminal|execute_code|process_manage', command: hook, timeout: 30, fail_closed: true };
const commonKept = (c: Written) =>
  c._config_version === 46 && c.model.default === 'claude-opus-4-7' && c.memory.memory_enabled === false && c.memory.user_profile_enabled === false && c.timeouts.mcp.tool_call === 86400 && c.tools.tool_search.enabled === 'off' && !('mcp_servers' in c);

const inherit = applyMode(h, employeeProfile(ana), 'inherit');
let c = configOf(anaHome);
check(JSON.stringify(c.approvals) === JSON.stringify({ mode: 'off', timeout: 6000 }) && JSON.stringify(c.command_allowlist) === JSON.stringify(['pipe remote content to shell', 'script execution via -e/-c flag']) && !('hooks' in c), 'inherit copies the owner\'s approvals block and command allowlist and adds no hook');
check(commonKept(c), 'and every mode starts from what Hermes wrote, with memory off, MCP tools in front of the model, a day to answer an MCP call and none of the owner\'s MCP servers');
check(inherit.askHook === false && inherit.acpMode === 'accept_edits', 'it edits inside the block and asks outside');

applyMode(h, employeeProfile(ana), 'ask');
c = configOf(anaHome);
check(JSON.stringify(c.approvals) === JSON.stringify({ mode: 'manual', timeout: 86400 }) && !('command_allowlist' in c), 'ask is manual, waits a day for the owner and takes nothing from the owner\'s allowlist');
check(JSON.stringify(c.hooks) === JSON.stringify({ pre_tool_call: [hookEntry] }) && c.hooks_auto_accept === true, 'and adds the hook for terminal, execute_code and process_manage, which blocks the command if it cannot run');
check(commonKept(c), 'ask keeps the same base');

const auto = applyMode(h, employeeProfile(ana), 'auto');
c = configOf(anaHome);
check(JSON.stringify(c.approvals) === JSON.stringify({ mode: 'manual', timeout: 86400 }) && !('hooks' in c) && !('hooks_auto_accept' in c) && !('command_allowlist' in c) && auto.askHook === false, 'auto is manual with no hook, and switching to it takes the hook and the allowlist away');

const yolo = applyMode(h, employeeProfile(ana), 'yolo');
c = configOf(anaHome);
check(c.approvals.mode === 'off' && !('hooks' in c) && yolo.acpMode === 'dont_ask', 'yolo turns approvals off and lets edits through everywhere');
check(/mode: "off"/.test(rawOf(anaHome)) && /enabled: "off"/.test(rawOf(anaHome)), 'and off is written in quotes, so a YAML 1.1 reader takes it for a word and not for false');
check((Object.keys(MODES) as PermissionMode[]).every((m) => MODES[m].acpMode === (m === 'yolo' ? 'dont_ask' : 'accept_edits')), 'only yolo runs the edit mode that skips the folder check');

console.log('\n# the owner\'s config is read as Hermes reads it, and never trusted to exist');
const ownerOf = (config: string | undefined) => {
  const dir = join(scratch, `owner-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir);
  if (config !== undefined) writeFileSync(join(dir, 'config.yaml'), config);
  return { root: dir, cli: async () => {} } as Hermes;
};
const unquoted = readOwner(ownerOf('approvals:\n  mode: off\n'));
check(unquoted.approvals?.mode === false, 'an unquoted off is false, as Hermes reads it, and Hermes treats false as off');
const strict = (config: string | undefined) => {
  const f = ownerOf(config);
  return JSON.stringify(officeConfig({}, 'inherit', readOwner(f), '/x/hook').approvals);
};
const STRICT = JSON.stringify({ mode: 'manual', timeout: 86400 });
check([strict('model: x\n'), strict(': : not yaml ['), strict('approvals: nope\n'), strict(undefined), strict('')].every((s) => s === STRICT), 'an owner with no approvals block, a config that does not parse, one that says something odd or none at all gives the strict block, never an open one');
check(defaultModel(ownerOf(OWNER_CONFIG)) === 'anthropic:claude-opus-4-7', 'a new hire starts on the model the owner\'s Hermes starts on, spelled as session/new spells it');
check(defaultModel(ownerOf('model: some-model\n')) === 'some-model' && defaultModel(ownerOf('model:\n  default: bare\n')) === 'bare' && defaultModel(ownerOf(undefined)) === 'anthropic:claude-opus-4-7', 'a bare name stays bare, and with no config it is the one the C1 contract names');
process.env.OFFICE_HERMES_MODEL = 'anthropic:claude-haiku-4-5-20251001';
check(defaultModel(ownerOf(OWNER_CONFIG)) === 'anthropic:claude-haiku-4-5-20251001', 'OFFICE_HERMES_MODEL points a test at a cheap model');
delete process.env.OFFICE_HERMES_MODEL;

console.log('\n# a config that Hermes or an old run left behind');
const stale = { ...yaml11(FRESH_CONFIG), mcp_servers: { linear: { url: 'x' } }, hooks: { pre_tool_call: [{ command: 'old' }] }, hooks_auto_accept: true, command_allowlist: ['x'], approvals: { mode: 'off' }, memory: { memory_enabled: true, memory_char_limit: 100 }, display: { skin: 'plain' } };
const rebuilt = officeConfig(stale, 'auto', {}, '/x/hook');
check(!('mcp_servers' in rebuilt) && !('hooks' in rebuilt) && !('hooks_auto_accept' in rebuilt) && !('command_allowlist' in rebuilt), 'MCP servers, hooks and the allowlist are the office\'s to set, so old ones go');
check((rebuilt.memory as Written).memory_char_limit === 100 && (rebuilt.display as Written).skin === 'plain' && rebuilt._config_version === 46, 'and what the office does not own stays, so Hermes\'s own bookkeeping survives');
const mtime = statSync(join(anaHome, 'config.yaml')).ino;
applyMode(h, employeeProfile(ana), 'yolo');
check(statSync(join(anaHome, 'config.yaml')).ino === mtime, 'the same mode again rewrites nothing');
applyMode(h, employeeProfile(ana), 'ask');
check(statSync(join(anaHome, 'config.yaml')).ino !== mtime, 'a new mode goes in through a new file, which is how Hermes notices it');

console.log('\n# the ask hook');
const ask = (payload: unknown) => JSON.parse(execFileSync(hook, { input: typeof payload === 'string' ? payload : JSON.stringify(payload) }).toString());
const shellAsk = ask({ hook_event_name: 'pre_tool_call', tool_name: 'terminal', tool_input: { command: 'git status --short' }, session_id: 's' });
check(shellAsk.action === 'approve' && shellAsk.message === 'office:terminal\ngit status --short', 'a shell command asks, and the command is in the message, because Hermes shows the hooked one only as a placeholder');
const codeAsk = ask({ tool_name: 'execute_code', tool_input: { code: 'import os\nprint(os.getcwd())' } });
check(codeAsk.message === 'office:execute_code\nimport os\nprint(os.getcwd())', 'Python it is asked to run asks too, with the code');
check(ask({ tool_name: 'process_manage', tool_input: { action: 'kill', session_id: 'p1' } }).message === 'office:process_manage\n{"action":"kill","session_id":"p1"}', 'and so does managing a background process, with what it is asked to do');
check(ask({ tool_name: 'terminal', tool_input: { command: 'echo "héllo ✓" && cat <<EOF\nx\nEOF' } }).message === 'office:terminal\necho "héllo ✓" && cat <<EOF\nx\nEOF', 'quotes, accents and new lines in a command arrive as written');
check(ask('not json').action === 'approve' && ask({}).message === 'office:tool\n', 'a payload it cannot read still asks, and never lets a command through');
const long = 'x'.repeat(50_000);
check(ask({ tool_name: 'terminal', tool_input: { command: long } }).message === `office:terminal\n${long}`, 'a long command is not cut, because the owner decides on what the card shows');
const t0 = Date.now();
for (let i = 0; i < 5; i++) ask({ tool_name: 'terminal', tool_input: { command: 'date' } });
check((Date.now() - t0) / 5 < 250, `it costs a command ${Math.round((Date.now() - t0) / 5)} ms`);

console.log('\n# removing a profile');
await removeProfile(h, employeeProfile(ana));
check(!existsSync(anaHome) && calls.some((c) => c.join(' ') === `profile delete -y ${employeeProfile(ana)}`), 'firing deletes the profile with Hermes\'s own command');
const callsBefore = calls.length;
await removeProfile(h, employeeProfile(ana));
check(calls.length === callsBefore, 'and firing twice runs nothing more');
check(await rejects(() => removeProfile(h, 'helena-pm')) && existsSync(join(root, 'profiles', 'helena-pm')), 'a profile that is not an office one is never deleted, whatever the name');
mkdirSync(join(root, 'profiles', 'office-cafe0001'));
check(await rejects(() => removeProfile(h, 'office-cafe0001')) && existsSync(join(root, 'profiles', 'office-cafe0001')), 'nor an office-named folder without the office\'s marker');
rmSync(join(root, 'profiles', 'office-cafe0001'), { recursive: true });
const benHome = await ensureProfile(h, employeeProfile(ben), { kind: 'employee', employeeId: ben });
const noisy = fakeHermes(root, [], { after: (a) => (a[1] === 'delete' ? new Error('identity settlement is pending') : undefined) });
await removeProfile(noisy, employeeProfile(ben));
check(!existsSync(benHome), 'Hermes reports a delete whose folder is gone as a failure, and that still counts as gone');
const stuck: Hermes = { root, cli: async () => { throw new Error('busy'); } };
const stayHome = await ensureProfile(h, employeeProfile(ana), { kind: 'employee', employeeId: ana });
check(await rejects(() => removeProfile(stuck, employeeProfile(ana))) && existsSync(stayHome), 'but a failure that leaves the folder there is reported');
await removeProfile(h, employeeProfile(ana));

console.log('\n# the owner\'s files');
check(fingerprint(root) === before, 'after all of it, every file of the owner\'s install has the same content, and nothing was added outside profiles/office-*');
const listing = readdirSync(join(root, 'profiles')).filter((n) => !n.startsWith('.')).sort();
check(JSON.stringify(listing) === JSON.stringify(['helena-pm']), 'and only the owner\'s profile is left');

console.log('\n# a process the app cannot leave behind');
// Stands in for Hermes in the middle of a tool: it ignores a polite stop, and the command it runs leads its own process group.
const STAND_IN = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
const command = spawn('sleep', ['61.3'], { detached: true, stdio: 'ignore' });
writeFileSync(process.env.STAND_IN_OUT, JSON.stringify({ pid: process.pid, command: command.pid, cwd: process.cwd(), env: Object.keys(process.env).filter((k) => k.startsWith('HERMES_')), home: process.env.HERMES_HOME }));
setInterval(() => {}, 1000);
`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const goneAfter = async (pids: number[], ms: number) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pids.every((p) => !alive(p))) return Date.now() - t0;
    await sleep(25);
  }
  return undefined;
};
const block = join(scratch, 'block');
mkdirSync(block);
const profile = join(scratch, 'profile');
const standIn = async (out: string) => {
  await until(() => existsSync(out), 10_000);
  await sleep(50);
  return JSON.parse(readFileSync(out, 'utf8')) as { pid: number; command: number; cwd: string; env: string[]; home: string };
};

process.env.STAND_IN_OUT = join(scratch, 'stand-in-1.json');
process.env.HERMES_YOLO_MODE = '1';
const first = launchHermes({ home: profile, cwd: block }, { bin: process.execPath, args: ['-e', STAND_IN] });
const one = await standIn(process.env.STAND_IN_OUT);
delete process.env.HERMES_YOLO_MODE;
check(one.cwd === block, 'the process starts in the block folder');
check(JSON.stringify(one.env) === JSON.stringify(['HERMES_HOME']) && one.home === profile, 'and sees the employee\'s profile as its home, with no other HERMES_ variable from the app\'s environment');
check(alive(one.pid) && alive(one.command), 'it and the command it started are running');
first.kill();
const endedIn = await goneAfter([one.pid, one.command], 2000);
check(endedIn !== undefined, `kill() ends a process that ignores a polite stop, and the command under it, in ${endedIn} ms`);
check(/stopped \(SIGKILL\)/.test(await first.exited), 'and says how it ended');
const twice = () => {
  try {
    first.kill();
    return true;
  } catch {
    return false;
  }
};
check(twice(), 'kill() twice is harmless');

process.env.STAND_IN_OUT = join(scratch, 'stand-in-2.json');
const parent = spawn(process.execPath, [join(import.meta.dirname, 'hermes-parent.ts'), profile, block, STAND_IN], { stdio: 'ignore' });
const two = await standIn(process.env.STAND_IN_OUT);
check(alive(two.pid) && alive(two.command), 'a process started by an app that is running is up');
const killedAt = Date.now();
parent.kill('SIGKILL');
const survivors = await goneAfter([two.pid, two.command], 5000);
check(survivors !== undefined && survivors <= 2000, `SIGKILL to the app ends the process and its command in ${survivors} ms, and it would not stop on SIGTERM`);
check(Date.now() - killedAt < 6000 && !alive(two.pid) && !alive(two.command), 'and nothing is left');

const missing = launchHermes({ home: profile, cwd: block }, { bin: join(scratch, 'no-such-hermes'), args: ['acp'] });
check(/^Could not start Hermes: .*ENOENT/.test(await missing.exited), 'a Hermes that is not installed is reported as that');
const endMissing = () => {
  try {
    missing.kill();
    return true;
  } catch {
    return false;
  }
};
check(endMissing(), 'and ending it does not throw');
delete process.env.STAND_IN_OUT;

console.log('\n# the terminal');
const content = (text: string) => [{ type: 'content' as const, content: { type: 'text' as const, text } }];
const tool = (title: string, extra: Record<string, unknown> = {}) => termTool(title.split(':')[0]!.trim(), { title, ...extra } as Parameters<typeof termTool>[1], '/work/repo');
check(JSON.stringify(tool('terminal: git status', { content: content('$ git status --short') })) === '{"name":"Bash","input":{"command":"git status --short"}}', 'a terminal call is a Bash call with its command, without the prompt Hermes prints');
check(JSON.stringify(tool('terminal: date -u')) === '{"name":"Bash","input":{"command":"date -u"}}', 'or the command from its title when the call has no content');
check(JSON.stringify(tool('read_file: /work/repo/src/a.ts', { locations: [{ path: '/work/repo/src/a.ts' }] })) === '{"name":"Read","input":{"file_path":"src/a.ts"}}', 'a read is a Read of the file, relative to the folder');
check(JSON.stringify(tool('patch: /work/repo/src/a.ts', { locations: [{ path: '/work/repo/src/a.ts' }] })) === '{"name":"Patch","input":{"paths":["src/a.ts"]}}' && tool('write_file: /work/repo/b.ts').name === 'Patch', 'a write and a patch are an update of the file');
check(tool('web_search: pnpm patch').name === 'WebSearch' && tool('delegate_task: read three files').name === 'Task' && tool('search_files: TODO').name === 'Grep', 'searches and helpers have Claude Code names');
check(tool('mcp_office_message').name === 'mcp_office_message', 'a tool from an MCP server keeps its whole name');

rmSync(scratch, { recursive: true, force: true });
finish();
