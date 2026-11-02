// Every sandbox kind reeval has, one entry each: what it can do, how its sandboxes are named,
// prepared, created and cleaned up. Code outside a kind's own modules asks this table, not the
// kind's name, so a new kind is one more entry.
import { createHash } from 'node:crypto'
import { DOCKER_EGRESS, type EgressCapabilities } from '@reeval/sandbox-docker'
import type {
  DockerSandboxDescriptor,
  FakeSandboxDescriptor,
  InstallStep,
  SandboxDescriptor,
} from '../types.ts'
import { createFakeSandbox, FAKE_EGRESS } from './fake.ts'
import type { SandboxOptions } from './index.ts'
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
  /** Starts from an image preflight prepares before the run, which the record names. */
  images: boolean
  /** Runs a plugin's `build` while preparing the image. */
  pluginBuilds: boolean
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
  /** The descriptor's host paths, which a declaration written as data makes absolute. */
  hostPaths: Readonly<Record<string, HostPath>>
  /** Whether the attempt's sandbox may have to build an image as it starts. */
  buildsAtStart(sandbox: D): boolean
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
    images: true,
    pluginBuilds: true,
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
    images: false,
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

export const SANDBOX_KINDS: Kinds = { docker: DOCKER, fake: FAKE }

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
 * Whether a sandbox can run a real harness whose bootstrap installs its CLI for `platforms`: it
 * gives the harness a session, keeps the credential out, and runs one of them.
 */
export const runsAgent = (platforms: readonly NodeJS.Platform[]) => (c: SandboxCapabilities) =>
  c.harnessSession && c.brokers && platforms.includes(c.platform)

/** The first helper of each kind that can, for a fix: `docker()`. */
export const suggestedSandbox = (which: (capabilities: SandboxCapabilities) => boolean) =>
  Object.values(SANDBOX_KINDS)
    .filter((k) => which(k.capabilities))
    .map((k) => `${k.helpers[0]}()`)
    .join(' or ')

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
