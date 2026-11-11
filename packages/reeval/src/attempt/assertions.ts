// An attempt's assertion records, from the matcher calls it made, however they were made (the
// TypeScript `expect` or the attempt protocol's `expect` call): the one place a record's label,
// its ` #n` and its message are decided, so the same calls make the same history keys.
import { limitsLabel, runMatchLabel } from '../assert.ts'
import type { RawAssertion } from '../engine/runtime.ts'
import { redactSecrets } from '../redact.ts'
import type { AssertionRecord } from '../types.ts'

const MESSAGE_LIMIT = 1024
const LABEL_LIMIT = 60

/** Masked first, so a secret the limit would cut through is masked whole. */
const clipped = (text: string, limit: number) => {
  const s = redactSecrets(text)
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error))

const shown = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value instanceof RegExp) return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const shownSubject = (subject: unknown) =>
  typeof subject === 'string' && subject ? subject.replace(/\s+/g, ' ').trim() : undefined

/**
 * The records of an attempt's matcher calls, in call order. Without a label, one is
 * `<matcher> <first argument>` (or what the subject names); repeats get ` #2`, ` #3`, skipping
 * any label already recorded, so each record's label is unique (a given `build #2` after two
 * `build`s is `build #2 #2`).
 */
export function assertionRecords(raw: readonly RawAssertion[]): AssertionRecord[] {
  const seen = new Map<string, number>()
  const used = new Set<string>()
  return raw.map((r) => {
    const named =
      r.matcher === 'toStayWithin'
        ? limitsLabel(r.args[0])
        : r.matcher === 'toHaveRun' && runMatchLabel(r.args[0]) !== undefined
          ? runMatchLabel(r.args[0])
          : r.args.length
            ? shown(r.args[0])
            : shownSubject(r.subject)
    const base =
      r.label ?? clipped(named === undefined ? r.matcher : `${r.matcher} ${named}`, LABEL_LIMIT)
    let n = seen.get(base) ?? 0
    let label: string
    do {
      n += 1
      label = n > 1 ? `${base} #${n}` : base
    } while (used.has(label))
    seen.set(base, n)
    used.add(label)
    const reason =
      r.matcher === 'skip' && typeof r.args[0] === 'string'
        ? clipped(r.args[0], MESSAGE_LIMIT)
        : undefined
    return {
      label,
      labelled: r.label !== undefined || r.matcher === 'skip',
      matcher: r.matcher,
      status: r.status,
      soft: r.soft,
      ...(r.at ? { at: r.at } : {}),
      ...(r.status === 'pass' || r.status === 'not_applicable'
        ? {}
        : { message: clipped(text(r.error), MESSAGE_LIMIT) }),
      ...(reason !== undefined ? { reason } : {}),
      ...(r.durationMs === undefined ? {} : { durationMs: r.durationMs }),
    }
  })
}

export const CAUGHT_HINT =
  '(the eval caught this failed check, which still fails the attempt; to wait or retry, use expect.poll)'

/**
 * What fails the attempt at its end for the checks that failed without ending the body: the first
 * that didn't pass, an `expect` as what it failed with, an `expect.require` the eval caught with
 * `CAUGHT_HINT` after its message.
 */
export function checkFailure(raw: readonly RawAssertion[]): Error | undefined {
  const failed = raw.find((r) => r.status !== 'pass' && r.status !== 'not_applicable')
  if (!failed) return undefined
  const error = failed.error instanceof Error ? failed.error : new Error(text(failed.error))
  if (failed.soft) return error
  const message = `${error.message} ${CAUGHT_HINT}`
  const stack = error.stack?.replace(error.message, () => message)
  // A DOMException's getters read slots a copy doesn't have, so it rides along as the cause.
  if (error instanceof DOMException) {
    return Object.defineProperties(new Error(message, { cause: error }), {
      name: own(error.name),
      stack: own(stack),
    })
  }
  // Data properties of their own: chai's AssertionError has `name` as a getter alone, and a
  // subclass may have `message` so, where assigning either would throw.
  return Object.setPrototypeOf(
    Object.defineProperties(new Error(), {
      ...Object.getOwnPropertyDescriptors(error),
      name: own(error.name),
      message: own(message),
      stack: own(stack),
    }),
    Object.getPrototypeOf(error),
  )
}

const own = (value: unknown): PropertyDescriptor => ({
  value,
  writable: true,
  configurable: true,
  enumerable: false,
})
