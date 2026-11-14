// Grok Build's catalog entry: how its agent reads what it's given, and what it reports.
import type { HarnessCatalogEntry } from './entry.ts'
import { LAYOUTS } from './layouts.ts'
import { acpMcpServers } from './mcp.ts'
import { CLAUDE_FORMAT_PARTS } from './plugins.ts'

export const grokBuild = {
  ...LAYOUTS['grok-build'],
  pluginParts: CLAUDE_FORMAT_PARTS,
  pluginServersByName: true,
  name: 'Grok Build',
  factory: 'grokBuild',
  keychainTrust: true,
  bridgePort: true,
  platforms: ['linux', 'darwin'],
  configuredModelOnStart: true,
  reasoning: 'streamed',
  reasoningTokens: true,
  storedUsage: async () => {
    const m = await import('@reeval/harness-grok-build')
    return { command: m.grokStoredUsageCommand, parse: m.parseGrokStoredUsage }
  },
  credential: 'XAI_API_KEY',
  mcpServers: acpMcpServers,
} satisfies HarnessCatalogEntry
