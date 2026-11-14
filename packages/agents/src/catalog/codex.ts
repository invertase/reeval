// Codex's catalog entry: how its agent reads what it's given, and what it reports.
import type { HarnessCatalogEntry } from './entry.ts'
import { LAYOUTS } from './layouts.ts'
import { codexMcpServers } from './mcp.ts'

export const codex = {
  ...LAYOUTS.codex,
  // What Codex's plugin format has besides apps; it installs a plugin whole, from a marketplace.
  pluginParts: ['skills', 'mcp'],
  pluginApps: 'they need a ChatGPT login',
  // Codex 0.164.0 reads a root plugin.json (with an Agent Plugins $schema), then
  // .codex-plugin/plugin.json, then .claude-plugin/plugin.json.
  pluginManifestsFirst: ['plugin.json', '.codex-plugin/plugin.json'],
  pluginRootManifestNeedsSchema: true,
  pluginServersByName: true,
  name: 'Codex',
  factory: 'codex',
  keychainTrust: true,
  platforms: ['linux', 'darwin'],
  // codex exec sends a reasoning item only once it's complete, when it sends one at all.
  reasoning: 'whole',
  reasoningTokens: true,
  storedUsage: async () => {
    const m = await import('@reeval/harness-codex')
    return { command: m.codexStoredUsageCommand, parse: m.parseCodexStoredUsage }
  },
  // Its JSON events carry a command's and an MCP call's whole result; the model gets its start and end.
  fullToolOutput: 'all',
  credential: 'OPENAI_API_KEY',
  mcpServers: codexMcpServers,
} satisfies HarnessCatalogEntry
