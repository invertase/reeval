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
  { type: 'tool-call', toolCallId: id, toolName, input },
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
    output: done.rawOutput ?? { metadata: { truncated: false } },
  },
]

const names = (parts: Part[]) =>
  parts.flatMap((p) =>
    p.type === 'tool-call' || p.type === 'tool-result' || p.type === 'tool-error'
      ? [p.toolName]
      : [],
  )

const LAST_CALL = { inputTokens: { total: 8559 }, outputTokens: { total: 25 } }
const turn = (parts: Part[], mcpServers?: string[]) => {
  const t = new OpenCodeStreamTranslator({ ...(mcpServers ? { mcpServers } : {}) })
  return [...parts, { type: 'finish', totalUsage: LAST_CALL }].flatMap((p) => t.push(p))
}

test('names a call from its first update, and drops the usage', () => {
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
  assert.equal(finish.totalUsage.inputTokens?.total, undefined)
  assert.equal(finish.totalUsage.outputTokens?.total, undefined)
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
  assert.deepEqual(result?.output, {
    output: '(no output)\nExited with code 3',
    metadata: { status: 'completed', exit: 3, truncated: false },
  })
})

test('twin: a result with no content keeps its raw output', () => {
  const [a, b, c, , e] = call('s1', 'shell', 'true', { command: 'true' })
  const out = turn([a, b, c, e] as Part[])
  assert.deepEqual(out.find((p) => p.type === 'tool-result')?.output, {
    metadata: { truncated: false },
  })
})

/** An `execute` call that ran `tools.stamp.house_stamp()` in Code Mode. */
const execute = (calls: unknown[]) =>
  call(
    'e1',
    'execute',
    'execute',
    { code: 'return await tools.stamp.house_stamp()' },
    {
      content: [text('STAMP-7Q')],
      rawOutput: { metadata: { toolCalls: calls, truncated: false } },
    },
    'execute',
  )

test('each MCP call an execute call made follows it, named mcp__<server>__<tool>', () => {
  const out = turn(
    execute([
      { tool: 'stamp.house_stamp', status: 'completed' },
      { tool: 'opencode.models', status: 'completed' },
      { tool: 'stamp.house_stamp', status: 'error' },
    ]),
    ['stamp'],
  )
  assert.deepEqual(names(out), [
    'execute',
    'execute',
    'mcp__stamp__house_stamp',
    'mcp__stamp__house_stamp',
    'mcp__stamp__house_stamp',
    'mcp__stamp__house_stamp',
  ])
  const inner = out.filter((p) => String(p.toolCallId).startsWith('e1/'))
  assert.deepEqual(
    inner.map((p) => [p.type, p.toolCallId]),
    [
      ['tool-call', 'e1/0'],
      ['tool-result', 'e1/0'],
      ['tool-call', 'e1/2'],
      ['tool-error', 'e1/2'],
    ],
  )
})

test('twin: an MCP call to a server the session has no such name for is not reported', () => {
  const out = turn(execute([{ tool: 'stamp.house_stamp', status: 'completed' }]), ['other'])
  assert.deepEqual(names(out), ['execute', 'execute'])
})

test("a server's name matches OpenCode's namespace for it, longest first", () => {
  const out = turn(
    execute([
      { tool: 'my_docs.search', status: 'completed' },
      { tool: 'docs_api.search', status: 'completed' },
    ]),
    ['my.docs', 'docs', 'docs_api'],
  )
  assert.deepEqual(
    names(out).filter((n) => n.startsWith('mcp__')),
    [
      'mcp__my.docs__search',
      'mcp__my.docs__search',
      'mcp__docs_api__search',
      'mcp__docs_api__search',
    ],
  )
})

test('a call harness-acp already named is left alone', () => {
  const t = new OpenCodeStreamTranslator()
  t.push({
    type: 'raw',
    rawValue: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'shell' },
  })
  const part = { type: 'tool-call', toolCallId: 'r1', toolName: 'read', input: {} }
  assert.deepEqual(t.push(part), [part])
})

test('a directly called MCP tool is named from its title', () => {
  const out = turn(call('m1', 'docs_api_search', 'x', {}), ['docs', 'docs_api'])
  assert.deepEqual(names(out), ['mcp__docs_api__search', 'mcp__docs_api__search'])
})
