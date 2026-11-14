import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent'
import {
  AgentError,
  FAKE_LAYOUT,
  HARNESSES,
  type HarnessEntry,
  LAYOUTS,
  type Layout,
  PLUGIN_PARTS,
  type PlacedPlugin,
  providerOf,
  type ResolvedMcpServer,
} from '@reeval/agents'
import type { GooseProvider } from '@reeval/harness-goose'
import type { OpenCodeMcpServer } from '@reeval/harness-opencode'
import type { PiMcpServer } from '@reeval/harness-pi'
import { piProvider } from '@reeval/harness-pi/providers'
import {
  type DerivedTokens,
  type EndpointMatch,
  hostAllowed,
  type LocalResponse,
} from '@reeval/sandbox-docker'
import {
  type ExpectedBlocked,
  type HarnessWire,
  keyed,
  type ModelSpecific,
  opencodeVars,
  type ServedModel,
  type Upstream,
  WIRE,
} from '../environment/harness-wire.ts'
import {
  PART_PATHS,
  PLUGIN_MANIFEST,
  type PluginContents,
  pluginServerName,
} from '../environment/plugins.ts'
import { isRoutingGateway, onRoutingGateway, ROUTING_GATEWAYS } from '../gateway/routes.ts'
import { vercelApi } from '../gateway/vercel.ts'
import {
  SANDBOX_ACCESS_TOKEN,
  VERTEX_ROUTES,
  type VertexChat,
  type VertexSettings,
} from '../gateway/vertex.ts'
import { modelLimits } from '../prices.ts'
import { InfraError, type Sandbox } from '../sandbox/types.ts'
import { heldSecret, hostEnv } from '../secrets-file.ts'
import { withoutBom } from '../text.ts'
import type {
  AgentHarnessDescriptor,
  EnvironmentLayer,
  HarnessDescriptor,
  McpServer,
  PluginPart,
  Secret,
  SecretTemplate,
} from '../types.ts'

export {
  acpMcpServers,
  agentMcp,
  antigravityMcpServers,
  claudeCodeCost,
  claudeMcpServers,
  claudePluginFiles,
  cursorHookMatcher,
  cursorMcpServers,
  gooseMcpServers,
  type HarnessUsage,
  LAYOUTS,
  type Layout,
  piCost,
  piMcpServers,
  type ReasoningDelivery,
} from '@reeval/agents'
export {
  directProviderRefusal,
  type ModelSpecific,
  opencodeVars,
  type ServedModel,
  type Upstream,
} from '../environment/harness-wire.ts'

/** The kind of a real agent's harness, e.g. `cursor` or `claude-code`. */
export type AgentKind = AgentHarnessDescriptor['kind']

/** What reeval needs to know about a real agent; everything else is the same for all of them. */
export type Agent = HarnessEntry &
  HarnessWire & {
    /**
     * The adapter, with `auth` always an explicit environment holding only the credential: left on
     * `'auto'`, an adapter picks up the host's AI Gateway key, subscriptions or keychain.
     */
    adapter: (options: {
      mcpServers?: Record<string, unknown>
      auth: Record<string, string>
      /** `routeEnv`, for the agent's environment. */
      env?: Record<string, string>
      /** On Vertex through `adc`: the project, region and where the service account was written. */
      vertex?: AdapterVertex
      /** `vertexChat`, for the agent's provider. */
      vertexChat?: VertexChat
      descriptor: AgentHarnessDescriptor
      /** The model id the agent asks for: `modelId` of the harness's own. */
      model: string
      plugins: readonly PlacedPlugin[]
    }) => Promise<HarnessAgentAdapter>
  }

/**
 * An agent's catalog entry: what `ModelSpecific` names comes only from `forModel` for an agent
 * that runs on any of several providers' keys (OpenCode, Goose, pi), with no credential of its own.
 */
export type CatalogEntry =
  | Agent
  | (Omit<Agent, keyof ModelSpecific | 'forModel'> &
      Partial<Pick<Agent, keyof ModelSpecific>> & {
        credential?: undefined
        endpoints?: undefined
        forModel: NonNullable<Agent['forModel']>
      })

/** What a Gemini CLI's adapter takes to run on Vertex AI from Application Default Credentials. */
export type AdapterVertex = { project: string; location: string; credentialsFile: string }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Writes the layout's plugin files into the sandbox and returns their paths. A `merge` file's keys
 * go into the JSON object already at its path (an object-valued key merged one level down), so
 * settings an environment's `files` wrote there stay.
 */
export async function writePluginFiles(
  sandbox: Sandbox,
  layout: Layout,
  plugins: readonly PlacedPlugin[],
): Promise<string[]> {
  const written: string[] = []
  for (const f of layout.pluginFiles?.(plugins) ?? []) {
    const existing = f.merge ? await sandbox.readFile(f.path) : null
    let content = f.content
    if (existing?.trim()) {
      let base: unknown
      try {
        base = JSON.parse(withoutBom(existing))
      } catch {}
      if (!isObject(base)) {
        throw new InfraError(
          `${f.path} isn't a JSON object, so reeval can't enable the session's plugins in it: write it as one in files, or leave it out`,
        )
      }
      const ours = JSON.parse(f.content) as Record<string, unknown>
      const merged: Record<string, unknown> = { ...base }
      for (const [k, v] of Object.entries(ours)) {
        const was = base[k]
        merged[k] = isObject(v) && isObject(was) ? { ...was, ...v } : v
      }
      content = `${JSON.stringify(merged, null, 2)}\n`
    }
    await sandbox.writeFile(f.path, content)
    written.push(f.path)
  }
  return written
}

/**
 * Every real agent reeval can drive, by harness kind: its catalog entry, what the egress gateway
 * needs to know about it, and its adapter.
 */
export const AGENTS: Record<AgentKind, CatalogEntry> = {
  cursor: {
    ...HARNESSES.cursor,
    ...WIRE.cursor,
    adapter: async ({ auth, mcpServers, descriptor }) =>
      (await import('@reeval/harness-cursor-sdk')).createCursorSdk({
        auth,
        ...(mcpServers ? { mcpServers } : {}),
        ...(descriptor.kind === 'cursor' && descriptor.params
          ? { modelParams: descriptor.params }
          : {}),
        ...(descriptor.kind === 'cursor' && descriptor.effort ? { effort: descriptor.effort } : {}),
        requireCredentialBrokering: true,
      }),
  },
  'claude-code': {
    ...HARNESSES['claude-code'],
    ...WIRE['claude-code'],
    adapter: async ({ auth, env, mcpServers, descriptor }) =>
      (await import('@ai-sdk/harness-claude-code')).createClaudeCode({
        auth,
        ...(mcpServers ? { mcpServers } : {}),
        ...(descriptor.kind === 'claude-code' && descriptor.effort
          ? { effort: descriptor.effort }
          : {}),
        env: {
          // The CLI refuses to skip permissions as root (docker({ root: true })) unless told it's
          // in a sandbox.
          IS_SANDBOX: '1',
          // No telemetry, error reporting or feature-flag fetches: fewer endpoints for the key,
          // and flags that can't change between runs.
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ...env,
        },
      }),
  },
  antigravity: {
    ...HARNESSES.antigravity,
    ...WIRE.antigravity,
    adapter: async ({ auth, mcpServers, descriptor, plugins, vertex }) =>
      (await import('@reeval/harness-antigravity')).createAntigravity({
        auth,
        ...(vertex ? { vertex } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        ...(plugins.length ? { plugins: plugins.map(({ name, dir }) => ({ name, dir })) } : {}),
        ...(descriptor.kind === 'antigravity' && descriptor.effort
          ? { effort: descriptor.effort }
          : {}),
        // reeval's Docker sandbox always brokers; a sandbox that can't must not get the key.
        requireCredentialBrokering: true,
      }),
  },
  opencode: {
    ...HARNESSES.opencode,
    ...WIRE.opencode,
    adapter: async ({ auth, mcpServers, descriptor, model, vertex }) =>
      (await import('@reeval/harness-opencode')).createOpenCode({
        auth,
        model,
        ...(vertex ? { vertex } : { vars: opencodeVars(model) }),
        ...(descriptor.kind === 'opencode' && descriptor.effort
          ? { effort: descriptor.effort }
          : {}),
        ...(mcpServers ? { mcpServers: mcpServers as Record<string, OpenCodeMcpServer> } : {}),
        requireCredentialBrokering: true,
      }),
  },
  goose: {
    ...HARNESSES.goose,
    ...WIRE.goose,
    adapter: async ({ auth, mcpServers, descriptor, model, vertex }) => {
      const goose = await import('@reeval/harness-goose')
      const direct: Record<string, GooseProvider> = {
        google: goose.GEMINI_PROVIDER,
        anthropic: goose.ANTHROPIC_PROVIDER,
        openai: goose.OPENAI_PROVIDER,
        xai: goose.XAI_PROVIDER,
      }
      const provider =
        onRoutingGateway(descriptor, {
          vercel: goose.AI_GATEWAY_PROVIDER,
          openrouter: goose.OPENROUTER_PROVIDER,
        }) ?? direct[providerOf(descriptor.model)]
      return goose.createGoose({
        ...(vertex ? { vertex } : provider ? { provider } : {}),
        auth,
        model,
        ...(descriptor.kind === 'goose' && descriptor.effort ? { effort: descriptor.effort } : {}),
        ...(mcpServers
          ? { mcpServers: mcpServers as Record<string, Record<string, unknown>> }
          : {}),
        requireCredentialBrokering: true,
      })
    },
  },
  pi: {
    ...HARNESSES.pi,
    ...WIRE.pi,
    adapter: async ({ auth, mcpServers, descriptor, model, vertex }) => {
      const pi = await import('@reeval/harness-pi')
      const api = vercelApi()
      const gateway = onRoutingGateway(descriptor, {
        vercel: { ...pi.PI_AI_GATEWAY, openai: api.openai, anthropic: api.anthropic },
        openrouter: pi.PI_OPENROUTER,
      })
      const modelInfo =
        gateway && model && !pi.piGatewayDescribes(gateway, model)
          ? await modelLimits(model)
          : undefined
      return pi.createPi({
        auth,
        ...(gateway
          ? { gateway, ...(modelInfo ? { modelInfo } : {}) }
          : vertex
            ? { vertex }
            : { provider: keyed(piProvider(providerOf(descriptor.model))) }),
        ...(descriptor.kind === 'pi' && descriptor.effort ? { effort: descriptor.effort } : {}),
        ...(mcpServers ? { mcpServers: mcpServers as Record<string, PiMcpServer> } : {}),
        requireCredentialBrokering: true,
      })
    },
  },
  codex: {
    ...HARNESSES.codex,
    ...WIRE.codex,
    adapter: async ({ auth, mcpServers, descriptor, plugins }) => {
      const codex = await import('@reeval/harness-codex')
      const provider = onRoutingGateway(descriptor, {
        vercel: { ...codex.AI_GATEWAY_PROVIDER, baseUrl: vercelApi().openai },
        openrouter: codex.OPENROUTER_PROVIDER,
      })
      return codex.createCodex({
        auth,
        ...(provider ? { provider } : {}),
        ...(descriptor.kind === 'codex' && descriptor.effort ? { effort: descriptor.effort } : {}),
        ...(mcpServers
          ? { mcpServers: mcpServers as Record<string, Record<string, unknown>> }
          : {}),
        ...(plugins.length ? { plugins: plugins.map(({ name, dir }) => ({ name, dir })) } : {}),
        requireCredentialBrokering: true,
      })
    },
  },
  fx: {
    ...HARNESSES.fx,
    ...WIRE.fx,
    adapter: async ({ auth, env, mcpServers, model, descriptor }) =>
      (await import('@reeval/harness-fx')).createFx({
        auth,
        model,
        // On Vercel AI Gateway, the model id picks fx's own provider.
        ...onRoutingGateway(descriptor, {
          vercel: { gatewayUrl: vercelApi().origin },
          openrouter: { provider: 'openrouter' as const },
        }),
        // On Vertex AI, the route's project and region.
        ...(env?.FX_VERTEX_PROJECT
          ? { vertex: { project: env.FX_VERTEX_PROJECT, location: env.FX_VERTEX_LOCATION ?? '' } }
          : {}),
        ...(descriptor.kind === 'fx' && descriptor.effort ? { effort: descriptor.effort } : {}),
        ...(mcpServers
          ? { mcpServers: mcpServers as Record<string, Record<string, unknown>> }
          : {}),
        requireCredentialBrokering: true,
      }),
  },
  'grok-build': {
    ...HARNESSES['grok-build'],
    ...WIRE['grok-build'],
    adapter: async ({ auth, mcpServers, descriptor, plugins, model, vertexChat }) => {
      const grok = await import('@reeval/harness-grok-build')
      return grok.createGrokBuild({
        // On Vertex the gateway adds the token, so Grok's env_key holds a placeholder.
        ...(vertexChat
          ? {
              auth: { [grok.VERTEX_TOKEN_ENV]: SANDBOX_ACCESS_TOKEN },
              provider: grok.vertexProvider(vertexChat.project, vertexChat.region),
            }
          : {
              auth,
              ...onRoutingGateway(descriptor, {
                vercel: {
                  provider: { ...grok.AI_GATEWAY_PROVIDER, baseUrl: vercelApi().openai },
                },
                openrouter: { provider: grok.OPENROUTER_PROVIDER },
              }),
            }),
        model,
        ...(plugins.length
          ? {
              pluginDirs: plugins.map((p) => p.dir),
              pluginMcpServers: plugins.flatMap((p) =>
                p.servers.map((s) => s.slice(p.name.length + 1)),
              ),
            }
          : {}),
        ...(descriptor.kind === 'grok-build' && descriptor.effort
          ? { effort: descriptor.effort }
          : {}),
        ...(mcpServers
          ? { mcpServers: mcpServers as Record<string, Record<string, unknown>> }
          : {}),
        requireCredentialBrokering: true,
      })
    },
  },
}

/** The harness of a config that names none: Cursor, on Cursor's own model. */
export const DEFAULT_HARNESS: AgentHarnessDescriptor = { kind: 'cursor', model: 'composer-2.5' }
/** A harness to name in messages that ask for one. */
export const HARNESS_EXAMPLE = "cursor({ model: 'composer-2.5' })"

export const isAgentKind = (kind: unknown): kind is AgentKind =>
  typeof kind === 'string' && Object.hasOwn(AGENTS, kind)

/**
 * A server as the plan knows it: its names, literal values and each `secret.template`'s text. A
 * host secret's value is read when the attempt starts, so the plan has it as `''`.
 */
function plannedMcpServer(s: McpServer): ResolvedMcpServer {
  const literal = (values: Record<string, string | Secret | SecretTemplate>) =>
    Object.fromEntries(
      Object.entries(values).map(([k, v]): [string, string] => [
        k,
        typeof v === 'string' ? v : v.kind === 'secret-template' ? v.template : '',
      ]),
    )
  return s.transport === 'stdio'
    ? { transport: 'stdio', command: s.command, args: s.args, env: literal(s.env) }
    : { transport: s.transport, url: s.url, headers: literal(s.headers) }
}

/**
 * Why a harness's agent can't take the environment's MCP servers (Goose, OpenCode, pi and Codex
 * take no `mcp.sse`; OpenCode would substitute a `{env:…}` or `{file:…}` in a name or value), in the
 * agent's own words, so the plan refuses them before any attempt starts; undefined when it can.
 */
export function refusedMcp(
  harness: HarnessDescriptor,
  layers: readonly EnvironmentLayer[],
): string | undefined {
  if (!isAgentKind(harness.kind)) return undefined
  const servers = new Map<string, ResolvedMcpServer>()
  for (const { spec } of layers) {
    for (const [name, server] of Object.entries(spec.mcp ?? {})) {
      servers.set(name, plannedMcpServer(server))
    }
  }
  if (servers.size === 0) return undefined
  try {
    AGENTS[harness.kind].mcpServers(Object.fromEntries(servers))
    return undefined
  } catch (error) {
    if (error instanceof AgentError) return error.message
    throw error
  }
}

/**
 * Why a harness's agent can't share a machine with `slots - 1` other attempts: its bridge takes
 * the one port every session exposes. Undefined when it can.
 */
export function refusedSharedMachine(
  harness: HarnessDescriptor,
  slots: number,
): string | undefined {
  if (slots <= 1) return undefined
  const kind = isAgentKind(harness.kind)
    ? harness.kind
    : harness.kind === 'fake' && harness.brokers
      ? (harness.layout ?? 'cursor')
      : undefined
  if (!kind || !AGENTS[kind].bridgePort) return undefined
  return `${kind}'s bridge listens on a fixed port in the machine, so it runs one attempt per machine: set attemptsPerMachine: 1 for it (got ${slots})`
}

/** The first host variable a plugin MCP server reads (`${VAR}`), as `VAR`; undefined for none. */
function hostVariable(s: McpServer): string | undefined {
  const values = Object.entries(s.transport === 'stdio' ? s.env : s.headers)
  for (const [key, v] of values) {
    if (typeof v === 'string') continue
    if (v.kind === 'secret') return v.from ?? key
    return /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(v.template)?.[1] ?? key
  }
  return undefined
}

/** A skill the environment's `skills` place, named by the call that placed it. */
export type OwnSkill = { name: string; call: string }

const quoted = (parts: readonly PluginPart[]) => parts.map((p) => `'${p}'`).join(', ')

/**
 * Why a harness's agent can't take the plugins, in the agent's own words: a part it doesn't
 * load, apps it can't take (`pluginApps`), a hook event or type it doesn't run, a plugin MCP
 * server it refuses (named `<plugin>:<server>`) or whose `<plugin>:<server>` key `mcp` already has,
 * or, where it takes plugin items flat, a skill or MCP server whose name another already has, or a
 * subagent, command or rule another unpacks to the same file. `own` names the
 * environment's own skills and MCP servers, and `unread` the plugins not fetched yet (git and
 * npm ones, at plan time) by their call. Undefined when it can take them.
 */
export function refusedPlugins(
  harness: HarnessDescriptor,
  plugins: readonly PluginContents[],
  own: { skills: readonly OwnSkill[]; mcp: readonly string[] },
  unread: readonly string[] = [],
): string | undefined {
  if (plugins.length === 0 && unread.length === 0) return undefined
  const agent = isAgentKind(harness.kind) ? AGENTS[harness.kind] : undefined
  const mimics = harness.kind === 'fake' && harness.layout ? AGENTS[harness.layout] : undefined
  const loads = (agent ?? mimics)?.pluginParts ?? PLUGIN_PARTS
  const name =
    agent?.name ?? (mimics ? `The fake agent with ${mimics.name}'s layout` : 'The fake agent')
  if (loads.length === 0) {
    const first = plugins[0] ? `the ${plugins[0].name} plugin` : unread[0]
    return `${name} can't load plugins yet: leave ${first} out of this cell`
  }
  for (const p of plugins) {
    const refused = p.kept.filter((part) => !loads.includes(part))
    if (refused.length === 0) continue
    const can = p.kept.filter((part) => loads.includes(part))
    const what = refused.map((part) => `${part} (${PART_PATHS[part]})`).join(' and ')
    const fix = can.length ? `use only: [${quoted(can)}], or leave` : 'leave'
    return `${name} can't load the ${p.name} plugin's ${what}: ${fix} the plugin out of this cell`
  }
  const reads = agent ?? mimics
  const first = reads?.pluginManifestsFirst ?? []
  for (const p of plugins) {
    const other = p.manifests.find(
      (m) =>
        first.includes(m) &&
        (m !== 'plugin.json' || !reads?.pluginRootManifestNeedsSchema || p.rootSchema),
    )
    if (other) {
      return `${name} reads the ${p.name} plugin's ${other} in place of its ${PLUGIN_MANIFEST}, so reeval can't hold it to the parts it places: remove ${other} from the plugin, or leave the plugin out of this cell`
    }
  }
  const apps = (agent ?? mimics)?.pluginApps
  const withApps = apps ? plugins.find((p) => p.apps) : undefined
  if (withApps) return `${name} can't load the ${withApps.name} plugin's apps: ${apps}`
  const layout = layoutOf(harness)
  const runs = layout.pluginHookEvents
  for (const p of runs ? plugins : []) {
    const event = p.hooks.events.find((e) => !runs?.includes(e))
    const type = p.hooks.otherTypes[0]
    if (!event && !type) continue
    const rest = p.kept.filter((part) => part !== 'hooks')
    const fix = rest.length ? `use only: [${quoted(rest)}], or leave` : 'leave'
    return event
      ? `${name} can't run the ${p.name} plugin's ${event} hooks (hooks/hooks.json): it runs ${runs?.join(', ')} hooks; ${fix} the plugin out of this cell`
      : `${name} can't run the ${p.name} plugin's ${type} hooks (hooks/hooks.json): it runs only command hooks; ${fix} the plugin out of this cell`
  }
  const servers = Object.fromEntries(
    plugins.flatMap((p) =>
      Object.entries(p.mcp).map(([server, s]): [string, ResolvedMcpServer] => [
        pluginServerName(p.name, server),
        plannedMcpServer(s),
      ]),
    ),
  )
  if (agent && Object.keys(servers).length) {
    // A flat agent gets the environment's servers in one list with the plugins', so its own name
    // rules see both; refusedMcp has already checked the environment's servers themselves.
    const alongside =
      agent.pluginPlacement === 'flat'
        ? Object.fromEntries(
            own.mcp.map((n): [string, ResolvedMcpServer] => [
              n,
              { transport: 'stdio', command: 'true', args: [], env: {} },
            ]),
          )
        : {}
    try {
      agent.mcpServers({ ...alongside, ...servers })
    } catch (error) {
      if (error instanceof AgentError) return error.message
      throw error
    }
  }
  for (const p of plugins) {
    for (const server of Object.keys(p.mcp)) {
      const key = pluginServerName(p.name, server)
      if (own.mcp.includes(key)) {
        return `the ${p.name} plugin's MCP server "${server}" would join mcp as ${key}, which mcp already names: rename mcp["${key}"]`
      }
    }
  }
  if (layout.pluginPlacement === 'namespaced') {
    for (const p of plugins) {
      if (!p.kept.includes('mcp')) continue
      for (const [server, s] of Object.entries(p.mcp)) {
        const secret = hostVariable(s)
        if (!secret) continue
        const rest = p.kept.filter((part) => part !== 'mcp')
        return `${name} loads the ${p.name} plugin's MCP server "${server}" itself, so reeval can't give it ${secret} from the host: use only: [${quoted(rest)}] and declare the server in mcp, where reeval fills it in`
      }
    }
    if (!(agent ?? mimics)?.pluginServersByName) return undefined
    const byName = new Map(own.mcp.map((n) => [n, `mcp.${n}`]))
    for (const p of plugins) {
      for (const server of Object.keys(p.mcp)) {
        const other = byName.get(server)
        if (other) {
          return `${name} names the ${p.name} plugin's MCP server "${server}" by its own name, as it does ${other}, and keeps only one: rename one, or leave mcp out of the plugin with only`
        }
        byName.set(server, `the ${p.name} plugin's MCP server "${server}"`)
      }
    }
    return undefined
  }
  const serverOwner = new Map(own.mcp.map((n) => [n, `mcp.${n}`]))
  for (const p of plugins) {
    for (const server of Object.keys(p.mcp)) {
      const other = serverOwner.get(server)
      if (other) return `the ${p.name} plugin's MCP server "${server}" clashes with ${other}`
      serverOwner.set(server, `the ${p.name} plugin's MCP server "${server}"`)
    }
  }
  const skillOwner = new Map(own.skills.map((s) => [s.name, `${s.call}'s "${s.name}"`]))
  for (const p of plugins) {
    for (const { name: skill } of p.skills) {
      const other = skillOwner.get(skill)
      if (other) {
        return `the ${p.name} plugin's skill "${skill}" and ${other} would both be placed at ~/${layout.harnessSkillDir}/${skill}: rename one, or narrow it with only or exclude`
      }
      skillOwner.set(skill, `the ${p.name} plugin's skill "${skill}"`)
    }
  }
  for (const part of ['agents', 'commands'] as const) {
    const dir = layout.pluginUnpack?.[part]
    if (!dir) continue
    const owner = new Map<string, string>()
    for (const p of plugins) {
      for (const item of p[part]) {
        const other = owner.get(item)
        const what = part === 'agents' ? 'subagent' : 'command'
        if (other) {
          return `the ${p.name} plugin's ${what} "${item}" and the ${other} plugin's would both be placed at ${dir}/${item}.md: rename one, or narrow one with only`
        }
        owner.set(item, p.name)
      }
    }
  }
  const rules = layout.pluginUnpack?.rules
  const ruleOwner = new Map<string, string>()
  for (const p of rules ? plugins : []) {
    for (const rule of p.rules) {
      const file = `${p.name}-${rule.replace(/\.mdc?$/, '')}.mdc`
      const what = `the ${p.name} plugin's rule "${rule}"`
      const other = ruleOwner.get(file)
      if (other) {
        return `${what} and ${other} would both be placed at ${rules}/${file}: rename one, or narrow one with only`
      }
      ruleOwner.set(file, what)
    }
  }
  return undefined
}

/**
 * A real agent's catalog entry, with what its model's provider decides, or its gateway's route:
 * on Vertex, the attempt's `vertex()` settings decide the project and region.
 */
export function agentFor(h: AgentHarnessDescriptor, vertex?: VertexSettings): Agent {
  const agent = AGENTS[h.kind]
  // A gateway's route authenticates with its own credential only.
  const { fallbackCredentials: _, ...routed } = agent
  if (h.gateway === 'vertex') {
    const route = VERTEX_ROUTES[h.kind]
    if (!route) throw new InfraError(`reeval doesn't run ${agent.name} on Vertex AI`)
    if (!vertex) throw new InfraError(`${agent.name} on Vertex AI has no vertex() settings`)
    return { ...routed, ...route(vertex) }
  }
  if (isRoutingGateway(h.gateway)) {
    const gateway = ROUTING_GATEWAYS[h.gateway]
    const route = gateway.routes[h.kind]
    if (!route) throw new InfraError(`reeval doesn't run ${agent.name} on ${gateway.name}`)
    // The route stands in for forModel: it decides the credential, endpoints and hosts there.
    return { ...routed, ...route(process.env) }
  }
  if (agent.credential === undefined) return { ...agent, ...agent.forModel(h.model) }
  return agent.forModel ? { ...agent, ...agent.forModel(h.model) } : agent
}

/** The catalog entry for a harness's agent; undefined for the fake harness. */
export const agentOf = (h: HarnessDescriptor, vertex?: VertexSettings): Agent | undefined =>
  h.kind === 'fake' ? undefined : agentFor(h, vertex)

/** The host variables an agent authenticates with, any one of which will do: `credential` first. */
export const credentialsOf = (agent: Agent): string[] => [
  agent.credential,
  ...(agent.fallbackCredentials ?? []),
]

/** The host variable the agent authenticates with in `env`: the first set, else `credential`. */
export const credentialIn = (agent: Agent, env: NodeJS.ProcessEnv = process.env): string =>
  credentialsOf(agent).find((name) => env[name]) ?? agent.credential

/**
 * The host variables a harness authenticates with, any one of which will do; none for the fake
 * harness, and on Vertex, whose token comes from Application Default Credentials.
 */
export const harnessCredentials = (h: HarnessDescriptor): string[] =>
  h.kind === 'fake' || h.gateway === 'vertex' ? [] : credentialsOf(agentFor(h))

/** Where a harness's agent reads rules and skills; a fake one with `layout` mimics that agent. */
export function layoutOf(descriptor: HarnessDescriptor): Layout {
  if (descriptor.kind !== 'fake') return LAYOUTS[descriptor.kind]
  return descriptor.layout ? LAYOUTS[descriptor.layout] : FAKE_LAYOUT
}

/**
 * The hosts a harness's agent is known to try in a session with or without plugins; a fake agent
 * with `layout` expects that agent's. On Vertex, the attempt's `vertex()` settings pick the route.
 */
export function expectedBlockedFor(
  descriptor: HarnessDescriptor,
  plugins: boolean,
  vertex?: VertexSettings,
): ExpectedBlocked | undefined {
  const expected =
    descriptor.kind !== 'fake'
      ? agentFor(descriptor, vertex).expectedBlocked
      : descriptor.layout
        ? AGENTS[descriptor.layout].expectedBlocked
        : undefined
  return expected?.withPlugins && !plugins ? undefined : expected
}

/**
 * How the APIs behind the harnesses say they refused a key: an HTTP 401, Anthropic's and OpenAI's
 * wording, Google's (which answers 400), and OpenCode's for any provider's 401 or 403. A bare 403 isn't here: the gateway and MCP servers send
 * those for reasons that have nothing to do with the harness's key. Grok Build checks its key as
 * it starts and, when xAI refuses it (a 400 or 401, not an outage), offers no `xai.api_key`
 * sign-in, which is all `@ai-sdk/harness-acp` reports.
 */
const REFUSED_KEY =
  /\bHTTP 401\b|\b401\b.{0,40}\bunauthori[sz]ed\b|\bunauthori[sz]ed\b.{0,40}\b401\b|\b(?:invalid|incorrect) (?:x-)?api[ _-]?key\b|\bapi key not valid\b|\bAPI_KEY_INVALID\b|\bauthentication_error\b|\bprovider authentication required\b|\bauthentication method "xai\.api_key" is not advertised\b/i

/**
 * What to do when the harness's API refused its key, naming the variable; else undefined. The
 * error's wording says so for some CLIs; `refused` is the egress record's word for every one: a
 * brokered request the API answered with 401, whatever the CLI made of it.
 */
export function authHint(agent: Agent, message: string, refused = false): string | undefined {
  if (!refused && !REFUSED_KEY.test(message)) return undefined
  if (agent.token) {
    return `The API rejected the access token reeval minted from ${agent.credential}: check gcloud auth application-default login (or GOOGLE_APPLICATION_CREDENTIALS) and the project's Vertex AI access`
  }
  return keyRejected(credentialIn(agent))
}

/** What to do when the API refused the key in `credential`, naming it. */
export const keyRejected = (credential: string) =>
  `The API rejected ${credential}: set a valid key in the environment or .env.local`

/**
 * The agent's credential from the host, as the adapter's explicit `auth`. Fails closed. Empty for
 * a brokered token, which the adapter never sees.
 */
export function agentAuth(agent: Agent, env: NodeJS.ProcessEnv = hostEnv()) {
  if (agent.token) return {}
  const name = credentialIn(agent, env)
  const value = env[name]
  const held = heldSecret(name)
  if (held?.mode === 'brokered') {
    const off = [...new Set(agent.endpoints.map((e) => e.host))].filter(
      (host) => !hostAllowed(held.hosts, host),
    )
    if (off.length) {
      throw new InfraError(
        `${name} is brokered to ${held.hosts.join(', ')}, and the ${agent.name} harness sends it to ${off.join(', ')}, which it isn't brokered to.`,
      )
    }
  }
  if (!value) {
    const names = credentialsOf(agent)
    const unset = names.length === 1 ? `${name} isn't set` : `Neither ${names.join(' nor ')} is set`
    throw new InfraError(
      `${unset}, so the ${agent.name} harness can't authenticate. Set ${names.length === 1 ? 'it' : 'one'} in the environment or .env.local.`,
    )
  }
  return { ...agent.authEnv, [name === agent.credential ? (agent.authAs ?? name) : name]: value }
}

/**
 * What the Docker egress gateway brokers for a harness: its credential, on its endpoints only,
 * and the session tokens the agent derives from it.
 */
export type Brokering = {
  credential: string
  endpoints: readonly EndpointMatch[]
  tokens?: DerivedTokens
  servedModel?: ServedModel
  askedModel?: ServedModel
  modelResponses?: readonly EndpointMatch[]
  /** Every model call: the agent's `modelCalls` and `modelResponses`. */
  modelCalls?: readonly EndpointMatch[]
  modelStream?: true
  upstream?: Upstream
  localResponses?: readonly LocalResponse[]
}

/**
 * The key the fake agent brokers with `layout`, and where: the agent's own, or, for one that takes
 * its model's provider's key, a key of the fake's own on no endpoint.
 */
export function fakeBrokering(layout: AgentKind = 'cursor'): Brokering {
  const { credential, endpoints } = AGENTS[layout]
  return credential === undefined
    ? { credential: 'FAKE_AGENT_API_KEY', endpoints: [] }
    : { credential, endpoints }
}

export function brokeringFor(h: HarnessDescriptor, vertex?: VertexSettings): Brokering | undefined {
  if (h.kind === 'fake') return h.brokers ? fakeBrokering(h.layout) : undefined
  const agent = agentOf(h, vertex)
  if (!agent) return undefined
  const { endpoints, tokens, servedModel, askedModel, modelResponses, upstream } = agent
  const { localResponses, modelStream } = agent
  const credential = credentialIn(agent)
  const modelCalls = [...(agent.modelCalls ?? []), ...(modelResponses ?? [])]
  return {
    credential,
    endpoints,
    ...(tokens ? { tokens: { name: credential, ...tokens } } : {}),
    ...(servedModel ? { servedModel } : {}),
    ...(askedModel ? { askedModel } : {}),
    ...(modelResponses ? { modelResponses } : {}),
    ...(modelCalls.length ? { modelCalls } : {}),
    ...(modelStream ? { modelStream } : {}),
    ...(upstream ? { upstream } : {}),
    ...(localResponses?.length ? { localResponses } : {}),
  }
}
