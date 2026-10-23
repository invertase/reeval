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

type Outcome = Pick<RawAssertion, 'status' | 'error'> & { async: boolean }

const isPattern = (value: object): value is { regexp: string; flags?: string } =>
  'regexp' in value &&
  typeof value.regexp === 'string' &&
  Object.keys(value).every((k) => k === 'regexp' || k === 'flags')

/** A wire argument as `expect` takes it: every `{ regexp, flags? }` in it a `RegExp`. */
export function fromWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromWire)
  if (typeof value !== 'object' || value === null) return value
  if (isPattern(value)) {
    try {
      return new RegExp(value.regexp, value.flags)
    } catch (error) {
      throw new UsageError(
        `${JSON.stringify(value)} isn't a regular expression: ${(error as Error).message}`,
      )
    }
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromWire(v)]))
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

async function once(c: AttemptContext, name: MatcherName, call: ExpectCall): Promise<Outcome> {
  const args = call.args.map(fromWire)
  let async = false
  try {
    const actual = await subjectOf(c, call.subject)
    const running = runMatcher(name, actual, args, { not: call.not })
    async = running instanceof Promise
    const result = await running
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

/**
 * Runs one `expect` call on the attempt, as the matcher call it records. A polled call re-reads
 * its subject and retries until the matcher passes or its timeout leaves no room for another
 * try, then answers the last try.
 */
export async function match(c: AttemptContext, call: ExpectCall): Promise<RawAssertion> {
  const name = call.matcher
  if (!isMatcherName(name)) {
    throw new UsageError(
      `${name} isn't one of reeval's matchers (${Object.keys(MATCHERS).join(', ')})`,
    )
  }
  const startedAt = performance.now()
  let outcome = await once(c, name, call)
  if (call.poll) {
    const { interval = 50, timeout = 1000 } = call.poll
    const deadline = Date.now() + timeout
    while (outcome.status !== 'pass' && Date.now() + interval < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval))
      outcome = await once(c, name, call)
    }
  }
  const subject = subjectName(call.subject)
  return {
    matcher: [call.poll && 'poll', call.not && 'not', name].filter(Boolean).join('.'),
    args: call.args.map(fromWire),
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

/** Runs the call, adds it to the attempt's matcher calls and replies with its record. */
export async function expectCall(
  c: AttemptContext,
  calls: RawAssertion[],
  call: ExpectCall,
): Promise<AssertionRecord> {
  calls.push(await match(c, call))
  return assertionRecords(calls).at(-1) as AssertionRecord
}
