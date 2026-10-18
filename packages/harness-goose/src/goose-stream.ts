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

/**
 * How Goose words a failed model call (a refused key, a 5xx) when it reports it as the turn's
 * message and ends the turn normally, in its own template rather than the model's words.
 */
const GOOSE_ERROR =
  /^Ran into this error: ([\s\S]*?)\.?\n\nPlease retry if you think this is a transient or recoverable error\.$/

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const record = (value: unknown): Record<string, unknown> => (isObjectLike(value) ? value : {})

/**
 * Fixes up one Goose turn's parts from `@ai-sdk/harness-acp`:
 *
 * - A call it couldn't name (`acp_tool_<id>`) is named from the `_meta.goose.toolCall` of Goose's
 *   `tool_call` update: an MCP server's tool (`stamp__house_stamp` from extension `stamp`) as
 *   `mcp__stamp__house_stamp`, Goose's own by its name (`tree`, `extensionmanager__…`).
 * - The `finish` part's usage is dropped: Goose's ACP `PromptResponse.usage` is its last model
 *   call's, not the turn's, and an undercount is worse than none.
 * - A failed model call, which Goose sends as a message in its error template, is an `error`
 *   part instead of the turn's text, so the turn fails rather than completing.
 */
export class GooseStreamTranslator {
  private readonly names = new Map<string, string>()
  /** Messages in Goose's error template, by id, with the error they report. */
  private readonly failures = new Map<string, string>()
  private readonly reported = new Set<string>()
  private readonly servers: ReadonlySet<string>

  constructor(options: { mcpServers?: readonly string[] } = {}) {
    this.servers = new Set(options.mcpServers)
  }

  push(part: Part): Part {
    if (part.type === 'raw') {
      const update = record(part.rawValue)
      const content = record(update.content)
      if (
        update.sessionUpdate === 'agent_message_chunk' &&
        typeof update.messageId === 'string' &&
        typeof content.text === 'string'
      ) {
        const failure = GOOSE_ERROR.exec(content.text)
        if (failure) this.failures.set(update.messageId, failure[1] as string)
      }
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
    const id = part.id
    const failure = typeof id === 'string' ? this.failures.get(id) : undefined
    if (typeof id === 'string' && failure !== undefined) {
      if (part.type === 'text-delta' && !this.reported.has(id)) {
        this.reported.add(id)
        return { type: 'error', error: new Error(`Goose's model call failed: ${failure}`) }
      }
      if (part.type === 'text-delta') return { type: 'raw', rawValue: { replaced: part } }
      if (part.type === 'text-start' || part.type === 'text-end') {
        return { type: 'raw', rawValue: { replaced: part } }
      }
    }
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
