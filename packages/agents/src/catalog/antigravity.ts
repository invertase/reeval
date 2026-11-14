// Antigravity's catalog entry: how its agent reads what it's given, and what it reports.

import { PLUGIN_PARTS } from '../spec.ts'
import type { HarnessCatalogEntry } from './entry.ts'
import { LAYOUTS } from './layouts.ts'
import { antigravityMcpServers } from './mcp.ts'

export const antigravity = {
  ...LAYOUTS.antigravity,
  pluginParts: PLUGIN_PARTS,
  // agy 1.4.2 installs a plugin as a native one when it has any of these, under that manifest's
  // name and paths.
  pluginManifestsFirst: [
    'plugin.json',
    '.antigravity-plugin/plugin.json',
    '.gemini-plugin/plugin.json',
    'gemini-extension.json',
  ],
  name: 'Antigravity',
  factory: 'antigravity',
  keychainTrust: true,
  platforms: ['linux', 'darwin'],
  // agy's stream-json has only each step's `thinking_tokens`; the adapter reads the thought
  // summaries and their `thinking_duration` from agy's stored conversation after each turn.
  reasoning: 'recovered',
  reasoningTokens: true,
  // A Gemini API key, never the CLI's Google sign-in: automating that session risks the account.
  credential: 'GEMINI_API_KEY',
  mcpServers: antigravityMcpServers,
} satisfies HarnessCatalogEntry
