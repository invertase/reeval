// The attempt protocol's `expect` call for reeval's matchers: resolves the call's subject on the
// attempt, turns its wire arguments back into the values `expect` takes, and runs the matcher's
// row in MATCHERS, the code the TypeScript `expect` runs too. Its record comes from
// assertions.ts, as the TypeScript `expect`'s do.
import type { AttemptCall } from '../contract/attempt.ts'
import { isUnanswerable, type RawAssertion } from '../engine/runtime.ts'
import { UsageError } from '../errors.ts'
import { isMatcherName, MATCHERS, type MatcherName, runMatcher } from '../matchers.ts'
import type { AssertionRecord, AttemptContext } from '../types.ts'
import { assertionRecords } from './assertions.ts'

export type ExpectCall = Extract<AttemptCall, { op: 'expect' }>
export type RecordCall = Extract<AttemptCall, { op: 'record' }>

type Outcome = Pick<RawAssertion, 'status' | 'error'> & { async: boolean }

/** Strings a runner's pattern was tested on without an answer, by its `matchedBy`. */
type Untested = Map<string, Set<string>>

/** An `expect` call the runner must make again, with these strings answered. */
export type UntestedReply = { untested: Record<string, string[]> }

const isPattern = (value: object): value is { regexp: string; flags?: string } =>
  'regexp' in value &&
  typeof value.regexp === 'string' &&
  Object.keys(value).every((k) => k === 'regexp' || k === 'flags')

const isAnswered = (
  value: object,
): value is { matchedBy: string; answers: Record<string, boolean> } =>
  Object.keys(value).length === 2 &&
  'matchedBy' in value &&
  typeof value.matchedBy === 'string' &&
  'answers' in value &&
  typeof value.answers === 'object' &&
  value.answers !== null &&
  !Array.isArray(value.answers)

/**
 * A pattern the runner matches in its own language, as the `RegExp` a matcher takes: it answers
 * each string from the call's `answers`, and notes the strings it has none for, which it fails.
 */
class AnsweredPattern extends RegExp {
  static override get [Symbol.species]() {
    return RegExp
  }

  readonly matchedBy: string
  private readonly answers: Record<string, boolean>
  private readonly untested: Untested

  constructor(matchedBy: string, answers: Record<string, boolean>, untested: Untested) {
    super('(?:)')
    this.matchedBy = matchedBy
    this.answers = answers
    this.untested = untested
  }

  override test(value: string): boolean {
    const text = String(value)
    if (Object.hasOwn(this.answers, text)) return this.answers[text] === true
    const strings = this.untested.get(this.matchedBy) ?? new Set()
    this.untested.set(this.matchedBy, strings.add(text))
    return false
  }

  override exec(value: string): RegExpExecArray | null {
    const text = String(value)
    return this.test(text)
      ? (Object.assign([text], { index: 0, input: text }) as RegExpExecArray)
      : null
  }

  override get source(): string {
    return this.matchedBy
  }

  override toString(): string {
    return this.matchedBy
  }
}

/**
 * A wire argument as `expect` takes it: every `{ regexp, flags? }` in it a `RegExp`, and every
 * `{ matchedBy, answers }` one that notes in `untested` the strings it can't answer.
 */
export function fromWire(value: unknown, untested: Untested = new Map()): unknown {
  if (Array.isArray(value)) return value.map((v) => fromWire(v, untested))
  if (typeof value !== 'object' || value === null) return value
  if (isAnswered(value)) return new AnsweredPattern(value.matchedBy, value.answers, untested)
  if (isPattern(value)) {
    try {
      return new RegExp(value.regexp, value.flags)
    } catch (error) {
      throw new UsageError(
        `${JSON.stringify(value)} isn't a regular expression: ${(error as Error).message}`,
      )
    }
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromWire(v, untested)]))
}

function subjectOf(c: AttemptContext, subject: ExpectCall['subject']): unknown {
  if ('turn' in subject) {
    const turn = c.turns[subject.turn]
    if (!turn) {
      throw new UsageError(
        `expect's subject is turn ${subject.turn}, but the attempt has ${c.turns.length} turn${c.turns.length === 1 ? '' : 's'}`,
      )
    }
    return turn
  }
  if ('attempt' in subject) return c
  if ('value' in subject) return subject.value
  if ('exec' in subject) return subject.result ?? c.exec(subject.exec)
  return c.readFile(subject.readFile)
}

/** What the subject names itself by, as `c.exec`'s and `c.judge`'s results do in TypeScript. */
function subjectName(subject: ExpectCall['subject']): string | undefined {
  if ('exec' in subject) return subject.exec
  if (!('value' in subject)) return undefined
  const value = subject.value as { verdict?: unknown; question?: unknown } | null
  return typeof value === 'object' && value !== null && 'verdict' in value
    ? (value.question as string | undefined)
    : undefined
}

async function once(
  c: AttemptContext,
  name: MatcherName,
  call: ExpectCall,
  untested: Untested,
): Promise<Outcome> {
  const args = call.args.map((arg) => fromWire(arg, untested))
  let async = false
  try {
    const actual = await subjectOf(c, call.subject)
    const running = runMatcher(name, actual, args, { not: call.not })
    async = running instanceof Promise
    const result = await running
    if (untested.size > 0) return { status: 'pass', async }
    if (result.pass !== call.not) return { status: 'pass', async }
    const message = result.message()
    const error = new Error(call.label ? `${call.label}: ${message}` : message)
    error.name = 'AssertionError'
    return { status: 'fail', error, async }
  } catch (error) {
    if (!isUnanswerable(error)) throw error
    return { status: 'error', error, async }
  }
}

const untestedReply = (untested: Untested): UntestedReply => ({
  untested: Object.fromEntries([...untested].map(([pattern, strings]) => [pattern, [...strings]])),
})

/**
 * Runs one `expect` call on the attempt, as the matcher call it records. A polled call re-reads
 * its subject and retries until the matcher passes or its timeout leaves no room for another
 * try, then answers the last try. A try that tested a runner's pattern on a string it has no
 * answer for ends the call with those strings, and records nothing.
 */
export async function match(
  c: AttemptContext,
  call: ExpectCall,
): Promise<RawAssertion | UntestedReply> {
  const name = call.matcher
  if (!isMatcherName(name)) {
    throw new UsageError(
      `${name} isn't one of reeval's matchers (${Object.keys(MATCHERS).join(', ')})`,
    )
  }
  const startedAt = performance.now()
  const untested: Untested = new Map()
  let outcome = await once(c, name, call, untested)
  if (untested.size > 0) return untestedReply(untested)
  if (call.poll) {
    const { interval = 50, timeout = 1000 } = call.poll
    const deadline = Date.now() + timeout
    while (outcome.status !== 'pass' && Date.now() + interval < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval))
      outcome = await once(c, name, call, untested)
      if (untested.size > 0) return untestedReply(untested)
    }
  }
  const subject = subjectName(call.subject)
  return {
    matcher: [call.poll && 'poll', call.not && 'not', name].filter(Boolean).join('.'),
    args: call.args.map((arg) => fromWire(arg)),
    ...(subject === undefined ? {} : { subject }),
    ...(call.label ? { label: call.label } : {}),
    soft: call.soft,
    status: outcome.status,
    ...(outcome.status === 'pass' ? {} : { error: outcome.error }),
    ...(outcome.async || call.poll
      ? { durationMs: Math.round(performance.now() - startedAt) }
      : {}),
  }
}

/**
 * Runs the call, adds it to the attempt's matcher calls and replies with its record, or with the
 * strings a runner's pattern must answer first.
 */
export async function expectCall(
  c: AttemptContext,
  calls: RawAssertion[],
  call: ExpectCall,
): Promise<{ assertion: AssertionRecord } | UntestedReply> {
  // The slot is taken at call time, so concurrent calls are numbered (` #2`) in call order.
  const slot: RawAssertion = {
    matcher: [call.poll && 'poll', call.not && 'not', call.matcher].filter(Boolean).join('.'),
    args: call.args.map((arg) => fromWire(arg)),
    subject: subjectName(call.subject),
    ...(call.label ? { label: call.label } : {}),
    soft: call.soft,
    status: 'pass',
  }
  calls.push(slot)
  let result: RawAssertion | UntestedReply
  try {
    result = await match(c, call)
  } catch (error) {
    calls.splice(calls.indexOf(slot), 1)
    throw error
  }
  if ('untested' in result) {
    calls.splice(calls.indexOf(slot), 1)
    return result
  }
  Object.assign(slot, result)
  return { assertion: assertionRecords(calls)[calls.indexOf(slot)] as AssertionRecord }
}

/**
 * Adds a check the eval's own language made (`record`) to the attempt's matcher calls and replies
 * with its record, named and numbered as a matcher call is.
 */
export function recordCall(calls: RawAssertion[], call: RecordCall): AssertionRecord {
  const failure = new Error(call.message ?? `${call.label ?? call.subject ?? call.matcher} failed`)
  failure.name = 'AssertionError'
  calls.push({
    matcher: call.matcher,
    args: [],
    ...(call.subject === undefined ? {} : { subject: call.subject }),
    ...(call.label === undefined ? {} : { label: call.label }),
    soft: call.soft ?? false,
    status: call.status,
    ...(call.status === 'pass' ? {} : { error: failure }),
  })
  return assertionRecords(calls).at(-1) as AssertionRecord
}
