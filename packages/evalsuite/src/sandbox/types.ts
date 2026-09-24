import type { ExecResult } from '../types.ts'

export interface Sandbox {
  /** Absolute path of the agent's working directory inside the sandbox. */
  readonly workdir: string
  exec(command: string, opts?: { signal?: AbortSignal }): Promise<ExecResult>
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<void>
  /** Idempotent, never throws. */
  destroy(): Promise<void>
}

/** A failure of the sandbox or harness infrastructure, as opposed to the agent's work. */
export class InfraError extends Error {
  override name = 'InfraError'
}
