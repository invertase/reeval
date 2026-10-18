// The plain-data descriptors an environment and the eval options carry: the gate, the egress
// policy, secrets, host files, skills, MCP servers and git workspaces. The helpers that make them
// (`secret`, `skill`, `mcp`, `file`, `git`) check their own arguments in their own words; these
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
  Secret,
  SecretTemplate,
  SkillPlacement,
  SkillSource,
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

export const gatePolicySchema = z
  .union([z.literal('all'), z.strictObject({ passRate: z.number().gt(0).max(1) })])
  .describe(
    "How a cell's attempts decide its outcome: `'all'` (the default) passes only when every attempt passes (pass^k); `{ passRate }` passes when its pass@1 (passes over passes and fails) is at least that share.",
  )

export const egressPolicySchema = z
  .union([
    z.literal('allow-all'),
    z.literal('deny-all'),
    z.strictObject({ allow: z.array(host).readonly() }),
  ])
  .describe(
    "Where the sandbox may connect: anywhere (`'allow-all'`, the default), nowhere (`'deny-all'`), or only the listed hosts (`'*.example.com'` matches subdomains). Under a restricted policy the harness's own hosts, brokered secrets' `hosts` and MCP servers' hosts are allowed too; any other request gets a refusal, and the attempt goes on.",
  )

export const substituteInSchema = z
  .enum(['header', 'query', 'body'])
  .describe('`header` values, the `query` string, or the request `body`.')

export const secretSchema = z
  .strictObject({
    kind: z.literal('secret'),
    from: z
      .string()
      .regex(VAR, 'needs a host variable name')
      .optional()
      .describe("The host variable; defaults to the key it's set under."),
    optional: z
      .boolean()
      .optional()
      .describe(
        'When the host variable is unset, skip it (the record says so) instead of failing.',
      ),
    to: z
      .enum(['agent', 'checks'])
      .optional()
      .describe(
        "`agent` (default): the container's environment. `checks`: only `c.exec` and `setup` steps.",
      ),
    hosts: z
      .array(host)
      .min(1)
      .optional()
      .describe(
        'Brokers the secret: the sandbox gets a per-attempt placeholder, and the Docker egress gateway swaps in the real value only on HTTPS requests to these hosts (`*.example.com` for subdomains).',
      ),
    in: z
      .array(substituteInSchema)
      .min(1)
      .optional()
      .describe(
        "Where in a request to those hosts the gateway substitutes; defaults to `['header']`.",
      ),
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
  .describe(
    'A host environment variable, redacted everywhere reeval writes and recorded by name only. Made by the `secret` helper of `defineEnvironment` and `defineConfig` callbacks.',
  )

export const secretTemplateSchema = z
  .strictObject({
    kind: z.literal('secret-template'),
    template: z
      .string()
      // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
      .describe('The string, with `${NAME}` for each host variable to substitute.'),
  })
  .describe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
    "`secret.template('Bearer ${TOKEN}')`: host variables substituted into a string, for MCP headers.",
  )

export const envValueSchema = z
  .union([z.string(), secretSchema])
  .describe("A variable's value: a literal string, or a host secret.")

export const envVarsSchema = z
  .record(z.string(), envValueSchema)
  .describe('Environment variables by name.')

export const hostFileSchema = z
  .strictObject({
    kind: z.literal('file'),
    path: nonEmpty().describe(
      "Its path on the host, absolute or relative to the directory of the file it's written in.",
    ),
  })
  .describe('A file on the host, read when an attempt starts. Made by the `file` helper.')

export const skillPlacementSchema = z
  .enum(['harness', 'workspace'])
  .describe(
    "`harness` (default): the agent's own skills, via its adapter. `workspace`: its repo skill dir.",
  )

const ONLY = 'The skill names to keep; default every one found.'
const EXCLUDE = 'Paths in each skill directory to leave out, gitignore-style.'
const skill = <S extends string, F extends z.core.$ZodLooseShape>(source: S, fields: F) =>
  z.strictObject({
    kind: z.literal('skill'),
    placement: skillPlacementSchema,
    source: z.literal(source),
    ...fields,
  })

export const skillSourceSchema = z
  .discriminatedUnion('source', [
    skill('local', {
      path: nonEmpty().describe('A host directory with a `SKILL.md`, or a directory of them.'),
      only: z.array(z.string()).optional().describe(ONLY),
      exclude: z.array(z.string()).optional().describe(EXCLUDE),
    }),
    skill('git', {
      repo: nonEmpty().describe(
        'As written: a URL, `github:owner/repo`, or a GitHub `/tree/<ref>/<path>` URL.',
      ),
      ref: z
        .string()
        .optional()
        .describe("A branch, tag or commit SHA; unset is the remote's `HEAD`."),
      path: z.string().optional().describe('The directory in the repository to read skills from.'),
      only: z.array(z.string()).optional().describe(ONLY),
      exclude: z.array(z.string()).optional().describe(EXCLUDE),
    }),
    skill('registry', {
      id: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+@[a-z0-9-]+$/)
        .describe('A skills.sh id, `owner/repo@skill`.'),
      version: z.string().optional().describe("A git ref of the skill's repository."),
    }),
    skill('npm', {
      spec: nonEmpty().describe('A pinned npm package spec.'),
      path: z
        .string()
        .describe('The directory in the package to read skills from; default `skills`.'),
      only: z.array(z.string()).optional().describe(ONLY),
      exclude: z.array(z.string()).optional().describe(EXCLUDE),
    }),
    skill('inline', {
      name: z.string().describe("The skill's name, as in `SKILL.md`'s frontmatter."),
      description: z.string().describe("The skill's description, as in `SKILL.md`'s frontmatter."),
      content: z.string().describe('The body of `SKILL.md`.'),
      files: z
        .record(z.string(), z.string())
        .describe('Other files in the skill directory, by relative path.'),
    }),
  ])
  .describe('Skills to place for the agent, made by the `skill` helper.')

export const mcpServerSchema = z
  .discriminatedUnion('transport', [
    z.strictObject({
      kind: z.literal('mcp'),
      transport: z.literal('stdio'),
      command: nonEmpty().describe('The command that starts the server in the sandbox.'),
      args: z.array(z.string()),
      env: envVarsSchema.describe('Variables the server process gets.'),
    }),
    z.strictObject({
      kind: z.literal('mcp'),
      transport: z.enum(['http', 'sse']).describe('Streamable HTTP, or the older SSE transport.'),
      url: z.url('must be a URL'),
      headers: z
        .record(z.string(), z.union([z.string(), secretSchema, secretTemplateSchema]))
        .describe('Request headers, with secrets brokered by the egress gateway.'),
    }),
  ])
  .describe(
    'An MCP server the agent gets, made by the `mcp` helper: a command in the sandbox, or a URL.',
  )

export const gitWorkspaceSchema = z
  .strictObject({
    kind: z.literal('git'),
    repo: nonEmpty().describe('As written: a URL, `github:owner/repo`, or a local path.'),
    url: nonEmpty().describe(
      'What reeval fetches: the clone URL, or an absolute path for a local repository.',
    ),
    ref: z
      .string()
      .optional()
      .describe("A branch, tag or commit SHA; unset is the remote's `HEAD`."),
    path: z
      .string()
      .optional()
      .describe('A directory in the repository whose contents become the workspace.'),
    init: z
      .boolean()
      .optional()
      .describe('Give the workspace a `.git`: one commit of the fetched tree, with no remote.'),
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
      .optional()
      .describe('The host variable holding a token for the fetch; read on the host only.'),
  })
  .describe(
    'A git repository (or one directory of it) the workspace starts as, from the `git` helper. `url` is what reeval fetches: the clone URL, or an absolute path for a local repository.',
  )

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof gatePolicySchema>, GatePolicy>>,
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
  "is 'all' (every attempt passes) or { passRate } with a share above 0 and at most 1, e.g. gate: { passRate: 0.8 }"

/** reeval's sentence for a gate that isn't one, or undefined. */
export const gateProblem = (value: unknown, where: string) =>
  refusal(gatePolicySchema, value, () => `gate in ${where} ${GATE_SHAPE} (got ${got(value)})`)

const EGRESS_SHAPE = `is 'allow-all' (the default), 'deny-all', or { allow: ['api.example.com', '*.example.org'] }`

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
