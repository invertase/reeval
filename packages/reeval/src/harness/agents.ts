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
  PLUGIN_PARTS,
  type PluginContents,
  pluginServerName,
} from '../environment/plugins.ts'
import type { ResolvedMcpServer } from '../environment/resolve.ts'
import { InfraError } from '../sandbox/types.ts'
import type {
  AgentHarnessDescriptor,
  EnvironmentLayer,
  HarnessDescriptor,
  PluginPart,
  WebEventType,
} from '../types.ts'

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
   * plugin's name.
   */
  pluginPlacement: 'flat' | 'namespaced'
}

/** What reeval needs to know about a real agent; everything else is the same for all of them. */
export type Agent = Layout & {
  /** For messages. */
  name: string
  /** The `reeval/harness` factory, for messages. */
  factory: string
  /** The host variable the harness authenticates with. It never enters the sandbox. */
  credential: string
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
  }) => Promise<HarnessAgentAdapter>
}

/** The part of an agent's catalog entry its model's provider decides. */
export type ModelSpecific = Pick<Agent, 'credential' | 'endpoints' | 'servedModel'> & {
  modelResponses?: readonly EndpointMatch[]
  hosts: readonly string[]
}

/** A harness's known noise: the hosts, and what they are, for the `-v` summary. */
export type ExpectedBlocked = { hosts: readonly string[]; why: string }

const WEB_EVENTS: Record<string, WebEventType> = { webSearch: 'web-search', webFetch: 'web-fetch' }

/** `harnessMetadata.cursorSdk.unreportedTools` as transcript event types. */
export function cursorUnreported(harnessMetadata: unknown): WebEventType[] {
  const meta = harnessMetadata as { cursorSdk?: { unreportedTools?: unknown } } | undefined
  const tools = meta?.cursorSdk?.unreportedTools
  return Array.isArray(tools) ? tools.flatMap((t) => (WEB_EVENTS[t] ? [WEB_EVENTS[t]] : [])) : []
}

/** The model a request names, from its method, host and path; undefined when it names none. */
export type ServedModel = (request: {
  method: string
  host: string
  path: string
  /** What the response body said served it, on a `modelResponses` endpoint. */
  responseModel?: string
  /** The reasoning effort the response body said it ran at, on a `modelResponses` endpoint. */
  responseEffort?: string
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

/** Goose's extension shape (its `config.yaml`); it has no SSE transport. */
export function gooseMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, Record<string, unknown>> {
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
 */
export function piMcpServers(
  servers: Record<string, ResolvedMcpServer>,
): Record<string, PiMcpServer> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]): [string, PiMcpServer] => {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new InfraError(
          `pi takes MCP server names of letters, digits, "_" and "-" only, so it can't use the ${name} server: rename it`,
        )
      }
      if (s.transport === 'sse') {
        throw new InfraError(
          `pi has no SSE MCP transport, so it can't use the ${name} server (mcp.sse): use mcp.http or mcp.stdio`,
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
 * fx on the model's provider: Vercel AI Gateway for a gateway id, OpenAI's Chat Completions API
 * for a bare OpenAI id. Each response's first `model` names the model that served it.
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
  // The model list fx fetches before a turn, and its language-model calls.
  const call = {
    host: 'ai-gateway.vercel.sh',
    path: { regex: '^/v\\d+/ai/language-model$' },
    method: ['POST'],
  } as const satisfies EndpointMatch
  const endpoints = [
    { host: 'ai-gateway.vercel.sh', path: { regex: '^/coding-agent/v1/' }, method: ['GET'] },
    call,
  ] as const satisfies readonly EndpointMatch[]
  return {
    credential: 'AI_GATEWAY_API_KEY',
    endpoints,
    modelResponses: [call],
    servedModel: ({ host, responseModel }) =>
      host === 'ai-gateway.vercel.sh' ? responseModel : undefined,
    hosts: ['ai-gateway.vercel.sh'],
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

/** Where each agent with an image reads rules and skills. */
export const LAYOUTS: Record<BakedHarness, Layout> = {
  // The SDK loads AGENTS.md and .cursor/skills from the workspace (settingSources `project`) and
  // ~/.agents/skills from home (`user`).
  cursor: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.cursor/skills',
    harnessSkillDir: '.agents/skills',
    pluginPlacement: 'flat',
  },
  'claude-code': {
    rulesFile: 'CLAUDE.md',
    workspaceSkillDir: '.claude/skills',
    harnessSkillDir: '.claude/skills',
    pluginPlacement: 'namespaced',
  },
  // Home skills are ~/.gemini/config/skills, not the ~/.gemini/antigravity-cli path its docs give.
  antigravity: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.agents/skills',
    harnessSkillDir: '.gemini/config/skills',
    pluginPlacement: 'namespaced',
  },
  // OpenCode reads AGENTS.md but not CLAUDE.md. It also reads .claude/skills and .agents/skills, in
  // the workspace and the home directory; nothing turns that off.
  opencode: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.opencode/skills',
    harnessSkillDir: '.config/opencode/skills',
    pluginPlacement: 'flat',
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
  // it; it reads AGENTS.md (or CLAUDE.md, when there's no AGENTS.md).
  pi: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.pi/skills',
    harnessSkillDir: '.pi/agent/skills',
    pluginPlacement: 'flat',
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
  // the ACP bootstrap gives it.
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
    pluginParts: [],
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
    pluginParts: [],
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
    pluginParts: [],
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
    adapter: async ({ auth, mcpServers, descriptor }) =>
      (await import('@reeval/harness-antigravity')).createAntigravity({
        auth,
        ...(mcpServers ? { mcpServers } : {}),
        ...(descriptor.kind === 'antigravity' && descriptor.effort
          ? { effort: descriptor.effort }
          : {}),
        // reeval's Docker sandbox always brokers; a sandbox that can't must not get the key.
        requireCredentialBrokering: true,
      }),
  },
  opencode: {
    ...LAYOUTS.opencode,
    pluginParts: [],
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
    adapter: async ({ auth, mcpServers, descriptor }) =>
      (await import('@reeval/harness-opencode')).createOpenCode({
        auth,
        model: descriptor.model,
        vars: opencodeVars(descriptor.model),
        ...(descriptor.kind === 'opencode' && descriptor.effort
          ? { effort: descriptor.effort }
          : {}),
        ...(mcpServers ? { mcpServers: mcpServers as Record<string, OpenCodeMcpServer> } : {}),
        requireCredentialBrokering: true,
      }),
  },
  goose: {
    ...LAYOUTS.goose,
    pluginParts: [],
    name: 'Goose',
    factory: 'goose',
    credential: 'GOOGLE_GENERATIVE_AI_API_KEY',
    // The requests Goose sends the key on, with session naming off.
    endpoints: GOOSE_ENDPOINTS,
    servedModel: geminiServedModel,
    mcpServers: gooseMcpServers,
    adapter: async ({ auth, mcpServers, descriptor }) =>
      (await import('@reeval/harness-goose')).createGoose({
        // Goose reads the key as GOOGLE_API_KEY; reeval's host variable is the one the others use.
        auth: { GOOGLE_API_KEY: auth.GOOGLE_GENERATIVE_AI_API_KEY ?? '' },
        model: descriptor.model,
        ...(descriptor.kind === 'goose' && descriptor.effort ? { effort: descriptor.effort } : {}),
        ...(mcpServers
          ? { mcpServers: mcpServers as Record<string, Record<string, unknown>> }
          : {}),
        requireCredentialBrokering: true,
      }),
  },
  pi: {
    ...LAYOUTS.pi,
    pluginParts: [],
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
    pluginParts: [],
    name: 'Codex',
    factory: 'codex',
    credential: 'OPENAI_API_KEY',
    // The only request Codex sends the key on, on the adapter's provider (HTTP, not WebSockets),
    // whose response names the dated model and the effort that served it.
    endpoints: OPENAI_ENDPOINTS,
    modelResponses: OPENAI_ENDPOINTS,
    servedModel: openaiServedModel,
    mcpServers: codexMcpServers,
    adapter: async ({ auth, mcpServers, descriptor }) =>
      (await import('@reeval/harness-codex')).createCodex({
        auth,
        ...(descriptor.kind === 'codex' && descriptor.effort ? { effort: descriptor.effort } : {}),
        ...(mcpServers
          ? { mcpServers: mcpServers as Record<string, Record<string, unknown>> }
          : {}),
        requireCredentialBrokering: true,
      }),
  },
  fx: {
    ...LAYOUTS.fx,
    pluginParts: [],
    name: 'fx',
    factory: 'fx',
    // AI Gateway's, for what names no model; forModel gives the model's provider's.
    ...fxForModel('provider/model'),
    forModel: fxForModel,
    mcpServers: acpMcpServers,
    adapter: async ({ auth, mcpServers, descriptor }) =>
      (await import('@reeval/harness-fx')).createFx({
        auth,
        model: descriptor.model,
        ...(mcpServers
          ? { mcpServers: mcpServers as Record<string, Record<string, unknown>> }
          : {}),
        requireCredentialBrokering: true,
      }),
  },
  'grok-build': {
    ...LAYOUTS['grok-build'],
    pluginParts: [],
    name: 'Grok Build',
    factory: 'grokBuild',
    credential: 'XAI_API_KEY',
    // The requests Grok sends the key on, with its summary, recap and title-refresh calls off.
    endpoints: XAI_ENDPOINTS,
    modelResponses: XAI_MODEL_RESPONSES,
    servedModel: xaiServedModel,
    mcpServers: acpMcpServers,
    adapter: async ({ auth, mcpServers, descriptor }) =>
      (await import('@reeval/harness-grok-build')).createGrokBuild({
        auth,
        model: descriptor.model,
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

/** A skill the environment's `skills` place, named by the call that placed it. */
export type OwnSkill = { name: string; call: string }

const quoted = (parts: readonly PluginPart[]) => parts.map((p) => `'${p}'`).join(', ')

/**
 * Why a harness's agent can't take the plugins, in the agent's own words: a part it doesn't
 * load, a plugin MCP server it refuses (named `<plugin>:<server>`), or, where it takes plugin
 * items flat, a skill or MCP server whose name another already has. `own` names the
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
  const loads = agent ? agent.pluginParts : PLUGIN_PARTS
  const name = agent?.name ?? 'The fake agent'
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
  const servers = Object.fromEntries(
    plugins.flatMap((p) =>
      Object.entries(p.mcp).map(([server, s]): [string, ResolvedMcpServer] => [
        pluginServerName(p.name, server),
        s.transport === 'stdio' ? { ...s, env: {} } : { ...s, headers: {} },
      ]),
    ),
  )
  if (agent && Object.keys(servers).length) {
    try {
      agent.mcpServers(servers)
    } catch (error) {
      if (error instanceof InfraError) return error.message
      throw error
    }
  }
  const layout = layoutOf(harness)
  if (layout.pluginPlacement !== 'flat') return undefined
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
  return undefined
}

/** A real agent's catalog entry, with what its model's provider decides. */
export function agentFor(h: AgentHarnessDescriptor): Agent {
  const agent = AGENTS[h.kind]
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

/** The hosts a harness's agent is known to try; a fake agent with `layout` expects that agent's. */
export function expectedBlockedFor(descriptor: HarnessDescriptor): ExpectedBlocked | undefined {
  const kind = descriptor.kind === 'fake' ? descriptor.layout : descriptor.kind
  return kind ? AGENTS[kind].expectedBlocked : undefined
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

/** What to do when a harness error says its API refused the key, naming the variable; else undefined. */
export function authHint(agent: Agent, message: string): string | undefined {
  if (!REFUSED_KEY.test(message)) return undefined
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
  return { [agent.credential]: value }
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
  modelResponses?: readonly EndpointMatch[]
}

export function brokeringFor(h: HarnessDescriptor): Brokering | undefined {
  const agent = agentOf(h)
  if (!agent) return undefined
  const { credential, endpoints, tokens, servedModel, modelResponses } = agent
  return {
    credential,
    endpoints,
    ...(tokens ? { tokens: { name: credential, ...tokens } } : {}),
    ...(servedModel ? { servedModel } : {}),
    ...(modelResponses ? { modelResponses } : {}),
  }
}
