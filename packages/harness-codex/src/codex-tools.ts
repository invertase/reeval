import { commonTool, type HarnessV1BuiltinTool } from '@ai-sdk/harness'
import { tool } from '@ai-sdk/provider-utils'
import { z } from 'zod'

// biome-ignore lint/suspicious/noExplicitAny: as in the AI SDK's own adapter catalogs
type BuiltinTool = HarnessV1BuiltinTool<any, any>

/*
 * The tools Codex's `exec --json` items report, as the adapter names them: a
 * `command_execution` is `bash`, and each path of a `file_change` is `write` (added), `edit`
 * (updated) or `delete`, with the path relative to the workspace. A `web_search` is `webSearch`,
 * or `webFetch` when the model opened a page; an `mcp_tool_call` is `mcp__<server>__<tool>`.
 */
export const CODEX_BUILTIN_TOOLS = {
  bash: {
    ...commonTool('bash', {
      nativeName: 'shell',
      toolUseKind: 'bash',
      inputSchema: z.looseObject({ command: z.string() }),
    }),
    title: 'shell',
  },
  write: {
    ...tool({ title: 'apply_patch (add)', inputSchema: z.looseObject({ path: z.string() }) }),
    toolUseKind: 'edit',
  },
  edit: {
    ...tool({ title: 'apply_patch (update)', inputSchema: z.looseObject({ path: z.string() }) }),
    toolUseKind: 'edit',
  },
  delete: {
    ...tool({ title: 'apply_patch (delete)', inputSchema: z.looseObject({ path: z.string() }) }),
    toolUseKind: 'edit',
  },
  webSearch: {
    ...commonTool('webSearch', {
      nativeName: 'web_search',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ query: z.string() }),
    }),
    title: 'web_search',
  },
  webFetch: {
    ...tool({ title: 'web_search (open_page)', inputSchema: z.looseObject({ url: z.string() }) }),
    toolUseKind: 'readonly',
  },
} as const satisfies Record<string, BuiltinTool>

export type CodexBuiltinTools = typeof CODEX_BUILTIN_TOOLS
