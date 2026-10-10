import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenCodeStreamTranslator } from '../src/opencode-stream.ts'

type Part = { type: string; [key: string]: unknown }

const text = (t: string) => ({ type: 'content', content: { type: 'text', text: t } })

/** OpenCode 2.0.18's ACP updates for one call, as `@ai-sdk/harness-acp` passes them on. */
const call = (
  id: string,
  title: string,
  laterTitle: string,
  input: unknown,
  done: { content?: unknown[]; rawOutput?: unknown } = {},
  toolName = `acp_tool_${id}`,
): Part[] => [
  {
    type: 'raw',
    rawValue: { sessionUpdate: 'tool_call', toolCallId: id, title, status: 'pending' },
  },
  {
    type: 'raw',
    rawValue: { sessionUpdate: 'tool_call_update', toolCallId: id, title: laterTitle },
  },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  {
    type: 'raw',
    rawValue: {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: 'completed',
      content: done.content ?? [text('ok')],
      rawOutput: done.rawOutput ?? { metadata: { truncated: false } },
    },
  },
  {
    type: 'tool-result',
    toolCallId: id,
    toolName,
    result: done.rawOutput ?? { metadata: { truncated: false } },
  },
]

const names = (parts: Part[]) =>
  parts.flatMap((p) => (p.type === 'tool-call' || p.type === 'tool-result' ? [p.toolName] : []))

const LAST_CALL = { inputTokens: { total: 8559 }, outputTokens: { total: 25 } }
const turn = (parts: Part[], mcpServers?: string[]) => {
  const t = new OpenCodeStreamTranslator({ ...(mcpServers ? { mcpServers } : {}) })
  return [...parts, { type: 'finish', totalUsage: LAST_CALL }].flatMap((p) => t.push(p))
}

test('names a call from its first update, and keeps the usage', () => {
  const out = turn([
    ...call('b1', 'shell', 'echo contract-$((6*7))', { command: 'echo contract-$((6*7))' }),
    ...call('w1', 'webfetch', 'https://example.com', { url: 'https://example.com' }),
    ...call('x1', 'future_tool', 'future_tool', {}),
  ])
  assert.deepEqual(names(out), [
    'bash',
    'bash',
    'webFetch',
    'webFetch',
    'acp_tool_x1',
    'acp_tool_x1',
  ])
  const finish = out.find((p) => p.type === 'finish') as {
    totalUsage: Record<string, { total?: number }>
  }
  assert.deepEqual(finish.totalUsage, LAST_CALL)
})

test('twin: without the first update the call keeps its generic name', () => {
  const [, ...rest] = call('b1', 'shell', 'echo hi', { command: 'echo hi' })
  assert.deepEqual(names(turn(rest)), ['acp_tool_b1', 'acp_tool_b1'])
})

test("a tool's output is its content's text, with its metadata", () => {
  const out = turn(
    call(
      's1',
      'shell',
      'exit 3',
      { command: 'exit 3' },
      {
        content: [text('(no output)'), text('Exited with code 3')],
        rawOutput: { metadata: { status: 'completed', exit: 3, truncated: false } },
      },
    ),
  )
  const result = out.find((p) => p.type === 'tool-result')
  assert.deepEqual(result?.result, {
    output: '(no output)\nExited with code 3',
    metadata: { status: 'completed', exit: 3, truncated: false },
  })
})

test('twin: a result with no content keeps its raw output', () => {
  const [a, b, c, , e] = call('s1', 'shell', 'true', { command: 'true' })
  const out = turn([a, b, c, e] as Part[])
  assert.deepEqual(out.find((p) => p.type === 'tool-result')?.result, {
    metadata: { truncated: false },
  })
})

test("a web search's results are its references", () => {
  const out = turn(
    call(
      's1',
      'websearch',
      'websearch',
      { query: 'opencode' },
      {
        content: [
          text(
            '## [anomalyco/opencode](https://github.com/anomalyco/opencode)\n\nThe agent.\n\n## [OpenCode](https://opencode.ai)\n',
          ),
        ],
        rawOutput: { metadata: { provider: 'exa', truncated: false } },
      },
    ),
  )
  assert.deepEqual(names(out), ['webSearch', 'webSearch'])
  const result = out.find((p) => p.type === 'tool-result')?.result as Record<string, unknown>
  assert.deepEqual(result.references, [
    { title: 'anomalyco/opencode', url: 'https://github.com/anomalyco/opencode' },
    { title: 'OpenCode', url: 'https://opencode.ai' },
  ])
})

test('twin: another tool with the same text has no references', () => {
  const out = turn(
    call(
      'f1',
      'webfetch',
      'https://opencode.ai',
      { url: 'https://opencode.ai' },
      {
        content: [text('## [OpenCode](https://opencode.ai)')],
      },
    ),
  )
  const result = out.find((p) => p.type === 'tool-result')?.result as Record<string, unknown>
  assert.equal('references' in result, false)
})

test('a call harness-acp already named is left alone', () => {
  const t = new OpenCodeStreamTranslator()
  t.push({
    type: 'raw',
    rawValue: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'shell' },
  })
  const part = { type: 'tool-call', toolCallId: 'r1', toolName: 'read', input: '{}' }
  assert.deepEqual(t.push(part), [part])
})

test('an MCP tool is named from its title, by the longest server', () => {
  const out = turn(call('m1', 'docs_api_search', 'x', {}), ['docs', 'docs_api'])
  assert.deepEqual(names(out), ['mcp__docs_api__search', 'mcp__docs_api__search'])
})

test("2.0.26's tool_call.name is remapped from <server>_<tool>, like the title", () => {
  const named = (toolName: string, mcpServers: string[], title = toolName) =>
    names(turn(call('m1', title, title, {}, {}, toolName), mcpServers))
  assert.deepEqual(named('stamp_house_stamp', ['stamp']), [
    'mcp__stamp__house_stamp',
    'mcp__stamp__house_stamp',
  ])
  assert.deepEqual(named('docs_api_search', ['docs', 'docs_api']), [
    'mcp__docs_api__search',
    'mcp__docs_api__search',
  ])
  // A dashed server's OpenCode name uses `_`; the configured name is put back.
  assert.deepEqual(named('my_docs_latest_version', ['my-docs']), [
    'mcp__my-docs__latest_version',
    'mcp__my-docs__latest_version',
  ])
  // Two servers that sanitize alike can't be told apart, so OpenCode's name stands.
  assert.deepEqual(named('a_b_x', ['a-b', 'a_b']), ['a_b_x', 'a_b_x'])
  assert.deepEqual(named('stamp_house_stamp', []), ['stamp_house_stamp', 'stamp_house_stamp'])
  assert.deepEqual(named('read', ['stamp']), ['read', 'read'])
})

test("2.0.26's tool_call.name names an acp_tool_ call when the title is a display string", () => {
  const parts = [
    {
      type: 'raw',
      rawValue: {
        sessionUpdate: 'tool_call',
        toolCallId: 'm1',
        name: 'stamp_house_stamp',
        title: 'House stamp',
      },
    },
    { type: 'tool-call', toolCallId: 'm1', toolName: 'acp_tool_m1', input: '{}' },
    {
      type: 'tool-result',
      toolCallId: 'm1',
      toolName: 'acp_tool_m1',
      result: { metadata: { truncated: false } },
    },
  ]
  assert.deepEqual(names(turn(parts, ['stamp'])), [
    'mcp__stamp__house_stamp',
    'mcp__stamp__house_stamp',
  ])
})
