type Part = { type: string; [key: string]: unknown }

/** fx's MCP tool name segment: bytes outside `[A-Za-z0-9_-]` become `_`. */
export const fxMcpSegment = (value: string) =>
  value ? Array.from(new TextEncoder().encode(value), fxMcpByte).join('') : 'server'

const fxMcpByte = (byte: number) =>
  (byte >= 48 && byte <= 57) ||
  (byte >= 65 && byte <= 90) ||
  (byte >= 97 && byte <= 122) ||
  byte === 45 ||
  byte === 95
    ? String.fromCharCode(byte)
    : '_'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** The text of an ACP tool call's `content` blocks, or nothing when it has none. */
const contentText = (content: unknown) => {
  if (!Array.isArray(content)) return undefined
  const texts = content.flatMap((block) => {
    const inner = record(record(block).content)
    return inner.type === 'text' && typeof inner.text === 'string' ? [inner.text] : []
  })
  return texts.length ? texts.join('') : undefined
}

/**
 * Fixes up one fx turn's parts from `@ai-sdk/harness-acp`'s bridge:
 *
 * - A command's output streams in its `in_progress` updates; the `completed` update's `content`
 *   is a clipped JSON summary, and its `command_result` has the exit code. A shell result
 *   becomes `{ output, exitCode }` from those.
 * - MCP calls are renamed from fx's `mcp_<server>_<tool>` to `mcp__<server>__<tool>`, as Claude
 *   Code names them, for the servers the session was given. The longest matching server wins,
 *   since a server's name can itself contain `_`.
 */
export class FxStreamTranslator {
  private readonly prefixes: ReadonlyArray<readonly [string, string]>
  private readonly outputs = new Map<string, string>()
  private readonly exitCodes = new Map<string, number>()

  constructor(options: { mcpServers?: readonly string[] } = {}) {
    this.prefixes = (options.mcpServers ?? [])
      .map((name) => [`mcp_${fxMcpSegment(name)}_`, name] as const)
      .sort((a, b) => b[0].length - a[0].length)
  }

  push(part: Part): Part {
    if (part.type === 'raw') {
      this.observe(record(part.rawValue))
      return part
    }
    if (
      (part.type !== 'tool-call' && part.type !== 'tool-result' && part.type !== 'tool-error') ||
      typeof part.toolName !== 'string'
    ) {
      return part
    }
    const name = part.toolName
    const match = this.prefixes.find(([prefix]) => name.startsWith(prefix))
    const out = match
      ? { ...part, toolName: `mcp__${match[1]}__${name.slice(match[0].length)}` }
      : part
    const id = typeof part.toolCallId === 'string' ? part.toolCallId : ''
    if (out.type !== 'tool-result' || out.toolName !== 'bash' || !this.outputs.has(id)) return out
    const exitCode = this.exitCodes.get(id)
    return {
      ...out,
      result: { output: this.outputs.get(id), ...(exitCode === undefined ? {} : { exitCode }) },
    }
  }

  private observe(update: Record<string, unknown>) {
    const id = update.toolCallId
    if (typeof id !== 'string' || update.sessionUpdate !== 'tool_call_update') return
    if (update.status === 'in_progress') {
      const text = contentText(update.content)
      if (text !== undefined) this.outputs.set(id, (this.outputs.get(id) ?? '') + text)
    }
    const exitCode = record(update.command_result).exit_code
    if (typeof exitCode === 'number') {
      this.exitCodes.set(id, exitCode)
      if (!this.outputs.has(id)) this.outputs.set(id, '')
    }
  }
}
