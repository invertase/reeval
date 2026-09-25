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
  writeFile(path: string, content: string): Promise<void>
  /** Idempotent, never throws. */
  destroy(): Promise<void>
}

/** A failure of the sandbox or harness infrastructure, as opposed to the agent's work. */
export class InfraError extends Error {
  override name = 'InfraError'
}
