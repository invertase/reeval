import { commonTool, type HarnessV1BuiltinTool } from '@ai-sdk/harness'
import { tool } from '@ai-sdk/provider-utils'
import { z } from 'zod'

// biome-ignore lint/suspicious/noExplicitAny: as in the AI SDK's own adapter catalogs
type BuiltinTool = HarnessV1BuiltinTool<any, any>

const native = (title: string, toolUseKind?: 'readonly' | 'edit' | 'bash'): BuiltinTool => ({
  ...tool({ title, inputSchema: z.looseObject({}) }),
  ...(toolUseKind ? { toolUseKind } : {}),
})

/*
 * Captured from OpenCode 1.18.32's ACP `tool_call` updates. `@ai-sdk/harness-acp` names a call
 * when it first has input, when OpenCode's title is still the tool's name, except for `bash`,
 * whose title is already the command: that one is matched by its `command` input instead.
 * read, write and edit take `filePath`, not the common `file_path`, so they aren't common tools.
 * There's no websearch: OpenCode offers it only on its own provider or with Exa or Parallel
 * enabled, and the adapter runs it on `google` with neither.
 */
export const OPENCODE_BUILTIN_TOOLS = {
  bash: {
    ...commonTool('bash', {
      nativeName: 'bash',
      toolUseKind: 'bash',
      inputSchema: z.looseObject({ command: z.string(), description: z.string().optional() }),
    }),
    title: 'bash',
  },
  read: {
    ...tool({
      title: 'read',
      inputSchema: z.looseObject({ filePath: z.string(), offset: z.number().optional() }),
    }),
    toolUseKind: 'readonly',
  },
  write: {
    ...tool({
      title: 'write',
      inputSchema: z.looseObject({ filePath: z.string(), content: z.string() }),
    }),
    toolUseKind: 'edit',
  },
  edit: {
    ...tool({
      title: 'edit',
      inputSchema: z.looseObject({
        filePath: z.string(),
        oldString: z.string(),
        newString: z.string(),
      }),
    }),
    toolUseKind: 'edit',
  },
  glob: {
    ...commonTool('glob', {
      nativeName: 'glob',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ pattern: z.string(), path: z.string().optional() }),
    }),
    title: 'glob',
  },
  grep: {
    ...commonTool('grep', {
      nativeName: 'grep',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ pattern: z.string(), include: z.string().optional() }),
    }),
    title: 'grep',
  },
  webFetch: {
    ...tool({ title: 'webfetch', inputSchema: z.looseObject({ url: z.string() }) }),
    nativeName: 'webfetch',
    toolUseKind: 'readonly',
  },
  todowrite: native('todowrite'),
  task: native('task'),
  skill: native('skill', 'readonly'),
} as const satisfies Record<string, BuiltinTool>

export type OpenCodeBuiltinTools = typeof OPENCODE_BUILTIN_TOOLS
