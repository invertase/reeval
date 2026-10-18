import { commonTool, type HarnessV1BuiltinTool } from '@ai-sdk/harness'
import { tool } from '@ai-sdk/provider-utils'
import { z } from 'zod'

// biome-ignore lint/suspicious/noExplicitAny: as in the AI SDK's own adapter catalogs
type BuiltinTool = HarnessV1BuiltinTool<any, any>

/*
 * fx's own tools, by the `name` its ACP `tool_call` updates carry, which `@ai-sdk/harness-acp`
 * matches before the title. Each is keyed by the name reeval's transcript reads (`bash`, `write`,
 * `edit`, `webFetch`, `webSearch`); fx's file tools take `path`, not the common `file_path`, so
 * only `bash`, `glob`, `grep` and `webSearch` are common tools. The rest keep fx's names.
 */
export const FX_BUILTIN_TOOLS = {
  bash: commonTool('bash', {
    nativeName: 'shell',
    toolUseKind: 'bash',
    inputSchema: z.looseObject({ command: z.string() }),
  }),
  write: {
    ...tool({ inputSchema: z.looseObject({ path: z.string(), content: z.string() }) }),
    nativeName: 'write_file',
    toolUseKind: 'edit',
  },
  edit: {
    ...tool({
      inputSchema: z.looseObject({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
    }),
    nativeName: 'edit_file',
    toolUseKind: 'edit',
  },
  delete_file: {
    ...tool({ inputSchema: z.looseObject({ path: z.string() }) }),
    toolUseKind: 'edit',
  },
  read: {
    ...tool({ inputSchema: z.looseObject({ path: z.string() }) }),
    nativeName: 'read_file',
    toolUseKind: 'readonly',
  },
  glob: commonTool('glob', {
    nativeName: 'glob_files',
    toolUseKind: 'readonly',
    inputSchema: z.looseObject({ pattern: z.string() }),
  }),
  grep: commonTool('grep', {
    nativeName: 'grep_files',
    toolUseKind: 'readonly',
    inputSchema: z.looseObject({ pattern: z.string() }),
  }),
  webSearch: commonTool('webSearch', {
    nativeName: 'web_search',
    toolUseKind: 'readonly',
    inputSchema: z.looseObject({ query: z.string() }),
  }),
  webFetch: {
    ...tool({ inputSchema: z.looseObject({ url: z.string() }) }),
    nativeName: 'web_fetch',
    toolUseKind: 'readonly',
  },
} as const satisfies Record<string, BuiltinTool>

export type FxBuiltinTools = typeof FX_BUILTIN_TOOLS
