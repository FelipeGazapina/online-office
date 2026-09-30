// The Hermes profiles the office owns: one per employee, and one that only lists models. Everything the office writes
// on the owner's Hermes install is under ~/.hermes/profiles/office-*. The owner's own config is read, never written.
// Plain Node: the check script imports it.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { EmployeeId, ModelId, PermissionMode } from '../../../shared/protocol.ts';
import { providerLaunch } from './launch.ts';

// `root` is the owner's Hermes home. Every path the office writes is derived from it and a validated profile name, so no
// caller can point a write at the owner's own files.
export type Hermes = { readonly root: string; cli(args: string[]): Promise<void> };

// Hermes reads HERMES_HOME as the root of an install. One outside ~/.hermes makes it rebuild the shared checkout, and the
// rest (HERMES_YOLO_MODE, HERMES_CONFIG...) would change what an employee may do, so a shell that exports them stays out.
export const withoutHermesVars = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('HERMES_')));

const run = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const launch = providerLaunch('hermes', withoutHermesVars(process.env));
    if (!launch.executable) return reject(new Error('Hermes is not installed on this machine'));
    execFile(launch.executable, args, { env: launch.env, timeout: 60_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`hermes ${args.slice(0, 2).join(' ')} failed: ${stderr.trim().split('\n').at(-1) || err.message}`));
      else resolve();
    });
  });

export const hermes: Hermes = { root: join(homedir(), '.hermes'), cli: run };

export const CATALOG_PROFILE = 'office-catalog';
// Eight hex digits of the employee id: enough to tell them apart, short enough to read in `hermes profile list`.
export const employeeProfile = (id: EmployeeId) => `office-${id.replace(/-/g, '').slice(0, 8)}`;
const PROFILE_NAME = /^office-[a-z0-9]{1,32}$/;

export function profileHome(h: Hermes, name: string): string {
  if (!PROFILE_NAME.test(name)) throw new Error(`${name} is not a name the office gives a Hermes profile`);
  return join(h.root, 'profiles', name);
}

const DESCRIPTION = 'Reserved for the Online Office desktop app. Not a kanban worker: never assign work here.';
const MARKER = 'online-office.json';
const PARKED = 'gateway.parked';
export const HOOK_FILE = 'office-ask-hook';

// What Hermes hands a pre_tool_call hook on stdin is JSON with the tool name and its input. The hook answers "approve",
// which makes Hermes ask through the client, and puts what to show in `message`: `office:<tool>` on the first line and
// the command, or the code, from the second. Hermes shows a hooked shell command only as "<terminal> (plugin approval
// rule)", so the message is the one place the command survives. Perl ships with macOS and starts in 15 ms.
export const ASK_HOOK_PREFIX = 'office:';
const HOOK_SOURCE = `#!/usr/bin/perl
use strict;
use warnings;
use JSON::PP;
local $/;
my $p = eval { decode_json(<STDIN> // '') } || {};
my $args = $p->{tool_input};
my $detail = ref($args) eq 'HASH' ? ($args->{command} // $args->{code} // JSON::PP->new->canonical->encode($args)) : ($args // '');
print JSON::PP->new->utf8->canonical->encode({ action => 'approve', message => '${ASK_HOOK_PREFIX}' . ($p->{tool_name} // 'tool') . "\\n" . $detail });
`;

export type Whose = { kind: 'employee'; employeeId: EmployeeId } | { kind: 'catalog' };
const marker = z.object({ made_by: z.literal('online-office'), for: z.enum(['employee', 'catalog']), employee_id: z.string().optional() });

const ownedBy = (home: string, whose: Whose): boolean => {
  try {
    const m = marker.parse(JSON.parse(readFileSync(join(home, MARKER), 'utf8')));
    return whose.kind === 'catalog' ? m.for === 'catalog' : m.for === 'employee' && m.employee_id === whose.employeeId;
  } catch {
    return false;
  }
};

// Writes go through a temp file and a rename, so Hermes, which caches its config by file signature, sees a new file.
function replaceFile(path: string, content: string, mode = 0o644) {
  try {
    if (readFileSync(path, 'utf8') === content) return;
  } catch {
    // no file yet
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

// Creates the profile with Hermes's own command, then takes it out of the owner's gateway. The gateway serves every
// profile it finds, and a profile with bot credentials or cron jobs would start them there. A fresh one has neither, so
// the gateway serves it with no adapters for the few seconds until it sees the `gateway.parked` marker. The marker is
// Hermes's own way to keep a profile installed but not served. Safe to run again: it only adds what is missing.
export async function ensureProfile(h: Hermes, name: string, whose: Whose): Promise<string> {
  const home = profileHome(h, name);
  if (!existsSync(home)) {
    await h.cli(['profile', 'create', name, '--no-alias', '--no-skills', '--description', DESCRIPTION]);
    // The marker first: a crash between the two files leaves a profile this office can still recognize as its own.
    writeFileSync(join(home, MARKER), JSON.stringify({ made_by: 'online-office', for: whose.kind, ...(whose.kind === 'employee' && { employee_id: whose.employeeId }) }));
  } else if (!ownedBy(home, whose)) {
    throw new Error(`${home} exists and the office did not make it, so it is left alone`);
  }
  replaceFile(join(home, PARKED), 'provisioned offline\n');
  replaceFile(join(home, HOOK_FILE), HOOK_SOURCE, 0o755);
  return home;
}

// Deletes what ensureProfile made, with Hermes's own command, which also tells the gateway. Nothing else is ever deleted.
export async function removeProfile(h: Hermes, name: string): Promise<void> {
  const home = profileHome(h, name);
  if (!existsSync(home)) return;
  if (!existsSync(join(home, MARKER))) throw new Error(`${home} is not a profile the office made, so it is left alone`);
  try {
    await h.cli(['profile', 'delete', '-y', name]);
  } catch (err) {
    // Hermes removes the folder before it settles the profile's routing rows, and reports that as a failure.
    if (existsSync(home)) throw err;
  }
}

// The three things the office takes from the owner's config.yaml, read as Hermes reads it: YAML 1.1, where an unquoted
// `off` is false. It never throws, because a config the office cannot read must not stop an employee from starting.
const ownerConfig = z.looseObject({
  approvals: z.record(z.string(), z.unknown()).optional(),
  command_allowlist: z.array(z.string()).optional(),
  model: z.union([z.string(), z.looseObject({ default: z.string().optional(), provider: z.string().optional() })]).optional(),
});
export type OwnerHermes = { approvals?: Record<string, unknown>; commandAllowlist?: string[]; model?: { default: string; provider?: string } };

export function readOwner(h: Hermes): OwnerHermes {
  try {
    const cfg = ownerConfig.parse(parse(readFileSync(join(h.root, 'config.yaml'), 'utf8'), { version: '1.1' }));
    const model = typeof cfg.model === 'string' ? { default: cfg.model } : cfg.model?.default ? { default: cfg.model.default, provider: cfg.model.provider } : undefined;
    return { ...(cfg.approvals && { approvals: cfg.approvals }), ...(cfg.command_allowlist && { commandAllowlist: cfg.command_allowlist }), ...(model && { model }) };
  } catch {
    return {};
  }
}

// What a new hire starts on when the owner picks nothing: the owner's own default, as the ids in `session/new` spell it.
// OFFICE_HERMES_MODEL points tests at a cheap model.
export function defaultModel(h: Hermes): ModelId {
  const { model } = readOwner(h);
  return (process.env.OFFICE_HERMES_MODEL ?? (model ? (model.provider ? `${model.provider}:${model.default}` : model.default) : 'anthropic:claude-opus-4-7')) as ModelId;
}

type AcpMode = 'accept_edits' | 'dont_ask';
// `owner` copies the owner's approvals block. An owner with none gets the strict one, because inheriting nothing must not mean asking for nothing.
type Settings = { approvals: 'owner' | { mode: 'manual' | 'off'; timeout?: number }; askHook: boolean; acpMode: AcpMode };

// A card can wait a day for the owner, so a pending approval must not time itself out before that (Hermes's default is 5 minutes).
const CARD_WAIT_S = 24 * 60 * 60;
const STRICT = { mode: 'manual', timeout: CARD_WAIT_S } as const;

// docs/beta-plan.md maps each permission mode onto Hermes. `accept_edits` lets an employee edit inside the block folder
// and asks outside it. YOLO uses `dont_ask`, because a mode that bypasses every check must not ask about a file in the
// next folder. Hermes still asks about .env, .git and .ssh under it.
export const MODES: Record<PermissionMode, Settings> = {
  inherit: { approvals: 'owner', askHook: false, acpMode: 'accept_edits' },
  ask: { approvals: STRICT, askHook: true, acpMode: 'accept_edits' },
  auto: { approvals: STRICT, askHook: false, acpMode: 'accept_edits' },
  yolo: { approvals: { mode: 'off' }, askHook: false, acpMode: 'dont_ask' },
};

const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// The quotes are for Hermes's command parser, which reads the hook's command line as a shell would.
const quoted = (path: string) => (/^[\w./@+-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`);

// The config an employee's profile gets: what Hermes wrote when it made the profile, plus what the office owns. Employees
// share nothing with the owner's setup: no MCP servers of their own, no memory (the office keeps the notes), and MCP tools
// in front of the model, because Hermes hides them behind a search tool by default and `ask_owner` has to be one it can call.
export function officeConfig(existing: Record<string, unknown>, mode: PermissionMode, owner: OwnerHermes, hook: string): Record<string, unknown> {
  // The keys the office owns come out of `kept` and go back in a fixed order, so the same mode always gives the same file.
  const { approvals: _a, command_allowlist: _c, hooks: _h, hooks_auto_accept: _x, mcp_servers: _m, memory, timeouts, tools, ...kept } = existing;
  const { approvals, askHook } = MODES[mode];
  return {
    ...kept,
    approvals: approvals === 'owner' ? (owner.approvals ?? STRICT) : approvals,
    ...(approvals === 'owner' && owner.commandAllowlist && { command_allowlist: owner.commandAllowlist }),
    memory: { ...object(memory), memory_enabled: false, user_profile_enabled: false },
    // A call to ask_owner blocks until the owner answers, and Hermes gives up on an MCP call after 5 minutes.
    timeouts: { ...object(timeouts), mcp: { ...object(object(timeouts).mcp), tool_call: CARD_WAIT_S } },
    tools: { ...object(tools), tool_search: { ...object(object(tools).tool_search), enabled: 'off' } },
    // A shell command reaches the model through terminal, but also through Python (execute_code) and background processes.
    // Without a hook Hermes asks only about commands it finds dangerous. `fail_closed` blocks the command when the hook cannot run.
    ...(askHook && {
      hooks: { pre_tool_call: [{ matcher: 'terminal|execute_code|process_manage', command: quoted(hook), timeout: 30, fail_closed: true }] },
      hooks_auto_accept: true,
    }),
  };
}

// Writes the config for `mode`. Hermes checks approvals.* on every tool call, so a change there reaches a live process at
// its next command. Hooks it reads once, when the process starts. Resolves with what a process started now would have.
export function applyMode(h: Hermes, name: string, mode: PermissionMode): { askHook: boolean; acpMode: AcpMode } {
  const home = profileHome(h, name);
  const file = join(home, 'config.yaml');
  const next = officeConfig(object(parse(readFileSync(file, 'utf8'), { version: '1.1' })), mode, readOwner(h), join(home, HOOK_FILE));
  // Version 1.1 keeps "off" and "yes" in quotes, which is how a YAML 1.1 reader tells them from booleans.
  replaceFile(file, stringify(next, { version: '1.1' }));
  return { askHook: MODES[mode].askHook, acpMode: MODES[mode].acpMode };
}
