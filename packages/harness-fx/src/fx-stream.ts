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

/**
 * Renames one fx turn's MCP calls from fx's `mcp_<server>_<tool>` to `mcp__<server>__<tool>`, as
 * Claude Code names them, for the servers the session was given. The longest matching server
 * wins, since a server's name can itself contain `_`.
 */
export class FxStreamTranslator {
  private readonly prefixes: ReadonlyArray<readonly [string, string]>

  constructor(options: { mcpServers?: readonly string[] } = {}) {
    this.prefixes = (options.mcpServers ?? [])
      .map((name) => [`mcp_${fxMcpSegment(name)}_`, name] as const)
      .sort((a, b) => b[0].length - a[0].length)
  }

  push(part: Part): Part {
    if (
      (part.type !== 'tool-call' && part.type !== 'tool-result' && part.type !== 'tool-error') ||
      typeof part.toolName !== 'string'
    ) {
      return part
    }
    const name = part.toolName
    const match = this.prefixes.find(([prefix]) => name.startsWith(prefix))
    return match ? { ...part, toolName: `mcp__${match[1]}__${name.slice(match[0].length)}` } : part
  }
}
