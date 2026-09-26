type Part = { type: string; [key: string]: unknown }

const NO_USAGE = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/**
 * Fixes up one Goose turn's parts from `@ai-sdk/harness-acp`:
 *
 * - A call it couldn't name (`acp_tool_<id>`) is named from the `_meta.goose.toolCall` of Goose's
 *   `tool_call` update: an MCP server's tool (`stamp__house_stamp` from extension `stamp`) as
 *   `mcp__stamp__house_stamp`, Goose's own by its name (`tree`, `extensionmanager__…`).
 * - The `finish` part's usage is dropped: Goose's ACP `PromptResponse.usage` is its last model
 *   call's, not the turn's, and an undercount is worse than none.
 */
export class GooseStreamTranslator {
  private readonly names = new Map<string, string>()
  private readonly servers: ReadonlySet<string>

  constructor(options: { mcpServers?: readonly string[] } = {}) {
    this.servers = new Set(options.mcpServers)
  }

  push(part: Part): Part {
    if (part.type === 'raw') {
      const update = record(part.rawValue)
      const call = record(record(record(update._meta).goose).toolCall)
      if (
        update.sessionUpdate === 'tool_call' &&
        typeof update.toolCallId === 'string' &&
        typeof call.toolName === 'string' &&
        typeof call.extensionName === 'string'
      ) {
        const ext = call.extensionName
        const tool = call.toolName.startsWith(`${ext}__`)
          ? call.toolName.slice(ext.length + 2)
          : call.toolName
        this.names.set(
          update.toolCallId,
          this.servers.has(ext) ? `mcp__${ext}__${tool}` : call.toolName,
        )
      }
      return part
    }
    if (part.type === 'finish') return { ...part, totalUsage: NO_USAGE }
    if (
      (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'tool-error') &&
      typeof part.toolName === 'string' &&
      part.toolName.startsWith('acp_tool_') &&
      typeof part.toolCallId === 'string'
    ) {
      const name = this.names.get(part.toolCallId)
      if (name) return { ...part, toolName: name }
    }
    return part
  }
}
