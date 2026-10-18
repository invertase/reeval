import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GrokBuildStreamTranslator, grokTurnUsage } from '../src/grok-build-stream.ts'

type Part = { type: string; [key: string]: unknown }

/** Grok's ACP `tool_call` for one call, and the parts `@ai-sdk/harness-acp` makes of it. */
const call = (id: string, name: string, rawInput: unknown = {}): Part[] => [
  {
    type: 'raw',
    rawValue: {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: name,
      rawInput,
      _meta: { 'x.ai/tool': { name, namespace: 'grok_build' } },
    },
  },
  { type: 'tool-call', toolCallId: id, toolName: `acp_tool_${id}`, input: '{}' },
  { type: 'tool-result', toolCallId: id, toolName: `acp_tool_${id}`, result: {} },
]

/** Grok's prompt response: `_meta.usage` sums the turn, `_meta.inputTokens` is the last call's. */
const promptResponse = (usage: Record<string, number>): Part => ({
  type: 'raw',
  rawValue: { stopReason: 'end_turn', _meta: { usage, inputTokens: 1 } },
})
const TURN_USAGE = {
  inputTokens: 21000,
  outputTokens: 300,
  totalTokens: 21300,
  cachedReadTokens: 16000,
  cacheCreationTokens: 0,
  reasoningTokens: 120,
  modelCalls: 3,
}

const turn = (parts: Part[], mcpServers?: string[]) => {
  const t = new GrokBuildStreamTranslator(mcpServers ? { mcpServers } : {})
  return [...parts, { type: 'finish', totalUsage: { inputTokens: {}, outputTokens: {} } }].map(
    (p) => t.push(p),
  )
}
const calls = (parts: Part[]) =>
  parts.flatMap((p) => (p.type === 'tool-call' ? [{ name: p.toolName, input: p.input }] : []))
const finishUsage = (parts: Part[]) =>
  (parts.find((p) => p.type === 'finish') as { totalUsage: unknown }).totalUsage

test("names a call it couldn't from Grok's x.ai/tool metadata", () => {
  const out = turn(call('t1', 'search_tool'))
  assert.deepEqual(calls(out), [{ name: 'search_tool', input: '{}' }])
  assert.equal(out.find((p) => p.type === 'tool-result')?.toolName, 'search_tool')
})

test("a use_tool call of an MCP server's tool is mcp__<server>__<tool>, with its input", () => {
  const out = turn(
    call('m1', 'use_tool', { tool_name: 'stamp__house_stamp', tool_input: { word: 'x' } }),
    ['stamp'],
  )
  assert.deepEqual(calls(out), [{ name: 'mcp__stamp__house_stamp', input: '{"word":"x"}' }])
})

test('twin: a use_tool call of a tool that is no MCP server of the run stays use_tool', () => {
  const out = turn(call('m1', 'use_tool', { tool_name: 'other__tool', tool_input: {} }), ['stamp'])
  assert.deepEqual(calls(out), [{ name: 'use_tool', input: '{}' }])
})

test('the longest server name wins when one is a prefix of another', () => {
  const out = turn(call('m1', 'use_tool', { tool_name: 'a__b__tool', tool_input: {} }), [
    'a',
    'a__b',
  ])
  assert.equal(calls(out)[0]?.name, 'mcp__a__b__tool')
})

test('twin: without the metadata, the call keeps its generic name', () => {
  const [, ...rest] = call('t1', 'search_tool')
  assert.deepEqual(calls(turn(rest)), [{ name: 'acp_tool_t1', input: '{}' }])
})

test("the finish part's usage is the turn's sum from the prompt response", () => {
  const out = turn([promptResponse(TURN_USAGE)])
  assert.deepEqual(finishUsage(out), {
    inputTokens: { total: 21000, noCache: 5000, cacheRead: 16000, cacheWrite: 0 },
    outputTokens: { total: 300, text: 180, reasoning: 120 },
  })
})

test('twin: reasoning tokens on top of the output tokens count apart from them', () => {
  assert.deepEqual(grokTurnUsage({ ...TURN_USAGE, totalTokens: 21420 })?.outputTokens, {
    total: 420,
    text: 300,
    reasoning: 120,
  })
})

test('twin: without a prompt response the finish part is left as it is', () => {
  assert.deepEqual(finishUsage(turn([])), { inputTokens: {}, outputTokens: {} })
})
