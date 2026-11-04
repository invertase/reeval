import picomatch from 'picomatch'
import { closest } from './contract/shared.ts'
import { parseDuration } from './duration.ts'
import { SKILL_LOAD_TOOLS, toolTarget } from './history/tool-target.ts'
import { isObjectLike } from './object.ts'
import { commandOf, isShellCall, transcriptCommands } from './shell-commands.ts'
import { formatDuration } from './text.ts'
import type {
  AttemptContext,
  Duration,
  FileChange,
  TokenUsage,
  TranscriptEvent,
  Turn,
  WebEventType,
} from './types.ts'
import { totalTokens } from './usage.ts'

export type Result = { pass: boolean; message: () => string }

/**
 * A matcher handed a subject it can't read, such as `toHaveEdited(1)`: recorded as `error`, an
 * answer it couldn't give, so the eval's own `TypeError`s stay errors that end the attempt.
 */
export function subjectError(message: string): TypeError {
  return Object.assign(new TypeError(message), { [Symbol.for('reeval.subjectError')]: true })
}

/**
 * A matcher called wrong, such as `toStayWithin()` with no limit: not a check that ran, so it
 * isn't recorded as one, and the `TypeError` ends the attempt as the eval's own would.
 */
export function misuseError(message: string): TypeError {
  return Object.assign(new TypeError(message), { [Symbol.for('reeval.misuse')]: true })
}

export const isMisuse = (error: unknown): boolean =>
  error instanceof TypeError && Symbol.for('reeval.misuse') in error

/** A check the turn's harness can't answer either way, e.g. a web fetch it never reports. */
export class HarnessCapabilityError extends Error {
  override name = 'HarnessCapabilityError'
}

export type ToolInputMatch = string | RegExp | Record<string, unknown>

type ToolEvent = Extract<TranscriptEvent, { type: 'tool' }>

type Subject = Pick<Turn, 'transcript' | 'unreported'>

const isTurn = (value: unknown): value is Subject =>
  isObjectLike(value) && Array.isArray(value.transcript) && Array.isArray(value.unreported)

const isContext = (value: unknown): value is Pick<AttemptContext, 'turns'> =>
  isObjectLike(value) && Array.isArray(value.turns)

/** A turn from `c.send()`, or `c` (every turn so far). */
export function transcriptSubject(actual: unknown, matcher: string): Subject {
  if (isTurn(actual)) return actual
  if (isContext(actual)) {
    return {
      transcript: actual.turns.flatMap((t) => t.transcript),
      unreported: [...new Set(actual.turns.flatMap((t) => t.unreported))],
    }
  }
  throw subjectError(`${matcher}() expects a turn from c.send(), or c`)
}

const matches = (value: string, pattern: RegExp | string | undefined) =>
  pattern === undefined ||
  (typeof pattern === 'string' ? value.includes(pattern) : pattern.test(value))

const listed = (values: string[]) => (values.length ? JSON.stringify(values) : 'none')

const targetOf = (pattern: RegExp | string | undefined) =>
  pattern === undefined ? '' : ` matching ${pattern}`

const record = (value: unknown): Record<string, unknown> => (isObjectLike(value) ? value : {})

const toolsOf = (transcript: TranscriptEvent[]) =>
  transcript.flatMap((e) => (e.type === 'tool' ? [e] : []))

const editsOf = (transcript: TranscriptEvent[]) =>
  transcript.flatMap((e) => (e.type === 'file-edit' ? [e] : []))

const skillLoadName = (event: ToolEvent): string | undefined => {
  if (!SKILL_LOAD_TOOLS.has(event.tool)) return undefined
  const input = record(event.input)
  if (typeof input.id === 'string') return input.id
  if (typeof input.name === 'string') return input.name
}

const skillLike = (event: ToolEvent): string | undefined => {
  const loaded = skillLoadName(event)
  if (loaded) return `${event.tool}:${loaded}`
  const target = toolTarget(event.input, event.tool)
  if (target.includes('skills/')) return `${event.tool} ${target}`
}

const isSkillCall = (event: ToolEvent, name: string): boolean => {
  if (skillLoadName(event) === name) return true
  return toolTarget(event.input, event.tool).includes(`skills/${name}/`)
}

const nameMatches = (tool: string, name: string | RegExp) =>
  typeof name === 'string' ? tool === name : name.test(tool)

export function inputMatches(input: unknown, expected?: ToolInputMatch): boolean {
  if (expected === undefined) return true
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  if (typeof expected === 'string') return text.includes(expected)
  if (expected instanceof RegExp) return expected.test(text)
  if (!isObjectLike(input)) return false
  return Object.entries(expected).every(([key, value]) => {
    const actual = input[key]
    if (value instanceof RegExp) return value.test(String(actual ?? ''))
    if (typeof value === 'string') {
      return actual === value || String(actual ?? '').includes(value)
    }
    return JSON.stringify(actual) === JSON.stringify(value)
  })
}

function webEvent(
  matcher: string,
  actual: unknown,
  type: WebEventType,
  field: (e: TranscriptEvent) => string,
  pattern: RegExp | string | undefined,
): Result {
  const subject = transcriptSubject(actual, matcher)
  const what = type === 'web-search' ? 'web searches' : 'web fetches'
  if (subject.unreported.includes(type)) {
    throw new HarnessCapabilityError(
      `${matcher}() can't check this turn: its harness doesn't report ${what} ('${type}' is in turn.unreported), so the agent may have made them with no event. Check the reply or files instead, or use a harness that reports them.`,
    )
  }
  const seen = subject.transcript.filter((e) => e.type === type).map(field)
  const pass = seen.some((v) => matches(v, pattern))
  return {
    pass,
    message: () =>
      pass
        ? `expected no ${what}${targetOf(pattern)}, got ${listed(seen)}`
        : `expected ${what}${targetOf(pattern)}, got ${listed(seen)}`,
  }
}

export function calledSkill(actual: unknown, name: string): Result {
  const { transcript } = transcriptSubject(actual, 'toHaveCalledSkill')
  const calls = toolsOf(transcript)
  const seen = calls.flatMap((e) => {
    const label = skillLike(e)
    return label ? [label] : []
  })
  const pass = calls.some((e) => isSkillCall(e, name))
  return {
    pass,
    message: () =>
      pass
        ? `expected no skill-like calls matching ${name}, got ${listed(seen)}`
        : `expected skill-like calls matching ${name}, got ${listed(seen)}`,
  }
}

export function calledTool(actual: unknown, name: string | RegExp, input?: ToolInputMatch): Result {
  const { transcript } = transcriptSubject(actual, 'toHaveCalledTool')
  const calls = toolsOf(transcript)
  const inputPart = input === undefined ? '' : ` with input ${formatInput(input)}`
  const seen = calls.map((e) =>
    input === undefined ? e.tool : `${e.tool} ${JSON.stringify(e.input)}`,
  )
  const pass = calls.some((e) => nameMatches(e.tool, name) && inputMatches(e.input, input))
  return {
    pass,
    message: () =>
      pass
        ? `expected no tool calls matching ${name}${inputPart}, got ${listed(seen)}`
        : `expected tool calls matching ${name}${inputPart}, got ${listed(seen)}`,
  }
}

const MCP_NAME = /^mcp__(.+)__(.+)$/

const mcpLabel = (tool: string) => {
  const m = MCP_NAME.exec(tool)
  return m ? `${m[1]}/${m[2]}` : tool
}

/** `type: 'tool'` named `mcp__<server>__<tool>` after adapters and the normalizer. */
export function calledMcp(
  actual: unknown,
  server: string,
  tool: string,
  input?: ToolInputMatch,
): Result {
  const subject = transcriptSubject(actual, 'toHaveCalledMcp')
  const result = calledTool(subject, `mcp__${server}__${tool}`, input)
  const mcpCalls = toolsOf(subject.transcript).filter((e) => e.tool.startsWith('mcp__'))
  const inputPart = input === undefined ? '' : ` with input ${formatInput(input)}`
  const seen = mcpCalls.map((e) =>
    input === undefined ? mcpLabel(e.tool) : `${mcpLabel(e.tool)} ${JSON.stringify(e.input)}`,
  )
  return {
    pass: result.pass,
    message: () =>
      result.pass
        ? `expected no MCP calls matching ${server}/${tool}${inputPart}, got ${listed(seen)}`
        : `expected MCP calls matching ${server}/${tool}${inputPart}, got ${listed(seen)}`,
  }
}

function formatInput(input: ToolInputMatch): string {
  if (typeof input === 'string' || input instanceof RegExp) return String(input)
  return JSON.stringify(input)
}

/** `toHaveRun`'s object form: the program a segment of a shell command ran, after its wrappers. */
export type RunMatch = {
  /** The program's name without its directory, or a regular expression it matches. */
  program: string | RegExp
  /** Text the program's arguments, joined by spaces, contain, or a regular expression they match. */
  args?: string | RegExp
}

const RUN_MATCH_KEYS = ['program', 'args'] as const

const isPatternArg = (value: unknown): value is string | RegExp =>
  typeof value === 'string' || value instanceof RegExp

function checkRunMatch(match: Record<string, unknown>): RunMatch {
  const example = "e.g. toHaveRun({ program: 'genkit', args: /^flow:run\\b/ })"
  for (const key of Object.keys(match)) {
    if ((RUN_MATCH_KEYS as readonly string[]).includes(key)) continue
    const near = closest(key, RUN_MATCH_KEYS)
    throw misuseError(
      `toHaveRun() has no "${key}"; it takes program and args.${near ? ` Did you mean "${near}"?` : ''}`,
    )
  }
  if (!isPatternArg(match.program) || match.program === '') {
    throw misuseError(
      `toHaveRun()'s program is a program name or a regular expression, ${example} (got ${JSON.stringify(match.program)})`,
    )
  }
  if (match.args !== undefined && !isPatternArg(match.args)) {
    throw misuseError(
      `toHaveRun()'s args is text or a regular expression, ${example} (got ${JSON.stringify(match.args)})`,
    )
  }
  return match as RunMatch
}

/**
 * `toHaveRun({ program, args })`'s default label, `program genkit args /^flow:run\b/`: unlike
 * `toHaveRun('genkit')`'s, so switching an eval to the object form starts a new history key.
 */
export function runMatchLabel(match: unknown): string | undefined {
  if (!isObjectLike(match) || match instanceof RegExp || !isPatternArg(match.program)) {
    return undefined
  }
  const { program, args } = match
  const programPart = `program ${String(program)}`
  return isPatternArg(args) ? `${programPart} args ${String(args)}` : programPart
}

function ranProgram(transcript: TranscriptEvent[], match: RunMatch): Result {
  const commands = transcriptCommands(transcript)
  const shown = (c: { program: string; args: string[] }) => [c.program, ...c.args].join(' ')
  const hits = commands.filter(
    (c) =>
      (typeof match.program === 'string'
        ? c.program === match.program
        : match.program.test(c.program)) && matches(c.args.join(' '), match.args),
  )
  const argsPart = match.args === undefined ? '' : ` with args matching ${match.args}`
  const target = `${match.program}${argsPart}`
  return {
    pass: hits.length > 0,
    message: () =>
      hits.length > 0
        ? `expected no runs of ${target}, got ${listed(hits.map(shown))}`
        : `expected runs of ${target}, got ${listed(commands.map(shown))}`,
  }
}

export function ran(actual: unknown, command?: RegExp | string | RunMatch): Result {
  const { transcript } = transcriptSubject(actual, 'toHaveRun')
  if (isObjectLike(command) && !(command instanceof RegExp)) {
    return ranProgram(transcript, checkRunMatch(command))
  }
  const shells = transcript.filter(isShellCall)
  const seen = shells.map(commandOf)
  const pass = shells.some((e) => matches(commandOf(e), command))
  return {
    pass,
    message: () =>
      pass
        ? `expected no shell commands${targetOf(command)}, got ${listed(seen)}`
        : `expected shell commands${targetOf(command)}, got ${listed(seen)}`,
  }
}

/**
 * The workspace files that changed while the agent ran a turn, set on each turn `c.send` returns.
 * Not the turn's `diff`, which also has earlier turns' changes and the eval's own writes.
 */
export const TURN_EDITED: unique symbol = Symbol('reeval.turnEdited')

const editedIn = (turn: unknown): string[] => {
  if (!isObjectLike(turn)) return []
  const own = (turn as { [TURN_EDITED]?: unknown })[TURN_EDITED]
  if (Array.isArray(own)) return own
  return hasDiff(turn) ? turn.diff.files.map((f) => f.path) : []
}

/**
 * Edit tools' `file-edit` events and the files the turn changed in the workspace, so a file
 * written from the shell or by a script counts, and one only read doesn't.
 */
export function edited(actual: unknown, path?: RegExp | string): Result {
  const { transcript } = transcriptSubject(actual, 'toHaveEdited')
  const changed = isContext(actual) ? actual.turns.flatMap(editedIn) : editedIn(actual)
  const seen = [...new Set([...editsOf(transcript).map((e) => e.path), ...changed])]
  const pass = seen.some((p) => matches(p, path))
  return {
    pass,
    message: () =>
      pass
        ? `expected no file edits${targetOf(path)}, got ${listed(seen)}`
        : `expected file edits${targetOf(path)}, got ${listed(seen)}`,
  }
}

export type PathMatch = string | RegExp | ReadonlyArray<string | RegExp>

const hasDiff = (value: unknown): value is Pick<Turn, 'diff'> =>
  isObjectLike(value) && isObjectLike(value.diff) && Array.isArray(value.diff.files)

/** A turn's changed files, or `c`'s as of its latest turn: the diff is cumulative. */
function changedFiles(actual: unknown): FileChange[] {
  if (hasDiff(actual)) return actual.diff.files
  if (isContext(actual)) return actual.turns.at(-1)?.diff.files ?? []
  throw subjectError('toHaveChanged() expects a turn from c.send(), or c')
}

/** A glob also matches every file under the directory it names, so `test` is `test/**` too. */
const pathTest = (pattern: string | RegExp): ((path: string) => boolean) => {
  if (pattern instanceof RegExp) return (path) => pattern.test(path)
  const glob = pattern.replace(/^\.?\/+/, '').replace(/\/+$/, '')
  const self = picomatch(glob, { dot: true })
  const inside = picomatch(`${glob}/**`, { dot: true })
  return (path) => self(path) || inside(path)
}

/** Files in the workspace diff, so every write counts: a tool's, a shell command's or a subprocess's. */
export function changed(actual: unknown, paths?: PathMatch): Result {
  const files = changedFiles(actual)
  const patterns =
    paths === undefined
      ? []
      : typeof paths === 'string' || paths instanceof RegExp
        ? [paths]
        : [...paths]
  const tests = patterns.map(pathTest)
  const hits = files.filter((f) => tests.length === 0 || tests.some((t) => t(f.path)))
  const label = (list: FileChange[]) =>
    list.length
      ? `[${list.map((f) => `${JSON.stringify(f.path)} (${f.status})`).join(', ')}]`
      : 'none'
  const target = patterns.length ? ` to ${patterns.map(String).join(', ')}` : ''
  return {
    pass: hits.length > 0,
    message: () =>
      hits.length > 0
        ? `expected no changes${target}, got ${label(hits)}`
        : `expected changes${target}, got ${label(files)}`,
  }
}

export function searched(actual: unknown, query?: RegExp | string): Result {
  return webEvent(
    'toHaveSearched',
    actual,
    'web-search',
    (e) => ('query' in e ? e.query : ''),
    query,
  )
}

export function fetched(actual: unknown, url?: RegExp | string): Result {
  return webEvent('toHaveFetched', actual, 'web-fetch', (e) => ('url' in e ? e.url : ''), url)
}

/** `toStayWithin`'s limits: each one caps what the turn, or every turn of `c`, used. */
export type Limits = {
  /** Input (cache included) plus output tokens, subagents included. */
  tokens?: number
  /** Every tool call, or each listed tool's calls by name as `toHaveCalledTool` names them. */
  toolCalls?: number | Readonly<Record<string, number>>
  /** The agent's time, as `turn.durationMs` counts it; setup and checks don't count. */
  duration?: Duration
}

const LIMIT_KEYS = ['tokens', 'toolCalls', 'duration'] as const

type BudgetSubject = Pick<Turn, 'usage' | 'transcript' | 'durationMs'>

const isBudgetTurn = (value: unknown): value is BudgetSubject =>
  isObjectLike(value) && Array.isArray(value.transcript) && typeof value.durationMs === 'number'

const count = (n: number) => n.toLocaleString('en-US')

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/** The limits as `toStayWithin`'s default label shows them: `tokens 200,000, bash 10`. */
export function limitsLabel(limits: unknown): string | undefined {
  if (!isObjectLike(limits)) return undefined
  const parts: string[] = []
  if (isCount(limits.tokens)) parts.push(`tokens ${count(limits.tokens)}`)
  const calls = limits.toolCalls
  if (isCount(calls)) parts.push(`toolCalls ${count(calls)}`)
  else if (isObjectLike(calls)) {
    for (const [tool, n] of Object.entries(calls)) {
      parts.push(`${tool} ${isCount(n) ? count(n) : String(n)}`)
    }
  }
  if (limits.duration !== undefined) parts.push(`duration ${String(limits.duration)}`)
  return parts.length ? parts.join(', ') : undefined
}

function checkLimits(limits: unknown): Limits {
  const example = 'e.g. toStayWithin({ tokens: 200_000, toolCalls: { bash: 10 } })'
  if (!isObjectLike(limits)) {
    throw misuseError(`toStayWithin() takes limits, ${example} (got ${JSON.stringify(limits)})`)
  }
  for (const key of Object.keys(limits)) {
    if ((LIMIT_KEYS as readonly string[]).includes(key)) continue
    const near = closest(key, LIMIT_KEYS)
    throw misuseError(
      `toStayWithin() has no limit "${key}"; it takes tokens, toolCalls and duration.${near ? ` Did you mean "${near}"?` : ''}`,
    )
  }
  if (!LIMIT_KEYS.some((k) => limits[k] !== undefined)) {
    throw misuseError(`toStayWithin() needs at least one limit, ${example}`)
  }
  const bad = (what: string, value: unknown) =>
    misuseError(
      `toStayWithin()'s ${what} is a whole number of 0 or more (got ${typeof value === 'number' ? String(value) : JSON.stringify(value)})`,
    )
  if (limits.tokens !== undefined && !isCount(limits.tokens)) throw bad('tokens', limits.tokens)
  const calls = limits.toolCalls
  if (calls !== undefined && !isCount(calls)) {
    if (!isObjectLike(calls) || !Object.keys(calls).length) {
      throw misuseError(
        `toStayWithin()'s toolCalls is a count, or a count per tool such as { bash: 10 } (got ${typeof calls === 'number' ? String(calls) : JSON.stringify(calls)})`,
      )
    }
    for (const [tool, n] of Object.entries(calls)) {
      if (!isCount(n)) throw bad(`toolCalls.${tool}`, n)
    }
  }
  if (limits.duration !== undefined) {
    try {
      parseDuration(limits.duration as Duration)
    } catch (error) {
      throw misuseError(
        `toStayWithin()'s duration: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return limits as Limits
}

/**
 * `toStayWithin`: what the turn, or every turn of `c`, used, against each limit. A null `usage`
 * can't show it stayed within `tokens`, so that's a `HarnessCapabilityError`, not a failure.
 */
export function withinLimits(actual: unknown, limits: unknown, not: boolean): Result {
  if (not) {
    throw misuseError(
      "toStayWithin() can't be negated: a budget checks the agent stayed within it. Check the figure itself instead, e.g. expect(turn.usage.output).toBeGreaterThan(…).",
    )
  }
  const turns: readonly BudgetSubject[] = isBudgetTurn(actual)
    ? [actual]
    : isContext(actual)
      ? actual.turns
      : (() => {
          throw subjectError('toStayWithin() expects a turn from c.send(), or c')
        })()
  const checked = checkLimits(limits)
  const over: string[] = []
  if (checked.tokens !== undefined) {
    if (turns.some((t) => t.usage === null)) {
      throw new HarnessCapabilityError(
        "toStayWithin() can't check tokens: the harness reported no token usage for this turn (turn.usage is null). Drop tokens, or use a harness that reports usage.",
      )
    }
    const used = turns.reduce((sum, t) => sum + totalTokens(t.usage as TokenUsage), 0)
    if (used > checked.tokens) {
      over.push(`tokens ${count(used)} > ${count(checked.tokens)} (subagents included)`)
    }
  }
  const transcript = turns.flatMap((t) => t.transcript)
  const calls = checked.toolCalls
  if (typeof calls === 'number') {
    const used = transcript.filter((e) => 'toolCallId' in e).length
    if (used > calls) over.push(`toolCalls ${count(used)} > ${count(calls)}`)
  } else if (calls) {
    const tools = toolsOf(transcript)
    for (const [tool, limit] of Object.entries(calls)) {
      const used = tools.filter((e) => e.tool === tool).length
      if (used > limit) over.push(`${tool} ${count(used)} > ${count(limit)}`)
    }
  }
  if (checked.duration !== undefined) {
    const limit = parseDuration(checked.duration)
    const used = turns.reduce((sum, t) => sum + t.durationMs, 0)
    if (used > limit) over.push(`duration ${formatDuration(used)} > ${String(checked.duration)}`)
  }
  return {
    pass: over.length === 0,
    message: () =>
      over.length ? `went over its budget: ${over.join(' · ')}` : 'stayed within its budget',
  }
}
