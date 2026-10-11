import { commonTool, type HarnessV1BuiltinTool } from '@ai-sdk/harness'
import { tool } from '@ai-sdk/provider-utils'
import { z } from 'zod'

// biome-ignore lint/suspicious/noExplicitAny: as in the AI SDK's own adapter catalogs
type BuiltinTool = HarnessV1BuiltinTool<any, any>

/*
 * Goose 1.54.0's developer extension, from its ACP `tool_call` updates: the title is
 * `<tool> · <target>` (`shell · cat a.txt`), which `@ai-sdk/harness-acp` matches by prefix.
 * write and edit take `path`, not the common `file_path`, so they aren't common tools. Its other
 * tools keep Goose's own names (see GooseStreamTranslator).
 */
export const GOOSE_BUILTIN_TOOLS = {
  bash: {
    ...commonTool('bash', {
      nativeName: 'shell',
      toolUseKind: 'bash',
      inputSchema: z.looseObject({ command: z.string() }),
    }),
    title: 'shell',
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
      inputSchema: z.looseObject({ path: z.string(), before: z.string(), after: z.string() }),
    }),
    toolUseKind: 'edit',
  },
} as const satisfies Record<string, BuiltinTool>

export type GooseBuiltinTools = typeof GOOSE_BUILTIN_TOOLS
