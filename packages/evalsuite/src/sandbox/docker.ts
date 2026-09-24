import type { DockerSandboxDescriptor } from '../types.ts'
import type { SandboxOptions } from './index.ts'
import { InfraError, type Sandbox } from './types.ts'

export async function createDockerSandbox(
  _descriptor: DockerSandboxDescriptor,
  _options: SandboxOptions,
): Promise<Sandbox> {
  throw new InfraError('The Docker sandbox is not implemented yet')
}
