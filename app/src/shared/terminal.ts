// What an employee's terminal shows. A session tells the office what happened in the words of its harness reduced to one
// event shape (`TermEvent`), `TerminalBuffer` folds them into blocks of styled lines the way Claude Code's own terminal
// lays them out, and `screenOf` lays the blocks out for a width: the monitor on a desk and the zoomed terminal both draw
// that. Pure and free of Node and Electron, so the office, the renderer and the check scripts import the same code.
import type { AllowRule, EmployeeStatus, PermissionMode, Question } from './protocol.ts';
import { ruleFor, SHELL_TOOL } from './permissions.ts';

// ---------------------------------------------------------------- the shape

// Colours are names, the renderer owns the palette.
export type Tone = 'fg' | 'dim' | 'bright' | 'accent' | 'ok' | 'err' | 'warn' | 'info' | 'rule' | 'violet';
// A highlight behind a span ('user' echoes what the owner typed) or behind a whole row (a diff row).
export type Bg = 'user' | 'add' | 'del';
export type Span = { t: string; c?: Tone; b?: boolean; i?: boolean; bg?: Bg };
// `hang` is how far wrapped rows of this line are indented. `fill` colours the whole row instead of only its text.
export type TerminalLine = { spans: Span[]; hang?: number; fill?: Bg; toggle?: true };
// A block is what one thing printed: a message, a tool call with its result, a notice. Blocks never reorder. `n` counts
// up from 0 over the life of the buffer, and block 0 is the banner, which stays when old blocks are dropped.
// A prompt opens the next `turn`, and every block after it belongs to that turn. `full` is the call the way it reads once
// the owner opens its result, for a call that printed more than it shows.
// A `chore` is a call that only keeps the employee's own list (TaskCreate, TaskUpdate): it is printed small, and the list shows in the spinner.
export type BlockKind = 'banner' | 'prompt' | 'say' | 'thought' | 'call' | 'chore' | 'note' | 'end';
export type TermBlock = { n: number; turn: number; kind: BlockKind; lines: TerminalLine[]; full?: TerminalLine[] };
// What the screen shows besides the blocks: how many tokens the turn wrote so far, what the employee's todo list says they are doing
// and will do next, and what the calls waiting on the owner say they are for.
export type Plan = { active: string; next?: string };
// What a call waiting for approval says about itself. `detail` is the command or path the question carries, and `description`
// is the line the model wrote for the owner under a Bash command ("Run the test suite").
export type Ask = { detail: string; description?: string; reason?: string };
export type TermLive = { tokens: number; plan?: Plan; asks?: Ask[] };
// What changed since the last push. Blocks below `from` (other than the banner) are gone. `reset` says the sender holds
// nothing the receiver can keep, so it starts from these blocks alone.
export type TerminalPush = { from: number; blocks: TermBlock[]; live: TermLive; reset?: boolean };

// ---------------------------------------------------------------- what a session reports

export type TermEvent =
  // A message the model is about to read, as the owner or a teammate wrote it.
  | { k: 'prompt'; text: string }
  // The assistant's text so far. The same `id` again replaces it.
  | { k: 'text'; id: string; text: string }
  // The model is thinking. `secs` closes it.
  | { k: 'thinking'; id: string; secs?: number }
  // A tool call the moment it is known, and the result when it comes back. `data` is the harness's own structured result.
  | { k: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { k: 'result'; id: string; ok: boolean; text: string; data?: unknown }
  // The turn is over. `interrupted` is the owner pressing Esc.
  // `ms` is how long the turn took.
  | { k: 'end'; how: 'done' | 'interrupted' | 'error'; message?: string; ms?: number }
  | { k: 'note'; text: string; tone?: Tone }
  | { k: 'tokens'; out: number }
  // A call is about to ask the owner for approval, with what the harness says about it.
  | { k: 'approval'; detail: string; description?: string; reason?: string }
  // The header: which harness, which model, where.
  | { k: 'banner'; title: string; model: string; cwd: string };

// ---------------------------------------------------------------- building lines

const sp = (t: string, c?: Tone, more: Partial<Span> = {}): Span => ({ t, ...(c ? { c } : {}), ...more });
const line = (spans: Span[], more: Partial<TerminalLine> = {}): TerminalLine => ({ spans, ...more });

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// A little of markdown, the part an assistant message uses most: **bold**, `code`, # headings and lists. Anything else is text.
export function inline(text: string): Span[] {
  const out: Span[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push(sp(text.slice(at, m.index)));
    const hit = m[0];
    out.push(hit.startsWith('**') ? sp(hit.slice(2, -2), undefined, { b: true }) : sp(hit.slice(1, -1), 'info'));
    at = m.index + hit.length;
  }
  if (at < text.length) out.push(sp(text.slice(at)));
  return out.length ? out : [sp('')];
}

function proseLines(text: string, lead: Span[]): TerminalLine[] {
  const rows = text.replace(/\r/g, '').trimEnd().split('\n');
  return rows.map((raw, i) => {
    const first = i === 0;
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    const body = heading ? [sp(heading[1]!, undefined, { b: true })] : bullet ? [sp(`${bullet[1]}• `), ...inline(bullet[2]!)] : inline(raw);
    return line([...(first ? lead : [sp('  ')]), ...body], { hang: 2 + (bullet ? bullet[1]!.length + 2 : 0) });
  });
}

// ---------------------------------------------------------------- how each tool reads, as Claude Code writes it

type Result = { ok: boolean; text: string; data?: unknown };
type Facts = { name: string; input: Record<string, unknown>; cwd: string };
// What a call shows under itself once it returned: a few lines, and when there is more, all of it for the owner to open.
type Shown = { rows: TerminalLine[]; full?: TerminalLine[] };
type ToolStyle = {
  // A call that is bookkeeping for the employee, not work on the project.
  quiet?: true;
  label: (f: Facts) => string;
  // What goes in the parentheses after the label.
  arg: (f: Facts) => string;
  // The lines under the call once it returned. `⎿` leads the first of them.
  done: (f: Facts, r: Result) => Shown;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function relPath(file: string, cwd: string): string {
  if (!file.startsWith('/')) return file;
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return file.startsWith(base) ? file.slice(base.length) : file;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lines = (text: string) => (text ? text.replace(/\r/g, '').replace(/\n+$/, '').split('\n') : []);

// What a result keeps for the owner who opens it. A longer one says how many lines it left out.
const FULL_LINES = 80;
// The words of a result that has more to open, at the end of its last shown line.
export const EXPAND_HINT = ' (click to expand)';

const dimLine = (text: string): TerminalLine => line([sp(cut(text, 240), 'dim')]);
const shown = (rows: TerminalLine[], full?: TerminalLine[]): Shown => {
  if (!full || full.length <= rows.length) return { rows };
  return { rows, full: full.length > FULL_LINES ? [...full.slice(0, FULL_LINES), line([sp(`… +${plural(full.length - FULL_LINES, 'line')}`, 'dim')])] : full };
};

// "Read 46 lines": the words as bright as the rest of the result, the number bold.
const counted = (before: string, n: number, after: string): TerminalLine => line([sp(before, 'fg'), sp(String(n), 'bright', { b: true }), sp(after, 'fg')]);

// The first few lines of a result, and all of it to open.
function head(text: string, tone: Tone | undefined, max = 3): Shown {
  const all = lines(text);
  if (!all.length) return { rows: [dimLine('(No content)')] };
  const rows = all.map((l) => line([sp(cut(l, 240), tone)]));
  return shown(rows.slice(0, max), rows);
}

// A count with the lines it counted, for the owner to open.
const listed = (summary: TerminalLine, text: string): Shown => shown([summary], [summary, ...lines(text).map(dimLine)]);

type Hunk = { oldStart: number; newStart: number; lines: string[] };
const hunksOf = (data: unknown): Hunk[] => {
  const patch = obj(data).structuredPatch;
  if (!Array.isArray(patch)) return [];
  return patch.flatMap((h) => {
    const o = obj(h);
    const ls = Array.isArray(o.lines) ? o.lines.filter((l): l is string => typeof l === 'string') : [];
    return [{ oldStart: num(o.oldStart) ?? 1, newStart: num(o.newStart) ?? 1, lines: ls }];
  });
};

// Rows of a diff the way Claude Code draws it: the line number, a sign, the text, and the whole row tinted.
function diffRows(hunks: Hunk[]): TerminalLine[] {
  const out: TerminalLine[] = [];
  let width = 2;
  for (const h of hunks) width = Math.max(width, String(h.newStart + h.lines.length).length);
  for (const h of hunks) {
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      const sign = l[0] === '+' || l[0] === '-' ? l[0] : ' ';
      const body = l.slice(1);
      const at = sign === '-' ? o : n;
      if (sign !== '+') o++;
      if (sign !== '-') n++;
      const gutter = `${String(at).padStart(width)} ${sign} `;
      const bg = sign === '+' ? 'add' : sign === '-' ? 'del' : undefined;
      out.push(line([sp(gutter, bg ? undefined : 'dim'), sp(cut(body, 200), bg ? 'bright' : 'dim')], { hang: gutter.length, ...(bg ? { fill: bg } : {}) }));
    }
  }
  return out;
}

const countChanges = (hunks: Hunk[]) => {
  let add = 0;
  let del = 0;
  for (const h of hunks) for (const l of h.lines) (l[0] === '+' ? add++ : l[0] === '-' && del++);
  return { add, del };
};

// The first rows of a diff are shown, and every row to open.
const PREVIEW_DIFF = 12;

const TOOLS: Record<string, ToolStyle> = {
  Read: {
    label: () => 'Read',
    arg: (f) => relPath(str(f.input.file_path), f.cwd),
    done: (_f, r) => {
      const file = obj(obj(r.data).file);
      const all = lines(r.text);
      const n = num(file.numLines) ?? all.length;
      const summary = counted('Read ', n, n === 1 ? ' line' : ' lines');
      return shown([summary], [summary, ...all.map(dimLine)]);
    },
  },
  Write: {
    label: () => 'Write',
    arg: (f) => relPath(str(f.input.file_path), f.cwd),
    done: (f, r) => {
      const all = lines(str(f.input.content));
      const created = obj(r.data).type !== 'update';
      const summary = line([sp(created ? 'Wrote ' : 'Updated ', 'fg'), sp(String(all.length), 'bright', { b: true }), sp(` ${all.length === 1 ? 'line' : 'lines'} to ${relPath(str(f.input.file_path), f.cwd)}`, 'fg')]);
      // The text is what the owner reads, so it is as bright as the words above it. The numbers stay dim.
      const body = all.map((l, i) => line([sp(`${String(i + 1).padStart(3)}  `, 'dim'), sp(cut(l, 200), 'fg')]));
      return shown([summary, ...body.slice(0, 4)], [summary, ...body]);
    },
  },
  Edit: {
    label: () => 'Update',
    arg: (f) => relPath(str(f.input.file_path), f.cwd),
    done: (f, r) => {
      const hunks = hunksOf(r.data);
      const { add, del } = countChanges(hunks);
      const where = relPath(str(f.input.file_path), f.cwd);
      const words: Span[] = [sp('Updated ', 'fg'), sp(where, 'bright', { b: true }), sp(' with ', 'fg')];
      if (add) words.push(sp(String(add), 'bright', { b: true }), sp(add === 1 ? ' addition' : ' additions', 'fg'));
      if (add && del) words.push(sp(' and ', 'fg'));
      if (del) words.push(sp(String(del), 'bright', { b: true }), sp(del === 1 ? ' removal' : ' removals', 'fg'));
      if (!add && !del) words.push(sp('no changes', 'fg'));
      const diff = diffRows(hunks);
      return shown([line(words), ...diff.slice(0, PREVIEW_DIFF)], [line(words), ...diff]);
    },
  },
  Bash: {
    label: () => 'Bash',
    arg: (f) => cut(flat(str(f.input.command)), 160),
    done: (_f, r) => {
      const out = obj(r.data);
      const text = str(out.stdout) || str(out.stderr) ? [str(out.stdout), str(out.stderr)].filter(Boolean).join('\n') : r.text;
      return head(text, r.ok ? 'fg' : 'err');
    },
  },
  Glob: {
    label: () => 'Search',
    arg: (f) => [`pattern: "${str(f.input.pattern)}"`, str(f.input.path) ? `path: "${relPath(str(f.input.path), f.cwd)}"` : ''].filter(Boolean).join(', '),
    done: (_f, r) => {
      const n = num(obj(r.data).numFiles) ?? lines(r.text).filter((l) => l && !l.startsWith('No files')).length;
      return listed(counted('Found ', n, n === 1 ? ' file' : ' files'), r.text);
    },
  },
  Grep: {
    label: () => 'Search',
    arg: (f) => [`pattern: "${str(f.input.pattern)}"`, str(f.input.path) ? `path: "${relPath(str(f.input.path), f.cwd)}"` : ''].filter(Boolean).join(', '),
    done: (_f, r) => {
      const data = obj(r.data);
      const n = num(data.numFiles) ?? num(data.numLines) ?? lines(r.text).length;
      return listed(counted('Found ', n, data.mode === 'content' ? (n === 1 ? ' line' : ' lines') : n === 1 ? ' file' : ' files'), r.text);
    },
  },
  LS: { label: () => 'List', arg: (f) => relPath(str(f.input.path), f.cwd), done: (_f, r) => listed(counted('Listed ', lines(r.text).length, ' paths'), r.text) },
  WebFetch: { label: () => 'Fetch', arg: (f) => str(f.input.url), done: (_f, r) => head(r.text, undefined, 1) },
  WebSearch: { label: () => 'Web Search', arg: (f) => `"${str(f.input.query)}"`, done: () => ({ rows: [counted('Did ', 1, ' search')] }) },
  TodoWrite: {
    label: () => 'Update Todos',
    arg: () => '',
    done: (f) => {
      const todos = Array.isArray(f.input.todos) ? f.input.todos.map(obj) : [];
      return {
        rows: todos.map((t) => {
          const done = t.status === 'completed';
          const now = t.status === 'in_progress';
          return line([sp(done ? '☒ ' : '☐ ', done ? 'dim' : now ? 'accent' : 'fg'), sp(str(t.content), done ? 'dim' : now ? 'bright' : 'fg', now ? { b: true } : {})]);
        }),
      };
    },
  },
  Task: { label: () => 'Task', arg: (f) => cut(flat(str(f.input.description)), 100), done: (_f, r) => head(r.text, undefined, 2) },
  // The task list Claude Code keeps: the calls say what changed, and the spinner shows the task being done.
  TaskCreate: { quiet: true, label: () => 'Add task', arg: (f) => cut(flat(str(f.input.subject)), 100), done: () => ({ rows: [] }) },
  TaskUpdate: {
    quiet: true,
    label: () => 'Update task',
    arg: (f) => [`#${str(f.input.taskId)}`, str(f.input.status).replace('_', ' ')].filter((x) => x.length > 1).join(' · '),
    done: () => ({ rows: [] }),
  },
  TaskList: { quiet: true, label: () => 'List tasks', arg: () => '', done: (_f, r) => head(r.text, undefined, 4) },
  TaskGet: { quiet: true, label: () => 'Get task', arg: (f) => `#${str(f.input.taskId)}`, done: () => ({ rows: [] }) },
};
// A change a harness reports by the files it touched and not by what it changed in them.
TOOLS.Patch = {
  label: () => 'Update',
  arg: (f) => cut(((Array.isArray(f.input.paths) ? f.input.paths : [str(f.input.file_path)]).filter((p): p is string => typeof p === 'string' && !!p)).map((p) => relPath(p, f.cwd)).join(', ') || 'files', 100),
  done: (f) => {
    const n = Array.isArray(f.input.paths) ? f.input.paths.length : 1;
    return { rows: [line([sp('Updated ', 'fg'), sp(String(n), 'bright', { b: true }), sp(n === 1 ? ' file' : ' files', 'fg')])] };
  },
};
TOOLS.MultiEdit = TOOLS.Edit!;
TOOLS.NotebookEdit = TOOLS.Edit!;
TOOLS.Agent = TOOLS.Task!;

// The office's own tools read like any other server's: "office - message (MCP)(text: "…")".
const mcp = /^mcp__(.+?)__(.+)$/;
function compact(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([k]) => k !== 'requestId')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${cut(flat(v), 80)}"` : cut(JSON.stringify(v) ?? '', 60)}`)
    .join(', ');
}

function styleOf(name: string): ToolStyle {
  const known = TOOLS[name];
  if (known) return known;
  const m = mcp.exec(name);
  return {
    label: () => (m ? `${m[1]} - ${m[2]} (MCP)` : name),
    arg: (f) => cut(compact(f.input), 160),
    // A server that says only that it is fine has nothing to show under the call.
    done: (_f, r) => (/^\s*\{\s*"ok"\s*:\s*true\s*\}\s*$/.test(r.text) ? { rows: [] } : head(r.text, undefined, 2)),
  };
}

const DENIED = /^The boss did not allow this/;
// What the SDK sends back for a call the owner stopped with Esc.
const STOPPED = /^(The user doesn't want to proceed with this tool use|\[Request interrupted by user)/;
const interruptedRow = (): TerminalLine => line([sp('Interrupted', 'err'), sp(' · What should Claude do instead?', 'dim')]);

function failure(text: string): Shown {
  const first = lines(text);
  if (STOPPED.test(text)) return { rows: [interruptedRow()] };
  if (DENIED.test(text)) return { rows: [line([sp(cut(first[0] ?? 'Denied', 240), 'err')])] };
  if (!first.length) return { rows: [line([sp('Error', 'err')])] };
  const rows = first.map((l, i) => line([sp(i === 0 ? `Error: ${cut(l, 230)}` : cut(l, 240), 'err')]));
  return shown(rows.slice(0, 3), rows);
}

// `⎿` leads the first row under a call, and the rows after it line up under that one.
const under = (rows: TerminalLine[]): TerminalLine[] =>
  rows.map((l, i) => line([sp(i === 0 ? '  ⎿  ' : '     ', 'dim'), ...l.spans], { hang: 5 + (l.hang ?? 0), ...(l.fill ? { fill: l.fill } : {}) }));

// A call: its first line, what it printed collapsed, and `full` for the owner who opens it. A click on a line with `toggle` does that.
export type Tool = { lines: TerminalLine[]; full?: TerminalLine[] };

export const isChore = (name: string): boolean => !!styleOf(name).quiet;

// The call, and the result under it when there is one.
export function toolLines(name: string, input: Record<string, unknown>, cwd: string, result?: Result): Tool {
  const style = styleOf(name);
  const f: Facts = { name, input, cwd };
  const dot = !result || style.quiet ? sp('● ', 'dim') : sp('● ', result.ok ? 'ok' : 'err');
  const call = style.quiet
    ? line([dot, sp(`${style.label(f)}(${style.arg(f)})`, 'dim')], { hang: 2 })
    : line([dot, sp(style.label(f), 'bright', { b: true }), sp(`(${style.arg(f)})`, 'fg')], { hang: 2 });
  if (!result) return { lines: [call] };
  const { rows, full } = result.ok ? style.done(f, result) : failure(result.text);
  if (!full) return { lines: [call, ...under(rows)] };
  const opening = { ...call, toggle: true as const };
  const hidden = full.length - rows.length;
  // A result of one line says "click to expand" after it. A longer one says how many lines are left, under it.
  const preview =
    rows.length === 1
      ? under([line([...rows[0]!.spans, sp(EXPAND_HINT, 'dim')])])
      : [...under(rows), line([sp(`     … +${plural(hidden, 'line')} (click to expand)`, 'dim')], { hang: 5, toggle: true })];
  return {
    lines: [opening, ...preview],
    full: [opening, ...under(full), line([sp('     (click to collapse)', 'dim')], { hang: 5, toggle: true })],
  };
}

// ---------------------------------------------------------------- the buffer

// Lines kept per employee. Old blocks go first, the banner never.
export const TERMINAL_LINES = 800;
// What one prompt echo shows before it is cut.
const PROMPT_LINES = 8;
const PROMPT_TEXT = 1200;

const CLAWD = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝'];

// The block glyphs the mascot is drawn with, as which quarters of the cell they fill: upper left, upper right, lower left, lower right.
// A font draws them with gaps at the edges of the line, so both renderers fill the quarters themselves.
const QUARTERS: Record<string, readonly [boolean, boolean, boolean, boolean]> = {
  '▘': [true, false, false, false], '▝': [false, true, false, false], '▖': [false, false, true, false], '▗': [false, false, false, true],
  '▌': [true, false, true, false], '▐': [false, true, false, true], '▀': [true, true, false, false], '▄': [false, false, true, true],
  '▛': [true, true, true, false], '▜': [true, true, false, true], '▙': [true, false, true, true], '▟': [false, true, true, true],
  '█': [true, true, true, true], '▚': [true, false, false, true], '▞': [false, true, true, false],
};
export const quartersOf = (ch: string): readonly [boolean, boolean, boolean, boolean] | undefined => QUARTERS[ch];

// "claude-haiku-4-5-20251001" reads "Haiku 4.5", as the header of Claude Code writes a model. Another harness's model id stays as it is.
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id;
}

// A long folder keeps its tail: the name of the project is what the owner knows it by.
const tail = (path: string, n: number) => (path.length > n ? `…${path.slice(-(n - 1))}` : path);

function bannerLines(title: string, model: string, cwd: string): TerminalLine[] {
  const info = [[sp(title, 'bright', { b: true })], [sp(modelName(model), 'dim')], [sp(tail(cwd, 44), 'dim')]];
  return CLAWD.map((art, i) => line([sp(art.padEnd(11), 'accent'), ...(info[i] ?? [])], { hang: 11 }));
}

// One line of the list an employee keeps for itself, whether it writes the whole list at once (TodoWrite) or one task at a time (TaskCreate, TaskUpdate).
type Todo = { id?: string; content: string; status: string; activeForm?: string };

const todosOf = (input: Record<string, unknown>): Todo[] =>
  (Array.isArray(input.todos) ? input.todos.map(obj) : []).map((t) => ({ content: str(t.content), status: str(t.status), ...(str(t.activeForm) ? { activeForm: str(t.activeForm) } : {}) }));

// What the list says the employee is doing and will do next. A list with nothing left to do says nothing.
function planOf(todos: readonly Todo[]): Plan | undefined {
  const open = todos.filter((t) => t.status !== 'completed');
  const active = open.find((t) => t.status === 'in_progress') ?? open[0];
  if (!active) return undefined;
  const next = open.slice(open.indexOf(active) + 1).find((t) => t.status !== 'in_progress');
  const sentence = (text: string) => flat(text).replace(/^./, (c) => c.toUpperCase());
  return { active: sentence(active.activeForm || active.content), ...(next ? { next: sentence(next.content) } : {}) };
}

export class TerminalBuffer {
  private readonly blocks = new Map<number, TermBlock>();
  private next = 1;
  // The turn the last prompt opened. Block 0, the banner, and anything printed before a prompt is turn 0.
  private turn = 0;
  // Which block holds a text, thinking or tool id.
  private readonly byId = new Map<string, number>();
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  // A call already says it was interrupted, so the end of the turn need not.
  private stoppedCall = false;
  // The last block added is a thought, so another one right after it joins it.
  private lastIsThought = false;
  private dirty = new Set<number>();
  // The token count changed, though no block did.
  private liveDirty = false;
  private from = 1;
  private everSent = false;
  private tokens = 0;
  private todos: Todo[] = [];
  // A TaskCreate that has not come back with its id yet.
  private readonly creating = new Map<string, Todo>();
  private asks: Ask[] = [];
  private readonly cwd: string;

  constructor(cwd: string, title = 'Claude Code', model = '') {
    this.cwd = cwd;
    this.put(0, 'banner', bannerLines(title, model, cwd));
  }

  get live(): TermLive {
    const plan = planOf(this.todos);
    return { tokens: this.tokens, ...(plan ? { plan } : {}), ...(this.asks.length ? { asks: this.asks } : {}) };
  }

  // The list changes with the calls that write it.
  private listChanged(e: Extract<TermEvent, { k: 'tool' }>) {
    if (e.name === 'TodoWrite') this.todos = todosOf(e.input);
    else if (e.name === 'TaskCreate') this.creating.set(e.id, { content: str(e.input.subject), status: 'pending', ...(str(e.input.activeForm) ? { activeForm: str(e.input.activeForm) } : {}) });
    else if (e.name === 'TaskUpdate') {
      const id = str(e.input.taskId);
      const status = str(e.input.status);
      this.todos = this.todos.flatMap((t) => (t.id !== id ? [t] : status === 'deleted' ? [] : [{ ...t, ...(status ? { status } : {}), ...(str(e.input.subject) ? { content: str(e.input.subject) } : {}), ...(str(e.input.activeForm) ? { activeForm: str(e.input.activeForm) } : {}) }]));
    } else return;
    this.liveDirty = true;
  }

  private put(n: number, kind: BlockKind, ls: TerminalLine[], full?: TerminalLine[]) {
    // A block that says more keeps the turn it began in.
    const turn = this.blocks.get(n)?.turn ?? this.turn;
    this.blocks.set(n, { n, turn, kind, lines: ls, ...(full ? { full } : {}) });
    this.dirty.add(n);
  }

  private add(kind: BlockKind, ls: TerminalLine[], id?: string, full?: TerminalLine[]): number {
    this.lastIsThought = false;
    const n = this.next++;
    this.put(n, kind, ls, full);
    if (id) this.byId.set(id, n);
    this.trim();
    return n;
  }

  // A block with this id says more, or is new.
  private upsert(id: string, kind: BlockKind, ls: TerminalLine[], full?: TerminalLine[]) {
    const n = this.byId.get(id);
    if (n !== undefined && this.blocks.has(n)) this.put(n, kind, ls, full);
    else this.add(kind, ls, id, full);
  }

  private trim() {
    let total = 0;
    for (const b of this.blocks.values()) total += b.lines.length;
    if (total <= TERMINAL_LINES) return;
    for (const n of [...this.blocks.keys()].sort((a, b) => a - b)) {
      if (n === 0) continue;
      if (total <= TERMINAL_LINES || this.blocks.size <= 2) break;
      total -= this.blocks.get(n)!.lines.length;
      this.blocks.delete(n);
      this.dirty.delete(n);
      this.from = n + 1;
    }
  }

  apply(e: TermEvent): void {
    switch (e.k) {
      case 'prompt': {
        const all = e.text.replace(/\r/g, '').trim().split('\n');
        const shown = all.slice(0, PROMPT_LINES);
        const ls = shown.map((l, i) => line([sp(i === 0 ? '❯ ' : '  ', 'dim', { bg: 'user' }), sp(cut(l, PROMPT_TEXT), 'bright', { bg: 'user' })], { hang: 2 }));
        if (all.length > PROMPT_LINES) ls.push(line([sp(`  … +${plural(all.length - PROMPT_LINES, 'line')}`, 'dim')]));
        this.turn++;
        this.add('prompt', ls);
        return;
      }
      case 'text':
        this.upsert(`text:${e.id}`, 'say', proseLines(e.text, [sp('● ', 'bright')]));
        return;
      case 'thinking': {
        // Thoughts with nothing printed between them are one line.
        const key = `think:${e.id}`;
        const n = this.byId.get(key) ?? (this.lastIsThought ? this.next - 1 : undefined);
        const ls = [line([sp(e.secs === undefined ? '∴ Thinking…' : `∴ Thought for ${Math.max(1, Math.round(e.secs))}s`, 'dim', { i: true })])];
        if (n !== undefined && this.blocks.has(n)) {
          this.put(n, 'thought', ls);
          this.byId.set(key, n);
        } else this.add('thought', ls, key);
        this.lastIsThought = true;
        return;
      }
      case 'tool':
        this.tools.set(e.id, { name: e.name, input: e.input });
        this.upsert(`tool:${e.id}`, isChore(e.name) ? 'chore' : 'call', toolLines(e.name, e.input, this.cwd).lines);
        this.listChanged(e);
        return;
      case 'result': {
        if (!e.ok && STOPPED.test(e.text)) this.stoppedCall = true;
        const call = this.tools.get(e.id);
        const t = toolLines(call?.name ?? 'Tool', call?.input ?? {}, this.cwd, { ok: e.ok, text: e.text.slice(0, 20_000), data: e.data });
        this.upsert(`tool:${e.id}`, isChore(call?.name ?? '') ? 'chore' : 'call', t.lines, t.full);
        this.tools.delete(e.id);
        const made = this.creating.get(e.id);
        if (made) {
          this.creating.delete(e.id);
          if (e.ok) {
            const id = str(obj(obj(e.data).task).id) || /#(\d+)/.exec(e.text)?.[1] || String(this.todos.length + 1);
            this.todos = [...this.todos, { ...made, id }];
            this.liveDirty = true;
          }
        }
        return;
      }
      case 'end': {
        // A call still waiting for its result will never get one.
        let said = this.stoppedCall;
        for (const [id, call] of this.tools) {
          const n = this.byId.get(`tool:${id}`);
          if (n === undefined || !this.blocks.has(n)) continue;
          this.put(n, isChore(call.name) ? 'chore' : 'call', toolLines(call.name, call.input, this.cwd, { ok: false, text: e.how === 'interrupted' ? "The user doesn't want to proceed with this tool use" : 'Stopped' }).lines);
          said ||= e.how === 'interrupted';
        }
        this.tools.clear();
        this.stoppedCall = false;
        this.tokens = 0;
        this.todos = [];
        this.creating.clear();
        this.asks = [];
        this.liveDirty = true;
        if (e.how === 'interrupted') {
          if (!said) this.add('end', [line([sp('  ⎿  ', 'dim'), ...interruptedRow().spans])]);
        } else if (e.how === 'done' && e.ms !== undefined && e.ms >= 5000) {
          // A turn that took a while says how long, with a verb in the past, as Claude Code does.
          this.add('end', [line([sp('✻ ', 'accent'), sp(`${PAST[Math.floor(e.ms / 1000) % PAST.length]} for ${secsText(e.ms)}`, 'dim')])]);
        } else if (e.how === 'error') this.add('end', [line([sp('  ⎿  ', 'dim'), sp(`Error: ${cut(flat(e.message ?? 'The turn failed'), 300)}`, 'err')], { hang: 5 })]);
        return;
      }
      case 'note':
        this.add('note', [line([sp(e.text, e.tone ?? 'dim')], { hang: 2 })]);
        return;
      case 'tokens':
        this.tokens = e.out;
        this.liveDirty = true;
        return;
      case 'approval':
        // The last few are kept: a turn can have several calls waiting, and the owner sees them one at a time.
        this.asks = [...this.asks.filter((a) => a.detail !== e.detail), { detail: e.detail, ...(e.description ? { description: e.description } : {}), ...(e.reason ? { reason: e.reason } : {}) }].slice(-4);
        this.liveDirty = true;
        return;
      case 'banner':
        this.put(0, 'banner', bannerLines(e.title, e.model, e.cwd));
        return;
    }
  }

  // The blocks that changed since the last call, or undefined when nothing did.
  take(): TerminalPush | undefined {
    if (!this.dirty.size && !this.liveDirty && this.everSent) return undefined;
    const blocks = [...this.dirty].sort((a, b) => a - b).flatMap((n) => this.blocks.get(n) ?? []);
    this.dirty = new Set();
    this.liveDirty = false;
    const reset = !this.everSent;
    this.everSent = true;
    return { from: this.from, blocks, live: this.live, ...(reset ? { reset } : {}) };
  }

  // Everything the buffer holds, for a window that just opened.
  full(): TerminalPush {
    this.everSent = true;
    this.dirty = new Set();
    this.liveDirty = false;
    return { from: this.from, blocks: [...this.blocks.values()].sort((a, b) => a.n - b.n), live: this.live, reset: true };
  }

  get size(): number {
    return this.blocks.size;
  }

  all(): TermBlock[] {
    return [...this.blocks.values()].sort((a, b) => a.n - b.n);
  }
}

// What a window does with a push: replace the blocks it names, forget the ones the sender dropped.
export function applyPush(held: Map<number, TermBlock>, push: TerminalPush): void {
  if (push.reset) held.clear();
  for (const b of push.blocks) held.set(b.n, b);
  for (const n of [...held.keys()]) if (n !== 0 && n < push.from) held.delete(n);
}

// ---------------------------------------------------------------- laying out for a width

// What a click on a row does: open or close an old turn, open or close a call's whole result, or pick a choice of the dialog.
export type Act = { turn: number } | { block: number } | { option: number };
// `old` marks a row of an old turn the owner opened, which is drawn dimmer than the turn in progress.
export type Row = { spans: Span[]; fill?: Bg; act?: Act; old?: true };

const sameStyle = (a: Span, b: Span) => a.c === b.c && a.b === b.b && a.i === b.i && a.bg === b.bg;
function push(row: Span[], s: Span) {
  if (!s.t) return;
  const last = row[row.length - 1];
  if (last && sameStyle(last, s)) last.t += s.t;
  else row.push({ ...s });
}

// Breaks a line into rows no wider than `cols`, at spaces where it can and mid-word where it must. Every character is one cell.
export function wrap(l: TerminalLine, cols: number): Row[] {
  const width = Math.max(8, cols);
  const hang = Math.min(l.hang ?? 0, Math.floor(width / 2));
  const rows: Row[] = [];
  let cur: Span[] = [];
  let col = 0;
  const flush = () => {
    const last = cur[cur.length - 1];
    if (last) last.t = last.t.trimEnd();
    if (last && !last.t) cur.pop();
    rows.push({ spans: cur, ...(l.fill ? { fill: l.fill } : {}) });
    cur = [];
    col = 0;
  };
  const indent = () => {
    if (hang) push(cur, sp(' '.repeat(hang)));
    col = hang;
  };
  for (const s of l.spans) {
    for (const tok of s.t.match(/ +|[^ ]+/g) ?? []) {
      const isSpace = tok[0] === ' ';
      if (col + tok.length <= width) {
        push(cur, { ...s, t: tok });
        col += tok.length;
        continue;
      }
      if (isSpace) {
        flush();
        indent();
        continue;
      }
      if (col > hang) {
        flush();
        indent();
      }
      let rest = tok;
      while (col + rest.length > width) {
        const room = Math.max(1, width - col);
        push(cur, { ...s, t: rest.slice(0, room) });
        rest = rest.slice(room);
        flush();
        indent();
      }
      push(cur, { ...s, t: rest });
      col += rest.length;
    }
  }
  if (cur.length || !rows.length) flush();
  return rows;
}

const blankRow = (): Row => ({ spans: [] });

// What the owner has opened. Everything else is as it was printed: the turn in progress in full, older turns as a row each.
export type View = {
  // Older turns shown in full, by turn.
  turns?: ReadonlySet<number>;
  // Calls shown with all of their result, by block.
  calls?: ReadonlySet<number>;
  // A monitor on a desk: no blank rows, a call and one line of its result, at most three rows to a block.
  compact?: boolean;
};

const textOf = (l: TerminalLine | undefined): string => (l ? l.spans.map((s) => s.t).join('') : '');
const blockText = (b: TermBlock): string => b.lines.map(textOf).join('\n');

// An older turn as one row: what was asked, how many calls it took, how it ended, and what the employee said at the end.
function summaryRow(group: readonly TermBlock[], cols: number, open: boolean): Row {
  const asked = flat(textOf(group.find((b) => b.kind === 'prompt')?.lines[0]).replace(/^❯ /, '')) || 'earlier';
  const calls = group.filter((b) => b.kind === 'call').length;
  const failed = group.some((b) => /Interrupted · /.test(blockText(b))) ? 'interrupted' : group.some((b) => b.kind === 'end' && /Error: /.test(blockText(b))) ? 'failed' : '';
  const said = flat(textOf(group.findLast((b) => b.kind === 'say')?.lines[0]).replace(/^● /, ''));
  const meta = [calls ? plural(calls, 'call') : '', failed].filter(Boolean).join(' · ');
  const tail = meta ? `  · ${meta}` : '';
  // What was asked gets what the answer leaves, and the answer is what the row is for, so it keeps up to a third of the width.
  const reply = said ? 4 + Math.min(said.length, Math.floor(cols / 3)) : 0;
  const ask = cut(asked, Math.max(10, cols - 4 - tail.length - reply));
  const spans: Span[] = [sp(open ? '▾ ' : '▸ ', 'dim'), sp('❯ ', 'dim'), sp(ask, 'fg')];
  if (tail) spans.push(sp(tail, failed ? 'err' : 'dim'));
  const room = cols - 4 - ask.length - tail.length - 4;
  if (said && room >= Math.min(said.length, 10)) spans.push(sp('  → ', 'dim'), sp(cut(said, room), 'dim'));
  return { spans, act: { turn: group[0]!.turn } };
}

function blockRows(b: TermBlock, cols: number, v: View, old: boolean): Row[] {
  const opened = !v.compact && !!b.full && !!v.calls?.has(b.n);
  const ls = opened ? b.full! : v.compact && b.kind === 'call' ? b.lines.slice(0, 2).map((l) => ({ ...l, spans: l.spans.filter((x) => x.t !== EXPAND_HINT) })) : b.lines;
  const rows = ls.flatMap((l) => {
    const wrapped = wrap(l, cols).map((r): Row => (l.toggle ? { ...r, act: { block: b.n } } : r));
    // A call on a monitor is its first line and one line of what it printed, each on one row.
    return v.compact && b.kind === 'call' ? wrapped.slice(0, 1) : wrapped;
  });
  const kept = v.compact ? rows.slice(0, 3) : rows;
  return old ? kept.map((r) => ({ ...r, old: true as const })) : kept;
}

// The log in three parts: what came before the first prompt (the header), the turns before the current one, and the current turn.
export type Log = { head: Row[]; past: Row[]; now: Row[] };

// The blocks in order, a blank row between neighbours as the terminal prints them. The last turn is printed in full. Each turn before it
// is one row until the owner opens it, and then it is drawn dimmer than the turn in progress.
export function layoutLog(blocks: readonly TermBlock[], cols: number, v: View = {}): Log {
  const log: Log = { head: [], past: [], now: [] };
  const lasts: Record<keyof Log, BlockKind | 'summary' | undefined> = { head: undefined, past: undefined, now: undefined };
  const current = blocks.at(-1)?.turn ?? 0;
  for (let i = 0; i < blocks.length; ) {
    const turn = blocks[i]!.turn;
    let j = i;
    while (j < blocks.length && blocks[j]!.turn === turn) j++;
    const group = blocks.slice(i, j);
    i = j;
    const part: keyof Log = turn === 0 ? 'head' : turn === current ? 'now' : 'past';
    const out = log[part];
    // A thought sits right above what it led to, chores sit together, and old turns sit together.
    const gap = (next: BlockKind | 'summary') => {
      const last = lasts[part];
      const tight = last === 'thought' || (last === 'chore' && next === 'chore') || (last === 'summary' && next === 'summary');
      if (out.length && !v.compact && !tight) out.push(blankRow());
      lasts[part] = next;
    };
    const old = part === 'past';
    const open = !old || !!v.turns?.has(turn);
    if (old) {
      gap('summary');
      out.push(summaryRow(group, cols, open));
    }
    if (!open) continue;
    for (const b of group) {
      // A monitor has no room for bookkeeping: the list is in the spinner.
      if (!b.lines.length || (v.compact && b.kind === 'chore')) continue;
      gap(b.kind);
      out.push(...blockRows(b, cols, v, old));
    }
  }
  return log;
}

// The same, as one list of rows: the log of a monitor on a desk, or a screen.
export function layoutBlocks(blocks: readonly TermBlock[], cols: number, v: View = {}): Row[] {
  const { head, past, now } = layoutLog(blocks, cols, v);
  const parts = [head, past, now].filter((rows) => rows.length);
  return parts.flatMap((rows, i) => (i > 0 && !v.compact ? [blankRow(), ...rows] : rows));
}

export const rowText = (r: Row): string => r.spans.map((s) => s.t).join('');

// ---------------------------------------------------------------- the part under the blocks

const GLYPHS = ['·', '✢', '✳', '∗', '✻', '✽'];
const VERBS = [
  'Accomplishing', 'Baking', 'Brewing', 'Calculating', 'Cerebrating', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Computing', 'Conjuring',
  'Considering', 'Cooking', 'Crafting', 'Crunching', 'Deliberating', 'Finagling', 'Forging', 'Generating', 'Grooving', 'Hatching', 'Herding', 'Hustling',
  'Ideating', 'Inferring', 'Manifesting', 'Marinating', 'Moseying', 'Mulling', 'Musing', 'Noodling', 'Percolating', 'Pondering', 'Processing',
  'Puzzling', 'Reticulating', 'Ruminating', 'Simmering', 'Spinning', 'Stewing', 'Synthesizing', 'Transmuting', 'Vibing', 'Working',
];

const PAST = ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Pondered', 'Simmered', 'Worked'];
export const verbOf = (startedAt: number): string => VERBS[Math.abs(Math.floor(startedAt / 1000)) % VERBS.length]!;
export const glyphOf = (now: number): string => GLYPHS[Math.floor(now / 160) % GLYPHS.length]!;

const tokensText = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const secsText = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

// The line of what the employee is doing: the verb Claude Code makes up, or the todo it is on when it keeps a list, with the next one under it.
export function spinnerRows(startedAt: number, now: number, tokens: number, cols: number, quantum = 160, plan?: Plan, compact = false): Row[] {
  const glyph = GLYPHS[Math.floor(now / quantum) % GLYPHS.length]!;
  const bits = [secsText(now - startedAt), ...(tokens > 0 ? [`↑ ${tokensText(tokens)} tokens`] : []), ...(compact ? [] : ['esc to interrupt'])];
  const doing = plan ? plan.active : verbOf(startedAt);
  const main = wrap(line([sp(`${glyph} `, 'accent', { b: true }), sp(`${doing}… `, 'accent', { b: !!plan }), sp(`(${bits.join(' · ')})`, 'dim')], { hang: 2 }), cols);
  if (!plan?.next) return main;
  return [...main, ...wrap(line([sp('  ⎿  ', 'dim'), sp('Next: ', 'dim', { b: true }), sp(cut(plan.next, 160), 'fg')], { hang: 5 }), cols)];
}

// The rule above and below the prompt, and the dashed one around a command.
export const ruleRow = (cols: number, tone: Tone = 'rule'): Row => ({ spans: [sp('─'.repeat(cols), tone)] });
const dashedRow = (cols: number): Row => ({ spans: [sp('╌'.repeat(cols), 'rule')] });

// What a choice does. `pick` is one of the options an employee offered.
export type Option = { key: string; label: string; kind: 'allow' | 'always' | 'deny' | 'pick' };

// What the "don't ask again" choice stores, word for word: `npm test *` is every command that starts with those words, `exactly`
// is that command and no other, and a tool is every use of it. The office stores `ruleFor(question)`, and this prints the same rule.
export function alwaysLabel(rule: AllowRule): string {
  switch (rule.kind) {
    case 'command':
      return `Yes, and don't ask again for: ${rule.prefix} *`;
    case 'exact':
      return `Yes, and don't ask again for exactly: ${rule.command}`;
    case 'tool':
      return `Yes, and don't ask again for: all ${rule.name} calls`;
  }
}

// What the owner can pick on a card: the same choices Claude Code's permission dialog offers.
export function optionsOf(q: Question): Option[] {
  if (q.kind === 'permission') {
    const rule = ruleFor(q);
    return [
      { key: '1', label: 'Yes', kind: 'allow' },
      ...(rule ? [{ key: '2', label: alwaysLabel(rule), kind: 'always' as const }] : []),
      { key: rule ? '3' : '2', label: 'No', kind: 'deny' },
    ];
  }
  return (q.options ?? []).map((label, i) => ({ key: String(i + 1), label, kind: 'pick' as const }));
}

const TITLES: Record<string, string> = { [SHELL_TOOL]: 'Bash command', Write: 'Create file', Edit: 'Edit file', MultiEdit: 'Edit file', NotebookEdit: 'Edit notebook', Read: 'Read file' };
export const questionTitle = (q: Question): string => (q.kind === 'permission' ? (TITLES[q.tool] ?? `Use ${q.tool}`) : 'The employee is asking you');

// What the owner's typing under the No choice reads, so the choice and the words stay on one row.
export const AMEND_LEAD = 'No, and tell them what to do differently: ';

export type QuestionView = {
  picked?: number;
  // What the call waiting says about itself, from `TermLive.asks`.
  ask?: Ask;
  // Who is asking and on what, for the foot of the dialog.
  who?: string;
  // The words typed under No, once the owner pressed Tab. Undefined while the owner is not amending.
  amend?: string;
  // A monitor on a desk: the command and the choices, nothing else.
  compact?: boolean;
};

// A command between its rules. A long one keeps its first rows and says how many it left out.
function commandRows(detail: string, cols: number, max: number): Row[] {
  const rows = detail.replace(/\r/g, '').split('\n').flatMap((l) => wrap(line([sp(' '), sp(cut(l, 400), 'bright')], { hang: 1 }), cols));
  return rows.length <= max ? rows : [...rows.slice(0, max), { spans: [sp(` … +${plural(rows.length - max, 'line')}`, 'dim')] }];
}

// The dialog a question puts on the screen: Claude Code's own permission prompt for a call, a plain list for a question.
export function questionRows(q: Question, cols: number, v: QuestionView = {}): Row[] {
  const { picked = 0, compact = false } = v;
  const out: Row[] = [ruleRow(cols, 'violet'), { spans: [sp(` ${questionTitle(q)}`, 'violet', { b: true })] }];
  const options = optionsOf(q);
  const optionRows = () =>
    options.flatMap((o, i) => {
      const on = i === picked;
      const amending = v.amend !== undefined && o.kind === 'deny';
      const text = amending ? `${o.key}. ${AMEND_LEAD}${v.amend}` : `${o.key}. ${o.label}`;
      return wrap(line([sp(on ? ' ❯ ' : '   ', 'violet'), sp(text, on ? 'violet' : 'fg'), ...(amending ? [sp('█', 'dim')] : [])], { hang: 6 }), cols).map((r) => ({ ...r, act: { option: i } }));
    });
  if (q.kind === 'permission') {
    if (!compact) {
      if (v.ask?.description) out.push({ spans: [sp(` ${cut(flat(v.ask.description), Math.max(8, cols - 2))}`, 'dim')] });
      out.push(dashedRow(cols));
    }
    out.push(...commandRows(q.detail, cols, compact ? 2 : 8));
    if (!compact) {
      // The harness says why it asks when it can. Otherwise the dialog says only that it must.
      const why = v.ask?.reason ? flat(v.ask.reason) : `This ${q.tool === SHELL_TOOL ? 'command' : 'action'} requires approval`;
      out.push(dashedRow(cols), ...wrap(line([sp(' '), sp(why, 'fg')], { hang: 1 }), cols), blankRow());
    }
    out.push({ spans: [sp(' Do you want to proceed?', 'fg')] }, ...optionRows());
    if (!compact) {
      const hint = v.amend === undefined ? ' Esc to cancel · Tab to amend' : ' Enter to send · Esc to cancel';
      const right = v.who ?? '';
      out.push(blankRow(), { spans: [sp(hint, 'dim'), ...(right ? [sp(' '.repeat(Math.max(1, cols - hint.length - right.length - 1)) + right, 'dim')] : [])] });
    }
    return out;
  }
  out.push(blankRow(), ...wrap(line([sp(' '), sp(q.text, 'bright')], { hang: 1 }), cols), ...optionRows());
  return out;
}

export type ScreenArgs = {
  blocks: readonly TermBlock[];
  live: TermLive;
  status: EmployeeStatus;
  now: number;
  cols: number;
  rows: number;
  // Fewer rows of furniture: no blank rows, no hint line. The monitor on a desk uses it.
  compact?: boolean;
  // What the owner opened in the log.
  view?: View;
  draft?: string;
  // Who and what the status line names, and how much the employee may do without asking.
  who?: string;
  model?: string;
  mode?: PermissionMode;
};

// What Claude Code's status line says of a permission mode. `ask` is its default mode, which says nothing.
export const MODE_LINE: Record<PermissionMode, { glyph: string; text: string; tone: Tone }> = {
  inherit: { glyph: '▸▸', text: 'accept edits on', tone: 'violet' },
  ask: { glyph: '⏸', text: 'manual mode on', tone: 'dim' },
  auto: { glyph: '▸▸', text: 'auto mode on', tone: 'warn' },
  yolo: { glyph: '▸▸', text: 'bypass permissions on', tone: 'err' },
};

// The bottom of the screen: what the harness is doing, a question waiting on the owner, the prompt.
export function footerOf(a: ScreenArgs): Row[] {
  const { cols, status, now } = a;
  const out: Row[] = [];
  const gap = () => {
    if (!a.compact) out.push(blankRow());
  };
  if (status.kind === 'blocked_on_owner') {
    gap();
    const q = status.question;
    const who = [a.who, a.model].filter(Boolean).join(' · ');
    const ask = q.kind === 'permission' ? a.live.asks?.find((x) => x.detail === q.detail) : undefined;
    out.push(...questionRows(q, cols, { ...(ask ? { ask } : {}), who, compact: a.compact }));
    // A permission dialog is the whole bottom of the screen: no prompt box under it, as in Claude Code.
    if (q.kind === 'permission') return out;
  } else if (status.kind === 'working') {
    gap();
    out.push(...spinnerRows(status.startedAt, now, a.live.tokens, cols, a.compact ? 500 : 160, a.live.plan, a.compact));
    gap();
  } else if (status.kind === 'error') {
    gap();
    out.push({ spans: [sp('  ⎿  ', 'dim'), sp(cut(`Error: ${flat(status.message)}`, Math.max(20, cols - 6)), 'err')] });
    gap();
  }
  out.push(ruleRow(cols), { spans: [sp('❯ ', 'dim'), sp(a.draft ?? '', 'bright'), sp('█', 'dim')] }, ruleRow(cols));
  if (!a.compact) {
    const mode = a.mode ? MODE_LINE[a.mode] : undefined;
    const left: Span[] = mode ? [sp(`  ${mode.glyph} ${mode.text} `, mode.tone), sp(mode.glyph === '⏸' ? '· ? for shortcuts' : '(shift+tab to cycle)', 'dim')] : [sp('  ? for shortcuts', 'dim')];
    const right = [a.who, a.model].filter(Boolean).join(' · ');
    const used = left.reduce((n, x) => n + x.t.length, 0);
    out.push({ spans: [...left, sp(' '.repeat(Math.max(1, cols - used - right.length - 1)) + right, 'dim')] });
  }
  return out;
}

// What the screen shows, exactly `rows` rows: the last of the blocks above the footer. A short log leaves the prompt under it, as a terminal does.
export function screenOf(a: ScreenArgs): Row[] {
  const body = layoutBlocks(a.blocks, a.cols, { ...a.view, compact: a.compact });
  const all = [...body, ...footerOf(a)];
  if (all.length > a.rows) {
    const foot = footerOf(a);
    const keep = Math.max(0, a.rows - foot.length);
    return [...(keep ? body.slice(-keep) : []), ...foot].slice(-a.rows);
  }
  while (all.length < a.rows) all.push(blankRow());
  return all;
}
