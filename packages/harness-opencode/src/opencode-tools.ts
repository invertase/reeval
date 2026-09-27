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
 * Captured from OpenCode 2.0.18's ACP `tool_call` updates. `@ai-sdk/harness-acp` names a call
 * when it first has input, when OpenCode's title is still the tool's name, except for `shell`,
 * whose title is already the command by then: that one is matched by its `command` input.
 * read, write and edit take `path`, not the common `file_path`, so they aren't common tools.
 * `execute` runs JavaScript that calls the Code Mode tools, MCP servers' among them; the
 * translator reports each MCP call it made. websearch, question and the browser tools are off
 * (see OPENCODE_DENIED_TOOLS).
 */
export const OPENCODE_BUILTIN_TOOLS = {
  bash: {
    ...commonTool('bash', {
      nativeName: 'shell',
      toolUseKind: 'bash',
      inputSchema: z.looseObject({ command: z.string(), workdir: z.string().optional() }),
    }),
    title: 'shell',
  },
  read: {
    ...tool({
      title: 'read',
      inputSchema: z.looseObject({ path: z.string(), offset: z.number().optional() }),
    }),
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
  skill: native('skill', 'readonly'),
  subagent: native('subagent'),
  execute: native('execute'),
} as const satisfies Record<string, BuiltinTool>

export type OpenCodeBuiltinTools = typeof OPENCODE_BUILTIN_TOOLS
