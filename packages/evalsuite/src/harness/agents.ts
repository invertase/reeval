import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent'
import type { BakedHarness, DerivedTokens, EndpointMatch } from '@evalsuite/sandbox-docker'
import type { ResolvedMcpServer } from '../environment/resolve.ts'
import { InfraError } from '../sandbox/types.ts'
import type { AgentHarnessDescriptor, HarnessDescriptor } from '../types.ts'

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
}

/** What ES needs to know about a real agent; everything else is the same for all of them. */
export type Agent = Layout & {
  /** For messages. */
  name: string
  /** The `evalsuite/harness` factory, for messages. */
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
  /** ES's MCP servers in the shape the adapter forwards to the agent as is. */
  mcpServers: (servers: Record<string, ResolvedMcpServer>) => Record<string, unknown>
  /**
   * The adapter, with `auth` always an explicit environment holding only the credential: left on
   * `'auto'`, an adapter picks up the host's AI Gateway key, subscriptions or keychain.
   */
  adapter: (options: {
    mcpServers?: Record<string, unknown>
    auth: Record<string, string>
  }) => Promise<HarnessAgentAdapter>
}

const pairs = (values: Record<string, unknown> = {}) =>
  Object.entries(values).map(([name, value]) => ({ name, value: String(value) }))

/** The ACP `session/new` shape. */
export function acpMcpServers(servers: Record<string, ResolvedMcpServer>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, s]) =>
      s.transport === 'stdio'
        ? [name, { command: s.command, args: s.args, env: pairs(s.env) }]
        : [name, { type: s.transport, url: s.url, headers: pairs(s.headers) }],
    ),
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

/** Where each agent with an image reads rules and skills. */
export const LAYOUTS: Record<BakedHarness, Layout> = {
  cursor: {
    rulesFile: 'AGENTS.md',
    workspaceSkillDir: '.cursor/skills',
    harnessSkillDir: '.agents/skills',
  },
  'claude-code': {
    rulesFile: 'CLAUDE.md',
    workspaceSkillDir: '.claude/skills',
    harnessSkillDir: '.claude/skills',
  },
}

/** Every real agent ES can drive, by harness kind. */
export const AGENTS: Record<AgentKind, Agent> = {
  cursor: {
    ...LAYOUTS.cursor,
    name: 'Cursor',
    factory: 'cursor',
    credential: 'CURSOR_API_KEY',
    endpoints: [
      { host: 'api2.cursor.sh', path: { exact: '/auth/exchange_user_api_key' }, method: ['POST'] },
    ],
    // The CLI stores these in auth.json and sends the access token to api2 and the agent hosts
    // (agentn.*.cursor.sh, over long-lived HTTP/2 streams). It doesn't check their signatures.
    tokens: {
      endpoint: {
        host: 'api2.cursor.sh',
        path: { exact: '/auth/exchange_user_api_key' },
        method: ['POST'],
      },
      fields: ['accessToken', 'refreshToken'],
      hosts: ['cursor.sh', '*.cursor.sh'],
    },
    mcpServers: acpMcpServers,
    adapter: async (options) => (await import('@ai-sdk/harness-cursor')).createCursor(options),
  },
  'claude-code': {
    ...LAYOUTS['claude-code'],
    name: 'Claude Code',
    factory: 'claudeCode',
    credential: 'ANTHROPIC_API_KEY',
    // What CLI 2.1.276 sends the key on, with non-essential traffic off (checked in Docker).
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
    adapter: async (options) =>
      (await import('@ai-sdk/harness-claude-code')).createClaudeCode({
        ...options,
        env: {
          // The CLI refuses to skip permissions as root unless told it's in a sandbox.
          IS_SANDBOX: '1',
          // No telemetry, error reporting or feature-flag fetches: fewer endpoints for the key,
          // and flags that can't change between runs.
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      }),
  },
}

export const isAgentKind = (kind: unknown): kind is AgentKind =>
  typeof kind === 'string' && Object.hasOwn(AGENTS, kind)

/** The catalog entry for a harness's agent; undefined for the fake harness. */
export const agentOf = (h: HarnessDescriptor): Agent | undefined =>
  h.kind === 'fake' ? undefined : AGENTS[h.kind]

/** The fake agent's own layout. */
const FAKE_LAYOUT: Layout = {
  rulesFile: 'AGENTS.md',
  workspaceSkillDir: '.agents/skills',
  harnessSkillDir: '.agents/skills',
}

/** Where a harness's agent reads rules and skills; a fake one with `layout` mimics that agent. */
export function layoutOf(descriptor: HarnessDescriptor): Layout {
  if (descriptor.kind !== 'fake') return LAYOUTS[descriptor.kind]
  return descriptor.layout ? LAYOUTS[descriptor.layout] : FAKE_LAYOUT
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
}

export function brokeringFor(h: HarnessDescriptor): Brokering | undefined {
  const agent = agentOf(h)
  if (!agent) return undefined
  const { credential, endpoints, tokens } = agent
  return { credential, endpoints, ...(tokens ? { tokens: { name: credential, ...tokens } } : {}) }
}
