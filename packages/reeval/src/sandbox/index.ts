import type { BrokeredSecret } from '../environment/resolve.ts'
import type { Brokering } from '../harness/agents.ts'
import type { PlannedEgress, SandboxDescriptor } from '../types.ts'
import { createFakeSandbox } from './fake.ts'
import { InfraError, type Sandbox } from './types.ts'

export type SandboxOptions = {
  runId: string
  timeoutMs: number
  signal: AbortSignal
  /** Variables for every process in the sandbox. */
  env: Record<string, string>
  /** The prepared image for Docker (see `prepareImage`). */
  image?: string
  /** The harness's credential, which the Docker egress gateway keeps out of the sandbox. */
  brokering?: Brokering
  /** Hosts the harness always tries: refused requests to them are traced, not logged each time. */
  expectedBlocked?: readonly string[]
  /** User secrets the Docker egress gateway brokers; none is swapped in until `setSubstitutions`. */
  substitutions?: readonly BrokeredSecret[]
  /** Checked against the sandbox's capabilities at plan time. */
  egress: PlannedEgress
  /** A gateway warning for the terminal (a refused brokered request), once per distinct text. */
  onWarning?: (text: string) => void
}

export async function createSandbox(
  descriptor: SandboxDescriptor,
  options: SandboxOptions,
): Promise<Sandbox> {
  try {
    switch (descriptor.kind) {
      case 'fake':
        return await createFakeSandbox(descriptor, options.env)
      case 'docker': {
        const { createDockerSandbox } = await import('./docker.ts')
        return await createDockerSandbox(descriptor, options)
      }
    }
  } catch (error) {
    if (error instanceof InfraError || options.signal.aborted) throw error
    const kind = descriptor.kind === 'docker' ? (descriptor.engine ?? 'docker') : descriptor.kind
    throw new InfraError(`Failed to create ${kind} sandbox: ${(error as Error).message}`)
  }
}

export { InfraError, type Sandbox }
