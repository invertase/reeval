// `evalsuite/sandbox`: sandbox descriptors. The implementations load lazily in workers.
import type { DockerSandboxDescriptor, FakeSandboxDescriptor } from './types.ts'

/** One local Docker container per eval, from the image built by `es image build`. */
export const docker = (options: { image?: string } = {}): DockerSandboxDescriptor => ({
  kind: 'docker',
  ...options,
})

/** A temp directory on the host with no isolation. For tests and the fake harness only. */
export const fakeSandbox = (options: Omit<FakeSandboxDescriptor, 'kind'> = {}) =>
  ({ kind: 'fake', ...options }) satisfies FakeSandboxDescriptor

export type { DockerSandboxDescriptor, FakeSandboxDescriptor, SandboxDescriptor } from './types.ts'
