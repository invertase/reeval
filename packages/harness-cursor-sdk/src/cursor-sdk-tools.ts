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
 * The SDK's `tool_call` names (`SDKToolUseMessage.name`), captured from @cursor/sdk 1.0.32. The
 * SDK calls its args and results unstable, so every schema is loose. Keys follow
 * `@ai-sdk/harness-cursor` (the ACP adapter) so transcripts from both line up.
 */
export const CURSOR_SDK_BUILTIN_TOOLS = {
  bash: {
    ...commonTool('bash', {
      nativeName: 'shell',
      toolUseKind: 'bash',
      inputSchema: z.looseObject({ command: z.string() }),
    }),
    title: 'Terminal',
  },
  read: {
    ...tool({ title: 'Read', inputSchema: z.looseObject({ path: z.string() }) }),
    nativeName: 'read',
    toolUseKind: 'readonly',
  },
  edit: {
    ...tool({ title: 'Edit', inputSchema: z.looseObject({ path: z.string() }) }),
    nativeName: 'edit',
    toolUseKind: 'edit',
  },
  write: {
    ...tool({ title: 'Write', inputSchema: z.looseObject({ path: z.string() }) }),
    nativeName: 'write',
    toolUseKind: 'edit',
  },
  delete: {
    ...tool({ title: 'Delete', inputSchema: z.looseObject({ path: z.string() }) }),
    nativeName: 'delete',
    toolUseKind: 'edit',
  },
  glob: {
    ...commonTool('glob', {
      nativeName: 'glob',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ pattern: z.string() }),
    }),
    title: 'Find',
  },
  grep: {
    ...commonTool('grep', {
      nativeName: 'grep',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ pattern: z.string(), path: z.string().optional() }),
    }),
    title: 'grep',
  },
  ls: native('ls', 'List', 'readonly'),
  webSearch: {
    ...commonTool('webSearch', {
      nativeName: 'webSearch',
      toolUseKind: 'readonly',
      inputSchema: z.looseObject({ query: z.string() }),
    }),
    title: 'Web Search',
  },
  webFetch: {
    ...tool({ title: 'Fetch', inputSchema: z.looseObject({ url: z.string() }) }),
    nativeName: 'webFetch',
    toolUseKind: 'readonly',
  },
  mcp: native('mcp', 'MCP'),
  task: native('task', 'Task'),
  semSearch: native('semSearch', 'Semantic Search', 'readonly'),
  updateTodos: native('updateTodos', 'Update TODOs'),
  readTodos: native('readTodos', 'Read TODOs', 'readonly'),
  readLints: native('readLints', 'Read Lints', 'readonly'),
} as const satisfies Record<string, BuiltinTool>

export type CursorSdkBuiltinTools = typeof CURSOR_SDK_BUILTIN_TOOLS

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

const BY_NATIVE_NAME = new Map<string, string>(
  Object.entries(CURSOR_SDK_BUILTIN_TOOLS).map(([key, t]) => [
    (t as BuiltinTool).nativeName ?? key,
    key,
  ]),
)

export type ProjectedToolCall = {
  /** The key in {@link CURSOR_SDK_BUILTIN_TOOLS}, or the native name for tools outside it. */
  toolName: string
  nativeName: string
  /** The SDK's args, plus the common-schema fields when the tool has a common name. */
  input: Record<string, unknown>
  /** Tools outside the catalog are reported as dynamic, so they aren't validated as builtins. */
  dynamic: boolean
}

/** Maps an SDK `tool_call` to its catalog name, adding the common-schema fields it implies. */
export function projectToolCall(nativeName: string, args: unknown): ProjectedToolCall {
  const a = record(args)
  const common = (toolName: string, extra: Record<string, unknown> = {}): ProjectedToolCall => ({
    toolName,
    nativeName,
    input: { ...a, ...extra },
    dynamic: false,
  })
  switch (nativeName) {
    case 'shell':
      return common('bash', { command: str(a.command) ?? '' })
    case 'glob':
      return common('glob', { pattern: str(a.globPattern) ?? str(a.pattern) ?? '' })
    case 'grep':
      return common('grep', { pattern: str(a.pattern) ?? '' })
    case 'webSearch':
      return common('webSearch', { query: str(a.searchTerm) ?? str(a.query) ?? '' })
  }
  const key = BY_NATIVE_NAME.get(nativeName)
  return key ? common(key) : { toolName: nativeName, nativeName, input: { ...a }, dynamic: true }
}

export type ProjectedToolResult = { output: NonNullable<unknown>; error?: string }

/**
 * An SDK tool result is `{ status: 'success', value }` or `{ status: 'error', error }`. The
 * value is passed on as is, except shell output, which becomes its text (as the ACP adapter
 * reports it), and MCP content, which is flattened to text parts.
 */
export function projectToolResult(
  toolName: string,
  status: string,
  result: unknown,
): ProjectedToolResult {
  const r = record(result)
  const failed = status === 'error' || (r.status !== undefined && r.status !== 'success')
  if (failed) {
    const error =
      str(r.error) ??
      str(record(r.error).message) ??
      str(record(r.value).error) ??
      (result === undefined ? `${toolName} failed` : JSON.stringify(result))
    return { output: error, error }
  }
  const value = r.status === 'success' ? r.value : result
  if (toolName === 'bash') {
    const v = record(value)
    const stdout = str(v.stdout) ?? ''
    const stderr = str(v.stderr) ?? ''
    return {
      output: stderr ? `${stdout}${stdout.endsWith('\n') || !stdout ? '' : '\n'}${stderr}` : stdout,
    }
  }
  if (toolName === 'mcp') {
    const content = record(value).content
    if (Array.isArray(content)) {
      return {
        output: content.map((c) => {
          const text = record(record(c).text).text ?? record(c).text
          return typeof text === 'string' ? { type: 'text', text } : c
        }),
      }
    }
  }
  return { output: value ?? '' }
}
