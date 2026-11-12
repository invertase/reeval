import type { BrokeredSecret } from '../environment/resolve.ts'
import type { Brokering } from '../harness/agents.ts'
import type { SecretWarning } from '../history/types.ts'
import type { HarnessDescriptor, PlannedEgress, SandboxBase, SandboxDescriptor } from '../types.ts'
import { sandboxKind } from './kinds.ts'
import type { PreparedHost } from './tart-hosts.ts'
import { InfraError, RunStopped, type Sandbox } from './types.ts'

export type SandboxOptions = {
  runId: string
  timeoutMs: number
  signal: AbortSignal
  /** Variables for every process in the sandbox. */
  env: Record<string, string>
  /** The image preflight prepared: Docker's, or the Tart image with the harness baked in. */
  image?: string
  /** The hosts of `tart({ hosts })` preflight kept, each with the image it prepared there. */
  hosts?: readonly PreparedHost[]
  /** The saved image preflight prepared for a VM sandbox, which each attempt runs in a container of. */
  base?: SandboxBase
  /** The attempt's harness, whose CLI `boat()` installs before the session's start is timed. */
  harness?: HarnessDescriptor
  /** The harness's credential, which the Docker egress gateway keeps out of the sandbox. */
  brokering?: Brokering
  /** The harness's CLI trusts only the keychain's CAs on macOS (its catalog's `keychainTrust`). */
  keychainTrust?: boolean
  /** Hosts the harness always tries: refused requests to them are traced, not logged each time. */
  expectedBlocked?: readonly string[]
  /** User secrets the Docker egress gateway brokers; none is swapped in until `setSubstitutions`. */
  substitutions?: readonly BrokeredSecret[]
  /** Checked against the sandbox's capabilities at plan time. */
  egress: PlannedEgress
  /**
   * A gateway warning for the terminal (a refused brokered request), once per distinct text, and
   * a few per attempt at most.
   */
  onWarning?: (text: string) => void
  /** Each new entry of the sandbox's `secretWarnings`, as the gateway finds it. */
  onSecretWarning?: (warning: SecretWarning) => void
}

export async function createSandbox(
  descriptor: SandboxDescriptor,
  options: SandboxOptions,
): Promise<Sandbox> {
  const kind = sandboxKind(descriptor)
  try {
    return await kind.create(descriptor, options)
  } catch (error) {
    if (error instanceof InfraError || error instanceof RunStopped || options.signal.aborted) {
      throw error
    }
    throw new InfraError(
      `Failed to create ${kind.provider(descriptor)} sandbox: ${(error as Error).message}`,
    )
  }
}

export { InfraError, RunStopped, type Sandbox }
