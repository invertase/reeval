type Part = { type: string; [key: string]: unknown }

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const record = (value: unknown): Record<string, unknown> => (isObjectLike(value) ? value : {})
const count = (value: unknown) => (typeof value === 'number' ? value : undefined)

/**
 * The turn's usage from Grok's `PromptResponse._meta.usage`, its sum over the turn's model calls
 * (`_meta.inputTokens` and the rest beside it are the last call's). Its `inputTokens` counts the
 * cached ones. Its `totalTokens` is the API's `total_tokens` summed, so reasoning tokens are part
 * of `outputTokens` when the total is input plus output, and on top of it when the total is more.
 */
export function grokTurnUsage(usage: Record<string, unknown>) {
  const input = count(usage.inputTokens)
  const output = count(usage.outputTokens)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = count(usage.cachedReadTokens)
  const cacheWrite = count(usage.cacheCreationTokens)
  const reasoning = count(usage.reasoningTokens)
  const total = count(usage.totalTokens)
  const reasoningApart = reasoning !== undefined && total !== undefined && total > input + output
  return {
    inputTokens: {
      total: input,
      noCache: input - (cacheRead ?? 0),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: reasoningApart ? output + reasoning : output,
      text: reasoningApart || reasoning === undefined ? output : output - reasoning,
      reasoning,
    },
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

/**
 * A tool result's text from Grok's `rawOutput`, which is an object per tool: a command's combined
 * output as bytes, a file read without its line numbers, an edit's or search's own summary, an MCP
 * tool's one result variant. Any other shape is kept as it is.
 */
export function grokToolOutput(output: unknown): unknown {
  const value = record(output)
  switch (value.type) {
    case 'Bash': {
      const bytes = value.output
      if (Array.isArray(bytes) && bytes.every((b) => typeof b === 'number')) {
        return new TextDecoder().decode(Uint8Array.from(bytes))
      }
      return text(value.output_for_prompt) ?? output
    }
    case 'ReadFile': {
      const file = record(value.FileContent)
      return text(file.raw_output) ?? text(file.content) ?? output
    }
    case 'SearchReplace':
      return text(record(value.EditsApplied).tool_output_for_prompt) ?? output
    case 'SearchTool':
      return text(value.content) ?? output
    case 'MCP': {
      const variants = Object.values(record(value.output))
      return (variants.length === 1 && text(variants[0])) || output
    }
    default:
      return output
  }
}

/**
 * Fixes up one Grok Build turn's parts from `@ai-sdk/harness-acp`:
 *
 * - A call it couldn't name (`acp_tool_<id>`) is named from `_meta['x.ai/tool'].name` on Grok's
 *   `tool_call` update, and a `use_tool` call of an MCP server's tool (`tool_name`
 *   `stamp__house_stamp`, server `stamp`) is `mcp__stamp__house_stamp`, with its `tool_input`
 *   as the input.
 * - A tool result's output is its text (see grokToolOutput).
 * - The `finish` part's usage is the turn's, from the prompt response's `_meta.usage`: Grok sends
 *   no ACP `usage`, so `@ai-sdk/harness-acp` reports none.
 */
export class GrokBuildStreamTranslator {
  private readonly names = new Map<string, { name: string; input?: unknown }>()
  private readonly servers: readonly string[]
  private usage: ReturnType<typeof grokTurnUsage>

  constructor(options: { mcpServers?: readonly string[] } = {}) {
    this.servers = [...(options.mcpServers ?? [])].sort((a, b) => b.length - a.length)
  }

  push(part: Part): Part {
    const named = this.name(part)
    if (named.type !== 'tool-result') return named
    return 'result' in named
      ? { ...named, result: grokToolOutput(named.result) }
      : { ...named, output: grokToolOutput(named.output) }
  }

  private name(part: Part): Part {
    if (part.type === 'raw') {
      const value = record(part.rawValue)
      if (typeof value.stopReason === 'string' && isObjectLike(record(value._meta).usage)) {
        this.usage = grokTurnUsage(record(record(value._meta).usage))
      }
      if (
        (value.sessionUpdate === 'tool_call' || value.sessionUpdate === 'tool_call_update') &&
        typeof value.toolCallId === 'string'
      ) {
        this.learn(value.toolCallId, value)
      }
      return part
    }
    if (part.type === 'finish') {
      const total = record(record(part.totalUsage).inputTokens).total
      return this.usage && total === undefined ? { ...part, totalUsage: this.usage } : part
    }
    if (
      (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'tool-error') &&
      typeof part.toolName === 'string' &&
      part.toolName.startsWith('acp_tool_') &&
      typeof part.toolCallId === 'string'
    ) {
      const named = this.names.get(part.toolCallId)
      if (!named) return part
      return part.type === 'tool-call' && named.input !== undefined
        ? { ...part, toolName: named.name, input: JSON.stringify(named.input) }
        : { ...part, toolName: named.name }
    }
    return part
  }

  private learn(id: string, update: Record<string, unknown>) {
    const native = record(record(update._meta)['x.ai/tool']).name
    if (typeof native !== 'string') return
    const input = record(update.rawInput)
    if (native === 'use_tool' && typeof input.tool_name === 'string') {
      const target = input.tool_name
      const server = this.servers.find((s) => target.startsWith(`${s}__`))
      if (server) {
        this.names.set(id, {
          name: `mcp__${server}__${target.slice(server.length + 2)}`,
          input: input.tool_input ?? {},
        })
        return
      }
    }
    if (!this.names.has(id)) this.names.set(id, { name: native })
  }
}
