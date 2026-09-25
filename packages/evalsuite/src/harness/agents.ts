import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent'
import type { BakedHarness, EndpointMatch } from '@evalsuite/sandbox-docker'
import type { ResolvedMcpServer } from '../environment/resolve.ts'
import { InfraError } from '../sandbox/types.ts'
import type { AgentHarnessDescriptor, HarnessDescriptor } from '../types.ts'

/** The kind of a real agent's harness, e.g. `cursor`. */
export type AgentKind = AgentHarnessDescriptor['kind']

/** Where an agent reads what the environment gives it. */
export type Layout = {
  /** The workspace file environment `rules` are written to. */
  rulesFile: string
  /** The repo skill directory for `placement: 'workspace'`, relative to the workspace. */
  workspaceSkillDir: string
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

/** Where each agent with an image reads rules and repo skills. */
export const LAYOUTS: Record<BakedHarness, Layout> = {
  cursor: { rulesFile: 'AGENTS.md', workspaceSkillDir: '.cursor/skills' },
  'claude-code': { rulesFile: 'CLAUDE.md', workspaceSkillDir: '.claude/skills' },
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
    mcpServers: acpMcpServers,
    adapter: async (options) => (await import('@ai-sdk/harness-cursor')).createCursor(options),
  },
}

export const isAgentKind = (kind: unknown): kind is AgentKind =>
  typeof kind === 'string' && Object.hasOwn(AGENTS, kind)

/** The catalog entry for a harness's agent; undefined for the fake harness. */
export const agentOf = (h: HarnessDescriptor): Agent | undefined =>
  h.kind === 'fake' ? undefined : AGENTS[h.kind]

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

/** What the Docker egress gateway brokers for a harness: its credential, on its endpoints only. */
export type Brokering = { credential: string; endpoints: readonly EndpointMatch[] }

export function brokeringFor(h: HarnessDescriptor): Brokering | undefined {
  const agent = agentOf(h)
  return agent && { credential: agent.credential, endpoints: agent.endpoints }
}
