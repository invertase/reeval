// The runner protocol between reeval and a Dart runner (sdks/dart/lib/src/protocol.dart):
// NDJSON over a loopback TCP socket reeval opens, named with a one-time token in REEVAL_RUNNER and
// REEVAL_RUNNER_TOKEN. Not the runner's stdio, which eval code prints to, and not Node's IPC
// channel, which Dart can't open.
import type { DeclarationTree } from '../declaration.ts'
import type { EsConfig } from '../types.ts'

export const RUNNER_PROTOCOL = 1

export type WireError = {
  name: string
  message: string
  stack?: string
  expected?: unknown
  actual?: unknown
  /** The `t.*` call whose error this is. */
  call?: number
}

export type ToRunner =
  | { t: 'config'; context: { ci: boolean; command: string; profile?: string } }
  | { t: 'collect'; file: string }
  | { t: 'run'; attempt: string; body: string; info: unknown }
  | { t: 'reply'; id: number; result?: unknown; error?: { name: string; message: string } }
  | { t: 'abort'; attempt: string; reason: string }

export type FromRunner =
  | { t: 'hello'; protocol: number; token: string; sdk: string; version: string; runtime: string }
  | { t: 'config'; config: EsConfig }
  | { t: 'declared'; file: string; tree: DeclarationTree }
  | { t: 'load-error'; error: WireError }
  | { t: 'call'; id: number; attempt: string; method: string; params: Record<string, unknown> }
  | { t: 'log'; attempt: string; stream: 'stdout' | 'stderr'; text: string }
  | { t: 'done'; attempt: string; state: 'passed' | 'failed'; error?: WireError }
