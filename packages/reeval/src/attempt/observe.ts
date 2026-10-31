import { OBSERVE_NAME } from '../contract/attempt.ts'
import { UsageError } from '../errors.ts'
import { redactValue } from '../redact.ts'
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

/** `c.observe`: keeps the last value per name, masked, with the turn it came after. */
export function observer(a: Attempt): AttemptContext['observe'] {
  return (name, value) => {
    if (typeof name !== 'string' || !OBSERVE_NAME.test(name)) {
      throw new UsageError(
        `c.observe() needs a name of 1 to 64 letters, digits, _ . : / or - (got ${JSON.stringify(name)})`,
      )
    }
    if (a.ended) throw new UsageError(`c.observe("${name}") came after the eval's body returned`)
    if (a.signal.aborted) {
      throw new UsageError(`c.observe("${name}") came after the attempt timed out or was canceled`)
    }
    const problem = notJson(value, '', new Set())
    if (problem) throw new UsageError(`c.observe("${name}") takes JSON: ${problem}`)
    const masked = redactValue(value as JSONValue)
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
    const observation = { name, value: masked, turn: a.turns.length }
    if (same) Object.assign(same, observation)
    else list.push(observation)
  }
}
