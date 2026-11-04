// Egress policies as the plan sees them: which one an attempt runs under, the hosts a restricted
// one allows on its own, and whether its sandbox can enforce it.
import { isIP } from 'node:net'
import {
  type EgressCapabilities,
  HARNESS_HOSTS,
  type NetworkPolicy,
  PACKAGE_HOSTS,
} from '@reeval/sandbox-docker'
import { localPluginServers } from './environment/plugins.ts'
import { plannedSecrets } from './environment.ts'
import type { VertexSettings } from './gateway/vertex.ts'
import { agentFor, isAgentKind } from './harness/agents.ts'
import { capabilitiesOf, SANDBOX_KINDS, suggestedSandbox } from './sandbox/kinds.ts'
import type {
  Egress,
  EgressPolicy,
  EnvironmentLayer,
  EnvVars,
  HarnessDescriptor,
  PhasedEgress,
  PlannedEgress,
  PlannedPhaseEgress,
  SandboxDescriptor,
} from './types.ts'
import { isCI } from './ui/mode.ts'

/**
 * The package registries and GitHub, to spread into an allowlist that still installs:
 * `egress: { allow: [...DEFAULT_EGRESS_ALLOW, 'api.example.com'] }`.
 */
export const DEFAULT_EGRESS_ALLOW: readonly string[] = PACKAGE_HOSTS

/** What each sandbox kind can do about egress, as its provider declares it. */
export const SANDBOX_EGRESS = Object.fromEntries(
  Object.entries(SANDBOX_KINDS).map(([kind, k]) => [kind, k.capabilities.egress]),
) as Record<SandboxDescriptor['kind'], EgressCapabilities>

/** The policy an attempt runs under when nothing sets one. */
export const DEFAULT_EGRESS: EgressPolicy = 'proxy'

/** The phases an attempt's egress can set a policy for. */
export type EgressPhase = 'setup' | 'agent'

/** Whether `egress` sets a policy per phase, `{ setup, agent }`, rather than one for both. */
export const isPhased = (egress: Egress): egress is PhasedEgress =>
  typeof egress === 'object' && !('allow' in egress)

/** The policy `egress` sets for `phase`: a plain policy sets both; undefined when it sets none. */
const phaseOf = (egress: Egress | undefined, phase: EgressPhase): EgressPolicy | undefined =>
  egress === undefined ? undefined : isPhased(egress) ? egress[phase] : egress

/**
 * `over` set at the same level as `under`, later: a plain policy replaces both phases,
 * `{ setup, agent }` only the phases it names.
 */
export function layerEgress(under: Egress | undefined, over: Egress): Egress {
  if (!isPhased(over)) return over
  const setup = over.setup ?? phaseOf(under, 'setup')
  const agent = over.agent ?? phaseOf(under, 'agent')
  return {
    ...(setup !== undefined ? { setup } : {}),
    ...(agent !== undefined ? { agent } : {}),
  }
}

/** Each phase's policy `egress` sets, the default where it sets none. */
export const phasePolicies = (egress: Egress): Record<EgressPhase, EgressPolicy> => ({
  setup: phaseOf(egress, 'setup') ?? DEFAULT_EGRESS,
  agent: phaseOf(egress, 'agent') ?? DEFAULT_EGRESS,
})

/** `egress` planned with no automatic hosts: what a config-level check can tell of it. */
export function bareEgress(egress: Egress): PlannedEgress {
  const { setup, agent } = phasePolicies(egress)
  return samePolicy(setup, agent)
    ? { policy: agent, auto: [] }
    : { policy: agent, auto: [], setup: { policy: setup, auto: [] } }
}

const policyKey = (p: EgressPolicy) =>
  typeof p === 'string' ? p : JSON.stringify([...new Set(p.allow)].sort())
const samePolicy = (a: EgressPolicy, b: EgressPolicy) => policyKey(a) === policyKey(b)

/** The setup phase's planned policy: its own when it differs from the agent's. */
export const setupEgress = (planned: PlannedEgress): PlannedPhaseEgress => planned.setup ?? planned

/** Whether the policy allows only some hosts: `deny-all` and allowlists. */
export const isRestricted = (policy: EgressPolicy) => policy !== 'allow-all' && policy !== 'proxy'

/**
 * Whether traffic can leave around the gateway: under `allow-all` the container keeps its network,
 * so whatever ignores the proxy goes out directly, unfiltered and unrecorded.
 */
export const isDirect = (policy: EgressPolicy) => policy === 'allow-all'

/**
 * The hosts the harness needs: a real agent's own API (its model's provider's, for OpenCode), or
 * a fake agent's with `layout` (it behaves like that agent). A plain fake agent talks to nothing.
 */
function harnessHosts(harness: HarnessDescriptor, vertex?: VertexSettings): readonly string[] {
  if (harness.kind !== 'fake' && isAgentKind(harness.kind)) {
    return agentFor(harness, vertex).hosts ?? HARNESS_HOSTS[harness.kind]
  }
  return harness.kind === 'fake' && harness.layout ? HARNESS_HOSTS[harness.layout] : []
}

/** MCP `http`/`sse` servers' hosts, local plugins' included: the agent connects to them from the sandbox. */
function mcpServerHosts(layers: readonly EnvironmentLayer[]): string[] {
  const urls = new Map<string, string>()
  for (const { spec } of layers) {
    for (const [name, server] of Object.entries(spec.mcp ?? {})) {
      if (server.transport === 'stdio') urls.delete(name)
      else urls.set(name, server.url)
    }
  }
  for (const [name, server] of localPluginServers(layers)) {
    if (server.transport !== 'stdio') urls.set(name, server.url)
  }
  return [...urls.values()].flatMap((url) => URL.parse(url)?.hostname ?? [])
}

/**
 * The policy each phase of an attempt runs under, and the hosts a restricted one allows on its
 * own: the harness's, the brokered secrets' `hosts` and the MCP servers'. Each phase cascades on
 * its own: config and profile defaults (`inherited`), then the environment's layers, then groups
 * and the eval (`own`). `setup` is set only when the setup phase's policy differs from the agent's.
 */
export function plannedEgress(
  egress: { inherited?: Egress; own?: Egress },
  harness: HarnessDescriptor,
  env: EnvVars,
  layers: readonly EnvironmentLayer[],
  vertex?: VertexSettings,
): PlannedEgress {
  const pick = (phase: EgressPhase) =>
    phaseOf(egress.own, phase) ??
    layers.map((l) => phaseOf(l.spec.egress, phase)).findLast((p) => p !== undefined) ??
    phaseOf(egress.inherited, phase) ??
    DEFAULT_EGRESS
  const phase = (policy: EgressPolicy): PlannedPhaseEgress => {
    if (!isRestricted(policy)) return { policy, auto: [] }
    const own = policy === 'deny-all' ? [] : policy.allow
    const auto = [
      ...harnessHosts(harness, vertex),
      ...plannedSecrets(env, layers).flatMap((s) => s.hosts ?? []),
      ...mcpServerHosts(layers),
    ]
    return { policy, auto: [...new Set(auto)].filter((h) => !own.includes(h)) }
  }
  const agent = phase(pick('agent'))
  const setup = pick('setup')
  return samePolicy(setup, agent.policy) ? agent : { ...agent, setup: phase(setup) }
}

/** Every host a restricted policy lets through, or null under `proxy` and `allow-all`. */
export function allowedHosts({ policy, auto }: PlannedPhaseEgress): string[] | null {
  if (!isRestricted(policy)) return null
  return [...new Set([...(policy === 'deny-all' ? [] : policy.allow), ...auto])]
}

/**
 * The policy the Docker sandbox's gateway enforces: `allow-all` under `proxy` and `allow-all`
 * (whether the container also keeps its network is {@link isDirect}), `deny-all` when a
 * restricted policy allows no host at all, else an allowlist. A listed IP address is an allowed
 * range too, since the gateway reaches a private address only through one.
 */
export function gatewayPolicy(planned: PlannedPhaseEgress): NetworkPolicy {
  const hosts = allowedHosts(planned)
  if (hosts === null) return { mode: 'allow-all' }
  if (!hosts.length) return { mode: 'deny-all' }
  const cidrs = hosts.filter((h) => isIP(h)).map((h) => `${h}/${isIP(h) === 6 ? 128 : 32}`)
  return { mode: 'custom', allowedHosts: hosts, ...(cidrs.length ? { allowedCIDRs: cidrs } : {}) }
}

/** What enforcing the policy takes: nothing, turning egress off, or a host allowlist. */
export function egressNeeds(planned: PlannedPhaseEgress): EgressCapabilities['enforce'] {
  if (!isRestricted(planned.policy)) return 'none'
  return allowedHosts(planned)?.length ? 'allowlist' : 'all-or-nothing'
}

const LEVELS: EgressCapabilities['enforce'][] = ['none', 'all-or-nothing', 'allowlist']

/** Why the sandbox can't enforce the attempt's policies, or undefined when it can. */
export function unenforceable(
  planned: PlannedEgress,
  sandbox: SandboxDescriptor,
  where: string,
): string | undefined {
  if (!planned.setup) return unenforceablePhase(planned, sandbox, where, 'egress')
  if (!capabilitiesOf(sandbox).egress.switches) {
    return `${where} runs under egress ${describeEgress(planned.setup.policy)} for setup and ${describeEgress(planned.policy)} for the agent, but the ${sandbox.kind} sandbox can't change its egress policy during an attempt. Give both phases one policy, or run it in ${suggestedSandbox((c) => c.isolated && c.egress.switches)}.`
  }
  return (
    unenforceablePhase(planned.setup, sandbox, where, 'egress.setup') ??
    unenforceablePhase(planned, sandbox, where, 'egress.agent')
  )
}

function unenforceablePhase(
  planned: PlannedPhaseEgress,
  sandbox: SandboxDescriptor,
  where: string,
  key: string,
): string | undefined {
  const capabilities = capabilitiesOf(sandbox)
  const can = capabilities.egress.enforce
  // `proxy` promises the gateway is the only way out, which a sandbox of its own that enforces
  // nothing can't keep; on the host (the fake sandbox) there's no way out to close.
  if (planned.policy === 'proxy' && capabilities.isolated && can === 'none') {
    return `${where} runs under ${key} 'proxy', where the egress gateway is the only way out, but the ${sandbox.kind} sandbox enforces no egress policy: its traffic that ignores the proxy goes out directly. Set ${key}: 'allow-all' to run it there, or run it in ${suggestedSandbox((c) => c.isolated && c.egress.enforce !== 'none')}.`
  }
  const needs = egressNeeds(planned)
  if (LEVELS.indexOf(can) >= LEVELS.indexOf(needs)) return undefined
  const hosts = allowedHosts(planned)?.join(', ')
  const what =
    needs !== 'allowlist'
      ? 'turning egress off'
      : planned.policy === 'deny-all'
        ? `a host allowlist for its automatic hosts (${hosts})`
        : `a host allowlist (${hosts})`
  const enforces =
    can === 'none'
      ? 'enforces no egress policy'
      : `only enforces ${can === 'all-or-nothing' ? "'allow-all' or 'deny-all'" : can}`
  const enforcing = suggestedSandbox(
    (c) => LEVELS.indexOf(c.egress.enforce) >= LEVELS.indexOf(needs),
  )
  const hint = capabilities.isolated
    ? ''
    : ` (its commands run on the host). ${enforcing ? `Run it in ${enforcing}, or set` : 'Set'} ${key}: 'allow-all'`
  return `${where} runs under ${key} ${describeEgress(planned.policy)}, which needs ${what}, but the ${sandbox.kind} sandbox ${enforces}${hint}.`
}

const describeEgress = (policy: EgressPolicy) =>
  typeof policy === 'string'
    ? `'${policy}'`
    : `{ allow: [${policy.allow.map((h) => `'${h}'`).join(', ')}] }`

/** A CI runner as the environment names it, which usually runs on a cloud VM; null elsewhere. */
export function ciRunner(env: NodeJS.ProcessEnv): string | null {
  if (env.GITHUB_ACTIONS === 'true') return 'a GitHub Actions runner (GITHUB_ACTIONS)'
  if (env.GITLAB_CI) return 'a GitLab CI runner (GITLAB_CI)'
  if (env.BUILDKITE) return 'a Buildkite agent (BUILDKITE)'
  if (env.CIRCLECI) return 'a CircleCI runner (CIRCLECI)'
  return isCI(env) ? 'a CI runner (CI)' : null
}

/**
 * What `allow-all` exposes on a cloud VM or CI runner (`where`): the container keeps its network,
 * so anything in it reaches cloud metadata and the host's network around the gateway.
 */
export const directOnCloud = (where: string) =>
  `egress 'allow-all' on ${where}: anything in the sandbox can reach the cloud metadata service (169.254.169.254, which hands out the machine's credentials), the host's network and its services around the egress gateway, unfiltered and unrecorded`

/**
 * What running attempts with a setup policy of their own (`ids`) side by side on rootless Podman
 * risks: a container leaving Podman's bridge, as one does at the switch, can cut the others on it
 * off from the host for seconds.
 */
export const rootlessPodmanSwitch = (ids: readonly string[]) =>
  `phased egress on rootless Podman: at the switch to the agent's policy an attempt's container leaves Podman's bridge network, which can cut the other containers on it off from the host for seconds, failing their direct connections (allow-all, and setup steps under it). Under it: ${ids.join(', ')}. Run with --concurrency 1, or on docker(), when those connections matter`

/**
 * `deny-all + auto: api2.cursor.sh, …` or `allow-all` for the plan; '' under `proxy`, the default.
 * With a setup policy of its own, `setup allow-all · agent deny-all + auto: …`.
 */
export function egressLabel(planned: PlannedEgress): string {
  if (!planned.setup) return phaseLabel(planned)
  return `setup ${phaseLabel(planned.setup) || 'proxy'} · agent ${phaseLabel(planned) || 'proxy'}`
}

/** {@link egressLabel} without the automatic hosts, which {@link autoHosts} lists. */
export function ownEgressLabel(planned: PlannedEgress): string {
  const own = (p: PlannedPhaseEgress) => ({ ...p, auto: [] })
  return egressLabel({ ...own(planned), ...(planned.setup ? { setup: own(planned.setup) } : {}) })
}

/** The hosts reeval allows on top of the policy, in either phase. */
export const autoHosts = (planned: PlannedEgress): string[] => [
  ...new Set([...(planned.setup?.auto ?? []), ...planned.auto]),
]

/** One phase's policy and automatic hosts, or `''` for the default, `proxy`. */
export function phaseLabel({ policy, auto }: PlannedPhaseEgress): string {
  if (policy === 'proxy') return ''
  if (policy === 'allow-all') return 'allow-all'
  const own =
    policy === 'deny-all'
      ? 'deny-all'
      : policy.allow.length
        ? `allow ${policy.allow.join(', ')}`
        : 'allow none'
  return auto.length ? `${own} + auto: ${auto.join(', ')}` : own
}
