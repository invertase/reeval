import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent'
import type { OpenCodeMcpServer } from '@reeval/harness-opencode'
import {
  providerEndpoints,
  providerHosts,
  providerModelResponses,
  providerServedModel,
  resolveOpenCodeProvider,
} from '@reeval/harness-opencode/providers'
import type { PiMcpServer } from '@reeval/harness-pi'
import type { BakedHarness, DerivedTokens, EndpointMatch } from '@reeval/sandbox-docker'
import {
  PART_PATHS,
  PLUGIN_DIR,
  PLUGIN_MANIFEST,
  PLUGIN_PARTS,
  type PluginContents,
  pluginServerName,
} from '../environment/plugins.ts'
import type { ResolvedMcpServer } from '../environment/resolve.ts'
import {
  FX_VERCEL_CALL,
  FX_VERCEL_ENDPOINTS,
  fxAskedModel,
  servedOnVercel,
  VERCEL_HOST,
  VERCEL_KEY,
  VERCEL_ROUTES,
} from '../gateway/vercel.ts'
import { InfraError, type Sandbox } from '../sandbox/types.ts'
import type {
  AgentHarnessDescriptor,
  EnvironmentLayer,
  HarnessDescriptor,
  McpServer,
  PluginPart,
  WebEventType,
} from '../types.ts'
import type { PlacedPlugin } from './types.ts'
import type { PluginUnpack } from './unpack.ts'

/** The kind of a real agent's harness, e.g. `cursor` or `claude-code`. */
export type AgentKind = AgentHarnessDescriptor['kind']

/** Where an agent reads what the environment gives it. */
export type Layout = {
  /** The workspace file environment `rules` are written to. */
  rulesFile: string
  /** The repo skill directory for `placement: 'workspace'`, relative to the workspace. */
  workspaceSkillDir: string
  /** Where the adapter puts harness-placed skills, under `~/`; the fake agent writes them there. */
  harnessSkillDir: string
  /**
   * How the agent takes a plugin's items: `flat`, unpacked into the same lists as the
   * environment's skills and MCP servers (so names can clash), or `namespaced` under the
   * plugin's name. A namespaced agent loads a plugin's MCP servers from the plugin itself.
   */
  pluginPlacement: 'flat' | 'namespaced'
  /**
   * Files under `~/` that make the agent load the session's plugins, written before it starts;
   * unset for an agent pointed at them some other way (launch arguments, an install step). One
   * marked `merge` is a JSON object whose keys are merged into the file an environment's `files`
   * may already have put there, rather than replacing it.
   */
  pluginFiles?: (plugins: readonly PlacedPlugin[]) => PluginFile[]
  /**
   * Where a flat agent reads the plugin parts reeval unpacks into the workspace before the
   * snapshot (rules, subagents, commands, hooks); unset for an agent that takes none.
   */
  pluginUnpack?: PluginUnpack
  /** The Claude Code hook events the agent runs from a plugin; unset, every event. */
  pluginHookEvents?: readonly string[]
}

/** A file a layout writes for the session's plugins. */
export type PluginFile = { path: string; content: string; merge?: true }

/** What reeval needs to know about a real agent; everything else is the same for all of them. */
export type Agent = Layout & {
  /** For messages. */
  name: string
  /** The `reeval/harness` factory, for messages. */
  factory: string
  /** The host variable the harness authenticates with. It never enters the sandbox. */
  credential: string
  /** The variable the adapter takes the credential as, when not its own name (a gateway's key). */
  authAs?: string
  /** The model id the agent asks for, from the harness's own; unset when they're the same. */
  modelId?: (model: string) => string
  /**
   * The only requests the egress gateway swaps the credential into, whatever rules the adapter
   * asks for. Anything else carrying the placeholder gets a 403 from the gateway.
   */
  endpoints: readonly EndpointMatch[]
  /**
   * Session tokens the agent's CLI gets for its credential, which the gateway keeps out of the
   * sandbox too: the exchange's response carries placeholders, swapped back on these hosts.
   */
  tokens?: Omit<DerivedTokens, 'name'>
  /**
   * Hosts the agent's CLI always tries and nothing needs, which no setting turns off. A
   * restricted policy still refuses them, but reeval records them apart from the real blocks and
   * `-v` summarises them once instead of a line per request.
   */
  expectedBlocked?: ExpectedBlocked
  /**
   * Why it can't take a plugin that bundles ChatGPT apps, which it would otherwise load with the
   * plugin; unset for an agent that ignores them.
   */
  pluginApps?: string
  /**
   * Plugin manifests it reads in place of `.claude-plugin/plugin.json` when a plugin has one, so it
   * would load what reeval didn't place or rewrite; unset for an agent that reads only that one.
   */
  pluginManifestsFirst?: readonly string[]
  /** It reads a root `plugin.json` only when it names an Agent Plugins `$schema`. */
  pluginRootManifestNeedsSchema?: true
  /**
   * Transcript events a turn may have had that its harness didn't report, from the turn's
   * `finish` part's `harnessMetadata`. Each turn carries these as `unreported`, so web matchers
   * refuse instead of passing silently.
   */
  unreported?: (harnessMetadata: unknown) => WebEventType[]
  /**
   * The model a brokered request asks the agent's API for, e.g. from its URL; unset when the
   * requests don't say (Cursor's are protobuf), so the record says it's unknown.
   */
  servedModel?: ServedModel
  /**
   * The model a successful request asked for, when neither it nor its response names the one that
   * served it; recorded as `askedModels`, never as served.
   */
  askedModel?: ServedModel
  /** Requests whose response body names the model that served them, for `servedModel`. */
  modelResponses?: readonly EndpointMatch[]
  /**
   * Hosts a restricted egress policy allows for it, in place of its image's (`HARNESS_HOSTS`);
   * set by `forModel` for an agent whose hosts depend on the model's provider.
   */
  hosts?: readonly string[]
  /**
   * What depends on the model, for an agent that runs on several providers (OpenCode): the
   * model's provider's credential, endpoints, hosts and served-model reader, with hosts built from
   * the host's variables (Bedrock's `AWS_REGION`). Throws an `InfraError` naming why a model can't
   * run.
   */
  forModel?: (model: string, env?: NodeJS.ProcessEnv) => ModelSpecific
  /** The plugin parts reeval places for the agent; empty refuses every plugin. */
  pluginParts: readonly PluginPart[]
  /**
   * Set for an agent that takes plugins namespaced but names a plugin's MCP servers by their own
   * keys, in one list with the environment's (Grok Build, Codex): it keeps one of two servers of a name.
   */
  pluginServersByName?: true
  /** reeval's MCP servers in the shape the adapter forwards to the agent as is. */
  mcpServers: (servers: Record<string, ResolvedMcpServer>) => Record<string, unknown>
  /**
   * The adapter, with `auth` always an explicit environment holding only the credential: left on
   * `'auto'`, an adapter picks up the host's AI Gateway key, subscriptions or keychain.
   */
  adapter: (options: {
    mcpServers?: Record<string, unknown>
    auth: Record<string, string>
    descriptor: AgentHarnessDescriptor
    /** The model id the agent asks for: `modelId` of the harness's own. */
    model: string
    plugins: readonly PlacedPlugin[]
  }) => Promise<HarnessAgentAdapter>
}

/** The part of an agent's catalog entry its model's provider decides. */
export type ModelSpecific = Pick<
  Agent,
  'credential' | 'endpoints' | 'servedModel' | 'askedModel'
> & {
  modelResponses?: readonly EndpointMatch[]
  hosts: readonly string[]
}

/** A harness's known noise: the hosts, and what they are, for the `-v` summary. */
export type ExpectedBlocked = {
  hosts: readonly string[]
  why: string
  /** Tried only in a session given plugins; another session's attempt on these hosts is a real block. */
  withPlugins?: true
}

const WEB_EVENTS: Record<string, WebEventType> = { webSearch: 'web-search', webFetch: 'web-fetch' }

/** `harnessMetadata.cursorSdk.unreportedTools` as transcript event types. */
export function cursorUnreported(harnessMetadata: unknown): WebEventType[] {
  const meta = harnessMetadata as { cursorSdk?: { unreportedTools?: unknown } } | undefined
  const tools = meta?.cursorSdk?.unreportedTools
  return Array.isArray(tools) ? tools.flatMap((t) => (WEB_EVENTS[t] ? [WEB_EVENTS[t]] : [])) : []
}

/**
 * The model a successful brokered request names, from its method, host and path; undefined when
 * it names none.
 */
export type ServedModel = (request: {
  method: string
  host: string
  path: string
  status?: number
  /** What the response body said served it, on a `modelResponses` endpoint. */
  responseModel?: string
  /** The reasoning effort the response body said it ran at, on a `modelResponses` endpoint. */
  responseEffort?: string
  /** The request's headers, as the agent sent them. */
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>
}) => string | undefined

/** A Gemini API key's only request: `POST /v1beta/models/<model>:streamGenerateContent`. */
const GEMINI_ENDPOINTS = [
  {
    host: 'generativelanguage.googleapis.com',
    path: { regex: '^/v1beta/models/[^/]+:streamGenerateContent$' },
    method: ['POST'],
  },
] as const satisfies readonly EndpointMatch[]

/** Goose's: the model call, and the model list it fetches with the key at the start of a turn. */
const GOOSE_ENDPOINTS = [
  ...GEMINI_ENDPOINTS,
  {
    host: 'generativelanguage.googleapis.com',
    path: { regex: '^/v1beta/models$' },
    method: ['GET'],
  },
] as const satisfies readonly EndpointMatch[]

/**
 * What Grok Build sends the key on: the model list and the key's status as a session starts, and
 * its model calls (Chat Completions, and the Responses API for a model or tool that takes it).
 */
const XAI_ENDPOINTS = [
  { host: 'api.x.ai', path: { exact: '/v1/models' }, method: ['GET'] },
  { host: 'api.x.ai', path: { exact: '/v1/api-key' }, method: ['GET'] },
  { host: 'api.x.ai', path: { exact: '/v1/chat/completions' }, method: ['POST'] },
  { host: 'api.x.ai', path: { exact: '/v1/responses' }, method: ['POST'] },
] as const satisfies readonly EndpointMatch[]

/** xAI's model calls, whose responses name the model that served them. */
const XAI_MODEL_RESPONSES = XAI_ENDPOINTS.filter(
  (e) => e.path.exact === '/v1/chat/completions' || e.path.exact === '/v1/responses',
)

/** The model an xAI response says served it. */
const xaiServedModel: ServedModel = ({ host, responseModel }) =>
  host === 'api.x.ai' ? responseModel : undefined

/** The model a Gemini API request names in its URL. */
const geminiServedModel: ServedModel = ({ host, path }) =>
  host === 'generativelanguage.googleapis.com'
    ? /^\/v1beta\/models\/([^/:]+):streamGenerateContent$/.exec(path)?.[1]
    : undefined

/** Cursor's key exchange: the only request the Cursor SDK sends the API key on. */
const CURSOR_EXCHANGE = {
  host: 'api2.cursor.sh',
  path: { exact: '/auth/exchange_user_api_key' },
  method: ['POST'],
} as const satisfies EndpointMatch

/** What Codex sends the key on: the Responses API. */
const OPENAI_ENDPOINTS = [
  { host: 'api.openai.com', path: { exact: '/v1/responses' }, method: ['POST'] },
] as const satisfies readonly EndpointMatch[]

/**
 * The model the Responses API says served a request, from its response (a dated snapshot for some
 * models), and the reasoning effort Codex resolved for it, e.g. `gpt-5.6-luna[effort=medium]`.
 */
const openaiServedModel: ServedModel = ({ host, path, responseModel, responseEffort }) =>
  host === 'api.openai.com' && path === '/v1/responses' && responseModel
    ? `${responseModel}${responseEffort ? `[effort=${responseEffort}]` : ''}`
    : undefined

/**
 * OpenCode on the model's provider (`anthropic/claude-haiku-4-5` is Anthropic's): its key, the
 * requests OpenCode sends it on, its hosts plus Exa's for web search, and the served model from
 * the URL (Gemini's API, Bedrock's) or the response body. Bedrock's hosts are its `AWS_REGION`'s.
 */
export function opencodeForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelSpecific {
  const resolved = resolveOpenCodeProvider(model, env)
  if ('error' in resolved) throw new InfraError(`opencode(): ${resolved.error}`)
  const { provider } = resolved
  const modelResponses = providerModelResponses(provider)
  return {
    credential: provider.env,
    endpoints: providerEndpoints(provider),
    ...(modelResponses.length ? { modelResponses } : {}),
    servedModel: (request) => providerServedModel(provider, request),
    hosts: [...providerHosts(provider), 'mcp.exa.ai'],
  }
}

/**
 * The variables besides its key that OpenCode's provider takes from the host, as they are:
 * Bedrock's `AWS_REGION` (default `us-east-1`); none for most providers.
 */
export function opencodeVars(model: string, env: NodeJS.ProcessEnv = process.env) {
  const resolved = resolveOpenCodeProvider(model, env)
  if ('error' in resolved) throw new InfraError(`opencode(): ${resolved.error}`)
  return resolved.vars
}

/** Codex's `config.toml` `[mcp_servers]` shape. */
export function codexMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) => {
      if (s.transport === 'sse') {
        throw new InfraError(
          `Codex has no SSE MCP transport, so it can't use the ${name} server (mcp.sse): use mcp.http or mcp.stdio`,
        )
      }
      return s.transport === 'stdio'
        ? [name, { command: s.command, args: s.args, env: s.env ?? {} }]
        : [name, { url: s.url, http_headers: s.headers ?? {} }]
    }),
  )
}

/** The `.mcp.json` shape. */
export function claudeMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) =>
      s.transport === 'stdio'
        ? [name, { type: 'stdio', command: s.command, args: s.args, env: s.env }]
        : [name, { type: s.transport, url: s.url, headers: s.headers }],
    ),
  )
}

/** The Antigravity CLI's `mcp_config.json` shape: remote servers take `serverUrl`, not `url`. */
export function antigravityMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) =>
      s.transport === 'stdio'
        ? [name, { command: s.command, args: s.args, env: s.env }]
        : [name, { serverUrl: s.url, headers: s.headers }],
    ),
  )
}

/**
 * OpenCode's config shape (its `mcp.servers`), which the adapter sets `codemode: false` on.
 * OpenCode has no SSE transport.
 */
export function opencodeMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, OpenCodeMcpServer> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]): [string, OpenCodeMcpServer] => {
      if (s.transport === 'sse') {
        throw new InfraError(
          `OpenCode has no SSE MCP transport, so it can't use the ${name} server (mcp.sse): use mcp.http or mcp.stdio`,
        )
      }
      return s.transport === 'stdio'
        ? [name, { type: 'local', command: [s.command, ...s.args], environment: s.env ?? {} }]
        : [name, { type: 'remote', url: s.url, headers: s.headers ?? {}, oauth: false }]
    }),
  )
}

/**
 * The key Goose keeps an extension by (its `name_to_key`): whitespace dropped, anything but ASCII
 * letters, digits, `_` and `-` made `_`, lower-cased. Of two extensions with one key it keeps one.
 */
const gooseKey = (name: string) =>
  name
    .replace(/\s/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .toLowerCase()

/** Goose's extension shape (its `config.yaml`); it has no SSE transport. */
export function gooseMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, Record<string, unknown>> {
  const byKey = new Map<string, string>()
  for (const name of Object.keys(servers)) {
    const key = gooseKey(name)
    const other = byKey.get(key)
    if (other !== undefined) {
      throw new InfraError(
        `Goose keys the ${other} and ${name} MCP servers both as ${key}, and keeps only one: rename one`,
      )
    }
    byKey.set(key, name)
  }
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) => {
      if (s.transport === 'sse') {
        throw new InfraError(
          `Goose has no SSE MCP transport, so it can't use the ${name} server (mcp.sse): use mcp.http or mcp.stdio`,
        )
      }
      return s.transport === 'stdio'
        ? [name, { type: 'stdio', cmd: s.command, args: s.args, envs: s.env ?? {} }]
        : [name, { type: 'streamable_http', uri: s.url, headers: s.headers ?? {} }]
    }),
  )
}

/**
 * pi's `mcp.json` shape, which the adapter escapes and sets `"exposure": "direct"` on. pi
 * skips a server whose name isn't letters, digits, `_` and `-`, so the plan refuses it instead.
 * A plugin's server, `<plugin>:<server>`, is named `<plugin>_<server>`, so its tools are
 * `mcp__<plugin>_<server>__<tool>`.
 */
export function piMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, PiMcpServer> {
  const named = new Map<string, string>()
  return Object.fromEntries(
    Object.entries(servers).map(([key, s]): [string, PiMcpServer] => {
      const name = /^[a-z0-9-]+:[^:]+$/.test(key) ? key.replace(':', '_') : key
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new InfraError(
          `pi takes MCP server names of letters, digits, "_" and "-" only, so it can't use the ${key} server: rename it`,
        )
      }
      const other = named.get(name)
      if (other) {
        throw new InfraError(
          `pi names the ${key} MCP server ${name}, as it does the ${other} server, and keeps only one: rename one`,
        )
      }
      named.set(name, key)
      if (s.transport === 'sse') {
        throw new InfraError(
          `pi has no SSE MCP transport, so it can't use the ${key} server (mcp.sse): use mcp.http or mcp.stdio`,
        )
      }
      return s.transport === 'stdio'
        ? [name, { command: s.command, args: s.args, env: s.env ?? {} }]
        : [name, { url: s.url, headers: s.headers ?? {} }]
    }),
  )
}

/**
 * ACP's `McpServer` shape, which fx and Grok Build take on `session/new`: `env` and `headers` as
 * name-value lists.
 */
export function acpMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, Record<string, unknown>> {
  const pairs = (values: Record<string, string> = {}) =>
    Object.entries(values).map(([name, value]) => ({ name, value }))
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) =>
      s.transport === 'stdio'
        ? // `harness-acp` takes only an absolute command, so a bare one goes through `env`'s PATH lookup.
          [
            name,
            s.command.startsWith('/')
              ? { command: s.command, args: s.args, env: pairs(s.env) }
              : { command: '/usr/bin/env', args: [s.command, ...s.args], env: pairs(s.env) },
          ]
        : [name, { type: s.transport, url: s.url, headers: pairs(s.headers) }],
    ),
  )
}

/**
 * fx on the model's provider: OpenAI's Chat Completions API for a bare OpenAI id, and Vercel AI
 * Gateway for a gateway id, which only `vercel()` in the gateway list serves. Each response's
 * first `model` names the model that served it.
 */
export function fxForModel(model: string): ModelSpecific {
  if (!model.includes('/')) {
    const endpoints = [
      { host: 'api.openai.com', path: { exact: '/v1/chat/completions' }, method: ['POST'] },
    ] as const satisfies readonly EndpointMatch[]
    return {
      credential: 'OPENAI_API_KEY',
      endpoints,
      modelResponses: endpoints,
      servedModel: ({ host, responseModel }) =>
        host === 'api.openai.com' ? responseModel : undefined,
      hosts: ['api.openai.com'],
    }
  }
  return {
    credential: VERCEL_KEY,
    endpoints: FX_VERCEL_ENDPOINTS,
    modelResponses: [FX_VERCEL_CALL],
    servedModel: servedOnVercel,
    askedModel: fxAskedModel,
    hosts: [VERCEL_HOST],
  }
}

/** The Cursor SDK's `McpServerConfig` shape. */
export function cursorMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) =>
      s.transport === 'stdio'
        ? [name, { type: 'stdio', command: s.command, args: s.args, env: s.env }]
        : [name, { type: s.transport, url: s.url, headers: s.headers }],
    ),
  )
}

/** Claude Code's hook events as Cursor names them, as the Cursor SDK converts Claude Code's own. */
const CURSOR_HOOK_EVENTS: Readonly<Record<string, string>> = {
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  UserPromptSubmit: 'beforeSubmitPrompt',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  SubagentStop: 'subagentStop',
  PreCompact: 'preCompact',
  Stop: 'stop',
}

/** Claude Code's tool names as Cursor's hooks match them; null for one Cursor has no tool for. */
const CURSOR_HOOK_TOOLS: Readonly<Record<string, string | null>> = {
  Bash: 'Shell',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Write',
  Glob: null,
  Grep: 'Grep',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
  Task: 'Task',
}

/**
 * A Claude Code hook group's tool matcher as Cursor's, on the tool events only: each name mapped,
 * `mcp__<server>__<tool>` as `MCP:<tool>`; null when it names only tools Cursor lacks.
 */
export function cursorHookMatcher(
  event: string,
  matcher: string | undefined,
): string | null | undefined {
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return undefined
  if (!matcher || matcher === '*') return undefined
  const out: string[] = []
  for (const raw of matcher.split('|')) {
    const name = raw.trim()
    const parts = name.split('__')
    const tool =
      name.startsWith('mcp__') && parts.length >= 3
        ? `MCP:${parts.slice(2).join('__')}`
        : CURSOR_HOOK_TOOLS[name] === undefined
          ? name
          : CURSOR_HOOK_TOOLS[name]
    if (tool && !out.includes(tool)) out.push(tool)
  }
  return out.length ? out.join('|') : null
}

/** Where Cursor reads what reeval unpacks from a plugin, in the workspace (settingSources `project`). */
const CURSOR_PLUGIN_UNPACK: PluginUnpack = {
  rules: '.cursor/rules',
  agents: '.cursor/agents',
  commands: '.cursor/commands',
  hooks: { file: '.cursor/hooks.json', events: CURSOR_HOOK_EVENTS, matcher: cursorHookMatcher },
}

/**
 * A plugin subagent's or command's frontmatter as OpenCode 2 takes it: the description, and a
 * subagent's `mode`. OpenCode skips a file whose frontmatter its schema refuses, without saying,
 * and Claude Code's `tools: Read, Grep`, `model: sonnet` and `allowed-tools` are such keys.
 */
export function opencodeFrontmatter(
  part: 'agents' | 'commands',
  front: Record<string, unknown>,
): Record<string, string> {
  const d = front.description
  const description =
    typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean' ? String(d) : undefined
  return {
    ...(description ? { description } : {}),
    ...(part === 'agents' ? { mode: 'subagent' } : {}),
  }
}

/** Where OpenCode reads plugin subagents and commands, in the workspace's config directory. */
const OPENCODE_PLUGIN_UNPACK: PluginUnpack = {
  agents: '.opencode/agents',
  commands: '.opencode/commands',
  frontmatter: opencodeFrontmatter,
}

/**
 * Where pi reads plugin commands, as prompt templates (`/<name>`), in the workspace, which its
 * `--approve` trusts. Its frontmatter takes `description` and `argument-hint`, and ignores the
 * rest of Claude Code's.
 */
const PI_PLUGIN_UNPACK: PluginUnpack = { commands: '.pi/prompts' }

/**
 * What Claude Code's plugin format bundles, which Grok Build reads too: every part but rules,
 * which neither loads from a plugin.
 */
const CLAUDE_FORMAT_PARTS: readonly PluginPart[] = PLUGIN_PARTS.filter((p) => p !== 'rules')

/** The marketplace Claude Code's settings name for the session's plugins. */
export const CLAUDE_PLUGIN_MARKETPLACE = 'reeval'

/**
 * Claude Code's settings for the session's plugins: a `directory` marketplace at the directory
 * they were copied to, listing each, and each enabled as `<plugin>@reeval`. Claude Code installs
 * and loads them as it starts, since the bridge leaves every settings source on.
 */
export function claudePluginFiles(plugins: readonly PlacedPlugin[]): PluginFile[] {
  const [first] = plugins
  if (!first) return []
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  const marketplace = {
    name: CLAUDE_PLUGIN_MARKETPLACE,
    owner: { name: 'reeval' },
    plugins: plugins.map((p) => ({ name: p.name, source: `./${p.name}` })),
  }
  const settings = {
    extraKnownMarketplaces: {
      [CLAUDE_PLUGIN_MARKETPLACE]: {
        source: { source: 'directory', path: first.dir.slice(0, first.dir.lastIndexOf('/')) },
      },
    },
    enabledPlugins: Object.fromEntries(
      plugins.map((p) => [`${p.name}@${CLAUDE_PLUGIN_MARKETPLACE}`, true]),
    ),
  }
  return [
    { path: `${PLUGIN_DIR}/.claude-plugin/marketplace.json`, content: json(marketplace) },
    { path: '~/.claude/settings.json', content: json(settings), merge: true },
  ]
}

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
        base = JSON.parse(existing)
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
 * The MCP servers the agent is given: all of them, less the plugins' own where it takes plugin
 * items namespaced, since it loads those from the plugin and would otherwise start each twice.
 */
export function agentMcp(
  layout: Layout,
  mcp: Record<string, ResolvedMcpServer>,
  plugins: readonly PlacedPlugin[],
): Record<string, ResolvedMcpServer> {
  if (layout.pluginPlacement !== 'namespaced') return mcp
  const own = new Set(plugins.flatMap((p) => p.servers))
  return Object.fromEntries(Object.entries(mcp).filter(([name]) => !own.has(name)))
}

/** Where each agent with an image reads rules and skills. */
export const LAYOUTS: Record<BakedHarness, Layout> = {
  // The SDK loads AGENTS.md and .cursor/skills from the workspace (settingSources `project`) and
  // ~/.agents/skills from home (`user`). Plugin skills join the home ones; the rest of a plugin is
  // unpacked into the workspace's .cursor/, never loaded with settingSources `plugins`, which also
  // fetches the key owner's account plugins.
  cursor: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.cursor/skills',
    harnessSkillDir: '.agents/skills',
    pluginPlacement: 'flat',
    pluginUnpack: CURSOR_PLUGIN_UNPACK,
    pluginHookEvents: Object.keys(CURSOR_HOOK_EVENTS),
  },
  'claude-code': {
    rulesFile: 'CLAUDE.md',
    workspaceSkillDir: '.claude/skills',
    harnessSkillDir: '.claude/skills',
    pluginPlacement: 'namespaced',
    pluginFiles: claudePluginFiles,
  },
  // Home skills are ~/.gemini/config/skills, not the ~/.gemini/antigravity-cli path its docs give.
  // Plugins are installed whole with `agy plugin install`, which the adapter runs as it starts.
  antigravity: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.agents/skills',
    harnessSkillDir: '.gemini/config/skills',
    pluginPlacement: 'namespaced',
    // The adapter's ANTIGRAVITY_HOOK_EVENTS, which a test holds this to.
    pluginHookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'],
  },
  // OpenCode reads AGENTS.md but not CLAUDE.md. It also reads .claude/skills and .agents/skills, in
  // the workspace and the home directory; nothing turns that off. Plugin skills join the home ones;
  // plugin subagents and commands are unpacked into the workspace's .opencode/. Its own plugins
  // are code modules, never loaded from an environment's plugins.
  opencode: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.opencode/skills',
    harnessSkillDir: '.config/opencode/skills',
    pluginPlacement: 'flat',
    pluginUnpack: OPENCODE_PLUGIN_UNPACK,
  },
  // Goose's bootstrap gives it a private home, so its home skills are under that. It also
  // reads .agents/skills and .claude/skills; nothing turns that off.
  goose: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.goose/skills',
    harnessSkillDir:
      '.ai-sdk-harness/.harness-bootstrap/goose/implementation/home/.config/goose/skills',
    pluginPlacement: 'flat',
  },
  // pi reads workspace skills only in a trusted project, which the adapter's --approve makes
  // it; it reads AGENTS.md (or CLAUDE.md, when there's no AGENTS.md). Plugin skills join the home
  // ones and plugin commands are unpacked as the workspace's prompt templates; pi packages (its own
  // plugins, with extension code) are never loaded from an environment's plugins.
  pi: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.pi/skills',
    harnessSkillDir: '.pi/agent/skills',
    pluginPlacement: 'flat',
    pluginUnpack: PI_PLUGIN_UNPACK,
  },
  // Codex reads skills from ~/.agents/skills and the repo's .agents/skills, AGENTS.md from
  // ~/.codex and the workspace.
  codex: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.agents/skills',
    harnessSkillDir: '.agents/skills',
    pluginPlacement: 'namespaced',
  },
  // fx reads AGENTS.md and .fx/skills from the workspace, and ~/.fx/skills from the private home
  // the ACP bootstrap gives it. It has no plugins of its own: plugin skills join its home skills.
  fx: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.fx/skills',
    harnessSkillDir: '.ai-sdk-harness/.harness-bootstrap/fx/implementation/home/.fx/skills',
    pluginPlacement: 'flat',
  },
  // Grok's bootstrap gives it a private home, so its home skills are under that. It reads the
  // workspace's AGENTS.md and skills only in a trusted folder, which the adapter's
  // GROK_FOLDER_TRUST=false makes it; it also reads .agents/skills and .claude/skills.
  'grok-build': {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.grok/skills',
    harnessSkillDir:
      '.ai-sdk-harness/.harness-bootstrap/grok-build/implementation/home/.grok/skills',
    pluginPlacement: 'namespaced',
  },
}

/** Every real agent reeval can drive, by harness kind. */
export const AGENTS: Record<AgentKind, Agent> = {
  cursor: {
    ...LAYOUTS.cursor,
    pluginParts: PLUGIN_PARTS,
    name: 'Cursor',
    factory: 'cursor',
    credential: 'CURSOR_API_KEY',
    // The SDK trades the key for session tokens at the same endpoint as the CLI, and sends the
    // tokens to api2.cursor.sh only (its agent stream included, over HTTP/1.1 through the proxy).
    endpoints: [CURSOR_EXCHANGE],
    tokens: {
      endpoint: CURSOR_EXCHANGE,
      fields: ['accessToken', 'refreshToken'],
      hosts: ['cursor.sh', '*.cursor.sh'],
    },
    // Web search and fetch: CURSOR_SDK_RECOVERED_TOOLS.
    unreported: cursorUnreported,
    mcpServers: cursorMcpServers,
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
    ...LAYOUTS['claude-code'],
    pluginParts: CLAUDE_FORMAT_PARTS,
    name: 'Claude Code',
    factory: 'claudeCode',
    credential: 'ANTHROPIC_API_KEY',
    // What the CLI sends the key on, with non-essential traffic off.
    // Anything else gets a 403 from the gateway and a warning that names the request.
    endpoints: [
      { host: 'api.anthropic.com', path: { exact: '/v1/messages' }, method: ['POST'] },
      { host: 'api.anthropic.com', path: { exact: '/v1/messages/count_tokens' }, method: ['POST'] },
      { host: 'api.anthropic.com', path: { exact: '/api/claude_code/settings' }, method: ['GET'] },
      {
        host: 'api.anthropic.com',
        path: { exact: '/api/claude_code/policy_limits' },
        method: ['GET'],
      },
    ],
    mcpServers: claudeMcpServers,
    adapter: async ({ auth, mcpServers, descriptor }) =>
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
        },
      }),
  },
  antigravity: {
    ...LAYOUTS.antigravity,
    pluginParts: PLUGIN_PARTS,
    // agy 1.4.2 installs a plugin as a native one when it has any of these, under that manifest's
    // name and paths.
    pluginManifestsFirst: [
      'plugin.json',
      '.antigravity-plugin/plugin.json',
      '.gemini-plugin/plugin.json',
      'gemini-extension.json',
    ],
    name: 'Antigravity',
    factory: 'antigravity',
    // A Gemini API key, never the CLI's Google sign-in: automating that session risks the account.
    credential: 'GEMINI_API_KEY',
    // The only request the CLI sends the key on (its main model, and a lite one for titles).
    endpoints: GEMINI_ENDPOINTS,
    // The CLI opens both in every session. Neither `enableTelemetry: false` nor any other
    // setting or variable in the binary stops them.
    expectedBlocked: {
      hosts: ['play.googleapis.com', 'antigravity-unleash.goog'],
      why: "Antigravity's telemetry and feature flags, which its CLI sends even with telemetry off",
    },
    // The CLI's `-low`/`-high` ids name an effort; the URL names the model that served it.
    servedModel: geminiServedModel,
    mcpServers: antigravityMcpServers,
    adapter: async ({ auth, mcpServers, descriptor, plugins }) =>
      (await import('@reeval/harness-antigravity')).createAntigravity({
        auth,
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
    ...LAYOUTS.opencode,
    // Plugin MCP servers go in its config with the environment's.
    pluginParts: ['skills', 'agents', 'commands', 'mcp'],
    name: 'OpenCode',
    factory: 'opencode',
    // Google's, for what names no model; forModel gives the model's provider's.
    credential: 'GOOGLE_GENERATIVE_AI_API_KEY',
    endpoints: GEMINI_ENDPOINTS,
    servedModel: geminiServedModel,
    // The requests the pinned CLI sends each provider's key on (its model, and the same model for
    // titles), probed per provider (harness-opencode's opencode-provider-table.ts).
    forModel: opencodeForModel,
    mcpServers: opencodeMcpServers,
    adapter: async ({ auth, mcpServers, descriptor, model }) =>
      (await import('@reeval/harness-opencode')).createOpenCode({
        auth,
        model,
        vars: opencodeVars(model),
        ...(descriptor.kind === 'opencode' && descriptor.effort
          ? { effort: descriptor.effort }
          : {}),
        ...(mcpServers ? { mcpServers: mcpServers as Record<string, OpenCodeMcpServer> } : {}),
        requireCredentialBrokering: true,
      }),
  },
  goose: {
    ...LAYOUTS.goose,
    // Plugin skills join its home skills; plugin MCP servers are extensions in its config.yaml.
    pluginParts: ['skills', 'mcp'],
    name: 'Goose',
    factory: 'goose',
    credential: 'GOOGLE_GENERATIVE_AI_API_KEY',
    // The requests Goose sends the key on, with session naming off.
    endpoints: GOOSE_ENDPOINTS,
    // Goose 1.55.0 refreshes its model catalogue from models.dev/api.json in every session, and
    // falls back to the one it bundles when that's refused.
    expectedBlocked: {
      hosts: ['models.dev'],
      why: "Goose's model catalogue refresh, which no setting turns off",
    },
    servedModel: geminiServedModel,
    mcpServers: gooseMcpServers,
    adapter: async ({ auth, mcpServers, descriptor, model }) =>
      (await import('@reeval/harness-goose')).createGoose({
        ...(auth[VERCEL_KEY]
          ? { auth, provider: (await import('@reeval/harness-goose')).AI_GATEWAY_PROVIDER }
          : // Goose reads the key as GOOGLE_API_KEY; reeval's host variable is the one the others use.
            { auth: { GOOGLE_API_KEY: auth.GOOGLE_GENERATIVE_AI_API_KEY ?? '' } }),
        model,
        ...(descriptor.kind === 'goose' && descriptor.effort ? { effort: descriptor.effort } : {}),
        ...(mcpServers
          ? { mcpServers: mcpServers as Record<string, Record<string, unknown>> }
          : {}),
        requireCredentialBrokering: true,
      }),
  },
  pi: {
    ...LAYOUTS.pi,
    // Plugin MCP servers go in its mcp.json with the environment's. It has no subagents.
    pluginParts: ['skills', 'commands', 'mcp'],
    name: 'pi',
    factory: 'pi',
    credential: 'GOOGLE_GENERATIVE_AI_API_KEY',
    // The only request pi sends the key on; --offline stops its startup network operations.
    endpoints: GEMINI_ENDPOINTS,
    servedModel: geminiServedModel,
    mcpServers: piMcpServers,
    adapter: async ({ auth, mcpServers, descriptor }) =>
      (await import('@reeval/harness-pi')).createPi({
        // pi reads the key as GEMINI_API_KEY; reeval's host variable is the one OpenCode and Goose use.
        auth: { GEMINI_API_KEY: auth.GOOGLE_GENERATIVE_AI_API_KEY ?? '' },
        ...(descriptor.kind === 'pi' && descriptor.effort ? { effort: descriptor.effort } : {}),
        ...(mcpServers ? { mcpServers: mcpServers as Record<string, PiMcpServer> } : {}),
        requireCredentialBrokering: true,
      }),
  },
  codex: {
    ...LAYOUTS.codex,
    // What Codex's plugin format has besides apps; it installs a plugin whole, from a marketplace.
    pluginParts: ['skills', 'mcp'],
    pluginApps: 'they need a ChatGPT login',
    // Codex 0.163.0 reads a root plugin.json (with an Agent Plugins $schema), then
    // .codex-plugin/plugin.json, then .claude-plugin/plugin.json.
    pluginManifestsFirst: ['plugin.json', '.codex-plugin/plugin.json'],
    pluginRootManifestNeedsSchema: true,
    pluginServersByName: true,
    name: 'Codex',
    factory: 'codex',
    credential: 'OPENAI_API_KEY',
    // The only request Codex sends the key on, on the adapter's provider (HTTP, not WebSockets),
    // whose response names the dated model and the effort that served it.
    endpoints: OPENAI_ENDPOINTS,
    modelResponses: OPENAI_ENDPOINTS,
    // Only with plugins on, which a session with plugins needs; it loads them all the same. In a
    // session without plugins these hosts are a real block.
    expectedBlocked: {
      hosts: ['github.com', 'api.github.com', 'chatgpt.com'],
      why: "Codex's plugin sync, which it runs on every turn once plugins are on",
      withPlugins: true,
    },
    servedModel: openaiServedModel,
    mcpServers: codexMcpServers,
    adapter: async ({ auth, mcpServers, descriptor, plugins }) =>
      (await import('@reeval/harness-codex')).createCodex({
        auth,
        ...(auth[VERCEL_KEY]
          ? { provider: (await import('@reeval/harness-codex')).AI_GATEWAY_PROVIDER }
          : {}),
        ...(descriptor.kind === 'codex' && descriptor.effort ? { effort: descriptor.effort } : {}),
        ...(mcpServers
          ? { mcpServers: mcpServers as Record<string, Record<string, unknown>> }
          : {}),
        ...(plugins.length ? { plugins: plugins.map(({ name, dir }) => ({ name, dir })) } : {}),
        requireCredentialBrokering: true,
      }),
  },
  fx: {
    ...LAYOUTS.fx,
    // Plugin MCP servers go over ACP with the environment's. It reads no subagents or commands
    // from files.
    pluginParts: ['skills', 'mcp'],
    name: 'fx',
    factory: 'fx',
    // AI Gateway's, for what names no model; forModel gives the model's provider's.
    ...fxForModel('provider/model'),
    forModel: fxForModel,
    mcpServers: acpMcpServers,
    adapter: async ({ auth, mcpServers, model }) =>
      (await import('@reeval/harness-fx')).createFx({
        auth,
        model,
        ...(mcpServers
          ? { mcpServers: mcpServers as Record<string, Record<string, unknown>> }
          : {}),
        requireCredentialBrokering: true,
      }),
  },
  'grok-build': {
    ...LAYOUTS['grok-build'],
    pluginParts: CLAUDE_FORMAT_PARTS,
    pluginServersByName: true,
    name: 'Grok Build',
    factory: 'grokBuild',
    credential: 'XAI_API_KEY',
    // The requests Grok sends the key on, with its summary, recap and title-refresh calls off.
    endpoints: XAI_ENDPOINTS,
    modelResponses: XAI_MODEL_RESPONSES,
    servedModel: xaiServedModel,
    mcpServers: acpMcpServers,
    adapter: async ({ auth, mcpServers, descriptor, plugins, model }) =>
      (await import('@reeval/harness-grok-build')).createGrokBuild({
        auth,
        ...(auth[VERCEL_KEY]
          ? { provider: (await import('@reeval/harness-grok-build')).AI_GATEWAY_PROVIDER }
          : {}),
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
      }),
  },
}

/** The harness of a config that names none: Cursor, on Cursor's own model. */
export const DEFAULT_HARNESS: AgentHarnessDescriptor = { kind: 'cursor', model: 'composer-2.5' }
/** A harness to name in messages that ask for one. */
export const HARNESS_EXAMPLE = "cursor({ model: 'composer-2.5' })"

export const isAgentKind = (kind: unknown): kind is AgentKind =>
  typeof kind === 'string' && Object.hasOwn(AGENTS, kind)

/**
 * Why a harness's agent can't take the environment's MCP servers (Goose, OpenCode, pi and Codex
 * take no `mcp.sse`), in the agent's own words, so the plan refuses them before any attempt
 * starts; undefined when it can.
 */
export function refusedMcp(
  harness: HarnessDescriptor,
  layers: readonly EnvironmentLayer[],
): string | undefined {
  if (!isAgentKind(harness.kind)) return undefined
  const servers = new Map<string, ResolvedMcpServer>()
  for (const { spec } of layers) {
    for (const [name, server] of Object.entries(spec.mcp ?? {})) {
      servers.set(
        name,
        server.transport === 'stdio' ? { ...server, env: {} } : { ...server, headers: {} },
      )
    }
  }
  if (servers.size === 0) return undefined
  try {
    AGENTS[harness.kind].mcpServers(Object.fromEntries(servers))
    return undefined
  } catch (error) {
    if (error instanceof InfraError) return error.message
    throw error
  }
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
        s.transport === 'stdio' ? { ...s, env: {} } : { ...s, headers: {} },
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
      if (error instanceof InfraError) return error.message
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

/** A real agent's catalog entry, with what its model's provider decides. */
export function agentFor(h: AgentHarnessDescriptor): Agent {
  const agent = AGENTS[h.kind]
  if (h.gateway === 'vercel') {
    const route = VERCEL_ROUTES[h.kind]
    if (!route) throw new InfraError(`reeval doesn't run ${agent.name} on Vercel AI Gateway`)
    // The route stands in for forModel: it decides the credential, endpoints and hosts on Vercel.
    return { ...agent, ...route(process.env) }
  }
  return agent.forModel ? { ...agent, ...agent.forModel(h.model) } : agent
}

/** The catalog entry for a harness's agent; undefined for the fake harness. */
export const agentOf = (h: HarnessDescriptor): Agent | undefined =>
  h.kind === 'fake' ? undefined : agentFor(h)

/** The host variable a harness authenticates with; undefined for the fake harness. */
export const credentialOf = (h: HarnessDescriptor): string | undefined => agentOf(h)?.credential

/** The fake agent's own layout. */
const FAKE_LAYOUT: Layout = {
  rulesFile: 'AGENTS.md',
  workspaceSkillDir: '.agents/skills',
  harnessSkillDir: '.agents/skills',
  pluginPlacement: 'flat',
}

/** Where a harness's agent reads rules and skills; a fake one with `layout` mimics that agent. */
export function layoutOf(descriptor: HarnessDescriptor): Layout {
  if (descriptor.kind !== 'fake') return LAYOUTS[descriptor.kind]
  return descriptor.layout ? LAYOUTS[descriptor.layout] : FAKE_LAYOUT
}

/**
 * The hosts a harness's agent is known to try in a session with or without plugins; a fake agent
 * with `layout` expects that agent's.
 */
export function expectedBlockedFor(
  descriptor: HarnessDescriptor,
  plugins: boolean,
): ExpectedBlocked | undefined {
  const expected =
    descriptor.kind !== 'fake'
      ? agentFor(descriptor).expectedBlocked
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
  return `The API rejected ${agent.credential}: set a valid key in the environment or .env.local`
}

/** The agent's credential from the host, as the adapter's explicit `auth`. Fails closed. */
export function agentAuth(agent: Agent, env: NodeJS.ProcessEnv = process.env) {
  const value = env[agent.credential]
  if (!value) {
    throw new InfraError(
      `${agent.credential} isn't set, so the ${agent.name} harness can't authenticate. Set it in the environment or .env.local.`,
    )
  }
  return { [agent.authAs ?? agent.credential]: value }
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
}

export function brokeringFor(h: HarnessDescriptor): Brokering | undefined {
  const agent = agentOf(h)
  if (!agent) return undefined
  const { credential, endpoints, tokens, servedModel, askedModel, modelResponses } = agent
  return {
    credential,
    endpoints,
    ...(tokens ? { tokens: { name: credential, ...tokens } } : {}),
    ...(servedModel ? { servedModel } : {}),
    ...(askedModel ? { askedModel } : {}),
    ...(modelResponses ? { modelResponses } : {}),
  }
}
