// NDJSON on a language SDK runner's stdin and stdout. Session messages use `t`; attempt
// traffic uses the attempt protocol shapes from src/contract/attempt.ts (no `t`).

import type {
  AttemptAbort,
  AttemptDone,
  AttemptReply,
  AttemptRequest,
  AttemptStart,
} from '../contract/attempt.ts'
import type { DeclarationTree } from '../declaration.ts'

export const RUNNER_PROTOCOL = 2

export type WireError = {
  name: string
  message: string
  stack?: string
  expected?: unknown
  actual?: unknown
}

export type SessionToRunner = { t: 'collect'; file: string }

export type SessionFromRunner =
  | {
      t: 'hello'
      protocol: number
      sdk: string
      version: string
      runtime: string
    }
  | { t: 'declared'; file: string; tree: DeclarationTree }
  | { t: 'load-error'; error: WireError }
  | {
      t: 'log'
      /** The `key` of the body that wrote it; none for output outside a body. */
      key?: string
      stream: 'stdout' | 'stderr'
      /** One line, without its line break. */
      text: string
    }

/**
 * One runner runs every body of its files, several at once, so each attempt message carries the
 * `key` reeval gave that run of the body in its `start`. It's unique per started body, unlike
 * `attempt.id`, which two evals on the same cell share.
 */
type Keyed = { key: string }

export type RunnerAttemptStart = AttemptStart & Keyed

export type RunnerAttemptReply = AttemptReply & Keyed

export type RunnerAttemptAbort = AttemptAbort & Keyed

export type ToRunner =
  | SessionToRunner
  | RunnerAttemptStart
  | RunnerAttemptAbort
  | RunnerAttemptReply

export type RunnerAttemptRequest = AttemptRequest & Keyed

export type RunnerAttemptDone = AttemptDone & Keyed

export type FromRunner = SessionFromRunner | RunnerAttemptRequest | RunnerAttemptDone

export const isSessionFrom = (message: FromRunner): message is SessionFromRunner => 't' in message

export const isRunnerAttemptRequest = (message: FromRunner): message is RunnerAttemptRequest =>
  'id' in message && 'call' in message && 'key' in message && !('ok' in message)

export const isRunnerAttemptDone = (message: FromRunner): message is RunnerAttemptDone =>
  'type' in message && message.type === 'done' && 'key' in message

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const isWireError = (value: unknown) =>
  isObject(value) && isString(value.name) && isString(value.message)

const SESSION: Record<string, (m: Fields) => boolean> = {
  hello: (m) =>
    typeof m.protocol === 'number' && isString(m.sdk) && isString(m.version) && isString(m.runtime),
  declared: (m) => isString(m.file) && isObject(m.tree),
  'load-error': (m) => isWireError(m.error),
  log: (m) =>
    (m.stream === 'stdout' || m.stream === 'stderr') &&
    isString(m.text) &&
    (m.key === undefined || isString(m.key)),
}

/**
 * Whether a runner's stdout line is a message: one of the shapes above, with its fields. Anything
 * else (a print the SDK didn't route that happens to be a JSON object) is output, not a message.
 */
export function isFromRunner(value: unknown): value is FromRunner {
  if (!isObject(value)) return false
  if ('t' in value) return isString(value.t) && SESSION[value.t]?.(value) === true
  if (!isString(value.key)) return false
  if (value.type === 'done') return value.error === undefined || isWireError(value.error)
  return (
    isString(value.id) &&
    isObject(value.call) &&
    isString(value.call.op) &&
    !('ok' in value) &&
    !('type' in value)
  )
}
