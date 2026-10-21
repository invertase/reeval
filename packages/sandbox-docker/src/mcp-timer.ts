import { fileURLToPath } from 'node:url'

/**
 * reeval's MCP start-up timer, shipped in the package: a Node script that runs a stdio MCP server
 * and logs when it answers `initialize` (see its header). It runs in any sandbox with `node`.
 */
export const MCP_TIMER = fileURLToPath(new URL('../bin/mcp-timer.cjs', import.meta.url))
