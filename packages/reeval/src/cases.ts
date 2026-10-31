// `cases` on an eval: each case's key, and the name its attempts plan under. A case plans as a
// member of a pooled family named `<eval> [<key>]`, so pooling, the paired lift and every reader
// read it as one eval with cases.
import { UsageError } from './errors.ts'
import { isObjectLike } from './object.ts'

/** The longest a case key may be. */
export const CASE_KEY_MAX = 80

/** Characters a case key can't hold: ids and paths split on them, and control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const BAD_KEY = /[#/›\u0000-\u001f\u007f]/

/** The name a case's eval plans under: `adds a health check [nextjs]`. */
export const caseEvalName = (name: string, key: string) => `${name} [${key}]`

/** The key a case gets without `caseKey`: a string, a finite number, or an object's `id` or `name`. */
function defaultKey(item: unknown): string | undefined {
  if (typeof item === 'string') return item
  if (typeof item === 'number' && Number.isFinite(item)) return String(item)
  if (isObjectLike(item) && !Array.isArray(item)) {
    if (typeof item.id === 'string') return item.id
    if (typeof item.name === 'string') return item.name
  }
  return undefined
}

/**
 * Each case's key, in list order: `caseKey(item)` when given, else its default. Trimmed, 1–80
 * characters, with no `#`, `/`, `›` or control characters, and unique within the eval.
 */
export function caseKeys(
  cases: readonly unknown[],
  caseKey: ((item: never) => string) | undefined,
  where: string,
): string[] {
  const seen = new Map<string, number>()
  return cases.map((item, i) => {
    const raw = caseKey ? (caseKey as (item: unknown) => unknown)(item) : defaultKey(item)
    if (raw === undefined) {
      throw new UsageError(
        `cases[${i}] in ${where} has no key: a case is its own key when it's a string or a number, or an object's id or name. Give it an id, or pass caseKey: (item) => item.slug.`,
      )
    }
    if (typeof raw !== 'string') {
      throw new UsageError(
        `caseKey in ${where} must return a string (got ${JSON.stringify(raw) ?? String(raw)} for cases[${i}])`,
      )
    }
    const key = raw.trim()
    if (!key || key.length > CASE_KEY_MAX || BAD_KEY.test(key)) {
      throw new UsageError(
        `cases[${i}] in ${where} has the key ${JSON.stringify(raw)}: a case key is 1–${CASE_KEY_MAX} characters, with no #, /, › or control characters.${caseKey ? '' : ' Pass caseKey to give it another.'}`,
      )
    }
    const earlier = seen.get(key)
    if (earlier !== undefined) {
      throw new UsageError(
        `cases[${earlier}] and cases[${i}] in ${where} have the same key "${key}". Each case needs its own key${caseKey ? '' : ': give them distinct ids or names, or pass caseKey'}.`,
      )
    }
    seen.set(key, i)
    return key
  })
}
