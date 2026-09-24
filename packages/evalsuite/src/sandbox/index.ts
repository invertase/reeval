import type { SandboxDescriptor } from '../types.ts'
import { createFakeSandbox } from './fake.ts'
import { InfraError, type Sandbox } from './types.ts'

export type SandboxOptions = { runId: string; timeoutMs: number; signal: AbortSignal }

export async function createSandbox(
  descriptor: SandboxDescriptor,
  options: SandboxOptions,
): Promise<Sandbox> {
  try {
    switch (descriptor.kind) {
      case 'fake':
        return await createFakeSandbox(descriptor)
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
