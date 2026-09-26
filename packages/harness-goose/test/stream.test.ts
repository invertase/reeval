import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GooseStreamTranslator } from '../src/goose-stream.ts'

type Part = { type: string; [key: string]: unknown }

/** Goose 1.52.0's ACP `tool_call` for one call, and the parts `@ai-sdk/harness-acp` makes of it. */
const call = (id: string, toolName: string, extensionName: string): Part[] => [
  {
    type: 'raw',
    rawValue: {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: `${toolName} · x`,
      _meta: { goose: { toolCall: { toolName, extensionName } } },
    },
  },
  { type: 'tool-call', toolCallId: id, toolName: `acp_tool_${id}`, input: '{}' },
  { type: 'tool-result', toolCallId: id, toolName: `acp_tool_${id}`, result: {} },
]

const LAST_CALL = { inputTokens: { total: 4179 }, outputTokens: { total: 39 } }
const turn = (parts: Part[], mcpServers?: string[]) => {
  const t = new GooseStreamTranslator(mcpServers ? { mcpServers } : {})
  return [...parts, { type: 'finish', totalUsage: LAST_CALL }].map((p) => t.push(p))
}
const names = (parts: Part[]) => parts.flatMap((p) => (p.type === 'tool-call' ? [p.toolName] : []))

test('names a call from its tool_call metadata, and drops the usage', () => {
  const out = turn(
    [
      ...call('m1', 'stamp__house_stamp', 'stamp'),
      ...call('e1', 'extensionmanager__search_available_extensions', 'extensionmanager'),
      ...call('t1', 'tree', 'developer'),
    ],
    ['stamp'],
  )
  assert.deepEqual(names(out), [
    'mcp__stamp__house_stamp',
    'extensionmanager__search_available_extensions',
    'tree',
  ])
  const finish = out.find((p) => p.type === 'finish') as {
    totalUsage: Record<string, { total?: number }>
  }
  assert.equal(finish.totalUsage.inputTokens?.total, undefined)
  assert.equal(finish.totalUsage.outputTokens?.total, undefined)
})

test('twin: an extension that is not one of the MCP servers is not named as one', () => {
  assert.deepEqual(names(turn(call('m1', 'stamp__house_stamp', 'stamp'))), ['stamp__house_stamp'])
})

test('twin: without the metadata, the call keeps its generic name', () => {
  const [, ...rest] = call('m1', 'stamp__house_stamp', 'stamp')
  assert.deepEqual(names(turn(rest, ['stamp'])), ['acp_tool_m1'])
})
