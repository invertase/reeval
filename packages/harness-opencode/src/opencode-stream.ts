import { OPENCODE_BUILTIN_TOOLS } from './opencode-tools.ts'

type Part = { type: string; [key: string]: unknown }

/** The builtin's key for each name OpenCode gives its tools. */
const BUILTIN_BY_NATIVE = new Map<string, string>(
  Object.entries(OPENCODE_BUILTIN_TOOLS).map(([key, t]) => [
    'nativeName' in t && typeof t.nativeName === 'string' ? t.nativeName : key,
    key,
  ]),
)

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
 * Fixes up one OpenCode turn's parts from `@ai-sdk/harness-acp`:
 *
 * - A call it couldn't name (`acp_tool_<id>`) is named from OpenCode's first `tool_call` update,
 *   whose title is the tool's name: `bash` (its later titles are the command), or
 *   `<server>_<tool>` for an MCP tool, named `mcp__<server>__<tool>`.
 * - The `finish` part's usage is dropped: OpenCode's ACP `PromptResponse.usage` is its last model
 *   call's, not the turn's, and an undercount is worse than none.
 */
export class OpenCodeStreamTranslator {
  private readonly titles = new Map<string, string>()
  private readonly servers: string[]

  constructor(options: { mcpServers?: readonly string[] } = {}) {
    // Longest first, so a server named `a_b` wins over `a` for `a_b_tool`.
    this.servers = [...(options.mcpServers ?? [])].sort((a, b) => b.length - a.length)
  }

  push(part: Part): Part {
    if (part.type === 'raw') {
      const update = record(part.rawValue)
      if (update.sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string') {
        if (typeof update.title === 'string') this.titles.set(update.toolCallId, update.title)
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
      const name = this.nameFor(this.titles.get(part.toolCallId))
      if (name) return { ...part, toolName: name }
    }
    return part
  }

  private nameFor(title: string | undefined): string | undefined {
    if (!title) return undefined
    const builtin = BUILTIN_BY_NATIVE.get(title)
    if (builtin) return builtin
    const server = this.servers.find((s) => title.startsWith(`${s}_`))
    return server ? `mcp__${server}__${title.slice(server.length + 1)}` : undefined
  }
}
