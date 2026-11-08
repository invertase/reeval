// A sandbox kind that runs each attempt on a machine of its own (a VM) reached over a transport,
// started through the shared sequence (start.ts). A provider like that writes a MachineProvider;
// kindOf() derives the rest of its kinds entry; createProviders() names its prepare provider.
import type { EgressCapabilities } from '@reeval/sandbox-docker'
import type { ListenerSource } from '../attempt/serve.ts'
import type {
  BoatSandboxDescriptor,
  DaytonaSandboxDescriptor,
  HostedSandboxDescriptor,
  TartSandboxDescriptor,
} from '../types.ts'
import type { SandboxOptions } from './index.ts'
import type { HostPath, SandboxHooks, SandboxKind } from './kinds.ts'
import type { OpenPool } from './machine-service.ts'
import type { Sandbox } from './types.ts'

/** The descriptors of the kinds a {@link MachineProvider} makes. */
export type MachineDescriptor =
  | TartSandboxDescriptor
  | BoatSandboxDescriptor
  | DaytonaSandboxDescriptor
  | HostedSandboxDescriptor

export interface MachineProvider<D extends MachineDescriptor> extends SandboxHooks<D> {
  kind: D['kind']
  /** The helpers that make it, as messages name them. */
  helpers: readonly string[]
  /** Left out of the helpers messages and the docs list, since it isn't public API. */
  internal?: true
  /** The OS its machines run, which picks the harness builds their bootstraps install. */
  os: 'linux' | 'darwin'
  capabilities: {
    /** The egress policies it can enforce, and whether the gateway records the hosts contacted. */
    egress: EgressCapabilities
    /** Has a Linux `/proc` for the agent's processes, and bash. */
    processTable: boolean
    /** How `c.serve` lists what listens in the machine. */
    listeners: ListenerSource
  }
  /** The cell id when `id` is unset. */
  id(sandbox: D): string
  /** The descriptor's host paths, which a declaration written as data makes absolute. */
  hostPaths: Readonly<Record<string, HostPath>>
  /** The most of its machines the host runs at once, and why. */
  hostLimit?: (sandbox: D) => { max: number; why: string }
  /** Boots one machine for an attempt and starts it through `startSandbox`. */
  create(sandbox: D, options: SandboxOptions): Promise<Sandbox>
  /**
   * How many machines the run may have at once, when the provider says, and for a pooled one the
   * attempts its pool runs at once, which is the run's default concurrency.
   */
  capacity?(sandbox: D): Promise<{ machines: number; attempts?: number } | null>
  /** Removes the run's machines: for `sandboxes`, or wherever it can look without them. */
  cleanupRun(runId: string, sandboxes?: readonly D[]): Promise<void>
  /**
   * Pools its machines in the run's main process (machine-service.ts): the attempts on sandboxes
   * with the same `key` share one pool, which `open` makes, and its start rate.
   */
  pool?: { key(sandbox: D, image?: unknown): string; open: OpenPool<D> }
}

/**
 * The kinds entry of a machine provider. Every machine is apart from the host, gets the harness a
 * session, keeps brokered values out behind the gateway and is checked in preflight; none starts
 * from an image preflight builds or runs a plugin's `build`.
 */
export function kindOf<D extends MachineDescriptor>(machine: MachineProvider<D>): SandboxKind<D> {
  const { capacity } = machine
  return {
    helpers: machine.helpers,
    ...(machine.internal && { internal: true as const }),
    capabilities: {
      platform: machine.os,
      ...machine.capabilities,
      brokers: true,
      harnessSession: true,
      isolated: true,
      images: false,
      preflight: true,
      pluginBuilds: false,
    },
    provider: () => machine.kind,
    id: (s) => machine.id(s),
    hostPaths: machine.hostPaths,
    buildsAtStart: () => true,
    ...(machine.hostLimit && { hostLimit: machine.hostLimit }),
    privileges: () => ({ root: false, capabilities: [] }),
    create: (s, o) => machine.create(s, o),
    ...(capacity && {
      async capacity(sandbox: D) {
        const free = await capacity.call(machine, sandbox)
        if (free === null) return null
        const machines = Math.max(1, free.machines)
        return {
          cpus: machines,
          memoryBytes: machines * 1e9,
          ...(free.attempts && { attempts: free.attempts }),
        }
      },
    }),
    cleanupRun: (runId, sandboxes) => machine.cleanupRun(runId, sandboxes),
    ...(machine.cleanupScope && { cleanupScope: machine.cleanupScope }),
    ...(machine.credentials && { credentials: machine.credentials }),
    ...(machine.doctor && { doctor: machine.doctor }),
    ...(machine.planWarnings && { planWarnings: machine.planWarnings }),
    ...(machine.attemptCap && { attemptCap: machine.attemptCap }),
    ...(machine.slotsPerMachine && { slotsPerMachine: machine.slotsPerMachine }),
    ...(machine.notHosted && { notHosted: machine.notHosted }),
  }
}
