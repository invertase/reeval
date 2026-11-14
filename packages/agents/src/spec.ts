// What a harness is given to place for its agent: MCP servers and plugins, as plain data.

/**
 * A part of a plugin, as Claude Code's layout bundles it: `skills/<name>/SKILL.md`,
 * `agents/<name>.md`, `commands/<name>.md`, `hooks/hooks.json`, `.mcp.json` (or the manifest's `mcpServers`) or `rules/`.
 */
export type PluginPart = 'skills' | 'agents' | 'commands' | 'hooks' | 'mcp' | 'rules'

export const PLUGIN_PARTS: readonly PluginPart[] = [
  'skills',
  'agents',
  'commands',
  'hooks',
  'mcp',
  'rules',
]

/** Where the session copies each plugin, under the sandbox's home. */
export const PLUGIN_DIR = '~/.reeval/plugins'

/** An MCP server with its secrets resolved, for the harness adapter. */
export type ResolvedMcpServer =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { transport: 'http' | 'sse'; url: string; headers: Record<string, string> }

/** A plugin the session copied into the sandbox. */
export type PlacedPlugin = { name: string; dir: string; parts: PluginPart[]; servers: string[] }

/** A file a layout writes for the session's plugins. */
export type PluginFile = { path: string; content: string; merge?: true }

/**
 * Where a flat agent reads each part reeval unpacks, relative to the workspace. Unset parts stay
 * in the plugin's copy only; the agent's `pluginParts` decide which parts it may be given.
 */
export type PluginUnpack = {
  /**
   * The rules directory. Each `rules/<file>.md` or `.mdc` lands as `<plugin>-<file>.mdc`, with
   * `alwaysApply: true` frontmatter when it has none, so it applies as a plugin's rules do.
   */
  rules?: string
  /** The subagents directory: `agents/<name>.md` lands as `<name>.md`. */
  agents?: string
  /** The commands directory: `commands/<name>.md` lands as `<name>.md`. */
  commands?: string
  /**
   * A subagent's or command's YAML frontmatter (`{}` when it has none) as the agent takes it,
   * for an agent whose schema refuses Claude Code's keys; unset, the file lands as it is.
   */
  frontmatter?: (part: 'agents' | 'commands', front: Record<string, unknown>) => object
  /** The hooks file, in Cursor's `hooks.json` shape: `{ version: 1, hooks: { <event>: [...] } }`. */
  hooks?: {
    file: string
    /** Each Claude Code hook event the agent runs, as the agent names it. */
    events: Readonly<Record<string, string>>
    /**
     * A Claude Code group's `matcher` (a tool name pattern) for a Claude Code event, as the agent
     * matches it: undefined for every tool, or null when it names no tool the agent has.
     */
    matcher: (event: string, matcher: string | undefined) => string | null | undefined
  }
}
