// The sandbox providers ES has, each meeting the prepare contract (provider.ts). Docker builds
// images; the fake sandbox needs nothing.
import { dockerAvailable, ImageBuildError, isTransient } from '@evalsuite/sandbox-docker'
import type { DockerSandboxDescriptor, FakeSandboxDescriptor, HarnessDescriptor } from '../types.ts'
import { PrepareError, type PrepareFailure, type SandboxProvider } from './provider.ts'

/** The key of a Docker sandbox's image: what's in it, not the limits or user it runs with. */
export const dockerKey = (sandbox: DockerSandboxDescriptor, harness: HarnessDescriptor) => {
  const kind = harness.kind === 'fake' ? (harness.layout ?? 'cursor') : harness.kind
  const { image, from, dockerfile, install } = sandbox
  return JSON.stringify({ harness: kind, image: { image, from, dockerfile, install } })
}

/** How Docker's build errors class: a named cause is a resource, a network error transient. */
export function classifyDocker(error: unknown): PrepareFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ImageBuildError) {
    const { stage, ref, transient, cause, log } = error.failure
    return {
      class: cause ? 'resource' : transient ? 'transient' : 'config',
      stage,
      ref,
      cause,
      log,
      message,
    }
  }
  return {
    class: isTransient(message) ? 'transient' : 'config',
    stage: 'image',
    ref: null,
    cause: null,
    log: null,
    message,
  }
}

/** Docker: one image per key, each sub-image built once per provider (so once per run). */
export function dockerProvider(
  options: { force?: boolean } = {},
): SandboxProvider<DockerSandboxDescriptor> {
  let builds: import('./prepare.ts').Builds | undefined
  return {
    kind: 'docker',
    async check() {
      if (await dockerAvailable()) return
      throw new PrepareError({
        class: 'config',
        stage: 'docker',
        ref: null,
        cause: null,
        log: null,
        usage: true,
        message: 'Docker is not running. Start Docker and try again.',
      })
    },
    key: dockerKey,
    async prepare(sandbox, harness, ctx) {
      const { createBuilds, imageHarness, prepareImage } = await import('./prepare.ts')
      builds ??= createBuilds({ retry: ctx.retry, log: ctx.log, force: !!options.force })
      return await prepareImage(sandbox, imageHarness(harness), ctx.root, ctx.signal, builds)
    },
    classify: classifyDocker,
  }
}

/** The fake sandbox is a temp directory on the host: nothing to check or prepare. */
export const fakeProvider = (): SandboxProvider<FakeSandboxDescriptor> => ({
  kind: 'fake',
  check: async () => {},
  key: () => 'fake',
  prepare: async () => null,
  classify: (error) => ({
    class: 'config',
    stage: 'fake',
    ref: null,
    cause: null,
    log: null,
    message: error instanceof Error ? error.message : String(error),
  }),
})

/** A fresh set of providers, one per run: each keeps the run's builds. */
export const createProviders = (options: { force?: boolean } = {}) =>
  ({ docker: dockerProvider(options), fake: fakeProvider() }) as unknown as Record<
    string,
    SandboxProvider
  >
