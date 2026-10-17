// What every SDK-facing schema shares: string and duration shapes, the type-level checks that
// hold a hand-written type to its schema, and the helpers that turn Zod's issues into reeval's
// one sentence per refusal.
import { z } from 'zod'
import { parseDuration } from '../duration.ts'
import type { Duration } from '../types.ts'

/** A string with something other than whitespace in it. */
export const nonEmpty = () => z.string().regex(/\S/)

// More than zero, so at least one non-zero digit.
const DURATION = /^(?=.*[1-9])\d+(\.\d+)?(ms|s|m|h)$/

export const durationSchema = z
  .union([
    z.number().positive(),
    // The template literal gives `Duration`'s type; its own JSON Schema pattern allows `-5s`.
    z
      .templateLiteral([z.number(), z.enum(['ms', 's', 'm', 'h'])])
      .check(z.regex(DURATION))
      .meta({ pattern: DURATION.source }),
  ])
  .describe('More than zero: `90s`, `15m`, `1h`, or a number of milliseconds.')

/** `parseDuration`'s sentence for a value that isn't a duration, or undefined when it is one. */
export function durationProblem(value: unknown): string | undefined {
  try {
    parseDuration(value as Duration)
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

/** True when `A` and `B` accept the same values. */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** Fails to compile unless `T` is `true`. */
export type Assert<T extends true> = T

export type Issue = z.core.$ZodIssue

export const got = (value: unknown): string => JSON.stringify(value)

/** The part of `value` an issue's path points at. */
export function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let at = value
  for (const key of path) at = (at as Record<PropertyKey, unknown> | null | undefined)?.[key]
  return at
}

/** The first unknown key an issue reports, if it's an unknown-key issue. */
export const unknownKey = (issue: Issue): string | undefined =>
  issue.code === 'unrecognized_keys' ? issue.keys[0] : undefined

/**
 * The issue a refusal explains: an unknown key at the top first, then the issue whose path starts
 * at the earliest key in `order` (the order the hand-written checks ran in), then Zod's order.
 */
export function firstIssue(issues: readonly Issue[], order: readonly string[] = []): Issue {
  const rank = (issue: Issue) => {
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0) return -1
    const at = order.indexOf(String(issue.path[0]))
    return at === -1 ? order.length : at
  }
  return [...issues].sort((a, b) => rank(a) - rank(b))[0] as Issue
}

export type Explain = (issue: Issue, value: unknown) => string

/** An issue's path as it reads in code: `files["a.txt"]`, `tools[0].ok`. */
export function fieldPath(path: readonly PropertyKey[]): string {
  return path
    .map((key, i) =>
      typeof key === 'number'
        ? `[${key}]`
        : /^[A-Za-z_$][\w$]*$/.test(String(key))
          ? `${i ? '.' : ''}${String(key)}`
          : `[${JSON.stringify(String(key))}]`,
    )
    .join('')
}

const EXPECTED: Record<string, string> = {
  string: 'a string',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  object: 'an object',
  array: 'a list',
  record: 'an object',
}

/**
 * The sentence for an issue no hand-written one covers, naming the field as `call({ field })`:
 * an unknown key, a value of the wrong type, or Zod's own words for anything else.
 */
export function genericProblem(call: string, issue: Issue, value: unknown): string {
  const at = fieldPath(issue.path)
  if (issue.code === 'unrecognized_keys') {
    return `${call}({ ${at} }) has an unknown key "${issue.keys[0]}"`
  }
  const v = valueAt(value, issue.path)
  const expected = issue.code === 'invalid_type' ? EXPECTED[issue.expected] : undefined
  if (expected) return `${call}({ ${at} }) must be ${expected} (got ${got(v)})`
  return `${call}({ ${at} }): ${issue.message} (got ${got(v)})`
}

/**
 * reeval's sentence for what `schema` refuses in `value`, or undefined when it's accepted. Issues
 * under a key in `skip` are left to a later check that names where the value was set.
 */
export function refusal(
  schema: z.ZodType,
  value: unknown,
  explain: Explain,
  { order = [], skip = [] }: { order?: readonly string[]; skip?: readonly string[] } = {},
): string | undefined {
  const result = schema.safeParse(value)
  if (result.success) return undefined
  const issues = result.error.issues.filter((i) => !skip.includes(String(i.path[0])))
  return issues.length ? explain(firstIssue(issues, order), value) : undefined
}

/**
 * The closest of `keys` to an unknown `key`, for "Did you mean", when it's a likely typo: one or
 * two edits away, or the same letters in another case.
 */
export function closest(key: string, keys: readonly string[]): string | undefined {
  let best: { key: string; distance: number } | undefined
  for (const candidate of keys) {
    const distance =
      candidate.toLowerCase() === key.toLowerCase() ? 0 : editDistance(key, candidate)
    if (!best || distance < best.distance) best = { key: candidate, distance }
  }
  const allowed = Math.min(2, Math.max(1, Math.floor(key.length / 3)))
  return best && best.distance <= allowed ? best.key : undefined
}

/** Edits from `a` to `b`: insertions, deletions, substitutions and swaps of neighbours. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  const at = (i: number, j: number) => d[i]?.[j] as number
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1)
      }
      ;(d[i] as number[])[j] = best
    }
  }
  return at(a.length, b.length)
}
