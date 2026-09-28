// The contract a sandbox provider meets before any attempt starts: check it can work, then make
// each distinct environment the plan needs, and class every failure so ES's generic layer
// (preflight.ts) can order, retry, cache and scope them the same way for every provider.
import type { HarnessDescriptor, SandboxDescriptor } from '../types.ts'
import { InfraError } from './types.ts'

/**
 * How a failure is classed. `config`: the user's setup is wrong (a bad token, a failing build
 * step, a missing image) and fails the same way again. `transient`: the network, a 5xx or a
 * quota, which may pass, so ES retries it. `resource`: the provider ran out of memory or disk.
 */
export type FailureClass = 'config' | 'transient' | 'resource'

/** What failed, as the record, the terminal and `summary.md` report it. */
export type PrepareFailure = {
  class: FailureClass
  /** The provider's name for the step that failed, e.g. `install` or `dockerfile` for Docker. */
  stage: string
  /** What was being made, e.g. an image tag; null when there's nothing to name. */
  ref: string | null
  /** A resource failure's cause, named in the headline. */
  cause: 'enospc' | 'oom' | null
  /** The provider's full output for the step, when it wrote one. */
  log: string | null
  /** The headline first, then the step's last lines. */
  message: string
  /** Fixing it means changing the config or the environment (exit 2), not rerunning (exit 3). */
  usage?: boolean
  /** The levels that set the sandbox, once ES knows them. */
  setBy?: string[]
}

export class PrepareError extends InfraError {
  override name = 'PrepareError'
  readonly failure: PrepareFailure
  constructor(failure: PrepareFailure) {
    super(failure.message)
    this.failure = failure
  }
}

/** What an attempt starts from: a provider's own JSON, e.g. Docker's image ref and id. */
export type PreparedHandle = { [key: string]: unknown } | null

export type PrepareContext = {
  root: string
  signal: AbortSignal
  /** Progress lines, e.g. for `es image build`. */
  log: (line: string) => void
  /**
   * Runs one step that may hit the network, retried on a transient failure as ES's policy says.
   * A provider wraps each such step, so a retry repeats only that step.
   */
  retry: <T>(step: () => Promise<T>) => Promise<T>
}

export interface SandboxProvider<D extends SandboxDescriptor = SandboxDescriptor> {
  kind: D['kind']
  /**
   * Once per run, before anything is prepared: credentials and connectivity. Throws a
   * {@link PrepareError}, which stops the run.
   */
  check(): Promise<void>
  /** Attempts whose sandbox and harness give the same key share one prepared environment. */
  key(sandbox: D, harness: HarnessDescriptor): string
  /** Builds, pulls or provisions the environment, and returns what attempts start from. */
  prepare(sandbox: D, harness: HarnessDescriptor, ctx: PrepareContext): Promise<PreparedHandle>
  /** Classes an error `prepare` or `check` threw that isn't already a {@link PrepareError}. */
  classify(error: unknown): PrepareFailure
}
