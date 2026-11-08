// Every sandbox kind reeval has, one entry each: what it can do, how its sandboxes are named,
// prepared, created and cleaned up. Code outside a kind's own modules asks this table, not the
// kind's name, so a new kind is one more entry. A kind whose attempts each run on a machine of
// their own is a MachineProvider (machines.ts), whose entry kindOf() derives.
import { DOCKER_EGRESS, type EgressCapabilities } from '@reeval/sandbox-docker'
import type { ListenerSource } from '../attempt/serve.ts'
import type { Check, DoctorDeps } from '../doctor.ts'
import type {
  DockerSandboxDescriptor,
  FakeSandboxDescriptor,
  HarnessDescriptor,
  SandboxDescriptor,
} from '../types.ts'
import { createFakeSandbox, FAKE_EGRESS } from './fake.ts'
import { recipeId } from './id-part.ts'
import type { SandboxOptions } from './index.ts'
import { kindOf } from './machine.ts'
import { BOAT_MACHINE, DAYTONA_MACHINE, HOSTED_MACHINE, TART_MACHINE } from './machines.ts'
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
}

/** A host path in a descriptor, made absolute against the file that declares it. */
export type HostPath = 'file' | 'dir'

/** What the attempt's sandbox did to widen its own privileges, for the plan's warnings. */
export type SandboxPrivileges = { root: boolean; capabilities: readonly string[] }

/** What `reeval doctor` gives a kind's checks. */
export type DoctorContext = { deps: DoctorDeps; root: string; online: boolean; envFile: string }

/** The questions code outside a kind's modules asks of it, each one a kind answers only when it must. */
export type SandboxHooks<D extends SandboxDescriptor> = {
  /**
   * Whether removing the run's leftovers has to be given `sandbox`, because cleanup without it
   * can't find its machines: the key that tells those apart (an account, a set of hosts), and
   * whether the run's start can, before the plan has named every eval's sandbox.
   */
  cleanupScope?(sandbox: D): { key: string; atStart: boolean } | null
  /** The credentials `sandbox` needs of its own, as `neededCredentials` lists them. */
  credentials?(sandbox: D): Array<{ names: string[]; line: string }>
  /** `reeval doctor`'s checks of the kind's sandboxes the config or the plan uses. */
  doctor?(sandboxes: readonly D[], ctx: DoctorContext): Promise<Check[]>
  /** The plan's warnings about `sandbox`. */
  planWarnings?(sandbox: D): string[]
  /** How many attempts share one of `sandbox`'s machines, when more than one may. */
  slotsPerMachine?(sandbox: D): number
  /**
   * When preflight learns how many of `sandbox`'s attempts can run at once (the hosts it kept),
   * reads that cap for the gate.
   */
  attemptCap?(
    sandbox: D,
  ):
    | ((o: { harness: HarnessDescriptor; root: string; runId: string }) => Promise<number | null>)
    | null
}

export type SandboxKind<D extends SandboxDescriptor = SandboxDescriptor> = SandboxHooks<D> & {
  /** The helpers that make it, as messages name them: `docker`, then `podman`. */
  helpers: readonly string[]
  /** Left out of the helpers messages and the docs list, since it isn't public API. */
  internal?: true
  capabilities: SandboxCapabilities
  /** The provider that prepares and runs it, which keys preflight and `maxConcurrent`. */
  provider(sandbox: D): string
  /** The cell id when `id` is unset. */
  id(sandbox: D): string
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
  capacity?(sandbox: D): Promise<{ cpus: number; memoryBytes: number; attempts?: number } | null>
  /**
   * Removes what the run left behind (a worker killed mid-attempt never destroys its sandboxes):
   * for `sandboxes`, or for every provider of the kind when unset.
   */
  cleanupRun?(runId: string, sandboxes?: readonly D[]): Promise<void>
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
  },
  provider: engineOf,
  id: (s) => recipeId(engineOf(s), s),
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
  },
  provider: () => 'fake',
  id: () => 'fake',
  hostPaths: { dir: 'dir' },
  buildsAtStart: () => false,
  privileges: () => ({ root: false, capabilities: [] }),
  create: (sandbox, options) => createFakeSandbox(sandbox, options.env),
}

type Kinds = {
  [K in SandboxDescriptor['kind']]: SandboxKind<Extract<SandboxDescriptor, { kind: K }>>
}

export const SANDBOX_KINDS: Kinds = {
  docker: DOCKER,
  fake: FAKE,
  tart: kindOf(TART_MACHINE),
  boat: kindOf(BOAT_MACHINE),
  daytona: kindOf(DAYTONA_MACHINE),
  hosted: kindOf(HOSTED_MACHINE),
}

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
    .filter((k) => !k.internal && which(k.capabilities))
    .flatMap((k) => k.helpers.map((h) => `${h}()`))
  return calls.length > 1 ? `${calls.slice(0, -1).join(', ')} or ${calls.at(-1)}` : (calls[0] ?? '')
}

/**
 * Whether a sandbox can run a real harness whose bootstrap installs its CLI for `platforms`: it
 * gives the harness a session, keeps the credential out and runs one of them.
 */
export const runsAgent = (platforms: readonly NodeJS.Platform[]) => (c: SandboxCapabilities) =>
  c.harnessSession && c.brokers && platforms.includes(c.platform)

/** The first helper of each kind that can, for a fix: `docker()`. */
export const suggestedSandbox = (which: (capabilities: SandboxCapabilities) => boolean) =>
  Object.values(SANDBOX_KINDS)
    .filter((k) => !k.internal && which(k.capabilities))
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
