// Loopback NDJSON between reeval and a language SDK runner. Session messages use `t`; attempt
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
      token: string
      sdk: string
      version: string
      runtime: string
    }
  | { t: 'declared'; file: string; tree: DeclarationTree }
  | { t: 'load-error'; error: WireError }
  | { t: 'log'; stream: 'stdout' | 'stderr'; text: string }

export type RunnerAttemptReply = AttemptReply & { attempt: string }

export type ToRunner = SessionToRunner | AttemptStart | AttemptAbort | RunnerAttemptReply

/** Attempt traffic from a remote runner: `attempt` multiplexes concurrent bodies on one socket. */
export type RunnerAttemptRequest = AttemptRequest & { attempt: string }

export type RunnerAttemptDone = AttemptDone & { attempt: string }

export type FromRunner = SessionFromRunner | RunnerAttemptRequest | RunnerAttemptDone

export const isSessionFrom = (message: FromRunner): message is SessionFromRunner => 't' in message

export const isRunnerAttemptRequest = (message: FromRunner): message is RunnerAttemptRequest =>
  'id' in message && 'call' in message && 'attempt' in message && !('ok' in message)

export const isRunnerAttemptDone = (message: FromRunner): message is RunnerAttemptDone =>
  'type' in message && message.type === 'done' && 'attempt' in message
