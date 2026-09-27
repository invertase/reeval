import type { EgressTraffic, Substitution } from '@evalsuite/sandbox-docker'
import type { ExecResult } from '../types.ts'

export type ExecOptions = { signal?: AbortSignal; env?: Record<string, string>; cwd?: string }

export interface Sandbox {
  /** Absolute path of the agent's working directory inside the sandbox. */
  readonly workdir: string
  /** Absolute path of the home directory; `~/` paths in `writeFile` resolve here. */
  readonly home: string
  /** `cwd` is relative to the workspace; `env` adds variables for this command only. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  readFile(path: string): Promise<string | null>
  /** Strings are written as UTF-8; bytes as they are. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>
  /** With the Docker egress gateway: the brokered secrets it swaps in from now on. */
  setSubstitutions?(subs: readonly Substitution[]): Promise<void>
  /** When the sandbox records egress: the hosts contacted and refused so far. */
  traffic?(): EgressTraffic
  /**
   * When the harness's requests or their responses name the model: each model that served its
   * brokered requests so far, in first-seen order.
   */
  servedModels?(): string[]
  /** The same, one entry per brokered request that named its model, in order. */
  servedRequests?(): string[]
  /** Idempotent, never throws. */
  destroy(): Promise<void>
}

/** A failure of the sandbox or harness infrastructure, as opposed to the agent's work. */
export class InfraError extends Error {
  override name = 'InfraError'
}
