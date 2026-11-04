// Every sandbox kind reeval has, one entry each: what it can do, how its sandboxes are named,
// prepared, created and cleaned up. Code outside a kind's own modules asks this table, not the
// kind's name, so a new kind is one more entry.
import { createHash } from 'node:crypto'
import { DOCKER_EGRESS, type EgressCapabilities } from '@reeval/sandbox-docker'
import type { ListenerSource } from '../attempt/serve.ts'
import { tartVmLimit } from '../contract/tart.ts'
import type {
  BoatSandboxDescriptor,
  DockerSandboxDescriptor,
  FakeSandboxDescriptor,
  InstallStep,
  SandboxDescriptor,
  TartSandboxDescriptor,
} from '../types.ts'
import { createFakeSandbox, FAKE_EGRESS } from './fake.ts'
import type { SandboxOptions } from './index.ts'
import type { TartTarget } from './tart-cli.ts'
import type { Sandbox } from './types.ts'

/** What a sandbox kind can do, which planning and the attempt check instead of its name. */
export type SandboxCapabilities = {
  /** The OS its commands run on: what a harness's bootstrap has to install a build for. */
  platform: NodeJS.Platform
  /** The egress policies it can enforce, and whether it records the hosts contacted. */
  egress: EgressCapabilities
  /**
   * Keeps brokered values out of the sandbox: it holds a placeholder, and a gateway outside swaps
   * the value in on the hosts it's brokered for.
   */
  brokers: boolean
  /** Gives a real harness an AI SDK sandbox session to run its agent in. */
  harnessSession: boolean
  /**
   * Runs apart from the host and from reeval's own state, so what the agent could see and what the
   * setup steps left running are worth recording. The fake sandbox is the host.
   */
  isolated: boolean
  /**
   * Has a Linux `/proc` for the agent's processes, and bash: what `leftRunning` and the
   * background-exec kill-tree read.
   */
  processTable: boolean
  /** How `c.serve` lists what listens in the sandbox. */
  listeners: ListenerSource
  /** Starts from an image preflight prepares before the run, which the record names. */
  images: boolean
  /** Has its provider checked, and what it starts from prepared, before the run. */
  preflight: boolean
  /** Runs a plugin's `build` while preparing the image. */
  pluginBuilds: boolean
  /**
   * The real harnesses it runs: every one, or the ones verified on it so far. The rest are refused
   * at plan time with its kind's `unverifiedHarnesses` sentence.
   */
  harnesses: 'all' | readonly string[]
}

/** A host path in a descriptor, made absolute against the file that declares it. */
export type HostPath = 'file' | 'dir'

/** What the attempt's sandbox did to widen its own privileges, for the plan's warnings. */
export type SandboxPrivileges = { root: boolean; capabilities: readonly string[] }

export type SandboxKind<D extends SandboxDescriptor = SandboxDescriptor> = {
  /** The helpers that make it, as messages name them: `docker`, then `podman`. */
  helpers: readonly string[]
  capabilities: SandboxCapabilities
  /** The provider that prepares and runs it, which keys preflight and `maxConcurrent`. */
  provider(sandbox: D): string
  /** The cell id when `id` is unset. */
  id(sandbox: D): string
  /** Why a real harness outside `capabilities.harnesses` doesn't run on it yet, and what to use. */
  unverifiedHarnesses?: string
  /** The descriptor's host paths, which a declaration written as data makes absolute. */
  hostPaths: Readonly<Record<string, HostPath>>
  /** Whether the attempt's sandbox may take long to start: build an image, or boot a VM. */
  buildsAtStart(sandbox: D): boolean
  /**
   * The most of its sandboxes the host runs at once, across the run, and why: the cap when
   * `maxConcurrent` is unset, and the most it may be. Unlimited when unset.
   */
  hostLimit?: (sandbox: D) => { max: number; why: string }
  privileges(sandbox: D): SandboxPrivileges
  create(sandbox: D, options: SandboxOptions): Promise<Sandbox>
  /** What its sandboxes may use at once, when they run somewhere other than the host. */
  capacity?(sandbox: D): Promise<{ cpus: number; memoryBytes: number } | null>
  /**
   * Removes what the run left behind (a worker killed mid-attempt never destroys its sandboxes):
   * for `sandboxes`, or for every provider of the kind when unset.
   */
  cleanupRun?(runId: string, sandboxes?: readonly D[]): Promise<void>
}

/** The last path segment of `text`, with what an id can't hold replaced. */
export const idPart = (text: string) =>
  (text.split('/').at(-1) ?? text).replace(/[^A-Za-z0-9._:@-]+/g, '-')

/** `+` and a hash of the install steps, or nothing without any. */
function installId(install: readonly InstallStep[] | undefined): string {
  if (!install?.length) return ''
  const key = JSON.stringify(
    install.map((step) =>
      typeof step === 'string' ? step : { run: step.run, timeout: step.timeout },
    ),
  )
  return `+${createHash('sha256').update(key).digest('hex').slice(0, 8)}`
}

const engineOf = (s: DockerSandboxDescriptor) => s.engine ?? 'docker'

const DOCKER: SandboxKind<DockerSandboxDescriptor> = {
  helpers: ['docker', 'podman'],
  capabilities: {
    platform: 'linux',
    egress: DOCKER_EGRESS,
    brokers: true,
    harnessSession: true,
    isolated: true,
    processTable: true,
    listeners: 'proc',
    images: true,
    preflight: true,
    pluginBuilds: true,
    harnesses: 'all',
  },
  provider: engineOf,
  id(s) {
    const install = installId(s.install)
    const engine = engineOf(s)
    if (s.dockerfile) {
      const [file = '', dir = ''] = s.dockerfile.split(/[\\/]/).reverse()
      return `${engine}:${idPart(file === 'Dockerfile' ? dir || file : file)}${install}`
    }
    const image = s.image ?? s.from
    return image ? `${engine}:${idPart(image)}${install}` : `${engine}${install}`
  },
  hostPaths: { dockerfile: 'file' },
  buildsAtStart: (s) => !!(s.from || s.dockerfile || s.install?.length),
  privileges: (s) => ({ root: !!s.root, capabilities: s.capabilities ?? [] }),
  async create(sandbox, options) {
    const { createDockerSandbox } = await import('./docker.ts')
    return createDockerSandbox(sandbox, options)
  },
  async capacity(sandbox) {
    const { dockerCapacity } = await import('@reeval/sandbox-docker')
    return dockerCapacity(sandbox.engine)
  },
  async cleanupRun(runId, sandboxes) {
    const engines = sandboxes
      ? [...new Set(sandboxes.map(engineOf))]
      : (['docker', 'podman'] as const)
    if (!engines.length) return
    const { removeRunContainers } = await import('./docker.ts')
    await removeRunContainers(runId, engines)
  },
}

const FAKE: SandboxKind<FakeSandboxDescriptor> = {
  helpers: ['fakeSandbox'],
  capabilities: {
    platform: process.platform,
    egress: FAKE_EGRESS,
    brokers: false,
    harnessSession: false,
    isolated: false,
    processTable: false,
    listeners: 'host',
    images: false,
    preflight: false,
    pluginBuilds: false,
    harnesses: 'all',
  },
  provider: () => 'fake',
  id: () => 'fake',
  hostPaths: { dir: 'dir' },
  buildsAtStart: () => false,
  privileges: () => ({ root: false, capabilities: [] }),
  create: (sandbox, options) => createFakeSandbox(sandbox, options.env),
}

/**
 * A Tart VM keeps Tart's network, so nothing it sends around the gateway's proxy is refused or
 * recorded; what goes through the proxy is. Its one policy holds for the whole attempt.
 */
export const TART_EGRESS: EgressCapabilities = { enforce: 'none', record: true, switches: false }

const TART: SandboxKind<TartSandboxDescriptor> = {
  helpers: ['tart'],
  capabilities: {
    platform: 'darwin',
    egress: TART_EGRESS,
    brokers: true,
    harnessSession: true,
    isolated: true,
    processTable: false,
    listeners: 'lsof',
    images: false,
    preflight: true,
    pluginBuilds: false,
    harnesses: ['cursor', 'claude-code', 'opencode', 'pi', 'codex'],
  },
  unverifiedHarnesses:
    "reeval bakes a harness's CLI into a copy of the Tart image before the run, and the other harnesses' bootstraps don't install for macOS yet. Run this one in docker().",
  provider: () => 'tart',
  id: (s) => `tart:${idPart(s.image)}`,
  hostPaths: { 'ssh.key': 'file' },
  buildsAtStart: () => true,
  hostLimit: tartVmLimit,
  privileges: () => ({ root: false, capabilities: [] }),
  async create(sandbox, options) {
    const { createTartSandbox } = await import('./tart.ts')
    return createTartSandbox(sandbox, options)
  },
  async cleanupRun(runId, sandboxes) {
    const { removeRunVms } = await import('./tart.ts')
    const { LOCAL_TART } = await import('./tart-cli.ts')
    const { hostTarget } = await import('./tart-hosts.ts')
    const { parseTartHost } = await import('../contract/tart.ts')
    const away = new Map<string, TartTarget>()
    for (const host of (sandboxes ?? []).flatMap((s) => s.hosts ?? [])) {
      const parsed = parseTartHost(host)
      if (typeof parsed !== 'string') away.set(parsed.label, hostTarget(parsed))
    }
    const here = !sandboxes || sandboxes.some((s) => !s.hosts)
    await removeRunVms(runId, [...(here ? [LOCAL_TART] : []), ...away.values()])
  },
}

/**
 * Enforces nothing yet: the VM keeps its own network, so only `allow-all` plans on it, for the
 * whole attempt. The gateway still brokers credentials and records what goes through it.
 */
const BOAT_EGRESS: EgressCapabilities = { enforce: 'none', record: true, switches: false }

const BOAT: SandboxKind<BoatSandboxDescriptor> = {
  helpers: ['boat'],
  capabilities: {
    platform: 'linux',
    egress: BOAT_EGRESS,
    brokers: true,
    harnessSession: true,
    isolated: true,
    processTable: true,
    listeners: 'proc',
    images: false,
    preflight: true,
    pluginBuilds: false,
    harnesses: ['cursor'],
  },
  unverifiedHarnesses:
    "Boat installs a harness's CLI as the attempt starts, through the egress gateway, and the others haven't been verified to start in time that way. They'll run on boat() once its snapshots bake their CLIs in ahead of the run; until then, run this one in docker().",
  provider: () => 'boat',
  id: (s) => (s.type ? `boat:${s.type}` : 'boat'),
  hostPaths: {},
  buildsAtStart: () => true,
  privileges: () => ({ root: false, capabilities: [] }),
  async create(sandbox, options) {
    const { createBoatSandbox } = await import('./boat.ts')
    return createBoatSandbox(sandbox, options)
  },
  async capacity(sandbox) {
    const { boatCapacity } = await import('./boat.ts')
    const free = await boatCapacity(sandbox)
    if (free === null) return null
    const machines = Math.max(1, free)
    return { cpus: machines, memoryBytes: machines * 1e9 }
  },
  async cleanupRun(runId, sandboxes) {
    // Without the run's descriptors there's no key or prefix to look under; each sandbox's TTL
    // is the backstop.
    if (!sandboxes?.length) return
    const { removeRunSandboxes } = await import('./boat.ts')
    await removeRunSandboxes(runId, sandboxes)
  },
}

type Kinds = {
  [K in SandboxDescriptor['kind']]: SandboxKind<Extract<SandboxDescriptor, { kind: K }>>
}

export const SANDBOX_KINDS: Kinds = { docker: DOCKER, fake: FAKE, tart: TART, boat: BOAT }

export type SandboxKindName = keyof Kinds

export const isSandboxKind = (kind: unknown): kind is SandboxKindName =>
  typeof kind === 'string' && Object.hasOwn(SANDBOX_KINDS, kind)

/** The entry for `sandbox`'s kind. */
export const sandboxKind = <D extends SandboxDescriptor>(sandbox: D): SandboxKind<D> =>
  SANDBOX_KINDS[sandbox.kind] as unknown as SandboxKind<D>

/** What `sandbox`'s kind can do. */
export const capabilitiesOf = (sandbox: SandboxDescriptor): SandboxCapabilities =>
  SANDBOX_KINDS[sandbox.kind].capabilities

/** Every helper that makes a sandbox, as a list a message reads: `docker(), podman() or fakeSandbox()`. */
export function sandboxHelpers(
  which: (capabilities: SandboxCapabilities) => boolean = () => true,
): string {
  const calls = Object.values(SANDBOX_KINDS)
    .filter((k) => which(k.capabilities))
    .flatMap((k) => k.helpers.map((h) => `${h}()`))
  return calls.length > 1 ? `${calls.slice(0, -1).join(', ')} or ${calls.at(-1)}` : (calls[0] ?? '')
}

/**
 * Whether a sandbox can run the real harness `harness`, whose bootstrap installs its CLI for
 * `platforms`: it gives the harness a session, keeps the credential out, runs one of them, and
 * has `harness` among the ones it runs.
 */
export const runsAgent =
  (harness: string, platforms: readonly NodeJS.Platform[]) => (c: SandboxCapabilities) =>
    c.harnessSession && c.brokers && platforms.includes(c.platform) && takesHarness(c, harness)

/** Whether a sandbox with `c` runs the real harness `harness`. */
export const takesHarness = (c: SandboxCapabilities, harness: string) =>
  c.harnesses === 'all' || c.harnesses.includes(harness)

/** The first helper of each kind that can, for a fix: `docker()`. */
export const suggestedSandbox = (which: (capabilities: SandboxCapabilities) => boolean) =>
  Object.values(SANDBOX_KINDS)
    .filter((k) => which(k.capabilities))
    .map((k) => `${k.helpers[0]}()`)
    .join(' or ')

/** Why `sandbox.maxConcurrent` (in `where`) is wrong, or undefined. */
export function maxConcurrentProblem(sandbox: SandboxDescriptor, where: string) {
  const max = sandbox.maxConcurrent as unknown
  if (max === undefined) return undefined
  if (!(typeof max === 'number' && Number.isInteger(max) && max >= 1)) {
    return `sandbox.maxConcurrent in ${where} must be a whole number of at least 1 (got ${String(max)})`
  }
  const limit = sandboxKind(sandbox).hostLimit?.(sandbox)
  if (limit && max > limit.max) {
    return `sandbox.maxConcurrent in ${where} is ${max}, but ${SANDBOX_KINDS[sandbox.kind].helpers[0]}() runs at most ${limit.max} at once: ${limit.why}`
  }
  return undefined
}

/** The cap on `sandbox`'s provider across the run: its `maxConcurrent`, else its kind's limit. */
export const providerLimit = (sandbox: SandboxDescriptor): number | undefined =>
  sandbox.maxConcurrent || sandboxKind(sandbox).hostLimit?.(sandbox).max

/** What the first of `sandboxes` that runs off the host may use, or null when none does or it doesn't answer. */
export async function sandboxCapacity(sandboxes: readonly SandboxDescriptor[]) {
  for (const sandbox of sandboxes) {
    const kind = sandboxKind(sandbox)
    if (kind.capacity) return kind.capacity(sandbox)
  }
  return null
}

/** Removes what the run left behind: for `sandboxes`, or everything any kind may have started when unset. */
export async function cleanupRun(runId: string, sandboxes?: readonly SandboxDescriptor[]) {
  for (const [name, kind] of Object.entries(SANDBOX_KINDS) as Array<
    [SandboxKindName, SandboxKind]
  >) {
    if (!kind.cleanupRun) continue
    const own = sandboxes?.filter((s) => s.kind === name)
    if (own && !own.length) continue
    await kind.cleanupRun(runId, own)
  }
}
