import { commonTool, type HarnessV1BuiltinTool } from '@ai-sdk/harness'
import { tool } from '@ai-sdk/provider-utils'
import { z } from 'zod'

// biome-ignore lint/suspicious/noExplicitAny: as in the AI SDK's own adapter catalogs
type BuiltinTool = HarnessV1BuiltinTool<any, any>

/*
 * pi 0.99.1's built-in tools, from its `--mode json` events. read, write and edit take `path`, not
 * the common `file_path`, so they aren't common tools; edit takes a list of `edits`.
 */
export const PI_BUILTIN_TOOLS = {
  bash: {
    ...commonTool('bash', {
      nativeName: 'bash',
      toolUseKind: 'bash',
      inputSchema: z.looseObject({ command: z.string(), timeout: z.number().optional() }),
    }),
    title: 'bash',
  },
  read: {
    ...tool({ title: 'read', inputSchema: z.looseObject({ path: z.string() }) }),
    toolUseKind: 'readonly',
  },
  write: {
    ...tool({
      title: 'write',
      inputSchema: z.looseObject({ path: z.string(), content: z.string() }),
    }),
    toolUseKind: 'edit',
  },
  edit: {
    ...tool({
      title: 'edit',
      inputSchema: z.looseObject({
        path: z.string(),
        edits: z.array(z.looseObject({ oldText: z.string(), newText: z.string() })),
      }),
    }),
    toolUseKind: 'edit',
  },
} as const satisfies Record<string, BuiltinTool>

export type PiBuiltinTools = typeof PI_BUILTIN_TOOLS
