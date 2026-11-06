// The machine providers reeval has: Tart's macOS VMs and Boat's Linux VMs. Each loads its own
// modules only when asked, so the kinds table stays cheap to import.
import type { EgressCapabilities } from '@reeval/sandbox-docker'
import { tartVmLimit } from '../contract/tart.ts'
import type { BoatSandboxDescriptor, TartSandboxDescriptor } from '../types.ts'
import { idPart } from './kinds.ts'
import type { MachineProvider } from './machine.ts'
import { boatProvider, tartProvider } from './providers.ts'
import type { TartTarget } from './tart-cli.ts'
import { tartTagWarning } from './tart-ref.ts'

/**
 * A Tart VM keeps Tart's network, so nothing it sends around the gateway's proxy is refused or
 * recorded; what goes through the proxy is. Its one policy holds for the whole attempt.
 */
const TART_EGRESS: EgressCapabilities = { enforce: 'none', record: true, switches: false }

export const TART_MACHINE: MachineProvider<TartSandboxDescriptor> = {
  kind: 'tart',
  helpers: ['tart'],
  os: 'darwin',
  capabilities: { egress: TART_EGRESS, processTable: false, listeners: 'lsof' },
  id: (s) => `tart:${idPart(s.image)}`,
  hostPaths: { 'ssh.key': 'file' },
  hostLimit: tartVmLimit,
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
  prepare: (o) => tartProvider(o),
  // This machine is cleaned up without a descriptor; other Macs only once the plan names them.
  cleanupScope: (s) => (s.hosts ? { key: JSON.stringify(s.hosts), atStart: false } : null),
  planWarnings(s) {
    const tag = tartTagWarning(s.image)
    return tag ? [tag] : []
  },
  attemptCap: (s) =>
    s.hosts
      ? async ({ harness, root, runId }) => {
          const { preparedFor } = await import('./preflight.ts')
          const { createProviders, preparedHosts } = await import('./providers.ts')
          const provider = createProviders().tart
          if (!provider) return null
          try {
            const prepared = preparedFor(root, runId, provider, s, harness)
            const hosts = prepared ? preparedHosts(prepared) : null
            return hosts ? hosts.reduce((sum, h) => sum + h.vms, 0) : null
          } catch {
            // A sandbox that failed to prepare fails in the attempt, which reads it again.
            return null
          }
        }
      : null,
}

/**
 * Enforces nothing yet: the VM keeps its own network, so only `allow-all` plans on it, for the
 * whole attempt. The gateway still brokers credentials and records what goes through it.
 */
const BOAT_EGRESS: EgressCapabilities = { enforce: 'none', record: true, switches: false }

export const BOAT_MACHINE: MachineProvider<BoatSandboxDescriptor> = {
  kind: 'boat',
  helpers: ['boat'],
  os: 'linux',
  capabilities: { egress: BOAT_EGRESS, processTable: true, listeners: 'proc' },
  id: (s) => (s.type ? `boat:${s.type}` : 'boat'),
  hostPaths: {},
  async create(sandbox, options) {
    const { createBoatSandbox } = await import('./boat.ts')
    return createBoatSandbox(sandbox, options)
  },
  async capacity(sandbox) {
    const { boatCapacity } = await import('./boat.ts')
    const free = await boatCapacity(sandbox)
    return free === null ? null : { machines: free }
  },
  async cleanupRun(runId, sandboxes) {
    // Without the run's descriptors there's no key or prefix to look under; each sandbox's TTL
    // is the backstop.
    if (!sandboxes?.length) return
    const { removeRunSandboxes } = await import('./boat.ts')
    await removeRunSandboxes(runId, sandboxes)
  },
  prepare: () => boatProvider(),
  // A run's VMs are found only under a descriptor's account and prefix.
  cleanupScope: (s) => ({ key: JSON.stringify(s), atStart: true }),
  credentials: (s) => [{ names: [s.apiKey.from], line: `${s.apiKey.from} (for boat())` }],
  async doctor(sandboxes, ctx) {
    const { boatDoctor } = await import('./boat.ts')
    return boatDoctor(sandboxes, ctx)
  },
}

/** Every machine provider, which `createProviders` makes the run's prepare providers from. */
export const MACHINE_PROVIDERS = [TART_MACHINE, BOAT_MACHINE] as const
