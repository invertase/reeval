// The plain-data descriptors an environment and the eval options carry: the gate, the egress
// policy, secrets, host files, skills, plugins, MCP servers and git workspaces. The helpers that
// make them (`secret`, `skill`, `plugin`, `mcp`, `file`, `git`) check their own arguments in their own words; these
// schemas check what arrives as data (from another language, or built by hand) and give the
// JSON Schema in schema/plan/.
import { isIP } from 'node:net'
import { z } from 'zod'
import type {
  EgressPolicy,
  EnvValue,
  EnvVars,
  GatePolicy,
  GitWorkspace,
  HostFile,
  McpServer,
  PluginMarketplace,
  PluginPart,
  PluginSource,
  Secret,
  SecretTemplate,
  SkillPlacement,
  SkillSource,
  SnapshotOption,
  SubstituteIn,
} from '../types.ts'
import {
  type Assert,
  closest,
  genericProblem,
  got,
  type Issue,
  nonEmpty,
  oneOf,
  refusal,
  type Same,
  valueAt,
} from './shared.ts'

/** A host environment variable's name. */
export const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A URL with its password (or a username on http(s) or git+http(s), which is where tokens go)
 * masked, or undefined when it has neither or isn't a URL. An SSH username (`git@`) is no secret.
 */
export function credentialsIn(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined
  const u = new URL(url)
  if (!u.password && !(u.username && /^(?:git\+)?https?:$/.test(u.protocol))) return undefined
  u.username = u.username && '***'
  u.password = u.password && '***'
  return u.href
}

/** A source reeval fetches on the host: a URL in it may not carry a password or token. */
const fetched = () =>
  nonEmpty().superRefine((url, ctx) => {
    const masked = credentialsIn(url)
    if (masked) {
      ctx.addIssue({
        code: 'custom',
        message: `${JSON.stringify(masked)} has a password or token in it, which reeval would record. reeval fetches it on the host with your own git and npm credentials; remove it from the URL.`,
      })
    }
  })

/** A host name, or `*.` and a domain for its subdomains. */
const HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i

/** Why `host` isn't a host name or `*.` pattern, or undefined when it is one. */
export function badHost(host: unknown): string | undefined {
  if (typeof host === 'string' && HOST.test(host)) {
    const name = host.replace(/^\*\./, '')
    if (/(?:^|\.)\d+$/.test(name) && (name !== host || isIP(name) !== 4)) {
      return `'${host}' isn't a host name or an IPv4 address, and a *. pattern never matches an address.`
    }
    if (name !== host && !name.includes('.')) {
      return `'${host}' would allow every host under .${name}; name the domain, e.g. '*.example.${name}'.`
    }
    return undefined
  }
  if (typeof host === 'string' && /^[a-z]+:\/\//i.test(host)) {
    return `hosts are host names, not URLs: use '${new URL(host).hostname}' (got '${host}')`
  }
  if (typeof host === 'string' && /^[^:/]+:\d+$/.test(host)) {
    return `hosts are host names without a port: use '${host.split(':')[0]}' (got '${host}')`
  }
  return `${JSON.stringify(host)} isn't a host. Use a name like 'api.example.com', or '*.example.com' for its subdomains.`
}

const host = z.string().superRefine((value, ctx) => {
  const bad = badHost(value)
  if (bad) ctx.addIssue({ code: 'custom', message: bad })
})

export const gatePolicySchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.strictObject({ passRate: z.number().gt(0).max(1) }),
])

const snapshotWhen = z.union([z.boolean(), z.literal('turns')])

export const snapshotOptionSchema = z.union([
  snapshotWhen,
  z.strictObject({ when: snapshotWhen.optional(), compress: z.boolean().optional() }),
])

export const egressPolicySchema = z.union([
  z.literal('proxy'),
  z.literal('allow-all'),
  z.literal('deny-all'),
  z.strictObject({ allow: z.array(host).readonly() }),
])

export const substituteInSchema = z.enum(['header', 'query', 'body'])

export const secretSchema = z
  .strictObject({
    kind: z.literal('secret'),
    from: z.string().regex(VAR, 'needs a host variable name').optional(),
    optional: z.boolean().optional(),
    to: z.enum(['agent', 'checks']).optional(),
    hosts: z.array(host).min(1).optional(),
    in: z.array(substituteInSchema).min(1).optional(),
  })
  .superRefine((secret, ctx) => {
    if (secret.in && !secret.hosts) {
      ctx.addIssue({
        code: 'custom',
        path: ['in'],
        message: 'in only applies to a brokered secret; add hosts',
      })
    }
  })

export const secretTemplateSchema = z.strictObject({
  kind: z.literal('secret-template'),
  template: z.string(),
})

export const envValueSchema = z.union([z.string(), secretSchema])

export const envVarsSchema = z.record(z.string(), envValueSchema)

export const hostFileSchema = z.strictObject({
  kind: z.literal('file'),
  path: nonEmpty(),
})

export const skillPlacementSchema = z.enum(['harness', 'workspace'])

const skill = <S extends string, F extends z.core.$ZodLooseShape>(source: S, fields: F) =>
  z.strictObject({
    kind: z.literal('skill'),
    placement: skillPlacementSchema,
    source: z.literal(source),
    ...fields,
  })

export const skillSourceSchema = z.discriminatedUnion('source', [
  skill('local', {
    path: nonEmpty(),
    only: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }),
  skill('git', {
    repo: fetched(),
    ref: z.string().optional(),
    path: z.string().optional(),
    only: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }),
  skill('registry', {
    id: z.string().regex(/^[\w.-]+\/[\w.-]+@[a-z0-9-]+$/),
    version: z.string().optional(),
  }),
  skill('npm', {
    spec: fetched(),
    path: z.string(),
    only: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }),
  skill('inline', {
    name: z.string(),
    description: z.string(),
    content: z.string(),
    files: z.record(z.string(), z.string()),
  }),
])

export const pluginPartSchema = z.enum(['skills', 'agents', 'commands', 'hooks', 'mcp', 'rules'])

export const pluginMarketplaceSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('git'),
    repo: fetched(),
    ref: z.string().optional(),
  }),
  z.strictObject({
    source: z.literal('npm'),
    spec: fetched(),
  }),
])

const buildCommands = z.union([nonEmpty(), z.array(nonEmpty()).min(1, 'at least one command')])

export const pluginBuildSchema = z.union([
  buildCommands,
  z.strictObject({
    run: buildCommands,
    cwd: z
      .string()
      .regex(
        /^(?:\.|(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]+)$/,
        "a directory relative to the source's root, with forward slashes and no ..",
      )
      .optional(),
  }),
])

const plugin = <S extends string, F extends z.core.$ZodLooseShape>(source: S, fields: F) =>
  z.strictObject({
    kind: z.literal('plugin'),
    source: z.literal(source),
    ...fields,
    only: z.array(pluginPartSchema).min(1, 'at least one part').optional(),
    build: pluginBuildSchema.optional(),
  })

export const pluginSourceSchema = z.discriminatedUnion('source', [
  plugin('local', {
    path: nonEmpty(),
  }),
  plugin('git', {
    repo: fetched(),
    ref: z.string().optional(),
    path: z.string().optional(),
  }),
  plugin('npm', {
    spec: fetched(),
    path: z.string().optional(),
  }),
  plugin('marketplace', {
    name: nonEmpty(),
    marketplace: pluginMarketplaceSchema,
  }),
])

export const mcpServerSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    kind: z.literal('mcp'),
    transport: z.literal('stdio'),
    command: nonEmpty(),
    args: z.array(z.string()),
    env: envVarsSchema,
  }),
  z.strictObject({
    kind: z.literal('mcp'),
    transport: z.enum(['http', 'sse']),
    url: z.url('must be a URL'),
    headers: z.record(z.string(), z.union([z.string(), secretSchema, secretTemplateSchema])),
  }),
])

export const gitWorkspaceSchema = z.strictObject({
  kind: z.literal('git'),
  repo: fetched(),
  url: fetched(),
  ref: z.string().optional(),
  path: z.string().optional(),
  init: z.boolean().optional(),
  token: z
    .string()
    .superRefine((token, ctx) => {
      // Never echo it: a token here instead of its variable's name is the token itself.
      if (!VAR.test(token) || /^(?:gh[opsur]_|github_pat_)/.test(token)) {
        ctx.addIssue({
          code: 'custom',
          message:
            "token names the host variable that holds the token, e.g. token: 'GITHUB_TOKEN'. Don't put the token itself in the eval.",
        })
      }
    })
    .optional(),
})

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof gatePolicySchema>, GatePolicy>>,
  Assert<Same<z.infer<typeof snapshotOptionSchema>, SnapshotOption>>,
  Assert<Same<z.infer<typeof egressPolicySchema>, EgressPolicy>>,
  Assert<Same<z.infer<typeof substituteInSchema>, SubstituteIn>>,
  Assert<Same<z.infer<typeof secretSchema>, Secret>>,
  Assert<Same<keyof z.infer<typeof secretSchema>, keyof Secret>>,
  Assert<Same<z.infer<typeof secretTemplateSchema>, SecretTemplate>>,
  Assert<Same<z.infer<typeof envValueSchema>, EnvValue>>,
  Assert<Same<z.infer<typeof envVarsSchema>, EnvVars>>,
  Assert<Same<z.infer<typeof hostFileSchema>, HostFile>>,
  Assert<Same<z.infer<typeof skillPlacementSchema>, SkillPlacement>>,
  Assert<Same<z.infer<typeof skillSourceSchema>, SkillSource>>,
  Assert<Same<z.infer<typeof pluginPartSchema>, PluginPart>>,
  Assert<Same<z.infer<typeof pluginMarketplaceSchema>, PluginMarketplace>>,
  Assert<Same<z.infer<typeof pluginSourceSchema>, PluginSource>>,
  Assert<Same<z.infer<typeof mcpServerSchema>, McpServer>>,
  Assert<Same<z.infer<typeof gitWorkspaceSchema>, GitWorkspace>>,
  Assert<Same<keyof z.infer<typeof gitWorkspaceSchema>, keyof GitWorkspace>>,
]

/** Every key any object in `schema` takes, for "Did you mean". */
function keysOf(schema: z.ZodType): string[] {
  const def = schema.def as { shape?: object; options?: z.ZodType[]; innerType?: z.ZodType }
  if (def.shape) return Object.keys(def.shape)
  if (def.options) return [...new Set(def.options.flatMap(keysOf))]
  return def.innerType ? keysOf(def.innerType) : []
}

/**
 * What's wrong with a descriptor that arrived as data, in terms of the helper that makes it
 * (`call`, e.g. `secret` or `skill.git`), or undefined when it's sound.
 */
export function descriptorProblem(
  schema: z.ZodType,
  value: unknown,
  call: string,
): string | undefined {
  return refusal(schema, value, (issue: Issue, v: unknown) => {
    if (issue.code === 'unrecognized_keys') {
      const key = issue.keys[0] as string
      const near = closest(key, keysOf(schema))
      const where = issue.path.length ? ` in ${String(issue.path.join('.'))}` : ''
      return `${call}() has no "${key}" field${where}.${near ? ` Did you mean "${near}"?` : ''}`
    }
    if (issue.code === 'custom') return `${call}(): ${issue.message}`
    if (issue.code === 'invalid_union' && issue.path.length === 1) {
      const key = String(issue.path[0])
      const values = (schema.def as { options?: z.ZodObject[] }).options?.flatMap(
        (o) => [...((o.shape[key] as z.ZodType | undefined)?._zod.values ?? [])] as string[],
      )
      const helper = call.split('.')[0]
      return `${helper}() ${key} is ${oneOf(values ?? [])} (got ${got(valueAt(v, issue.path))})`
    }
    return genericProblem(call, issue, v)
  })
}

const GATE_SHAPE =
  "is 'all' (every attempt passes), 'none' (nothing gates) or { passRate } with a share above 0 and at most 1, e.g. gate: { passRate: 0.8 }"

/** reeval's sentence for a gate that isn't one, or undefined. */
export const gateProblem = (value: unknown, where: string) =>
  refusal(gatePolicySchema, value, () => `gate in ${where} ${GATE_SHAPE} (got ${got(value)})`)

const SNAPSHOT_SHAPE =
  "is true (after the checks), 'turns' (after each c.send too), false, or { when, compress }, e.g. snapshot: { compress: true }"

/** reeval's sentence for a `snapshot` that isn't one, or undefined. */
export function snapshotProblem(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined
  return refusal(snapshotOptionSchema, value, () => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `snapshot in ${where} ${SNAPSHOT_SHAPE} (got ${got(value)})`
    }
    const key = Object.keys(value).find((k) => k !== 'when' && k !== 'compress')
    if (key !== undefined) {
      const near = closest(key, ['when', 'compress'])
      return `Unknown snapshot key "${key}" in ${where}.${near ? ` Did you mean "${near}"?` : ''} snapshot ${SNAPSHOT_SHAPE}`
    }
    const { when, compress } = value as { when?: unknown; compress?: unknown }
    if (compress !== undefined && typeof compress !== 'boolean') {
      return `snapshot.compress in ${where} is true or false (got ${got(compress)})`
    }
    return `snapshot.when in ${where} is true, 'turns' or false (got ${got(when)})`
  })
}

const EGRESS_SHAPE = `is 'proxy' (the default), 'allow-all', 'deny-all', or { allow: ['api.example.com', '*.example.org'] }`

/** reeval's sentence for an egress policy that isn't one, or undefined. */
export function egressProblem(value: unknown, where: string): string | undefined {
  return refusal(egressPolicySchema, value, () => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      const list = Array.isArray(value) ? ` For a list of hosts, use { allow: ${got(value)} }.` : ''
      return `egress in ${where} ${EGRESS_SHAPE} (got ${got(value)}).${list}`
    }
    const key = Object.keys(value).find((k) => k !== 'allow')
    if (key !== undefined) {
      const hint =
        key === 'deny'
          ? " A policy lists what's allowed; everything else is refused."
          : key === 'hosts' || key === 'allowedHosts'
            ? ' Did you mean "allow"?'
            : " A policy is { allow: ['api.example.com'] }."
      return `Unknown egress key "${key}" in ${where}.${hint}`
    }
    const allow = (value as { allow?: unknown }).allow
    if (!Array.isArray(allow)) return `egress in ${where} ${EGRESS_SHAPE} (got ${got(value)})`
    return `egress.allow in ${where}: ${allow.map(badHost).find(Boolean)}`
  })
}
