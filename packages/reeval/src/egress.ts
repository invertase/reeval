// Egress policies as the plan sees them: which one an attempt runs under, the hosts a restricted
// one allows on its own, and whether its sandbox can enforce it.
import {
  DOCKER_EGRESS,
  type EgressCapabilities,
  HARNESS_HOSTS,
  PACKAGE_HOSTS,
} from '@reeval/sandbox-docker'
import { plannedSecrets } from './environment.ts'
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

export const isRestricted = (policy: EgressPolicy) => policy !== 'allow-all'

/**
 * The hosts the harness needs: a real agent's own API (its model's provider's, for OpenCode), or
 * a fake agent's with `layout` (it behaves like that agent). A plain fake agent talks to nothing.
 */
function harnessHosts(harness: HarnessDescriptor): readonly string[] {
  if (harness.kind !== 'fake' && isAgentKind(harness.kind)) {
    return agentFor(harness).hosts ?? HARNESS_HOSTS[harness.kind]
  }
  return harness.kind === 'fake' && harness.layout ? HARNESS_HOSTS[harness.layout] : []
}

/** MCP `http`/`sse` servers' hosts: the agent connects to them from the sandbox. */
function mcpServerHosts(layers: readonly EnvironmentLayer[]): string[] {
  const urls = new Map<string, string>()
  for (const { spec } of layers) {
    for (const [name, server] of Object.entries(spec.mcp ?? {})) {
      if (server.transport === 'stdio') urls.delete(name)
      else urls.set(name, server.url)
    }
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
): PlannedEgress {
  const fromLayers = layers.findLast((l) => l.spec.egress !== undefined)?.spec.egress
  const policy = egress.own ?? fromLayers ?? egress.inherited ?? 'allow-all'
  if (!isRestricted(policy)) return { policy, auto: [] }
  const own = policy === 'deny-all' ? [] : policy.allow
  const auto = [
    ...harnessHosts(harness),
    ...plannedSecrets(env, layers).flatMap((s) => s.hosts ?? []),
    ...mcpServerHosts(layers),
  ]
  return { policy, auto: [...new Set(auto)].filter((h) => !own.includes(h)) }
}

/** Every host a restricted policy lets through, or null under `allow-all`. */
export function allowedHosts({ policy, auto }: PlannedEgress): string[] | null {
  if (!isRestricted(policy)) return null
  return [...new Set([...(policy === 'deny-all' ? [] : policy.allow), ...auto])]
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

/** `deny-all + auto: api2.cursor.sh, …` for the plan; '' under `allow-all`. */
export function egressLabel({ policy, auto }: PlannedEgress): string {
  if (!isRestricted(policy)) return ''
  const own =
    policy === 'deny-all'
      ? 'deny-all'
      : policy.allow.length
        ? `allow ${policy.allow.join(', ')}`
        : 'allow none'
  return auto.length ? `${own} + auto: ${auto.join(', ')}` : own
}
