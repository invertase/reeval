// The attempt protocol's `expect` call for reeval's matchers: resolves the call's subject on the
// attempt, turns its wire arguments back into the values `expect` takes, and runs the matcher's
// row in MATCHERS, the code the TypeScript `expect` runs too.
import type { AttemptCall } from '../contract/attempt.ts'
import { UsageError } from '../errors.ts'
import { isMatcherName, MATCHERS, type MatcherName, runMatcher } from '../matchers.ts'
import type { AssertionRecord, AttemptContext } from '../types.ts'

export type ExpectCall = Extract<AttemptCall, { op: 'expect' }>

/** A matcher call's outcome: its status, and why when it didn't pass. */
export type MatchOutcome = Pick<AssertionRecord, 'status' | 'message'>

/** Can't answer either way: the harness doesn't report it, or the subject isn't one it reads. */
const isUnanswerable = (error: unknown) =>
  error instanceof TypeError || (error as Error | null)?.name === 'HarnessCapabilityError'

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
  if ('exec' in subject) return c.exec(subject.exec)
  return c.readFile(subject.readFile)
}

async function once(c: AttemptContext, name: MatcherName, call: ExpectCall): Promise<MatchOutcome> {
  const args = call.args.map(fromWire)
  try {
    const actual = await subjectOf(c, call.subject)
    const result = await runMatcher(name, actual, args, { not: call.not })
    return result.pass !== call.not
      ? { status: 'pass' }
      : { status: 'fail', message: result.message() }
  } catch (error) {
    if (!isUnanswerable(error)) throw error
    return { status: 'error', message: (error as Error).message }
  }
}

/**
 * Runs one `expect` call on the attempt. A polled call re-reads its subject and retries until
 * the matcher passes or its timeout leaves no room for another try, then answers the last try.
 */
export async function match(c: AttemptContext, call: ExpectCall): Promise<MatchOutcome> {
  const name = call.matcher
  if (!isMatcherName(name)) {
    throw new UsageError(
      `${name} isn't one of reeval's matchers (${Object.keys(MATCHERS).join(', ')})`,
    )
  }
  if (!call.poll) return once(c, name, call)
  const { interval = 50, timeout = 1000 } = call.poll
  const deadline = Date.now() + timeout
  for (;;) {
    const outcome = await once(c, name, call)
    if (outcome.status === 'pass' || Date.now() + interval >= deadline) return outcome
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}
