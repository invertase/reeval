import { OBSERVE_NAME } from '../contract/attempt.ts'
import { UsageError } from '../errors.ts'
import { REDACTED, redactSecrets, redactValue } from '../redact.ts'
import type { AttemptContext, JSONValue } from '../types.ts'
import type { Attempt } from './state.ts'

/** The most JSON one value may serialize to, masked. */
export const MAX_OBSERVED_BYTES = 4096
/** The most names one attempt may observe. */
export const MAX_OBSERVATIONS = 50
/** The deepest a value may nest arrays and objects, so a check of it can't run out of stack. */
const MAX_DEPTH = 64

const at = (path: string) => (path ? ` at ${path}` : '')

/** Why `value` isn't JSON, naming where, or undefined. */
function notJson(value: unknown, path: string, seen: Set<object>, depth = 0): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : `${value}${at(path)} isn't a finite number`
  }
  if (typeof value !== 'object') return `a ${typeof value}${at(path)} isn't JSON`
  if (seen.has(value)) return `the value refers to itself${at(path)}`
  if (depth >= MAX_DEPTH) return `it nests deeper than ${MAX_DEPTH} levels${at(path)}`
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    return `a ${value.constructor?.name ?? 'class instance'}${at(path)} isn't plain JSON`
  }
  seen.add(value)
  const entries = Array.isArray(value)
    ? Array.from(value, (v, i) => [`${path}[${i}]`, v] as const)
    : Object.entries(value).map(([k, v]) => [path ? `${path}.${k}` : k, v] as const)
  for (const [p, v] of entries) {
    const problem = notJson(v, p, seen, depth + 1)
    if (problem) return problem
  }
  seen.delete(value)
  return undefined
}

/**
 * `value` with each number whose digits are a secret's masked too: `redactValue` leaves numbers
 * as they are, but an observed value goes to a judge's or question's model as it's recorded.
 */
function maskNumbers(value: JSONValue): JSONValue {
  if (typeof value === 'number') {
    return redactSecrets(String(value)) === String(value) ? value : REDACTED
  }
  if (Array.isArray(value)) return value.map(maskNumbers)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskNumbers(v)]))
  }
  return value
}

/**
 * An observation's name as it's recorded and shown: masked as its value is. A name that holds a
 * secret is a value too, and a judge's or question's list of names is matched against this.
 */
export const observedName = (name: string): string => redactSecrets(name)

/** Each attempt's names as its body gave them, by the name they're recorded as. */
const givenNames = new WeakMap<Attempt, Map<string, string>>()

/**
 * Whether this attempt observed `name` as given: its masked name alone may be another secret's.
 * An attempt that never called `c.observe` has observed nothing.
 */
export const observedHere = (a: Attempt, name: string): boolean =>
  givenNames.get(a)?.get(observedName(name)) === name

/**
 * `c.observe`: keeps the last value per name, masked, with the turn it came after. Two names that
 * mask to the same name are refused rather than renamed: a name is the key that tallies, compare
 * and `attempt_values` group by across attempts, and a numbered stand-in would depend on the
 * order of each attempt's calls, joining values that don't belong together.
 */
export function observer(a: Attempt): AttemptContext['observe'] {
  const raw = new Map<string, string>()
  givenNames.set(a, raw)
  return (given, value) => {
    if (typeof given !== 'string' || !OBSERVE_NAME.test(given)) {
      throw new UsageError(
        `c.observe() needs a name of 1 to 64 letters, digits, _ . : / or - (got ${JSON.stringify(typeof given === 'string' ? observedName(given) : given)})`,
      )
    }
    const name = observedName(given)
    const earlier = raw.get(name)
    if (earlier !== undefined && earlier !== given) {
      throw new UsageError(
        `c.observe("${name}") names a secret, and its masked name is another observation's: name the value without the secret`,
      )
    }
    if (a.ended) throw new UsageError(`c.observe("${name}") came after the eval's body returned`)
    if (a.signal.aborted) {
      throw new UsageError(`c.observe("${name}") came after the attempt timed out or was canceled`)
    }
    const problem = notJson(value, '', new Set())
    if (problem) throw new UsageError(`c.observe("${name}") takes JSON: ${problem}`)
    const masked = maskNumbers(redactValue(value as JSONValue))
    const bytes = Buffer.byteLength(JSON.stringify(masked))
    if (bytes > MAX_OBSERVED_BYTES) {
      throw new UsageError(
        `c.observe("${name}") takes at most ${MAX_OBSERVED_BYTES} bytes of JSON (got ${bytes}): observe a count or a summary instead`,
      )
    }
    a.record.observations ??= []
    const list = a.record.observations
    const same = list.find((o) => o.name === name)
    if (!same && list.length >= MAX_OBSERVATIONS) {
      throw new UsageError(
        `c.observe("${name}") is one name too many: an attempt observes at most ${MAX_OBSERVATIONS}`,
      )
    }
    raw.set(name, given)
    const observation = { name, value: masked, turn: a.turns.length }
    if (same) Object.assign(same, observation)
    else list.push(observation)
  }
}
