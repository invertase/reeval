// Claude Code's catalog entry: how its agent reads what it's given, and what it reports.
import type { HarnessCatalogEntry } from './entry.ts'
import { LAYOUTS } from './layouts.ts'
import { claudeMcpServers } from './mcp.ts'
import { CLAUDE_FORMAT_PARTS } from './plugins.ts'
import { claudeCodeCost } from './reported.ts'

export const claudeCode = {
  ...LAYOUTS['claude-code'],
  pluginParts: CLAUDE_FORMAT_PARTS,
  name: 'Claude Code',
  factory: 'claudeCode',
  bridgePort: true,
  platforms: ['linux', 'darwin'],
  reasoning: 'streamed',
  reasoningTokens: true,
  subagentCalls: true,
  reportedCost: claudeCodeCost,
  credential: 'ANTHROPIC_API_KEY',
  // A Claude subscription's token from `claude setup-token`, which the CLI sends as a Bearer
  // token on the same endpoints. ANTHROPIC_AUTH_TOKEN isn't one: it's a gateway's key, which
  // api.anthropic.com doesn't take.
  fallbackCredentials: ['CLAUDE_CODE_OAUTH_TOKEN'],
  mcpServers: claudeMcpServers,
} satisfies HarnessCatalogEntry
