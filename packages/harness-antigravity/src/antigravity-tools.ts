import { commonTool, type HarnessV1BuiltinTool } from '@ai-sdk/harness'
import { tool } from '@ai-sdk/provider-utils'
import { z } from 'zod'

/** Any built-in, whatever its input: inputs vary per tool, so the catalog can't name one. */
// biome-ignore lint/suspicious/noExplicitAny: as in the AI SDK's own adapter catalogs
type BuiltinTool = HarnessV1BuiltinTool<any, any>

const native = (
  nativeName: string,
  title: string,
  toolUseKind?: 'readonly' | 'edit' | 'bash',
): BuiltinTool => ({
  ...tool({ title, inputSchema: z.looseObject({}) }),
  nativeName,
  ...(toolUseKind ? { toolUseKind } : {}),
})

/*
 * Names and parameter keys from the CLI's `stream-json` output (`step_update.tool_info`).
 * The CLI reports only some parameters (never file contents), so the common-name schemas keep
 * everything else optional.
 */
export const ANTIGRAVITY_BUILTIN_TOOLS = {
  bash: {
    ...commonTool('bash', {
      nativeName: 'run_command',
      toolUseKind: 'bash',
      inputSchema: z.looseObject({ command: z.string(), Cwd: z.string().optional() }),
    }),
    title: 'Run Command',
  },
  read: {
    ...commonTool('read', {
      nativeName: 'view_file',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ file_path: z.string() }),
    }),
    title: 'View File',
  },
  write: {
    ...commonTool('write', {
      nativeName: 'write_to_file',
      toolUseKind: 'edit',
      inputSchema: z.looseObject({ file_path: z.string(), content: z.string().optional() }),
    }),
    title: 'Write File',
  },
  edit: {
    ...commonTool('edit', {
      nativeName: 'replace_file_content',
      toolUseKind: 'edit',
      inputSchema: z.looseObject({
        file_path: z.string(),
        old_string: z.string().optional(),
        new_string: z.string().optional(),
      }),
    }),
    title: 'Edit File',
  },
  grep: {
    ...commonTool('grep', {
      nativeName: 'grep_search',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ pattern: z.string(), path: z.string().optional() }),
    }),
    title: 'Grep Search',
  },
  glob: {
    ...commonTool('glob', {
      nativeName: 'find_by_name',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ pattern: z.string() }),
    }),
    title: 'Find By Name',
  },
  webSearch: {
    ...commonTool('webSearch', {
      nativeName: 'search_web',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ query: z.string() }),
    }),
    title: 'Search Web',
  },
  webFetch: {
    ...tool({ title: 'Read URL', inputSchema: z.looseObject({ url: z.string() }) }),
    nativeName: 'read_url_content',
    toolUseKind: 'readonly',
  },
  list_dir: native('list_dir', 'List Directory', 'readonly'),
  command_status: native('command_status', 'Command Status', 'readonly'),
  send_command_input: native('send_command_input', 'Send Command Input', 'bash'),
  call_mcp_tool: native('call_mcp_tool', 'Call MCP Tool'),
  generate_image: native('generate_image', 'Generate Image'),
  invoke_subagent: native('invoke_subagent', 'Invoke Subagent'),
  browser_subagent: native('browser_subagent', 'Browser Subagent'),
  notebook_edit: native('notebook_edit', 'Edit Notebook', 'edit'),
  ask_question: native('ask_question', 'Ask Question'),
  list_plugin_accounts: native('list_plugin_accounts', 'List Plugin Accounts'),
  search_marketplace: native('search_marketplace', 'Search Marketplace'),
} as const satisfies Record<string, BuiltinTool>

export type AntigravityBuiltinTools = typeof ANTIGRAVITY_BUILTIN_TOOLS

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** Native edit tools that all surface as `edit`, since the key must be unique. */
const EDIT_TOOLS = new Set(['replace_file_content', 'multi_replace_file_content', 'sed_file'])

const BY_NATIVE_NAME = new Map<string, string>(
  Object.entries(ANTIGRAVITY_BUILTIN_TOOLS).map(([key, t]) => [
    (t as BuiltinTool).nativeName ?? key,
    key,
  ]),
)

export type ProjectedToolCall = {
  /** The key in {@link ANTIGRAVITY_BUILTIN_TOOLS}, or the native name for tools outside it. */
  toolName: string
  nativeName: string
  /** Native parameters, plus the common-schema fields when the tool has a common name. */
  input: Record<string, unknown>
  /** Tools outside the catalog are reported as dynamic, so they aren't validated as builtins. */
  dynamic: boolean
}

/** Maps a native tool call to its catalog name, adding the common-schema fields it implies. */
export function projectToolCall(
  nativeName: string,
  parameters: Record<string, unknown> = {},
): ProjectedToolCall {
  const p = parameters
  const common = (toolName: string, extra: Record<string, unknown>): ProjectedToolCall => ({
    toolName,
    nativeName,
    input: { ...p, ...extra },
    dynamic: false,
  })
  if (EDIT_TOOLS.has(nativeName)) {
    return common('edit', { file_path: str(p.TargetFile) ?? str(p.AbsolutePath) ?? '' })
  }
  // MCP tools go by `mcp__<server>__<tool>` on every harness, not by the CLI's one generic tool.
  const server = str(p.ServerName)
  const mcpTool = str(p.ToolName)
  if (nativeName === 'call_mcp_tool' && server && mcpTool) {
    return { toolName: `mcp__${server}__${mcpTool}`, nativeName, input: { ...p }, dynamic: true }
  }
  switch (nativeName) {
    case 'run_command':
      return common('bash', { command: str(p.CommandLine) ?? str(p.command) ?? '' })
    case 'view_file':
      return common('read', { file_path: str(p.AbsolutePath) ?? str(p.TargetFile) ?? '' })
    case 'write_to_file':
      return common('write', { file_path: str(p.TargetFile) ?? '' })
    case 'grep_search':
      return common('grep', {
        pattern: str(p.Query) ?? str(p.Pattern) ?? str(p.query) ?? '',
        ...(str(p.SearchPath) ? { path: p.SearchPath } : {}),
      })
    case 'find_by_name':
      return common('glob', { pattern: str(p.Pattern) ?? str(p.pattern) ?? '' })
    case 'search_web':
      return common('webSearch', { query: str(p.query) ?? str(p.Query) ?? '' })
    case 'read_url_content':
      return common('webFetch', { url: str(p.Url) ?? str(p.url) ?? '' })
    // A `tool` step's call, in the shape the translator gives a `subagent` step's: the CLI reports
    // the same call either way.
    case 'invoke_subagent':
      if (!Array.isArray(p.Subagents)) break
      return {
        toolName: 'invoke_subagent',
        nativeName,
        input: {
          ...p,
          subagents: p.Subagents.map((a: Record<string, unknown> | null) => ({
            agent: str(a?.TypeName),
            role: str(a?.Role),
            prompt: str(a?.Prompt),
          })),
        },
        dynamic: false,
      }
  }
  const key = BY_NATIVE_NAME.get(nativeName)
  return key
    ? { toolName: key, nativeName, input: { ...p }, dynamic: false }
    : { toolName: nativeName, nativeName, input: { ...p }, dynamic: true }
}
