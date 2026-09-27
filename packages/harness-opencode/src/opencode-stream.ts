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

/** OpenCode's name for an MCP server in tool names and Code Mode paths. */
const namespaceOf = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, '_')

/** The text items of an ACP tool call's `content`, joined. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const texts = content.flatMap((item) => {
    const inner = record(record(item).content)
    return record(item).type === 'content' && typeof inner.text === 'string' ? [inner.text] : []
  })
  return texts.length ? texts.join('\n') : undefined
}

/**
 * Fixes up one OpenCode turn's parts from `@ai-sdk/harness-acp`:
 *
 * - A tool's output is `{ output, metadata }`: OpenCode sends the text only in the call's
 *   `content`, and `harness-acp` passes on its `rawOutput`, `{ metadata }`.
 * - Each MCP tool an `execute` call ran (OpenCode offers the servers' tools only through Code
 *   Mode) follows it as its own call, `mcp__<server>__<tool>`, with the status OpenCode reports
 *   and no input or output, which OpenCode doesn't report per call.
 * - A call it couldn't name (`acp_tool_<id>`) is named from OpenCode's first `tool_call` update,
 *   whose title is the tool's name: `shell` (its later titles are the command), or
 *   `<server>_<tool>` for an MCP tool called directly, named `mcp__<server>__<tool>`.
 * - The `finish` part's usage is dropped: OpenCode's ACP `PromptResponse.usage` is its last model
 *   call's, not the turn's, and an undercount is worse than none. Its `usage_update` is no help:
 *   `used` is the last call's context size, and `cost` the whole session's.
 */
export class OpenCodeStreamTranslator {
  private readonly titles = new Map<string, string>()
  private readonly texts = new Map<string, string>()
  private readonly innerCalls = new Map<string, unknown[]>()
  private readonly servers: string[]

  constructor(options: { mcpServers?: readonly string[] } = {}) {
    // Longest first, so a server named `a_b` wins over `a` for `a_b_tool`.
    this.servers = [...(options.mcpServers ?? [])].sort((a, b) => b.length - a.length)
  }

  push(part: Part): Part[] {
    if (part.type === 'raw') {
      this.observe(record(part.rawValue))
      return [part]
    }
    if (part.type === 'finish') return [{ ...part, totalUsage: NO_USAGE }]
    if (part.type !== 'tool-call' && part.type !== 'tool-result' && part.type !== 'tool-error') {
      return [part]
    }
    const id = typeof part.toolCallId === 'string' ? part.toolCallId : ''
    let out = part
    if (typeof part.toolName === 'string' && part.toolName.startsWith('acp_tool_')) {
      const name = this.nameFor(this.titles.get(id))
      if (name) out = { ...out, toolName: name }
    }
    if (part.type !== 'tool-result') return [out]
    const text = this.texts.get(id)
    const output = record(out.output)
    if (text !== undefined && typeof output.output !== 'string') {
      out = { ...out, output: { ...output, output: text } }
    }
    return out.toolName === 'execute' ? [out, ...this.mcpCalls(id)] : [out]
  }

  private observe(update: Record<string, unknown>) {
    const id = update.toolCallId
    if (typeof id !== 'string') return
    if (update.sessionUpdate === 'tool_call' && typeof update.title === 'string') {
      this.titles.set(id, update.title)
    }
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const text = contentText(update.content)
    if (text !== undefined) this.texts.set(id, text)
    const calls = record(record(update.rawOutput).metadata).toolCalls
    if (Array.isArray(calls)) this.innerCalls.set(id, calls)
  }

  /** The MCP calls an `execute` call made, as calls of their own after it. */
  private mcpCalls(id: string): Part[] {
    return (this.innerCalls.get(id) ?? []).flatMap((call, i) => {
      const { tool, status } = record(call)
      if (typeof tool !== 'string') return []
      const server = this.servers.find((s) => tool.startsWith(`${namespaceOf(s)}.`))
      if (!server) return []
      const toolName = `mcp__${server}__${tool.slice(namespaceOf(server).length + 1)}`
      const toolCallId = `${id}/${i}`
      const call_ = { type: 'tool-call', toolCallId, toolName, input: {}, providerExecuted: true }
      return [
        call_,
        status === 'completed'
          ? { type: 'tool-result', toolCallId, toolName, output: { status } }
          : { type: 'tool-error', toolCallId, toolName, error: `${tool}: ${String(status)}` },
      ]
    })
  }

  private nameFor(title: string | undefined): string | undefined {
    if (!title) return undefined
    const builtin = BUILTIN_BY_NATIVE.get(title)
    if (builtin) return builtin
    const server = this.servers.find((s) => title.startsWith(`${namespaceOf(s)}_`))
    return server ? `mcp__${server}__${title.slice(namespaceOf(server).length + 1)}` : undefined
  }
}
