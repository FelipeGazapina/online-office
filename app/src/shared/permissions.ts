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

// The rule text for a shell command: the executable plus its subcommand when it has one, so `npm test -- --watch` gives
// `npm test` and `git status --short` gives `git status`. Undefined when no rule can stand for the command.
export function commandPrefix(command: string): string | undefined {
  const [exe, sub] = simpleWords(command) ?? [];
  if (!exe || !EXECUTABLE.test(exe)) return undefined;
  return sub && SUBCOMMAND.test(sub) ? `${exe} ${sub}` : exe;
}

// The rule an Always allow click on this card adds, or undefined when the command is too tangled for a safe one.
export function ruleFor(body: PermissionBody): AllowRule | undefined {
  if (body.tool !== SHELL_TOOL) return { kind: 'tool', name: body.tool };
  const prefix = commandPrefix(body.detail);
  return prefix ? { kind: 'command', prefix } : undefined;
}

// Word by word, so `npm test` covers `npm test -- --watch` and not `npm testing`. A command that chains or redirects is
// never covered, whatever it starts with.
export function covers(rule: AllowRule, body: PermissionBody): boolean {
  if (rule.kind === 'tool') return body.tool === rule.name;
  if (body.tool !== SHELL_TOOL) return false;
  const words = simpleWords(body.detail);
  return !!words && rule.prefix.split(' ').every((w, i) => words[i] === w);
}

export const sameRule = (a: AllowRule, b: AllowRule): boolean =>
  a.kind === 'command' ? b.kind === 'command' && a.prefix === b.prefix : b.kind === 'tool' && a.name === b.name;
