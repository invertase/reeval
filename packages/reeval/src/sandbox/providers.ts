// The sandbox providers reeval has, each meeting the prepare contract (provider.ts). Docker and
// Podman build images, Tart finds them (and pulls them for `reeval image build`), Boat checks its
// account, and the fake sandbox needs nothing.
import {
  type DockerState,
  dockerState,
  type Engine,
  engineSpec,
  ImageBuildError,
  isTransient,
} from '@reeval/sandbox-docker'
import { pluginBuildId } from '../environment/plugins.ts'
import { UsageError } from '../errors.ts'
import type {
  AttemptImage,
  BoatSandboxDescriptor,
  DockerSandboxDescriptor,
  FakeSandboxDescriptor,
  HarnessDescriptor,
  PluginSource,
  TartSandboxDescriptor,
  VmImage,
} from '../types.ts'
import type { PreparedImage, Refresh } from './prepare.ts'
import {
  type PreparedHandle,
  PrepareError,
  type PrepareFailure,
  type SandboxProvider,
} from './provider.ts'
import { tartBake } from './tart-bake.ts'

/** The key of a Docker sandbox's image: what's in it, not the limits or user it runs with. */
export const dockerKey = (
  sandbox: DockerSandboxDescriptor,
  harness: HarnessDescriptor,
  plugins: readonly PluginSource[] = [],
) => {
  const kind = harness.kind === 'fake' ? (harness.layout ?? 'cursor') : harness.kind
  const { image, from, dockerfile, install } = sandbox
  return JSON.stringify({
    harness: kind,
    image: { image, from, dockerfile, install },
    ...(plugins.length ? { plugins: plugins.map(pluginBuildId) } : {}),
  })
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

/** How to install Docker on each platform, as a fix that starts lower-case. */
export const DOCKER_INSTALL: Partial<Record<NodeJS.Platform, string>> = {
  linux: 'install Docker Engine (https://docs.docker.com/engine/install/) or Docker Desktop',
  darwin:
    'install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/), or another Docker engine such as OrbStack or Colima',
  win32:
    'install Docker Desktop with the WSL 2 backend and Linux containers (https://docs.docker.com/desktop/setup/install/windows-install/)',
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
  if (state === 'missing')
    return `Docker isn't installed: there's no docker command on the PATH. ${upper(DOCKER_INSTALL[platform] ?? DOCKER_INSTALL.linux ?? '')}, and try again.`
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
    async prepare(sandbox, harness, ctx, plugins = []) {
      const { createBuilds, imageHarness, prepareImage } = await import('./prepare.ts')
      builds ??= createBuilds({
        retry: ctx.retry,
        log: ctx.log,
        refresh: options.refresh ?? 'none',
        engine,
      })
      return await prepareImage(
        sandbox,
        imageHarness(harness),
        ctx.root,
        ctx.signal,
        builds,
        plugins,
      )
    },
    classify: classifyDocker,
  }
}

/**
 * The image a Docker sandbox's `prepare` returned. Handles are opaque to preflight and round-trip
 * through `prepared.json`, so only the Docker provider's own type says what this one holds.
 */
export const preparedImage = (handle: PreparedHandle): PreparedImage => handle as PreparedImage

/** {@link preparedImage} as the record has it: the image, without the plugins built into it. */
export const attemptImage = (handle: PreparedHandle): AttemptImage => {
  const { plugins: _, ...image } = preparedImage(handle)
  return image
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

/**
 * Why this host can't run Tart VMs, or null: macOS on Apple Silicon only. reeval's own tests
 * set REEVAL_TEST_TART_ANY_HOST to run the fixtures on a stand-in `tart` anywhere.
 */
export function tartHostProblem(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === 'darwin' && arch === 'arm64') return null
  if (process.env.REEVAL_TEST_TART_ANY_HOST === '1') return null
  return `tart() runs macOS VMs with Tart, which needs a Mac with Apple Silicon, and this machine is ${platform}-${arch}. Run these evals on one, or in docker().`
}

/** How Tart's failures class: a full disk is a resource, a network error transient. */
export function classifyTart(error: unknown): PrepareFailure {
  const message = error instanceof Error ? error.message : String(error)
  const enospc = /no space left|not enough (free )?(disk )?space/i.test(message)
  return {
    class: enospc ? 'resource' : isTransient(message) ? 'transient' : 'config',
    stage: 'tart pull',
    ref: null,
    cause: enospc ? 'enospc' : null,
    log: null,
    message,
  }
}

/** {@link VmImage} from the handle the Tart provider's `prepare` returned. */
export const vmImage = (handle: PreparedHandle): VmImage | null => {
  const h = handle as { image?: unknown; digest?: unknown } | null
  if (typeof h?.image !== 'string') return null
  return { ref: h.image, digest: typeof h.digest === 'string' ? h.digest : null }
}

/** The image with the harness baked in that the Tart provider's `prepare` made, if it made one. */
export const bakedImage = (handle: PreparedHandle): string | null => {
  const baked = (handle as { baked?: unknown } | null)?.baked
  return typeof baked === 'string' ? baked : null
}

const tartRefusal = (message: string): PrepareError =>
  new PrepareError({
    class: 'config',
    stage: 'tart',
    ref: null,
    cause: null,
    log: null,
    usage: true,
    message,
  })

/**
 * Tart: a run starts only from images `tart list` has, and refuses the rest; with `pull`
 * (`reeval image build`), it pulls them, once the disk has room for all of them (counting what
 * Tart prunes from its cache). Then it bakes each harness the run needs into its own local image
 * of each, one at a time (each bake boots a VM, and macOS runs two at once), unless Tart has it.
 */
export const tartProvider = (
  options: { pull?: boolean } = {},
): SandboxProvider<TartSandboxDescriptor> => {
  const pulls = new Map<string, Promise<void>>()
  let bakes: Promise<unknown> = Promise.resolve()
  const oneAtATime = <T>(step: () => Promise<T>): Promise<T> => {
    const next = bakes.then(step, step)
    bakes = next.catch(() => {})
    return next
  }
  return {
    kind: 'tart',
    async check() {
      const { tartCli } = await import('./tart-cli.ts')
      const problem =
        tartHostProblem() ??
        (await tartCli(['--version']).then(
          (r) => (r.exitCode === 0 ? null : `tart --version failed: ${r.stderr.trim()}`),
          () =>
            "Tart isn't installed: there's no tart command on the PATH. Install it (brew install cirruslabs/cli/tart, see https://tart.run) and try again.",
        ))
      if (!problem) return
      throw new PrepareError({
        class: 'config',
        stage: 'tart',
        ref: null,
        cause: null,
        log: null,
        usage: true,
        message: problem,
      })
    },
    key: (sandbox, harness) =>
      JSON.stringify({ image: sandbox.image, bake: tartBake(harness)?.label ?? null }),
    async checkTargets(sandboxes, ctx) {
      const { tartNames } = await import('./tart-cli.ts')
      const images = await import('./tart-images.ts')
      const { parseTartRef, tartListed } = await import('./tart-ref.ts')
      const have = await tartNames(ctx.signal)
      const wanted = [...new Set(sandboxes.map((s) => s.image))].filter((i) => !tartListed(have, i))
      if (!wanted.length) return
      // A registry that doesn't answer soon leaves the size unsaid, not the refusal unmade.
      const lookup = AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)])
      const missing = await Promise.all(
        wanted.map(async (image) => ({ image, size: await images.tartImageSize(image, lookup) })),
      )
      const local = missing.filter((m) => !parseTartRef(m.image).oci)
      if (!options.pull || local.length) {
        throw tartRefusal(images.missingImagesMessage(options.pull ? local : missing))
      }
      for (const image of missing.filter((m) => !m.size)) {
        ctx.log(
          `${image.image}: its registry didn't give its size, so the disk check doesn't count it`,
        )
      }
      const present = [...new Set(sandboxes.map((s) => s.image))].filter((i) => tartListed(have, i))
      const space = await images.pullSpace(missing, present)
      if (!space) ctx.log(images.pullSpaceUnknown())
      if (space?.verdict === 'prunes') ctx.log(images.pullPruneWarning(space))
      // The machine's state, not the config: an infra failure (exit 3), as a full disk is to Docker.
      if (space?.verdict === 'short') {
        throw new PrepareError({
          class: 'resource',
          stage: 'tart',
          ref: null,
          cause: 'enospc',
          log: null,
          message: images.pullSpaceMessage(missing, space),
        })
      }
    },
    async prepare(sandbox, harness, ctx) {
      const { tartNames } = await import('./tart-cli.ts')
      const { tartDigest, tartPull } = await import('./tart-images.ts')
      const { tartListed } = await import('./tart-ref.ts')
      // Each harness on an image is a target of its own, and they share its one pull.
      const pull = async () => {
        if (!options.pull || tartListed(await tartNames(ctx.signal), sandbox.image)) return
        const { sandboxId } = await import('../options.ts')
        // Up to three pull at once: each line says whose it is.
        const id = sandboxId(sandbox)
        ctx.log(`tart pull ${sandbox.image}`)
        await ctx.retry(() =>
          tartPull(sandbox.image, {
            signal: ctx.signal,
            onLine: (line) => ctx.log(`${id}: ${line}`),
          }),
        )
      }
      const pulled = pulls.get(sandbox.image) ?? pull()
      pulls.set(sandbox.image, pulled)
      await pulled
      const digest = await tartDigest(sandbox.image)
      const bake = tartBake(harness)
      if (!bake) return { image: sandbox.image, digest }
      const { bakeTartImage } = await import('./tart-bake.ts')
      const baked = await oneAtATime(() =>
        ctx.retry(() => bakeTartImage(sandbox, bake, { digest, signal: ctx.signal, log: ctx.log })),
      )
      return {
        image: sandbox.image,
        digest,
        baked: baked.image,
        ...(baked.agentVersion && { agentVersion: baked.agentVersion }),
      }
    },
    classify: classifyTart,
  }
}

/**
 * Boat has nothing to build yet (each attempt's VM installs the harness as it starts): `prepare`
 * checks each account and machine size the run uses, once.
 */
export const boatProvider = (): SandboxProvider<BoatSandboxDescriptor> => ({
  kind: 'boat',
  check: async () => {},
  key: (sandbox) => JSON.stringify({ apiKey: sandbox.apiKey.from, type: sandbox.type ?? 'small' }),
  async prepare(sandbox, _harness, ctx) {
    const { checkBoat } = await import('./boat.ts')
    await checkBoat(sandbox, ctx.root)
    return null
  },
  classify: (error) => {
    const message = error instanceof Error ? error.message : String(error)
    return {
      class: isTransient(message) ? 'transient' : 'config',
      stage: 'boat',
      ref: null,
      cause: null,
      log: null,
      message,
    }
  },
})

/**
 * A fresh set of providers, one per run: each keeps the run's builds. `pull` lets Tart pull the
 * images it doesn't have, which only `reeval image build` does.
 */
export const createProviders = (
  options: { refresh?: Refresh; pull?: boolean } = {},
): Record<string, SandboxProvider> => ({
  docker: dockerProvider(options),
  podman: dockerProvider({ ...options, engine: 'podman' }),
  fake: fakeProvider(),
  tart: tartProvider({ pull: !!options.pull }),
  boat: boatProvider(),
})
