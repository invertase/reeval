// OpenCode's catalog entry: how its agent reads what it's given, and what it reports.
import type { HarnessCatalogEntry } from './entry.ts'
import { LAYOUTS } from './layouts.ts'
import { opencodeMcpServers } from './mcp.ts'

export const opencode = {
  ...LAYOUTS.opencode,
  // Plugin MCP servers go in its config with the environment's.
  pluginParts: ['skills', 'agents', 'commands', 'mcp'],
  name: 'OpenCode',
  factory: 'opencode',
  bridgePort: true,
  platforms: ['linux', 'darwin'],
  configuredModelOnStart: true,
  reasoning: 'streamed',
  reasoningTokens: 'provider',
  storedUsage: async () => {
    const m = await import('@reeval/harness-opencode')
    return { command: m.openCodeStoredUsageCommand, parse: m.parseOpenCodeStoredUsage }
  },
  mcpServers: opencodeMcpServers,
} satisfies HarnessCatalogEntry
