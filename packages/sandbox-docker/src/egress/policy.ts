import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import type { HarnessV1NetworkPolicy } from '@ai-sdk/harness'
import type { BakedHarness } from '../image.ts'

export type NetworkPolicy = HarnessV1NetworkPolicy

export type Lookup = (host: string) => Promise<string[]>

/** The hosts each harness's CLI talks to at runtime. */
export const HARNESS_HOSTS: Record<BakedHarness, readonly string[]> = {
  cursor: ['api2.cursor.sh', '*.cursor.sh', 'cursor.com', '*.cursor.com'],
  'claude-code': ['api.anthropic.com', '*.anthropic.com'],
}

/**
 * The harness's own hosts plus the package registries and GitHub, for a restricted policy that
 * still installs. Only that harness's hosts: a Cursor attempt can't reach Anthropic.
 */
export const defaultAllowedHosts = (harness: BakedHarness) => [
  ...HARNESS_HOSTS[harness],
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
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
  | { allowed: false; reason: string; status: 403 | 502 }

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

const normalise = (host: string) =>
  host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')

/** `*.example.com` matches any subdomain of example.com, not example.com itself. */
export function hostAllowed(patterns: readonly string[], host: string): boolean {
  const h = normalise(host)
  return patterns.some((pattern) => {
    const p = normalise(pattern)
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p
  })
}

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
    const host = normalise(rawHost)
    if (policy.mode === 'deny-all') {
      return { allowed: false, status: 403, reason: 'the policy denies all egress' }
    }
    let addresses: string[]
    try {
      addresses = isIP(host) ? [host] : await lookup(host)
    } catch (error) {
      return {
        allowed: false,
        status: 502,
        reason: `can't resolve ${host}: ${(error as Error).message}`,
      }
    }
    const first = addresses[0]
    if (!first) return { allowed: false, status: 502, reason: `${host} has no addresses` }
    if (addresses.some((a) => inList(always, a))) {
      return { allowed: false, status: 403, reason: `${host} is a loopback or link-local address` }
    }
    if (!custom) return { allowed: true, address: first }
    if (addresses.some((a) => inList(deniedCidrs, a))) {
      return { allowed: false, status: 403, reason: `${host} is in a denied range` }
    }
    if (hostAllowed(custom.allowedHosts ?? [], host)) return { allowed: true, address: first }
    if (custom.allowedCIDRs?.length && addresses.every((a) => inList(allowedCidrs, a))) {
      return { allowed: true, address: first }
    }
    return { allowed: false, status: 403, reason: `${host} isn't in the allowlist` }
  }
}
