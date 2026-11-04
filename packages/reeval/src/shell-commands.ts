// The programs a shell command line runs, for `toHaveRun({ program })` and `shellCommands`:
// shell-quote's words and operators, with a fixed list of wrappers unwrapped on top. Aliases,
// functions and backticks aren't followed.
import { parse } from 'shell-quote'
import { isObjectLike } from './object.ts'
import type { AttemptContext, TranscriptEvent, Turn } from './types.ts'

/** One program a shell call ran: a segment of its command line, after its wrappers. */
export type ShellCommand = {
  /**
   * The program, without its directory (`./node_modules/.bin/genkit` is `genkit`). One a package
   * runner ran is the package without its version: `npx genkit@latest` is `genkit`, and
   * `npx @angular/cli@19` is `@angular/cli`.
   */
  program: string
  /** The words after the program, with quotes removed. */
  args: string[]
  /** The shell call's whole command line, which may run other programs too. */
  line: string
  /** Whether the shell call succeeded; null when the harness never reported its result. */
  ok: boolean | null
  /** The turn's index in what `shellCommands` was given: always 0 for one turn. */
  turn: number
}

/** A segment's program and arguments, as `parseCommandLine` reads them. */
export type ParsedCommand = Pick<ShellCommand, 'program' | 'args'>

const SHELL_TOOLS = new Set(['bash', 'shell'])

type ToolEvent = Extract<TranscriptEvent, { type: 'tool' }>

export const isShellCall = (e: TranscriptEvent): e is ToolEvent =>
  e.type === 'tool' && SHELL_TOOLS.has(e.tool)

export const commandOf = (event: ToolEvent): string => {
  const command = isObjectLike(event.input) ? event.input.command : undefined
  return typeof command === 'string' ? command : ''
}

/** Operators that end a segment. `(` and `)` do too, so a subshell's or `$(…)`'s commands count. */
const SEPARATORS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')'])

/** A line break, as `shellText` hands it to shell-quote: `;;` ends a segment and survives in quotes. */
const LINE_BREAK = '\n;;'

const HEREDOC = /(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_][\w.-]*)\1/g

/** The line without its heredocs' bodies, which are text, not commands. */
function withoutHeredocs(line: string): string {
  const lines = line.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i] as string)
    for (const [, , end] of (lines[i] as string).matchAll(HEREDOC)) {
      do i++
      while (i < lines.length && (lines[i] as string).replace(/^\t+/, '') !== end)
    }
  }
  return kept.join('\n')
}

/**
 * The line as shell-quote should read it, where it reads a shell differently: a line break ends
 * a segment, a `\` continuation joins its lines, the `2` of `2>&1` is no word, and a `#` inside
 * a word (`http://host/#top`) starts no comment. Rewritten in quotes too; `words` undoes it there.
 */
const shellText = (line: string) =>
  withoutHeredocs(line)
    .replace(/\\\n/g, '')
    .replace(/(^|[\s;&|()])\d+(?=[<>])/g, '$1')
    .replace(/(?<=[^\s;&|()])#/g, '\\#')
    .replace(/\n/g, LINE_BREAK)

const word = (token: string) => token.replaceAll(LINE_BREAK, '\n').replaceAll('\\#', '#')

/**
 * The command line's words, a list per segment, as shell-quote reads them: variables stay as
 * written, a glob is its pattern, a redirection drops its target, and a comment runs to the end
 * of its line.
 */
function words(text: string): string[][] {
  const out: string[][] = [[]]
  let redirect = false
  for (const token of parse(text, (name) => `$${name}`)) {
    const current = out.at(-1) as string[]
    if (typeof token === 'string' || ('op' in token && token.op === 'glob')) {
      if (!redirect) current.push(word(typeof token === 'string' ? token : token.pattern))
      redirect = false
    } else if ('comment' in token) {
      const next = token.comment.indexOf(LINE_BREAK)
      if (next !== -1) out.push(...words(token.comment.slice(next + LINE_BREAK.length)))
      break
    } else if (SEPARATORS.has(token.op)) out.push([])
    else redirect = true
  }
  return out.filter((w) => w.length > 0)
}

const segments = (line: string) => words(shellText(line))

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const DURATION = /^\d+(\.\d+)?[smhd]?$/

const basename = (word: string) => word.slice(word.lastIndexOf('/') + 1)

/** The index after `words[i]`'s flags, skipping each value a flag in `takesValue` takes, and a `--`. */
function afterFlags(words: string[], i: number, takesValue: ReadonlySet<string> = new Set()) {
  while (i < words.length && (words[i] as string).startsWith('-') && words[i] !== '-') {
    if (words[i] === '--') return i + 1
    i += takesValue.has(words[i] as string) ? 2 : 1
  }
  return i
}

const set = (...flags: string[]) => new Set(flags)

const RUNNER_FLAGS = set('-p', '--package', '-c', '--call', '-w', '--workspace', '--registry')
const NPM_FLAGS = set('-w', '--workspace', '--prefix', '-C')
const PNPM_FLAGS = set('-F', '--filter', '-C', '--dir', '--workspace-dir', '--package')
const YARN_FLAGS = set('--cwd', '-p', '--package')

/**
 * Where a wrapper's command starts, or undefined when `words[i]` isn't a wrapper: the env
 * assignments, `env`, `timeout`, `time`, `exec`, `sudo`, `nohup`, `nice`, `command` (not
 * `command -v`), and the package runners `npx`, `bunx`, `npm exec` (`npm x`), `pnpm exec`,
 * `pnpm dlx` and `yarn dlx`, each with its flags.
 */
function unwrap(words: string[], i: number): { next: number; runner: boolean } | undefined {
  const name = basename(words[i] as string)
  const flags = (takesValue?: ReadonlySet<string>) => afterFlags(words, i + 1, takesValue)
  const subcommand = (global: ReadonlySet<string>, subs: readonly string[]) => {
    const at = afterFlags(words, i + 1, global)
    return subs.includes(words[at] as string) ? afterFlags(words, at + 1, global) : undefined
  }
  switch (name) {
    case 'env':
      return { next: flags(set('-u', '--unset', '-C', '--chdir')), runner: false }
    case 'timeout': {
      const at = flags(set('-s', '--signal', '-k', '--kill-after'))
      return { next: DURATION.test(words[at] ?? '') ? at + 1 : at, runner: false }
    }
    case 'time':
      return { next: flags(), runner: false }
    case 'exec':
      return { next: flags(set('-a')), runner: false }
    case 'nohup':
      return { next: flags(), runner: false }
    case 'nice':
      return { next: flags(set('-n', '--adjustment')), runner: false }
    case 'command':
      // `command -v genkit` looks the program up without running it.
      if (/^-[a-zA-Z]*[vV]/.test(words[i + 1] ?? '')) return undefined
      return { next: flags(), runner: false }
    case 'sudo':
      return {
        next: flags(set('-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '-D', '--chdir')),
        runner: false,
      }
    case 'npx':
    case 'bunx':
      return { next: flags(RUNNER_FLAGS), runner: true }
    case 'npm': {
      const next = subcommand(new Set([...NPM_FLAGS, ...RUNNER_FLAGS]), ['exec', 'x'])
      return next === undefined ? undefined : { next, runner: true }
    }
    case 'pnpm': {
      const next = subcommand(PNPM_FLAGS, ['exec', 'dlx'])
      return next === undefined ? undefined : { next, runner: true }
    }
    case 'yarn': {
      const next = subcommand(YARN_FLAGS, ['dlx'])
      return next === undefined ? undefined : { next, runner: true }
    }
  }
}

/** A package runner's target without its `@version`; any other program without its directory. */
function programName(word: string, runner: boolean): string {
  if (runner && word.startsWith('@')) {
    const at = word.indexOf('@', 1)
    return at === -1 ? word : word.slice(0, at)
  }
  const base = basename(word)
  const at = runner ? base.indexOf('@') : -1
  return at > 0 ? base.slice(0, at) : base
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])
const COMMAND_FLAG = /^-[a-z]*c[a-z]*$/

/** A shell's `-c` script, after the shell's other options (`bash -e -o pipefail -c '…'`). */
function scriptOf(args: string[]): string | undefined {
  let command = false
  let j = 0
  while (j < args.length && /^[-+]./.test(args[j] as string)) {
    if (args[j] === '--') {
      j++
      break
    }
    if (COMMAND_FLAG.test(args[j] as string)) command = true
    j += /^[-+][oO]$/.test(args[j] as string) ? 2 : 1
  }
  return command ? args[j] : undefined
}

/** Reserved words before a command, which run it: `then genkit`, `! genkit`, `{ genkit; }`. */
const KEYWORDS = set('!', '{', 'if', 'then', 'else', 'elif', 'while', 'until', 'do')
/** Segments that run nothing: a block's end, or a `for`, `case` or `select` header. */
const NOT_A_COMMAND = set('}', 'fi', 'done', 'esac', 'for', 'case', 'select', 'function')

function parseSegment(words: string[]): ParsedCommand[] {
  let i = 0
  let runner = false
  let wrapper = -1
  while (i < words.length && KEYWORDS.has(words[i] as string)) i++
  if (NOT_A_COMMAND.has(words[i] as string)) return []
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i] as string)) i++
    if (i >= words.length) break
    const unwrapped = unwrap(words, i)
    if (!unwrapped) break
    wrapper = i
    i = unwrapped.next
    runner = unwrapped.runner
  }
  if (i >= words.length) {
    // Only assignments, or a wrapper with nothing after it (`npx --version`): the wrapper ran.
    if (wrapper === -1) return []
    return [{ program: basename(words[wrapper] as string), args: words.slice(wrapper + 1) }]
  }
  const program = programName(words[i] as string, runner)
  const args = words.slice(i + 1)
  // `bash -lc '<script>'`, as Codex runs every command: the script's programs ran.
  const script = !runner && SHELLS.has(program) ? scriptOf(args) : undefined
  if (script !== undefined) return parseCommandLine(script)
  return [{ program, args }]
}

/** The programs a command line runs, one per segment, in order. */
export function parseCommandLine(line: string): ParsedCommand[] {
  return segments(line).flatMap(parseSegment)
}

/** The programs the transcript's shell calls ran, in order. */
export const transcriptCommands = (
  transcript: readonly TranscriptEvent[],
  turn = 0,
): ShellCommand[] =>
  transcript.filter(isShellCall).flatMap((e) => {
    const line = commandOf(e)
    return parseCommandLine(line).map((p) => ({ ...p, line, ok: e.ok, turn }))
  })

type ShellSubject =
  | Pick<Turn, 'transcript'>
  | readonly Pick<Turn, 'transcript'>[]
  | { turns: readonly Pick<Turn, 'transcript'>[] }

/**
 * The programs the agent ran from its shell calls (the tools named `bash` or `shell`), in order:
 * one per segment of each command line, after its env assignments, `env`, `timeout`, `time`,
 * `exec`, `sudo`, `nohup`, `nice`, `command`, `bash -c` and package runners (`npx`, `bunx`, `npm exec`, `pnpm exec`,
 * `pnpm dlx`, `yarn dlx`). Takes a turn from `c.send()`, a list of turns, or `c`.
 */
export function shellCommands(subject: ShellSubject | AttemptContext): ShellCommand[] {
  const given: unknown = subject
  const turns = Array.isArray(given)
    ? (given as Pick<Turn, 'transcript'>[])
    : isObjectLike(given) && Array.isArray(given.turns)
      ? (given.turns as Pick<Turn, 'transcript'>[])
      : isObjectLike(given) && Array.isArray(given.transcript)
        ? [given as Pick<Turn, 'transcript'>]
        : undefined
  if (!turns) throw new TypeError('shellCommands() expects a turn from c.send(), c.turns, or c')
  return turns.flatMap((t, i) => transcriptCommands(t.transcript, i))
}
