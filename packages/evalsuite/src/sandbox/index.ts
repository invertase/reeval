import type { SandboxDescriptor } from '../types.ts'
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
  /** Keep the harness's credentials out of the sandbox, behind the Docker egress gateway. */
  brokerCredentials?: boolean
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
    throw new InfraError(`Failed to create ${descriptor.kind} sandbox: ${(error as Error).message}`)
  }
}

export { InfraError, type Sandbox }
