import { SKILL_LOAD_TOOLS, toolTarget } from './history/tool-target.ts'
import type { AttemptContext, TranscriptEvent, Turn, WebEventType } from './types.ts'

export type Result = { pass: boolean; message: () => string }

/** A check the turn's harness can't answer either way, e.g. a web fetch it never reports. */
export class HarnessCapabilityError extends Error {
  override name = 'HarnessCapabilityError'
}

export type ToolInputMatch = string | RegExp | Record<string, unknown>

type ToolEvent = Extract<TranscriptEvent, { type: 'tool' }>

type Subject = Pick<Turn, 'transcript' | 'unreported'>

const isTurn = (value: unknown): value is Subject =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as Turn).transcript) &&
  Array.isArray((value as Turn).unreported)

const isContext = (value: unknown): value is Pick<AttemptContext, 'turns'> =>
  typeof value === 'object' && value !== null && Array.isArray((value as AttemptContext).turns)

/** A turn from `c.send()`, or `c` (every turn so far). */
export function transcriptSubject(actual: unknown, matcher: string): Subject {
  if (isTurn(actual)) return actual
  if (isContext(actual)) {
    return {
      transcript: actual.turns.flatMap((t) => t.transcript),
      unreported: [...new Set(actual.turns.flatMap((t) => t.unreported))],
    }
  }
  throw new TypeError(`${matcher}() expects a turn from c.send(), or c`)
}

const matches = (value: string, pattern: RegExp | string | undefined) =>
  pattern === undefined ||
  (typeof pattern === 'string' ? value.includes(pattern) : pattern.test(value))

const listed = (values: string[]) => (values.length ? JSON.stringify(values) : 'none')

const targetOf = (pattern: RegExp | string | undefined) =>
  pattern === undefined ? '' : ` matching ${pattern}`

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

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
  if (typeof input !== 'object' || input === null) return false
  const rec = input as Record<string, unknown>
  return Object.entries(expected).every(([key, value]) => {
    const actual = rec[key]
    if (value instanceof RegExp) return value.test(String(actual ?? ''))
    if (typeof value === 'string') {
      return actual === value || String(actual ?? '').includes(value)
    }
    return JSON.stringify(actual) === JSON.stringify(value)
  })
}

const SHELL_TOOLS = new Set(['bash', 'shell'])

const commandOf = (event: ToolEvent): string => {
  const command = record(event.input).command
  return typeof command === 'string' ? command : ''
}

const outputText = (output: unknown): string =>
  typeof output === 'string' ? output : JSON.stringify(output ?? '')

const mentionsPath = (event: ToolEvent, path: RegExp | string): boolean => {
  const target = toolTarget(event.input, event.tool)
  return matches(target, path) || matches(outputText(event.output), path)
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

function formatInput(input: ToolInputMatch): string {
  if (typeof input === 'string' || input instanceof RegExp) return String(input)
  return JSON.stringify(input)
}

export function ran(actual: unknown, command?: RegExp | string): Result {
  const { transcript } = transcriptSubject(actual, 'toHaveRun')
  const shells = toolsOf(transcript).filter((e) => SHELL_TOOLS.has(e.tool))
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

export function edited(actual: unknown, path?: RegExp | string): Result {
  const { transcript } = transcriptSubject(actual, 'toHaveEdited')
  const edits = editsOf(transcript)
  const calls = toolsOf(transcript)
  const fileHit = edits.some((e) => matches(e.path, path))
  const toolHit = path !== undefined && calls.some((e) => mentionsPath(e, path))
  const pass = fileHit || toolHit
  const seen = [
    ...edits.map((e) => e.path),
    ...calls
      .filter((e) => path !== undefined && mentionsPath(e, path))
      .map((e) => `${e.tool} ${toolTarget(e.input, e.tool)}`),
  ]
  return {
    pass,
    message: () =>
      pass
        ? `expected no file edits${targetOf(path)}, got ${listed(seen)}`
        : `expected file edits${targetOf(path)}, got ${listed(seen)}`,
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
