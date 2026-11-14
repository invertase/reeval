// Goose's catalog entry: how its agent reads what it's given, and what it reports.
import type { HarnessCatalogEntry } from './entry.ts'
import { LAYOUTS } from './layouts.ts'
import { gooseMcpServers } from './mcp.ts'
import { withoutProvider } from './provider-model.ts'

export const goose = {
  ...LAYOUTS.goose,
  // Plugin skills join its home skills; plugin MCP servers are extensions in its config.yaml.
  pluginParts: ['skills', 'mcp'],
  name: 'Goose',
  factory: 'goose',
  keychainTrust: true,
  bridgePort: true,
  platforms: ['linux', 'darwin'],
  configuredModelOnStart: true,
  reasoning: 'streamed',
  // The adapter reads each turn's usage from Goose's usage_ledger, which counts thinking tokens
  // in the output without splitting them out.
  reasoningTokens: false,
  storedUsage: async () => {
    const m = await import('@reeval/harness-goose')
    return {
      command: m.gooseStoredUsageCommand,
      parse: m.parseGooseStoredUsage,
      mark: m.gooseUsageMark,
    }
  },
  modelId: withoutProvider,
  mcpServers: gooseMcpServers,
} satisfies HarnessCatalogEntry
