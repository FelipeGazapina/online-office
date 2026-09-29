// What "Always allow" means: which permission requests a rule covers, and how a card becomes a rule. Pure and free of
// Node and Electron, so the office, its check scripts and the renderer's card can all import it.
import type { AllowRule, QuestionBody } from './protocol.ts';

export type PermissionBody = Extract<QuestionBody, { kind: 'permission' }>;

// Every harness names a shell command this way in a permission question, and puts the bare command in `detail`.
// A harness that wraps commands (Codex runs `/bin/zsh -lc '...'`) unwraps them first, or no rule can ever match.
export const SHELL_TOOL = 'Bash';

// What the Allow button sends, and what the office answers when a rule already allows the request.
export const ALLOW_ANSWER = 'Allow';

// "Yes", "sim, pode fazer", "OK go" all count. Anything else is a no and the text goes back to the agent.
const ALLOW_WORDS = /^\s*(allow|yes|y|sure|ok|okay|sim|pode)\b/i;

export const isAllow = (answer: string): boolean => ALLOW_WORDS.test(answer);

// The words of a command that is one plain command, or undefined for anything else. A rule must never let a second
// command ride along, so this refuses whatever can start one (; & | ` $( ), redirect output (< >), escape a character
// (\) or span lines. Quotes only group words. Inside double quotes `$` and backtick still substitute, so they refuse too.
function simpleWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let quote = '';
  for (const ch of command.trim()) {
    if (ch === '\n' || ch === '\r') return undefined;
    if (quote) {
      if (quote === '"' && '$`\\'.includes(ch)) return undefined;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (';&|<>()`$\\'.includes(ch)) {
      return undefined;
    } else if (ch === ' ' || ch === '\t') {
      if (word) words.push(word);
      word = '';
      continue;
    }
    word += ch;
  }
  if (quote) return undefined;
  if (word) words.push(word);
  return words;
}

// A program name or path, never an environment assignment (`FOO=1 npm test`) or a quoted word.
const EXECUTABLE = /^[\w./@+][\w./@:+-]*$/;
// `test`, `status`, `build:prod`. A flag, a path, a file name or a number is an argument, not a subcommand.
const SUBCOMMAND = /^[a-z][a-z0-9_:-]*$/;

// Programs that run any code they are given, run other commands, or destroy data. A rule for one of these must not
// cover every use of it, so Always allow on one makes an exact rule.
export const EXACT_ONLY = new Set([
  'bash', 'sh', 'zsh', 'fish', 'node', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'php', 'osascript', 'pwsh',
  'env', 'xargs', 'nohup', 'time', 'timeout', 'nice', 'watch', 'exec', 'eval', 'command',
  'find', 'rm', 'rmdir', 'dd', 'mkfs', 'chmod', 'chown', 'chgrp', 'truncate', 'shred', 'kill', 'killall', 'pkill',
  'launchctl', 'diskutil',
]);

// These run the rest of the command as someone else, so no rule can stand for it, not even an exact one.
const NO_RULE = new Set(['sudo', 'doas']);

// The program behind a path or a name, so that `/bin/bash`, `BASH`, `python3.12` and `mkfs.ext4` count as `bash`,
// `bash`, `python` and `mkfs`. The disk on a Mac ignores case, and a versioned interpreter is still an interpreter.
const programOf = (exe: string): string => exe.slice(exe.lastIndexOf('/') + 1).toLowerCase().split('.')[0]!.replace(/\d+$/, '');

// The rule an Always allow click on this card adds, or undefined when no safe rule can stand for it. Another tool gets
// a rule for the tool. A shell command gets its executable plus its subcommand when it has one, so `npm test -- --watch`
// gives `npm test` and `git status --short` gives `git status`. A program in EXACT_ONLY gets that command and no other.
export function ruleFor(body: PermissionBody): AllowRule | undefined {
  if (body.tool !== SHELL_TOOL) return { kind: 'tool', name: body.tool };
  const words = simpleWords(body.detail);
  const [exe, sub] = words ?? [];
  if (!words || !exe || !EXECUTABLE.test(exe)) return undefined;
  const program = programOf(exe);
  if (NO_RULE.has(program)) return undefined;
  if (EXACT_ONLY.has(program)) return { kind: 'exact', command: words.join(' ') };
  return { kind: 'command', prefix: sub && SUBCOMMAND.test(sub) ? `${exe} ${sub}` : exe };
}

// A command rule matches word by word, so `npm test` covers `npm test -- --watch` and not `npm testing`. An exact rule
// covers a command whose words are the same, and nothing that only starts with them. A command that chains or
// redirects is never covered, whatever it starts with.
export function covers(rule: AllowRule, body: PermissionBody): boolean {
  if (rule.kind === 'tool') return body.tool === rule.name;
  const words = body.tool === SHELL_TOOL ? simpleWords(body.detail) : undefined;
  if (!words) return false;
  if (rule.kind === 'command') return rule.prefix.split(' ').every((w, i) => words[i] === w);
  const wanted = simpleWords(rule.command);
  return wanted?.length === words.length && wanted.every((w, i) => words[i] === w);
}

export function sameRule(a: AllowRule, b: AllowRule): boolean {
  switch (a.kind) {
    case 'command':
      return b.kind === 'command' && a.prefix === b.prefix;
    case 'exact':
      return b.kind === 'exact' && a.command === b.command;
    case 'tool':
      return b.kind === 'tool' && a.name === b.name;
  }
}
