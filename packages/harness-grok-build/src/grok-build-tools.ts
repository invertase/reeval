import { commonTool, type HarnessV1BuiltinTool } from '@ai-sdk/harness'
import { tool } from '@ai-sdk/provider-utils'
import { z } from 'zod'

// biome-ignore lint/suspicious/noExplicitAny: as in the AI SDK's own adapter catalogs
type BuiltinTool = HarnessV1BuiltinTool<any, any>

/*
 * Grok Build's tools, by the name its ACP `tool_call` updates carry in `_meta['x.ai/tool'].name`,
 * which `@ai-sdk/harness-acp` matches against each tool's name and `nativeName`. Its other tools
 * keep Grok's own names, and an MCP server's tool, which Grok calls through `use_tool`, is
 * `mcp__<server>__<tool>` (see GrokBuildStreamTranslator).
 */
export const GROK_BUILD_BUILTIN_TOOLS = {
  bash: commonTool('bash', {
    nativeName: 'run_terminal_command',
    toolUseKind: 'bash',
    inputSchema: z.looseObject({ command: z.string() }),
  }),
  write: commonTool('write', {
    nativeName: 'write',
    toolUseKind: 'edit',
    inputSchema: z.looseObject({ file_path: z.string(), content: z.string() }),
  }),
  edit: commonTool('edit', {
    nativeName: 'search_replace',
    toolUseKind: 'edit',
    inputSchema: z.looseObject({
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
    }),
  }),
  grep: commonTool('grep', {
    nativeName: 'grep',
    toolUseKind: 'readonly',
    inputSchema: z.looseObject({ pattern: z.string() }),
  }),
  webSearch: commonTool('webSearch', {
    nativeName: 'web_search',
    toolUseKind: 'readonly',
    inputSchema: z.looseObject({ query: z.string() }),
  }),
  read_file: {
    ...tool({ inputSchema: z.looseObject({ target_file: z.string() }) }),
    toolUseKind: 'readonly',
  },
  list_dir: {
    ...tool({ inputSchema: z.looseObject({ target_directory: z.string() }) }),
    toolUseKind: 'readonly',
  },
  // Finds an MCP server's tool, by name and description, before `use_tool` calls it.
  search_tool: {
    ...tool({ inputSchema: z.looseObject({ query: z.string() }) }),
    toolUseKind: 'readonly',
  },
  spawn_subagent: tool({
    inputSchema: z.looseObject({ prompt: z.string(), subagent_type: z.string().optional() }),
  }),
} as const satisfies Record<string, BuiltinTool>

export type GrokBuildBuiltinTools = typeof GROK_BUILD_BUILTIN_TOOLS
