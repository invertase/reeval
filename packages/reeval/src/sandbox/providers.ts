// The sandbox providers reeval has, each meeting the prepare contract (provider.ts). Docker and
// Podman build images; the fake sandbox needs nothing.
import {
  type DockerState,
  dockerState,
  type Engine,
  engineSpec,
  ImageBuildError,
  isTransient,
} from '@reeval/sandbox-docker'
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

/** Why Docker (or Podman) can't run a sandbox, as the fix a user needs; null when it can. */
export function dockerProblem(
  state: DockerState,
  platform: NodeJS.Platform = process.platform,
  engine: Engine = 'docker',
): string | null {
  if (state === 'running') return null
  if (engine === 'podman') return podmanProblem(platform)
  if (state === 'windows-containers')
    return "Docker is running Windows containers, but reeval's sandboxes are Linux containers. Switch Docker Desktop to Linux containers (its tray menu: Switch to Linux containers) and try again."
  return platform === 'win32'
    ? 'Docker is not running. Start Docker Desktop (with the WSL 2 backend and Linux containers) and try again.'
    : 'Docker is not running. Start Docker and try again.'
}

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Podman doesn't answer: not installed, or (macOS, Windows) its machine isn't running. */
function podmanProblem(platform: NodeJS.Platform): string {
  return platform === 'linux'
    ? "Podman isn't answering: `podman info` failed. Install Podman 4 or later (your distribution's podman package) and check `podman info` works as you, then try again."
    : "Podman isn't answering: `podman info` failed. Start its machine (podman machine init, then podman machine start) and try again."
}

/** Throws a usage error unless Docker (or Podman) can run a sandbox. */
export async function requireDocker(engine: Engine = 'docker'): Promise<void> {
  const problem = dockerProblem(await dockerState(engine), process.platform, engine)
  if (problem) throw new UsageError(problem)
}

/** What `podman info` says about the host's Podman, for {@link podmanInfoProblem}. */
type PodmanInfo = { version: string; rootless: boolean; controllers: string[] | null }

/**
 * Why Podman can't confine a sandbox as reeval needs, or null: too old for the bridge network
 * rootless, or a rootless cgroup without the controllers `--cpus`, `--memory` and `--pids-limit`
 * need (systemd before 252 delegates only memory and pids).
 */
export function podmanInfoProblem(info: PodmanInfo): { problem: string; fix: string } | null {
  const major = Number(/^(\d+)/.exec(info.version)?.[1])
  if (major < 4) {
    return {
      problem: `Podman ${info.version} is too old for reeval's sandboxes, which need Podman 4 or later (its rootless bridge network)`,
      fix: 'upgrade Podman',
    }
  }
  const missing = ['cpu', 'memory', 'pids'].filter((c) => !(info.controllers ?? []).includes(c))
  if (info.rootless && missing.length) {
    const names = missing.join(', ')
    return {
      problem: `rootless Podman can't limit a sandbox's ${names}: your user's cgroup doesn't have the ${names} controller${missing.length === 1 ? '' : 's'}`,
      fix: 'delegate them with a systemd drop-in for user@.service (Delegate=cpu cpuset io memory pids), then log in again',
    }
  }
  return null
}

/** {@link podmanInfoProblem} for this host's Podman; null when `podman info` doesn't answer. */
export async function podmanConfinementProblem(): Promise<{
  problem: string
  fix: string
} | null> {
  const { docker } = await import('@reeval/sandbox-docker')
  const r = await docker(
    [
      'info',
      '--format',
      '{{json .Version.Version}} {{json .Host.Security.Rootless}} {{json .Host.CgroupControllers}}',
    ],
    { engine: 'podman' },
  ).catch(() => null)
  if (r?.exitCode !== 0) return null
  const [version, rootless, controllers] = r.stdout
    .toString('utf8')
    .trim()
    .split(/\s+/)
    .map((v) => JSON.parse(v)) as [string, boolean, string[] | null]
  return podmanInfoProblem({ version, rootless, controllers })
}

/** Docker or Podman: one image per key, each sub-image built once per provider (so once per run). */
export function dockerProvider(
  options: { refresh?: Refresh; engine?: Engine } = {},
): SandboxProvider<DockerSandboxDescriptor> {
  const engine = options.engine ?? 'docker'
  let builds: import('./prepare.ts').Builds | undefined
  return {
    kind: engine,
    async check() {
      const confinement = engine === 'podman' ? await podmanConfinementProblem() : null
      const problem =
        dockerProblem(await dockerState(engine), process.platform, engine) ??
        (confinement && `${upper(confinement.problem)}: ${confinement.fix}, and try again.`)
      if (!problem) return
      throw new PrepareError({
        class: 'config',
        stage: engineSpec(engine).bin,
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
        engine,
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
): Record<string, SandboxProvider> => ({
  docker: dockerProvider(options),
  podman: dockerProvider({ ...options, engine: 'podman' }),
  fake: fakeProvider(),
})
