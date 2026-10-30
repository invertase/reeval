import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import type { HarnessV1NetworkPolicy } from '@ai-sdk/harness'
import type { BakedHarness } from '../image.ts'

export type NetworkPolicy = HarnessV1NetworkPolicy

export type Lookup = (host: string) => Promise<string[]>

/**
 * What a sandbox provider can do about egress. `enforce`: nothing (`none`), `allow-all` or
 * `deny-all` only (`all-or-nothing`), or a host allowlist too (`allowlist`). `record`: whether
 * it reports the hosts the sandbox contacted and was refused.
 */
export type EgressCapabilities = {
  enforce: 'none' | 'all-or-nothing' | 'allowlist'
  record: boolean
}

/** The Docker sandbox enforces every policy through its egress gateway, and records what passes. */
export const DOCKER_EGRESS: EgressCapabilities = { enforce: 'allowlist', record: true }

/** The hosts each harness's CLI talks to at runtime. */
export const HARNESS_HOSTS: Record<BakedHarness, readonly string[]> = {
  // The agent backend only: the adapter fetches the model catalog on the host, so the sandbox
  // never needs api.cursor.com.
  cursor: ['api2.cursor.sh', '*.cursor.sh'],
  'claude-code': ['api.anthropic.com', '*.anthropic.com'],
  // The Gemini API only: with a Gemini API key the CLI needs no Google sign-in hosts, and its
  // auto-updater is off.
  antigravity: ['generativelanguage.googleapis.com'],
  // On Google, and Exa's hosted MCP server, where the adapter points its websearch tool
  // (keyless). reeval allows the model's provider's hosts instead of Google's.
  opencode: ['generativelanguage.googleapis.com', 'mcp.exa.ai'],
  goose: ['generativelanguage.googleapis.com'],
  pi: ['generativelanguage.googleapis.com'],
  // The Responses API only, with analytics and the plugin sync off.
  codex: ['api.openai.com'],
  // AI Gateway, for a gateway model id; a bare OpenAI id gets OpenAI's API instead.
  fx: ['ai-gateway.vercel.sh'],
  // The xAI API only, with telemetry, feedback, remote config and the auto-updater off.
  'grok-build': ['api.x.ai'],
}

/** The package registries and GitHub, for a restricted policy that still installs. */
export const PACKAGE_HOSTS: readonly string[] = Object.freeze([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
])

/**
 * The harness's own hosts plus `PACKAGE_HOSTS`. Only that harness's hosts: a Cursor attempt
 * can't reach Anthropic.
 */
export const defaultAllowedHosts = (harness: BakedHarness) => [
  ...HARNESS_HOSTS[harness],
  ...PACKAGE_HOSTS,
]

/**
 * Never reachable through the gateway, whatever the policy: the worker's own loopback (the
 * container's `localhost` is its own) and link-local addresses such as cloud metadata. A
 * connection to an unspecified address (`0.0.0.0`, `::`) reaches the local host too.
 */
const ALWAYS_DENIED = [
  '127.0.0.0/8',
  '169.254.0.0/16',
  '0.0.0.0/8',
  '::/128',
  '::1/128',
  'fe80::/10',
]

export const isRestricted = (policy: NetworkPolicy) => policy.mode !== 'allow-all'

export type Verdict =
  | { allowed: true; address: string }
  | { allowed: false; reason: string; status: 403 }
  /** The name didn't resolve: no policy refused it. */
  | { allowed: false; reason: string; status: 502; unresolved: true }

const blockList = (cidrs: readonly string[] = []) => {
  const list = new BlockList()
  for (const cidr of cidrs) {
    const [net = '', prefix] = cidr.split('/')
    const type = isIP(net) === 6 ? 'ipv6' : 'ipv4'
    list.addSubnet(net, Number(prefix ?? (type === 'ipv6' ? 128 : 32)), type)
  }
  return list
}

const inList = (list: BlockList, address: string) => {
  const v = isIP(address)
  return v !== 0 && list.check(address, v === 6 ? 'ipv6' : 'ipv4')
}

const normalize = (host: string) =>
  host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')

/**
 * Private, carrier-grade NAT and unique-local ranges: a name matched only by a `*.` pattern
 * mustn't resolve into them, or anyone who can add a DNS record under the pattern's domain
 * reaches the worker's LAN.
 */
const PRIVATE_RANGES = [
  '10.0.0.0/8',
  '100.64.0.0/10',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
]
const PRIVATE = blockList(PRIVATE_RANGES)

/**
 * Reachable only with an `allowedCIDRs` entry that covers them, so never under allow-all: the
 * gateway connects from the worker, so these would reach its LAN, the Docker host's bridge, cloud
 * metadata on a unique-local or CGNAT address (AWS's `fd00:ec2::254`, Alibaba's
 * `100.100.100.200`), multicast and broadcast. NAT64 addresses are checked by their embedded
 * IPv4 address as well.
 */
const RESERVED = blockList([
  ...PRIVATE_RANGES,
  '224.0.0.0/4',
  '255.255.255.255/32',
  'ff00::/8',
  '64:ff9b::/96',
])

const NAT64 = blockList(['64:ff9b::/96'])

/** The IPv4 address in the last 32 bits of an IPv6 address, as `a.b.c.d`. */
function embeddedIPv4(address: string): string {
  const tail = address.slice(address.lastIndexOf(':') + 1)
  if (isIP(tail) === 4) return tail
  const groups = address.split(':')
  const low = Number.parseInt(groups.at(-1) || '0', 16)
  const high = groups.length > 1 ? Number.parseInt(groups.at(-2) || '0', 16) : 0
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

/** The address, and for a NAT64 address the IPv4 address it reaches too. */
const reaches = (address: string) =>
  isIP(address) === 6 && inList(NAT64, address) ? [address, embeddedIPv4(address)] : [address]

/** How `host` matches: listed as it is, only by a `*.` pattern (never an IP address), or not. */
function hostMatch(patterns: readonly string[], host: string): 'exact' | 'wildcard' | undefined {
  const h = normalize(host)
  const ps = patterns.map(normalize)
  if (ps.includes(h)) return 'exact'
  // No top-level domain is numeric: such a host is an IP address, maybe in a short form like 10.1.
  if (isIP(h) || /(?:^|\.)\d+$/.test(h)) return undefined
  return ps.some((p) => p.startsWith('*.') && h.endsWith(p.slice(1))) ? 'wildcard' : undefined
}

/** `*.example.com` matches any subdomain of example.com, not example.com itself or an IP. */
export const hostAllowed = (patterns: readonly string[], host: string) =>
  hostMatch(patterns, host) !== undefined

const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address)

export type PolicyOptions = { lookup?: Lookup; allowLoopback?: boolean }

/**
 * Decides whether `host` may be reached and which address to connect to. The gateway connects
 * to the address it checked, so a DNS answer can't change between the check and the connect.
 */
export function createPolicyCheck(policy: NetworkPolicy, options: PolicyOptions = {}) {
  const lookup = options.lookup ?? defaultLookup
  const always = blockList(options.allowLoopback ? [] : ALWAYS_DENIED)
  const custom = policy.mode === 'custom' ? policy : undefined
  const allowedCidrs = blockList(custom?.allowedCIDRs)
  const deniedCidrs = blockList(custom?.deniedCIDRs)

  return async (rawHost: string): Promise<Verdict> => {
    const host = normalize(rawHost)
    if (policy.mode === 'deny-all') {
      return { allowed: false, status: 403, reason: 'the policy denies all egress' }
    }
    // Refused before any DNS lookup, so an unlisted name is never resolved on the agent's behalf:
    // the lookup alone would carry data out. Allowed CIDRs match IP addresses only.
    const listed = hostMatch(custom?.allowedHosts ?? [], host)
    if (custom && !listed && !(custom.allowedCIDRs?.length && isIP(host))) {
      return { allowed: false, status: 403, reason: `${host} isn't in the allowlist` }
    }
    let addresses: string[]
    try {
      addresses = isIP(host) ? [host] : await lookup(host)
    } catch (error) {
      return {
        allowed: false,
        status: 502,
        unresolved: true,
        reason: `can't resolve ${host}: ${(error as Error).message}`,
      }
    }
    const first = addresses[0]
    if (!first) {
      return { allowed: false, status: 502, unresolved: true, reason: `${host} has no addresses` }
    }
    const reached = addresses.flatMap(reaches)
    if (reached.some((a) => inList(always, a))) {
      return { allowed: false, status: 403, reason: `${host} is a loopback or link-local address` }
    }
    const reserved = reached.find((a) => inList(RESERVED, a) && !inList(allowedCidrs, a))
    if (reserved) {
      const which = reserved === host ? host : `${host} (${reserved})`
      return {
        allowed: false,
        status: 403,
        reason: custom
          ? `${which} is a private or reserved address; list the address itself in the allowlist to reach it`
          : `${which} is a private or reserved address, which allow-all doesn't reach; list the address in an allowlist to reach it`,
      }
    }
    if (!custom) return { allowed: true, address: first }
    if (reached.some((a) => inList(deniedCidrs, a))) {
      return { allowed: false, status: 403, reason: `${host} is in a denied range` }
    }
    if (listed === 'wildcard' && addresses.some((a) => inList(PRIVATE, a))) {
      return {
        allowed: false,
        status: 403,
        reason: `${host} resolves to a private address, which a *. pattern doesn't allow; list the host itself`,
      }
    }
    if (listed) return { allowed: true, address: first }
    if (custom.allowedCIDRs?.length && addresses.every((a) => inList(allowedCidrs, a))) {
      return { allowed: true, address: first }
    }
    return { allowed: false, status: 403, reason: `${host} isn't in the allowlist` }
  }
}
