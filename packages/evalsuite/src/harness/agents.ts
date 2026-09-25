import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent'
import type { ClaudeCodeHarnessSettings } from '@ai-sdk/harness-claude-code'
import type { BrokeredEndpoint } from '@evalsuite/sandbox-docker'
import type { ResolvedMcpServer } from '../environment/resolve.ts'
import type { AgentHarnessDescriptor, HarnessDescriptor } from '../types.ts'

/** The kind of a real agent's harness, e.g. `cursor` or `claude-code`. */
export type AgentKind = AgentHarnessDescriptor['kind']

/** What ES needs to know about a real agent; everything else is the same for all of them. */
export type Agent = {
  /** For messages. */
  name: string
  /** The `evalsuite/harness` factory, for messages. */
  factory: string
  /** The host variable the harness authenticates with; the egress gateway keeps it out of the sandbox. */
  credential: string
  /** The only requests the egress gateway adds the credential to, whatever rules the adapter asks for. */
  brokeredEndpoints: readonly BrokeredEndpoint[]
  /** Where the agent looks for repo skills, relative to the workspace. */
  workspaceSkillDir: string
  /** ES's MCP servers in the shape the adapter forwards to the agent as is. */
  mcpServers: (servers: Record<string, ResolvedMcpServer>) => Record<string, unknown>
  /** Loads the adapter; the package is only imported when an attempt starts. */
  adapter: (options: { mcpServers?: Record<string, unknown> }) => Promise<HarnessAgentAdapter>
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

/**
 * The Claude Code adapter's settings. `auth` is an explicit environment holding only
 * `ANTHROPIC_API_KEY`, so the adapter never reads the host's other Anthropic variables, AI Gateway
 * key, Claude subscription or `apiKeyHelper`.
 */
export function claudeCodeSettings(
  options: { mcpServers?: Record<string, unknown> },
  env: Record<string, string | undefined> = process.env,
): ClaudeCodeHarnessSettings {
  const key = env.ANTHROPIC_API_KEY
  return {
    ...options,
    auth: key ? { ANTHROPIC_API_KEY: key } : {},
    // The CLI refuses to skip permissions as root unless told it's in a sandbox.
    env: { IS_SANDBOX: '1' },
  }
}

/** Every real agent ES can drive, by harness kind. */
export const AGENTS: Record<AgentKind, Agent> = {
  cursor: {
    name: 'Cursor',
    factory: 'cursor',
    credential: 'CURSOR_API_KEY',
    brokeredEndpoints: [
      { host: 'api2.cursor.sh', path: { exact: '/auth/exchange_user_api_key' }, method: ['POST'] },
    ],
    workspaceSkillDir: '.cursor/skills',
    mcpServers: acpMcpServers,
    adapter: async (options) => (await import('@ai-sdk/harness-cursor')).createCursor(options),
  },
  'claude-code': {
    name: 'Claude Code',
    factory: 'claudeCode',
    credential: 'ANTHROPIC_API_KEY',
    brokeredEndpoints: [
      { host: 'api.anthropic.com', path: { exact: '/v1/messages' }, method: ['POST'] },
      { host: 'api.anthropic.com', path: { exact: '/v1/messages/count_tokens' }, method: ['POST'] },
      { host: 'api.anthropic.com', path: { exact: '/api/claude_code/settings' }, method: ['GET'] },
      {
        host: 'api.anthropic.com',
        path: { exact: '/api/claude_code/policy_limits' },
        method: ['GET'],
      },
      // Feature flags, keyed by the CLI build's client key.
      {
        host: 'api.anthropic.com',
        path: { regex: '^/api/eval/sdk-[A-Za-z0-9_-]+$' },
        method: ['POST'],
      },
    ],
    workspaceSkillDir: '.claude/skills',
    mcpServers: claudeMcpServers,
    adapter: async (options) =>
      (await import('@ai-sdk/harness-claude-code')).createClaudeCode(claudeCodeSettings(options)),
  },
}

/** Whether `kind` names a real agent in {@link AGENTS}. */
export const isAgentKind = (kind: unknown): kind is AgentKind =>
  typeof kind === 'string' && Object.hasOwn(AGENTS, kind)

/** Whether a harness drives a real agent rather than the fake one. */
export const isAgentHarness = (h: HarnessDescriptor): h is AgentHarnessDescriptor =>
  h.kind !== 'fake'

/** The catalog entry for a harness's agent; undefined for the fake harness. */
export const agentOf = (h: HarnessDescriptor): Agent | undefined =>
  isAgentHarness(h) ? AGENTS[h.kind] : undefined

/** What the Docker egress gateway brokers for a harness: its credential, on its endpoints only. */
export function brokeringFor(
  h: HarnessDescriptor,
): { credential: string; endpoints: readonly BrokeredEndpoint[] } | undefined {
  const agent = agentOf(h)
  return agent && { credential: agent.credential, endpoints: agent.brokeredEndpoints }
}
