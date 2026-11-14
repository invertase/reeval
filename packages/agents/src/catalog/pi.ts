// pi's catalog entry: how its agent reads what it's given, and what it reports.
import type { HarnessCatalogEntry } from './entry.ts'
import { LAYOUTS } from './layouts.ts'
import { piMcpServers } from './mcp.ts'
import { withoutProvider } from './provider-model.ts'
import { piCost } from './reported.ts'

export const pi = {
  ...LAYOUTS.pi,
  // Plugin MCP servers go in its mcp.json with the environment's. It has no subagents.
  pluginParts: ['skills', 'commands', 'mcp'],
  name: 'pi',
  factory: 'pi',
  platforms: ['linux', 'darwin'],
  reasoning: 'streamed',
  reasoningTokens: true,
  reportedCost: piCost,
  modelId: withoutProvider,
  mcpServers: piMcpServers,
} satisfies HarnessCatalogEntry
