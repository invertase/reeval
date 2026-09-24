// `evalsuite/sandbox`: sandbox descriptors. The implementations load lazily in workers.
import type { DockerSandboxDescriptor, FakeSandboxDescriptor } from './types.ts'

/**
 * One local Docker container per attempt. By default it's the image `es image build` makes;
 * `image` uses another image that already has the harness baked in, and `from` bakes Node and the
 * harness onto a Debian or Ubuntu based toolchain image on first use (e.g. `python:3.12-slim`).
 */
export const docker = (
  options: Omit<DockerSandboxDescriptor, 'kind'> = {},
): DockerSandboxDescriptor => ({
  kind: 'docker',
  ...options,
})

/** A temp directory on the host with no isolation. For tests and the fake harness only. */
export const fakeSandbox = (options: Omit<FakeSandboxDescriptor, 'kind'> = {}) =>
  ({ kind: 'fake', ...options }) satisfies FakeSandboxDescriptor

export type { DockerSandboxDescriptor, FakeSandboxDescriptor, SandboxDescriptor } from './types.ts'
