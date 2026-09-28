// Writes src/opencode-provider-table.ts from a probe-providers.ts result: each provider whose key
// OpenCode sends in a header on fixed hosts, with the hosts, paths and headers it was seen to
// use, and every other provider with the reason ES refuses it.
//
//   node --experimental-strip-types scripts/provider-table.ts <probe.json> <catalog.json>
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPENCODE_PACKAGE_JSON } from '../src/opencode-install.ts'

const OPENCODE_CLI_VERSION = JSON.parse(OPENCODE_PACKAGE_JSON).dependencies[
  '@opencode/cli'
] as string

type Request = { method: string; host: string; path: string; key: string[]; format?: string }
type Variant = {
  variant: string
  model: string
  exit: number | null
  error: string
  requests: Request[]
}
type Probed = { name?: string; env?: string[]; variants?: Variant[]; skipped?: string }

const [probeFile, catalogFile] = process.argv.slice(2)
if (!probeFile || !catalogFile)
  throw new Error('usage: provider-table.ts <probe.json> <catalog.json>')
const probe = JSON.parse(readFileSync(probeFile, 'utf8')) as Record<string, Probed | Request[]>
const catalog = JSON.parse(readFileSync(catalogFile, 'utf8')) as Record<
  string,
  { models: Record<string, unknown> }
>

/**
 * Why a provider can't run, where the probe can't tell: credentials a gateway can't swap in,
 * or a key that's traded for another token.
 */
const REASONS: Record<string, string> = {
  'amazon-bedrock':
    'its AWS credentials sign each request (SigV4), and its API keys go to a host per AWS region',
  'google-vertex':
    'it takes a service account (Vertex refuses API keys for most models), not a key in a header',
  'github-copilot': 'it runs on a GitHub Copilot subscription, through a GitHub login',
  gitlab: 'it runs on a GitLab Duo subscription, through a GitLab login',
  'sap-ai-core': 'its service key is JSON that OpenCode trades for OAuth tokens',
}

/** The reason for a provider the probe saw fail, from what it said or where it sent the key. */
function reasonFor(id: string, p: Probed): string | undefined {
  if (REASONS[id]) return REASONS[id]
  const errors = (p.variants ?? []).map((v) => v.error).join('\n')
  const requests = (p.variants ?? []).flatMap((v) => v.requests)
  if (/registry\.npmjs\.org/.test(errors)) {
    return 'OpenCode installs its provider package from npm when it starts, so where it sends the key is unknown'
  }
  if (requests.some((r) => /^(127\.|localhost$|0\.0\.0\.0$|\[?::1)/.test(r.host))) {
    return "it runs on your machine, and the sandbox can't reach the host's localhost"
  }
  if (/localhost|127\.0\.0\.1/.test(p.variants?.map((v) => v.variant).join(' ') ?? '')) {
    return "it runs on your machine, and the sandbox can't reach the host's localhost"
  }
  if (
    requests.some((r) => r.key.includes('host') || r.path.includes('<key>')) ||
    /requires (resourceName|accountId)|is required to resolve|Invalid URL|\$\{/.test(errors)
  ) {
    const extra = [
      ...(p.env ?? []).filter((e) => !/(_API_KEY|_TOKEN|_APIKEY|_PAT)$/.test(e)),
      ...[...errors.matchAll(/\b([A-Z][A-Z0-9_]+) is required/g)].map((m) => m[1] as string),
      ...(/requires accountId/.test(errors) ? ['CLOUDFLARE_ACCOUNT_ID'] : []),
      ...(/requires resourceName/.test(errors) ? ['AZURE_RESOURCE_NAME'] : []),
    ].filter((e, i, all) => all.indexOf(e) === i)
    return `its API host is per account${extra.length ? ` (${extra.join(', ')})` : ''}, which ES doesn't pass`
  }
  if (requests.some((r) => r.key.includes('query'))) {
    return 'OpenCode sends its key in the URL, which the gateway only swaps in headers'
  }
  if (requests.some((r) => r.key.includes('body'))) {
    return 'OpenCode sends its key in the request body, which the gateway only swaps in headers'
  }
  if (!requests.length) {
    return `OpenCode ${OPENCODE_CLI_VERSION} sends it no request with a key (${errors.split('\n').at(-1)?.slice(0, 120)})`
  }
  return undefined
}

/** A path with the model in it matches any model, and names it: the served model's source. */
function pathMatch(path: string, model: string) {
  const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const m of [model, encodeURIComponent(model)]) {
    const at = path.indexOf(m)
    if (at >= 0) {
      return {
        regex: `^${escaped(path.slice(0, at))}([^/]+)${escaped(path.slice(at + m.length))}$`,
      }
    }
  }
  return { exact: path }
}

type Endpoint = { host: string; method: string; path: { exact: string } | { regex: string } }
type Header = { name: string; scheme: 'bearer' | 'raw' }

const supported: string[] = []
const refused: string[] = []
const ids = Object.keys(probe)
  .filter((id) => id !== '(no key)')
  .sort()
for (const id of ids) {
  const p = probe[id] as Probed
  if (p.skipped) {
    // A search service (Exa, Tavily and the like) has no models; it's not a model provider.
    if (!Object.keys(catalog[id]?.models ?? {}).length) continue
    const why = "none of its models can call tools, so they can't run an agent"
    refused.push(
      `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(p.name ?? id)}, why: ${JSON.stringify(why)} },`,
    )
    continue
  }
  const name = p.name ?? id
  const why = reasonFor(id, p)
  if (why) {
    refused.push(
      `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, why: ${JSON.stringify(why)} },`,
    )
    continue
  }
  const endpoints = new Map<string, Endpoint>()
  const headers = new Map<string, Header>()
  for (const v of p.variants ?? []) {
    for (const r of v.requests) {
      const path = pathMatch(r.path, v.model)
      const e = { host: r.host, method: r.method, path }
      endpoints.set(JSON.stringify(e), e)
      for (const k of r.key) {
        headers.set(k, { name: k, scheme: r.format === 'bearer' ? 'bearer' : 'raw' })
      }
    }
  }
  const env = p.env ?? []
  const credential = env.includes('GOOGLE_GENERATIVE_AI_API_KEY')
    ? 'GOOGLE_GENERATIVE_AI_API_KEY'
    : env[0]
  const list = [...endpoints.values()].sort((a, b) =>
    `${a.host} ${a.method} ${JSON.stringify(a.path)}`.localeCompare(
      `${b.host} ${b.method} ${JSON.stringify(b.path)}`,
    ),
  )
  supported.push(
    [
      '  {',
      `    id: ${JSON.stringify(id)},`,
      `    name: ${JSON.stringify(name)},`,
      `    env: ${JSON.stringify(credential)},`,
      `    headers: ${JSON.stringify([...headers.values()])},`,
      '    endpoints: [',
      ...list.map(
        (e) =>
          `      { host: ${JSON.stringify(e.host)}, method: [${JSON.stringify(e.method)}], path: ${JSON.stringify(e.path)} },`,
      ),
      '    ],',
      '  },',
    ].join('\n'),
  )
}

const out = `// Generated by scripts/provider-table.ts from a probe of @opencode/cli ${OPENCODE_CLI_VERSION}
// (scripts/probe-providers.ts): don't edit by hand. Regenerate it on an OpenCode bump.
import type { OpenCodeProvider, RefusedOpenCodeProvider } from './opencode-providers.ts'

/** The version the table was probed on; a test holds it to OPENCODE_CLI_VERSION. */
export const PROBED_VERSION = ${JSON.stringify(OPENCODE_CLI_VERSION)}

/** Every provider whose key OpenCode sends in a header on fixed hosts, as the probe saw it. */
export const OPENCODE_PROVIDERS: readonly OpenCodeProvider[] = [
${supported.join('\n')}
]

/** Every other provider OpenCode knows, and why ES can't broker its key. */
export const REFUSED_OPENCODE_PROVIDERS: readonly RefusedOpenCodeProvider[] = [
${refused.join('\n')}
]
`
const file = join(import.meta.dirname, '../src/opencode-provider-table.ts')
writeFileSync(file, out)
execFileSync('pnpm', ['exec', 'biome', 'format', '--write', file], { stdio: 'inherit' })
console.log(`${supported.length} supported, ${refused.length} refused`)
