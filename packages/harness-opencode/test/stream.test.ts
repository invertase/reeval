import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenCodeStreamTranslator } from '../src/opencode-stream.ts'

type Part = { type: string; [key: string]: unknown }

/** OpenCode 1.18.32's ACP updates for one call, as `@ai-sdk/harness-acp` passes them on. */
const call = (id: string, title: string, laterTitle: string, input: unknown): Part[] => [
  {
    type: 'raw',
    rawValue: { sessionUpdate: 'tool_call', toolCallId: id, title, status: 'pending' },
  },
  {
    type: 'raw',
    rawValue: { sessionUpdate: 'tool_call_update', toolCallId: id, title: laterTitle },
  },
  { type: 'tool-call', toolCallId: id, toolName: `acp_tool_${id}`, input: JSON.stringify(input) },
  { type: 'tool-result', toolCallId: id, toolName: `acp_tool_${id}`, result: { output: 'ok' } },
]

const names = (parts: Part[]) =>
  parts.flatMap((p) => (p.type === 'tool-call' || p.type === 'tool-result' ? [p.toolName] : []))

const LAST_CALL = { inputTokens: { total: 8559 }, outputTokens: { total: 25 } }
const turn = (parts: Part[], mcpServers?: string[]) => {
  const t = new OpenCodeStreamTranslator({ ...(mcpServers ? { mcpServers } : {}) })
  return [...parts, { type: 'finish', totalUsage: LAST_CALL }].map((p) => t.push(p))
}

test('names a call from its first update, and drops the usage', () => {
  const out = turn(
    [
      ...call('b1', 'bash', 'echo contract-$((6*7))', { command: 'echo contract-$((6*7))' }),
      ...call('m1', 'stamp_house_stamp', 'stamp_house_stamp', {}),
      ...call('w1', 'webfetch', 'https://example.com', { url: 'https://example.com' }),
      ...call('x1', 'future_tool', 'future_tool', {}),
    ],
    ['stamp'],
  )
  assert.deepEqual(names(out), [
    'bash',
    'bash',
    'mcp__stamp__house_stamp',
    'mcp__stamp__house_stamp',
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

test('twin: without the first update, or the server, the call keeps its generic name', () => {
  const [, later, ...rest] = call('b1', 'bash', 'echo hi', { command: 'echo hi' })
  assert.deepEqual(names(turn([later as Part, ...rest])), ['acp_tool_b1', 'acp_tool_b1'])
  assert.deepEqual(names(turn(call('m1', 'stamp_house_stamp', 'x', {}))), [
    'acp_tool_m1',
    'acp_tool_m1',
  ])
})

test('a call harness-acp already named is left alone', () => {
  const t = new OpenCodeStreamTranslator()
  t.push({ type: 'raw', rawValue: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'bash' } })
  const part = { type: 'tool-call', toolCallId: 'r1', toolName: 'read', input: '{}' }
  assert.deepEqual(t.push(part), part)
})

test('the longest matching server names an MCP call', () => {
  const out = turn(call('m1', 'docs_api_search', 'x', {}), ['docs', 'docs_api'])
  assert.deepEqual(names(out), ['mcp__docs_api__search', 'mcp__docs_api__search'])
})
