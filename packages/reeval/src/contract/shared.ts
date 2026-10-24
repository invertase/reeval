// What every SDK-facing schema shares: string and duration shapes, the type-level checks that
// hold a hand-written type to its schema, and the helpers that turn Zod's issues into reeval's
// one sentence per refusal.
import { z } from 'zod'
import { parseDuration } from '../duration.ts'
import type { Duration, JSONValue } from '../types.ts'

/** A string with something other than whitespace in it. */
export const nonEmpty = () => z.string().regex(/\S/, 'must not be empty')

// Described through the registry, not `.describe()`: a described copy would leave the recursion
// pointing at an unnamed schema in the JSON Schema.
export const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)
z.globalRegistry.add(jsonValueSchema, { description: 'Any JSON value.' })

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

export const got = (value: unknown): string =>
  typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value)

/** The part of `value` an issue's path points at. */
export function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let at = value
  for (const key of path) at = (at as Record<PropertyKey, unknown> | null | undefined)?.[key]
  return at
}

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

/** `'a', 'b' or 'c'`, or `one of …` for a list of values. */
export function oneOf(values: readonly unknown[]): string {
  const quoted = values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v)))
  if (quoted.length < 2) return quoted.join('')
  return `${quoted.length > 2 ? 'one of ' : ''}${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}`
}

/**
 * The sentence for an issue no hand-written one covers, naming the field as `call({ field })`
 * (or bare, without a `call`):
 * an unknown key, a value of the wrong type, or Zod's own words for anything else.
 */
export function genericProblem(call: string, issue: Issue, value: unknown): string {
  issue = closestBranch(issue)
  const path = fieldPath(issue.path)
  const at = call ? `${call}({ ${path} })` : path
  if (issue.code === 'unrecognized_keys') return `${at} has an unknown key "${issue.keys[0]}"`
  const v = valueAt(value, issue.path)
  if (issue.code === 'invalid_value') return `${at} is ${oneOf(issue.values)} (got ${got(v)})`
  const expected = issue.code === 'invalid_type' ? EXPECTED[issue.expected] : undefined
  if (expected && v === undefined) return `${at} is missing: it must be ${expected}`
  if (expected) return `${at} must be ${expected} (got ${got(v)})`
  const sentence = /^(must|needs) /.test(issue.message) ? ` ${issue.message}` : `: ${issue.message}`
  return `${at}${sentence} (got ${got(v)})`
}

/**
 * For a union that matched no form, the issue in the form that got furthest (its issue sits
 * deepest, then fewest issues), with the union's path in front: a capture missing its `file`
 * names `file`, not the whole union, and an unknown key in that form comes first. The union's own
 * issue when every form failed at its root.
 */
export function closestBranch(issue: Issue): Issue {
  if (issue.code !== 'invalid_union' || !('errors' in issue) || !issue.errors.length) return issue
  const depth = (branch: readonly Issue[]) => Math.max(...branch.map((i) => i.path.length))
  const [best] = [...issue.errors]
    .filter((branch) => branch.length > 0)
    .sort((a, b) => depth(b) - depth(a) || a.length - b.length)
  if (!best || depth(best) === 0) return issue
  const inner = best.find((i) => i.code === 'unrecognized_keys') ?? (best[0] as Issue)
  return closestBranch({ ...inner, path: [...issue.path, ...inner.path] } as Issue)
}

/**
 * reeval's sentence for what `schema` refuses in data a runner in another language sent, naming
 * the field by its path in `what` ("The declaration tree", "The attempt request"), or undefined.
 * An unknown key comes first, since it's usually a typo of a missing one; `keysAt` gives the keys
 * the object holding it takes, for "Did you mean".
 */
export function dataProblem(
  schema: z.ZodType,
  value: unknown,
  what: string,
  keysAt: (object: Record<string, unknown>) => readonly string[],
): string | undefined {
  const result = schema.safeParse(value)
  if (result.success) return undefined
  const { issues } = result.error
  const issue = closestBranch(
    issues.find((i) => i.code === 'unrecognized_keys') ?? (issues[0] as Issue),
  )
  const field = fieldPath(issue.path)
  const v = valueAt(value, issue.path)
  if (issue.code === 'invalid_union' && 'options' in issue) {
    return `${what}'s ${field} is ${oneOf(issue.options as unknown[])} (got ${got(v)})`
  }
  if (issue.code === 'invalid_union') {
    return `${field ? `${what}'s ${field}` : what} matches none of its forms (got ${got(v)})`
  }
  if (issue.code === 'unrecognized_keys') {
    const near = closest(issue.keys[0] as string, keysAt(v as Record<string, unknown>))
    const hint = near ? `. Did you mean "${near}"?` : ''
    return `${field ? `${what}'s ${field}` : what} has an unknown key "${issue.keys[0]}"${hint}`
  }
  return `${what}'s ${genericProblem('', issue, value)}`
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
