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
  type LocalEngine,
} from '@reeval/sandbox-docker'
import type { ParsedTartHost } from '../contract/tart.ts'
import { pluginBuildId } from '../environment/plugins.ts'
import { UsageError } from '../errors.ts'
import type {
  AttemptImage,
  BoatSandboxDescriptor,
  DaytonaSandboxDescriptor,
  DockerSandboxDescriptor,
  FakeSandboxDescriptor,
  HarnessDescriptor,
  HostedSandboxDescriptor,
  PluginSource,
  SandboxBase,
  TartSandboxDescriptor,
  VmImage,
} from '../types.ts'
import type { BoatImage, BoatImageTimings, BoatSnapshotClient } from './boat-images.ts'
import { harnessBake } from './harness-install.ts'
import type { MACHINE_PROVIDERS } from './machines.ts'
import type { PreparedImage, Refresh } from './prepare.ts'
import {
  type PrepareContext,
  type PreparedHandle,
  PrepareError,
  type PrepareFailure,
  type SandboxProvider,
} from './provider.ts'
import { type ImageRecipe, type ResolveDigest, recipeOf } from './recipe.ts'
import { tartBakeKey } from './tart-bake.ts'
import { LOCAL_TART, type TartTarget } from './tart-cli.ts'
import type { HostProbe, PreparedHost } from './tart-hosts.ts'

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

/** Whether this host's Podman runs rootless; false when `podman info` doesn't answer. */
export async function podmanRootless(): Promise<boolean> {
  const { docker } = await import('@reeval/sandbox-docker')
  const r = await docker(['info', '--format', '{{json .Host.Security.Rootless}}'], {
    engine: 'podman',
  }).catch(() => null)
  return r?.exitCode === 0 && r.stdout.toString('utf8').trim() === 'true'
}

/** What a run's image builds may do beyond building: pull from a registry, and push to it. */
export type RegistryOptions = { registry?: string | null; push?: boolean }

/** Docker or Podman: one image per key, each sub-image built once per provider (so once per run). */
export function dockerProvider(
  options: { refresh?: Refresh; engine?: LocalEngine } & RegistryOptions = {},
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
        registry: options.registry ?? null,
        push: !!options.push,
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

/** The saved snapshot and image the Boat provider's `prepare` found or built, if there's one. */
export const sandboxBase = (handle: PreparedHandle): SandboxBase | null => {
  const h = handle as Partial<BoatImage> | null
  if (
    typeof h?.snapshot !== 'string' ||
    typeof h.imageRef !== 'string' ||
    typeof h.key !== 'string'
  )
    return null
  return {
    provider: 'boat',
    snapshot: h.snapshot,
    image: h.imageRef,
    key: h.key,
    pinned: h.pinned !== false,
    built: h.built === true,
  }
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

/** The hosts a Tart provider's `prepare` started each attempt's VM on, when it ran on others. */
export const preparedHosts = (handle: PreparedHandle): PreparedHost[] | null => {
  const hosts = (handle as { hosts?: unknown } | null)?.hosts
  return Array.isArray(hosts) ? (hosts as PreparedHost[]) : null
}

/** Why Tart can't run on this machine, or null: it's a Mac with Apple Silicon and `tart`. */
async function localTartProblem(): Promise<string | null> {
  const { tartCli } = await import('./tart-cli.ts')
  return (
    tartHostProblem() ??
    (await tartCli(['--version']).then(
      (r) => (r.exitCode === 0 ? null : `tart --version failed: ${r.stderr.trim()}`),
      () =>
        "Tart isn't installed: there's no tart command on the PATH. Install it (brew install cirruslabs/cli/tart, see https://tart.run) and try again.",
    ))
  )
}

/** The key two spellings of one Mac share: its user, host and port. */
const hostKey = (h: ParsedTartHost) => `${h.user ?? ''}@${h.host}:${h.port ?? ''}`

/**
 * Tart: a run starts only from images `tart list` has, and refuses the rest; with `pull`
 * (`reeval image build`), it pulls them, once the disk has room for all of them (counting what
 * Tart prunes from its cache). Then it bakes each harness the run needs into its own local image
 * of each, one at a time (each bake boots a VM, and macOS runs two at once), unless Tart has it.
 * A sandbox with `hosts` does all of this on each of them over SSH, after one check of each host:
 * one that doesn't answer stops the run, and one short of disk or memory is skipped.
 */
export const tartProvider = (
  options: { pull?: boolean; force?: boolean } = {},
): SandboxProvider<TartSandboxDescriptor> => {
  const pulls = new Map<string, Promise<void>>()
  const bakes = new Map<string, Promise<unknown>>()
  const probes = new Map<string, HostProbe>()
  /** One bake at a time on each Mac. */
  const oneAtATime = <T>(where: string, step: () => Promise<T>): Promise<T> => {
    const next = (bakes.get(where) ?? Promise.resolve()).then(step, step)
    bakes.set(
      where,
      next.catch(() => {}),
    )
    return next
  }
  /** The hosts of `sandbox` preflight kept, each with how many VMs it runs at once. */
  const usableHosts = async (sandbox: TartSandboxDescriptor) => {
    const { parseTartHosts } = await import('../contract/tart.ts')
    return parseTartHosts(sandbox.hosts ?? []).flatMap((host) => {
      const probe = probes.get(hostKey(host))
      if (!probe) return [{ host, vms: host.vms }]
      return probe.ok ? [{ host, vms: Math.min(host.vms, probe.vms) }] : []
    })
  }
  return {
    kind: 'tart',
    // What Tart needs depends on where each sandbox runs, so checkTargets checks it.
    async check() {},
    key: tartBakeKey,
    async checkTargets(sandboxes, ctx) {
      const here = sandboxes.filter((s) => !s.hosts)
      if (here.length) {
        const problem = await localTartProblem()
        if (problem) throw tartRefusal(problem)
        await checkImages(here, ctx, LOCAL_TART, !!options.pull)
      }
      const away = sandboxes.filter((s) => s.hosts)
      if (!away.length) return
      const { parseTartHosts } = await import('../contract/tart.ts')
      const { HostRefusal, hostTarget, probeHost } = await import('./tart-hosts.ts')
      const hosts = new Map<string, { host: ParsedTartHost; memory?: string | number }>()
      for (const sandbox of away) {
        for (const host of parseTartHosts(sandbox.hosts ?? [])) {
          const memory = sandbox.memory ?? hosts.get(hostKey(host))?.memory
          hosts.set(hostKey(host), { host, ...(memory !== undefined && { memory }) })
        }
      }
      const refused: string[] = []
      await Promise.all(
        [...hosts].map(async ([key, { host, memory }]) => {
          try {
            const probe = await probeHost(host, { memory }, ctx.signal)
            probes.set(key, probe)
            if (!probe.ok) ctx.log(probe.skip)
            else if (probe.note) ctx.log(probe.note)
          } catch (error) {
            if (!(error instanceof HostRefusal)) throw error
            refused.push(error.message)
          }
        }),
      )
      if (refused.length) throw tartRefusal(refused.sort().join('\n'))
      for (const sandbox of away) {
        const usable = await usableHosts(sandbox)
        if (!usable.length) {
          throw new PrepareError({
            class: 'resource',
            stage: 'tart',
            ref: null,
            cause: null,
            log: null,
            message: `tart(${sandbox.image}) has no host to run on: preflight skipped every one.\n${parseTartHosts(
              sandbox.hosts ?? [],
            )
              .map((h) => {
                const probe = probes.get(hostKey(h))
                return `  ${probe && !probe.ok ? probe.skip : h.label}`
              })
              .join('\n')}`,
          })
        }
      }
      const byHost = new Map<string, { host: ParsedTartHost; sandboxes: TartSandboxDescriptor[] }>()
      for (const sandbox of away) {
        for (const { host } of await usableHosts(sandbox)) {
          const entry = byHost.get(hostKey(host)) ?? { host, sandboxes: [] }
          entry.sandboxes.push(sandbox)
          byHost.set(hostKey(host), entry)
        }
      }
      for (const { host, sandboxes: on } of byHost.values()) {
        await checkImages(on, ctx, hostTarget(host), !!options.pull)
      }
    },
    async prepare(sandbox, harness, ctx) {
      if (!sandbox.hosts) {
        const prepared = await prepareOn(sandbox, harness, ctx, LOCAL_TART)
        return {
          image: sandbox.image,
          digest: prepared.digest,
          ...(prepared.baked && { baked: prepared.baked }),
        }
      }
      const { hostTarget } = await import('./tart-hosts.ts')
      // A host the pull or bake fails on is skipped, as preflight skips one it can't reach: the
      // target fails only when every host did.
      const usable = await usableHosts(sandbox)
      const settled = await Promise.allSettled(
        usable.map(async ({ host, vms }) => ({
          host: host.label,
          vms,
          ...(await prepareOn(sandbox, harness, ctx, hostTarget(host))),
        })),
      )
      const each = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
      const failed = settled.flatMap((s, i) =>
        s.status === 'rejected' ? [{ host: usable[i]?.host.label, error: s.reason }] : [],
      )
      if (!each.length || ctx.signal.aborted) throw failed[0]?.error
      for (const { host, error } of failed) {
        ctx.log(
          `tart(${sandbox.image}) skipped ${host}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const digests = new Set(each.map((h) => h.digest))
      if (digests.size > 1) {
        throw tartRefusal(
          `tart(${sandbox.image}) is a different image on each host, so the record can't say which one an attempt ran:\n${each
            .map((h) => `  ${h.host}: ${h.digest ?? 'no digest'}`)
            .join(
              '\n',
            )}\nPin the image by digest (image@sha256:…), or pull it again on every host: reeval image build --force`,
        )
      }
      const [first] = each
      return {
        image: sandbox.image,
        digest: first?.digest ?? null,
        ...(first?.baked && { baked: first.baked }),
        hosts: each.map((h) => ({ host: h.host, vms: h.vms, image: h.baked ?? sandbox.image })),
      }
    },
    classify: classifyTart,
  }

  /**
   * Refuses the images `sandboxes` clone that Tart on `on` doesn't have; with `pull`, checks the
   * disk has room to pull them (on this machine: another Mac's room was checked by its probe).
   */
  async function checkImages(
    sandboxes: TartSandboxDescriptor[],
    ctx: Pick<PrepareContext, 'signal' | 'log'>,
    on: TartTarget,
    pull: boolean,
  ) {
    const { tartNames } = await import('./tart-cli.ts')
    const images = await import('./tart-images.ts')
    const { parseTartRef, tartListed } = await import('./tart-ref.ts')
    const have = await tartNames(ctx.signal, on)
    const wanted = [...new Set(sandboxes.map((s) => s.image))].filter((i) => !tartListed(have, i))
    if (!wanted.length) return
    // A registry that doesn't answer soon leaves the size unsaid, not the refusal unmade.
    const lookup = AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)])
    const missing = await Promise.all(
      wanted.map(async (image) => ({ image, size: await images.tartImageSize(image, lookup) })),
    )
    const local = missing.filter((m) => !parseTartRef(m.image).oci)
    if (!pull || local.length) {
      const message = images.missingImagesMessage(pull ? local : missing)
      throw tartRefusal(on.remote ? images.onHost(message, on.label) : message)
    }
    if (on.remote) return
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
  }

  /** Pulls `sandbox`'s image on `on` (with `pull`), reads its digest, and bakes the harness there. */
  async function prepareOn(
    sandbox: TartSandboxDescriptor,
    harness: HarnessDescriptor,
    ctx: PrepareContext,
    on: TartTarget,
  ): Promise<{ digest: string | null; baked?: string }> {
    const { tartNames } = await import('./tart-cli.ts')
    const { tartDigestOn, tartPull, tartSourceOn } = await import('./tart-images.ts')
    const { parseTartRef, tartListed } = await import('./tart-ref.ts')
    const where = on.remote ? `${on.label}: ` : ''
    // Each harness on an image is a target of its own, and they share its one pull.
    const pull = async () => {
      if (!options.pull) return
      const listed = tartListed(await tartNames(ctx.signal, on), sandbox.image)
      // `--force` pulls a pulled tag again, which moves it to what the registry has now.
      if (listed && !(options.force && parseTartRef(sandbox.image).oci)) return
      const { sandboxId } = await import('../options.ts')
      // Up to three pull at once: each line says whose it is.
      const id = `${where}${sandboxId(sandbox)}`
      ctx.log(`${where}tart pull ${sandbox.image}`)
      await ctx.retry(() =>
        tartPull(sandbox.image, {
          signal: ctx.signal,
          onLine: (line) => ctx.log(`${id}: ${line}`),
          on,
        }),
      )
    }
    const pullKey = `${on.label}\0${sandbox.image}`
    const pulled = pulls.get(pullKey) ?? pull()
    pulls.set(pullKey, pulled)
    await pulled
    const digest = await tartDigestOn(sandbox.image, on)
    const bake = harnessBake(harness)
    if (!bake) return { digest }
    const { bakeTartImage } = await import('./tart-bake.ts')
    const source = await tartSourceOn(sandbox.image, on)
    const baked = await oneAtATime(on.label, () =>
      ctx.retry(() =>
        bakeTartImage(sandbox, bake, {
          source,
          force: !!options.force,
          signal: ctx.signal,
          log: (line) => ctx.log(`${where}${line}`),
          on,
        }),
      ),
    )
    return { digest, baked: baked.image }
  }
}

/**
 * Boat: `prepare` checks each account and machine size the run uses, once, and builds a sandbox's
 * image recipe into a saved snapshot when it has one. One recipe is built once per run, whatever machine sizes use it, on a build VM of the
 * size of the first target that asks for it.
 */
export const boatProvider = (
  options: { resolve?: ResolveDigest; timings?: BoatImageTimings } = {},
): SandboxProvider<BoatSandboxDescriptor> => {
  const images = new Map<string, Promise<BoatImage>>()
  return {
    kind: 'boat',
    check: async () => {},
    key: (sandbox, harness, plugins = []) => {
      const recipe = recipeOf(sandbox)
      return JSON.stringify({
        apiKey: sandbox.apiKey.from,
        type: sandbox.type ?? 'small',
        ...(recipe && { image: imageIdentity(sandbox, recipe, harness, plugins) }),
      })
    },
    async prepare(sandbox, harness, ctx, plugins = []) {
      const boat = await import('./boat.ts')
      await boat.checkBoat(sandbox, ctx.root)
      const recipe = recipeOf(sandbox)
      if (!recipe) return null
      const { boatImage } = await import('./boat-images.ts')
      const identity = imageIdentity(sandbox, recipe, harness, plugins)
      let image = images.get(identity)
      if (!image) {
        const api = (await boat.boatClient(sandbox, ctx.root)) as BoatSnapshotClient
        image = boatImage(boat.boatService(sandbox), api, sandbox, recipe, harness, ctx, {
          plugins,
          ...options,
        })
        images.set(identity, image)
        // A failed build is tried again by preflight's retry, not handed to the next size.
        image.catch(() => images.delete(identity))
      }
      return await image
    },
    classify: (error) => {
      if (error instanceof ImageBuildError) return classifyDocker(error)
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
  }
}

/** What decides a Boat sandbox's image beside its machine size: the account, prefix and recipe. */
const imageIdentity = (
  sandbox: BoatSandboxDescriptor,
  recipe: ImageRecipe,
  harness: HarnessDescriptor,
  plugins: readonly PluginSource[],
) =>
  JSON.stringify({
    apiKey: sandbox.apiKey.from,
    prefix: sandbox.prefix,
    harness: harness.kind === 'fake' ? (harness.layout ?? 'cursor') : harness.kind,
    recipe,
    ...(plugins.length ? { plugins: plugins.map(pluginBuildId) } : {}),
  })

/**
 * Daytona: `prepare` checks each organization the run uses, once, and has Daytona build each
 * recipe's image for each harness.
 */
export const daytonaProvider = (): SandboxProvider<DaytonaSandboxDescriptor> => ({
  kind: 'daytona',
  check: async () => {},
  key: (sandbox, harness) => {
    const { image, from, dockerfile, install } = sandbox
    if (image === undefined && from === undefined && dockerfile === undefined && !install) {
      return JSON.stringify({ apiKey: sandbox.apiKey.from })
    }
    const bake = harnessBake(harness)
    return JSON.stringify({
      apiKey: sandbox.apiKey.from,
      prefix: sandbox.prefix,
      size: sandbox.size ?? 'medium',
      recipe: { image, from, dockerfile, install },
      harness: bake?.label ?? harness.kind,
    })
  },
  async prepare(sandbox, harness, ctx) {
    const { prepareDaytona } = await import('./daytona.ts')
    return prepareDaytona(sandbox, harness, ctx)
  },
  classify: (error) => {
    const message = error instanceof Error ? error.message : String(error)
    return {
      class: isTransient(message) ? 'transient' : 'config',
      stage: 'daytona',
      ref: null,
      cause: null,
      log: null,
      message,
    }
  },
})

/** hosted()'s VMs have nothing to build either: `prepare` checks the service, per size. */
export const hostedProvider = (): SandboxProvider<HostedSandboxDescriptor> => ({
  kind: 'hosted',
  check: async () => {},
  key: (sandbox) => JSON.stringify({ size: sandbox.size ?? 'small' }),
  async prepare(sandbox, _harness, ctx) {
    const { checkHosted } = await import('./hosted.ts')
    await checkHosted(sandbox, ctx.root)
    return null
  },
  classify: (error) => {
    const message = error instanceof Error ? error.message : String(error)
    return {
      class: isTransient(message) ? 'transient' : 'config',
      stage: 'hosted',
      ref: null,
      cause: null,
      log: null,
      message,
    }
  },
})

/**
 * A fresh set of providers, one per run: each keeps the run's builds. `pull` lets Tart pull the
 * images it doesn't have, which only `reeval image build` does; with `force` too, it pulls each
 * tag again and bakes each harness image anew. `registry` is where Docker and Podman pull a
 * missing image from before building it, and push every image to with `push`.
 */
export const createProviders = (
  options: { refresh?: Refresh; pull?: boolean; force?: boolean } & RegistryOptions = {},
): Record<string, SandboxProvider> => ({
  docker: dockerProvider(options),
  podman: dockerProvider({ ...options, engine: 'podman' }),
  fake: fakeProvider(),
  ...machineProviders({ pull: !!options.pull, force: !!options.force }),
})

/** Each machine provider's prepare provider, by its kind. */
const machineProviders = (options: {
  pull: boolean
  force: boolean
}): Record<(typeof MACHINE_PROVIDERS)[number]['kind'], SandboxProvider> => ({
  tart: tartProvider(options),
  boat: boatProvider(),
  daytona: daytonaProvider(),
  hosted: hostedProvider(),
})
