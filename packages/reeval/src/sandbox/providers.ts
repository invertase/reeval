// The sandbox providers reeval has, each meeting the prepare contract (provider.ts). Docker builds
// images; the fake sandbox needs nothing.
import { type DockerState, dockerState, ImageBuildError, isTransient } from '@reeval/sandbox-docker'
import { UsageError } from '../errors.ts'
import type {
  AttemptImage,
  DockerSandboxDescriptor,
  FakeSandboxDescriptor,
  HarnessDescriptor,
} from '../types.ts'
import type { Refresh } from './prepare.ts'
import {
  type PreparedHandle,
  PrepareError,
  type PrepareFailure,
  type SandboxProvider,
} from './provider.ts'

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

/** Why Docker can't run a sandbox, as the fix a user needs; null when it can. */
export function dockerProblem(
  state: DockerState,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (state === 'running') return null
  if (state === 'windows-containers')
    return "Docker is running Windows containers, but reeval's sandboxes are Linux containers. Switch Docker Desktop to Linux containers (its tray menu: Switch to Linux containers) and try again."
  return platform === 'win32'
    ? 'Docker is not running. Start Docker Desktop (with the WSL 2 backend and Linux containers) and try again.'
    : 'Docker is not running. Start Docker and try again.'
}

/** Throws a usage error unless Docker can run a sandbox. */
export async function requireDocker(): Promise<void> {
  const problem = dockerProblem(await dockerState())
  if (problem) throw new UsageError(problem)
}

/** Docker: one image per key, each sub-image built once per provider (so once per run). */
export function dockerProvider(
  options: { refresh?: Refresh } = {},
): SandboxProvider<DockerSandboxDescriptor> {
  let builds: import('./prepare.ts').Builds | undefined
  return {
    kind: 'docker',
    async check() {
      const problem = dockerProblem(await dockerState())
      if (!problem) return
      throw new PrepareError({
        class: 'config',
        stage: 'docker',
        ref: null,
        cause: null,
        log: null,
        usage: true,
        message: problem,
      })
    },
    key: dockerKey,
    async prepare(sandbox, harness, ctx) {
      const { createBuilds, imageHarness, prepareImage } = await import('./prepare.ts')
      builds ??= createBuilds({
        retry: ctx.retry,
        log: ctx.log,
        refresh: options.refresh ?? 'none',
      })
      return await prepareImage(sandbox, imageHarness(harness), ctx.root, ctx.signal, builds)
    },
    classify: classifyDocker,
  }
}

/**
 * The image a Docker sandbox's `prepare` returned. Handles are opaque to preflight and round-trip
 * through `prepared.json`, so only the Docker provider's own type says what this one holds.
 */
export const attemptImage = (handle: PreparedHandle): AttemptImage => handle as AttemptImage

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
export const createProviders = (
  options: { refresh?: Refresh } = {},
): Record<string, SandboxProvider> => ({ docker: dockerProvider(options), fake: fakeProvider() })
