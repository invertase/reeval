// fx's catalog entry: how its agent reads what it's given, and what it reports.
import type { HarnessCatalogEntry } from './entry.ts'
import { LAYOUTS } from './layouts.ts'
import { fxMcpServers } from './mcp.ts'

export const fx = {
  ...LAYOUTS.fx,
  // Plugin MCP servers go over ACP with the environment's. It reads no subagents or commands
  // from files.
  pluginParts: ['skills', 'mcp'],
  name: 'fx',
  factory: 'fx',
  bridgePort: true,
  platforms: ['linux', 'darwin'],
  configuredModelOnStart: true,
  reasoning: 'streamed',
  reasoningTokens: 'provider',
  // A command's output is rebuilt from its streamed updates; the model gets a clipped summary.
  fullToolOutput: ['bash'],
  mcpServers: fxMcpServers,
} satisfies HarnessCatalogEntry
