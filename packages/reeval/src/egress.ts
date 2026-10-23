// Egress policies as the plan sees them: which one an attempt runs under, the hosts a restricted
// one allows on its own, and whether its sandbox can enforce it.
import { isIP } from 'node:net'
import {
  DOCKER_EGRESS,
  type EgressCapabilities,
  HARNESS_HOSTS,
  type NetworkPolicy,
  PACKAGE_HOSTS,
} from '@reeval/sandbox-docker'
import { localPluginServers } from './environment/plugins.ts'
import { plannedSecrets } from './environment.ts'
import type { VertexSettings } from './gateway/vertex.ts'
import { agentFor, isAgentKind } from './harness/agents.ts'
import { FAKE_EGRESS } from './sandbox/fake.ts'
import type {
  EgressPolicy,
  EnvironmentLayer,
  EnvVars,
  HarnessDescriptor,
  PlannedEgress,
  SandboxDescriptor,
} from './types.ts'
import { isCI } from './ui/mode.ts'

/**
 * The package registries and GitHub, to spread into an allowlist that still installs:
 * `egress: { allow: [...DEFAULT_EGRESS_ALLOW, 'api.example.com'] }`.
 */
export const DEFAULT_EGRESS_ALLOW: readonly string[] = PACKAGE_HOSTS

/** What each sandbox kind can do about egress, as its provider declares it. */
export const SANDBOX_EGRESS: Record<SandboxDescriptor['kind'], EgressCapabilities> = {
  docker: DOCKER_EGRESS,
  fake: FAKE_EGRESS,
}

/** The policy an attempt runs under when nothing sets one. */
export const DEFAULT_EGRESS: EgressPolicy = 'proxy'

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
 * The policy an attempt runs under, and the hosts a restricted one allows on its own: the
 * harness's, the brokered secrets' `hosts` and the MCP servers'. The cascade is config and
 * profile defaults (`inherited`), then the environment's layers, then groups and the eval (`own`).
 */
export function plannedEgress(
  egress: { inherited?: EgressPolicy; own?: EgressPolicy },
  harness: HarnessDescriptor,
  env: EnvVars,
  layers: readonly EnvironmentLayer[],
  vertex?: VertexSettings,
): PlannedEgress {
  const fromLayers = layers.findLast((l) => l.spec.egress !== undefined)?.spec.egress
  const policy = egress.own ?? fromLayers ?? egress.inherited ?? DEFAULT_EGRESS
  if (!isRestricted(policy)) return { policy, auto: [] }
  const own = policy === 'deny-all' ? [] : policy.allow
  const auto = [
    ...harnessHosts(harness, vertex),
    ...plannedSecrets(env, layers).flatMap((s) => s.hosts ?? []),
    ...mcpServerHosts(layers),
  ]
  return { policy, auto: [...new Set(auto)].filter((h) => !own.includes(h)) }
}

/** Every host a restricted policy lets through, or null under `proxy` and `allow-all`. */
export function allowedHosts({ policy, auto }: PlannedEgress): string[] | null {
  if (!isRestricted(policy)) return null
  return [...new Set([...(policy === 'deny-all' ? [] : policy.allow), ...auto])]
}

/**
 * The policy the Docker sandbox's gateway enforces: `allow-all` under `proxy` and `allow-all`
 * (whether the container also keeps its network is {@link isDirect}), `deny-all` when a
 * restricted policy allows no host at all, else an allowlist. A listed IP address is an allowed
 * range too, since the gateway reaches a private address only through one.
 */
export function gatewayPolicy(planned: PlannedEgress): NetworkPolicy {
  const hosts = allowedHosts(planned)
  if (hosts === null) return { mode: 'allow-all' }
  if (!hosts.length) return { mode: 'deny-all' }
  const cidrs = hosts.filter((h) => isIP(h)).map((h) => `${h}/${isIP(h) === 6 ? 128 : 32}`)
  return { mode: 'custom', allowedHosts: hosts, ...(cidrs.length ? { allowedCIDRs: cidrs } : {}) }
}

/** What enforcing the policy takes: nothing, turning egress off, or a host allowlist. */
export function egressNeeds(planned: PlannedEgress): EgressCapabilities['enforce'] {
  if (!isRestricted(planned.policy)) return 'none'
  return allowedHosts(planned)?.length ? 'allowlist' : 'all-or-nothing'
}

const LEVELS: EgressCapabilities['enforce'][] = ['none', 'all-or-nothing', 'allowlist']

/** Why the sandbox can't enforce the attempt's policy, or undefined when it can. */
export function unenforceable(
  planned: PlannedEgress,
  sandbox: SandboxDescriptor,
  where: string,
): string | undefined {
  const needs = egressNeeds(planned)
  const can = SANDBOX_EGRESS[sandbox.kind].enforce
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
  const hint =
    sandbox.kind === 'fake'
      ? " (its commands run on the host). Run it in docker(), or set egress: 'allow-all'"
      : ''
  return `${where} runs under egress ${describeEgress(planned.policy)}, which needs ${what}, but the ${sandbox.kind} sandbox ${enforces}${hint}.`
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

/** `deny-all + auto: api2.cursor.sh, …` or `allow-all` for the plan; '' under `proxy`, the default. */
export function egressLabel({ policy, auto }: PlannedEgress): string {
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
