import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { PiStreamTranslator } from '../src/pi-stream.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.ndjson`, import.meta.url), 'utf8').split('\n')

/** A turn through the translator, raw parts dropped. */
function translate(lines: string[], exitCode = 0) {
  const t = new PiStreamTranslator()
  const parts = [...lines.flatMap((l) => t.push(l)), ...t.end({ exitCode })]
  return { t, parts: parts.filter((p) => p.type !== 'raw') }
}

const usage = (p: HarnessV1StreamPart | undefined) =>
  p && 'totalUsage' in p ? p.totalUsage : p && 'usage' in p ? p.usage : undefined

test('a real multi-call turn: tool calls, results, one step per model call and their summed tokens', () => {
  const { t, parts } = translate(fixture('edit-and-run'))
  assert.equal(t.sessionId, '11111111-2222-3333-4444-555555555555')
  assert.deepEqual(
    parts.filter((p) => p.type === 'tool-call').map((p) => ('toolName' in p ? p.toolName : '')),
    ['read', 'write', 'edit', 'bash'],
  )
  const steps = parts.filter((p) => p.type === 'finish-step')
  assert.equal(steps.length, 5)
  assert.deepEqual(usage(steps[0])?.inputTokens, {
    total: 1379,
    noCache: 1379,
    cacheRead: 0,
    cacheWrite: 0,
  })
  const finish = parts.find((p) => p.type === 'finish')
  assert.equal(usage(finish)?.inputTokens.total, 1379 + 1490 + 1539 + 1612 + 1668)
  assert.equal(usage(finish)?.outputTokens.total, 101 + 32 + 49 + 40 + 7)
  assert.equal(parts[0]?.type, 'stream-start')
  assert.equal((parts[0] as { modelId?: string }).modelId, 'gemini-3.8-flash')
  // pi opens empty text blocks around tool calls; only the reply's is passed on.
  assert.deepEqual(
    parts.filter((p) => p.type === 'text-delta').map((p) => ('delta' in p ? p.delta : '')),
    ['done.'],
  )
})

test("a failed model call (pi's stopReason 'error', exit 0) is an error part and no usage", () => {
  const { parts } = translate(fixture('bad-key'))
  const error = parts.find((p) => p.type === 'error')
  assert.match(String((error as { error?: Error })?.error?.message), /API key not valid/)
  const finish = parts.find((p) => p.type === 'finish')
  assert.equal(usage(finish)?.inputTokens.total, undefined)
  assert.equal((finish as { finishReason?: { unified?: string } })?.finishReason?.unified, 'error')
})

// Synthetic: the real edit-and-run capture with a 503 on its second model call, in pi 1.4.0's
// order (`agent-session.js` and `pi-agent-core`'s `agent-loop.js`): the failed call,
// `agent_end` with `willRetry: true`, `auto_retry_start`, the `context_edit` (`entry_appended`)
// that omits the failed call from pi's context, and a new run (`agent_start`) that
// repeats the call. `auto-retry-exhausted` fails every retry, so its last `agent_end` has
// `willRetry: false` and `auto_retry_end` follows it.
test('a model call pi retried is a failed step, and the retry carries the turn on', () => {
  const { parts } = translate(fixture('auto-retry'))
  const plain = translate(fixture('edit-and-run')).parts
  assert.ok(!parts.some((p) => p.type === 'error'))
  const steps = parts.filter((p) => p.type === 'finish-step')
  assert.equal(steps.length, 6)
  assert.deepEqual((steps[1] as { finishReason?: unknown }).finishReason, {
    unified: 'error',
    raw: 'error',
  })
  const finish = parts.find((p) => p.type === 'finish')
  assert.deepEqual((finish as { finishReason?: unknown })?.finishReason, {
    unified: 'stop',
    raw: 'stop',
  })
  assert.deepEqual(usage(finish), usage(plain.find((p) => p.type === 'finish')))
  const without = (ps: HarnessV1StreamPart[]) =>
    ps.filter((p) => !(p.type === 'finish-step' && p.finishReason.unified === 'error'))
  assert.deepEqual(without(parts), plain)
})

test('twin: a failed call pi gives up retrying fails the turn with its error', () => {
  const { parts } = translate(fixture('auto-retry-exhausted'))
  const errors = parts.filter((p) => p.type === 'error')
  assert.equal(errors.length, 1)
  assert.match(String((errors[0] as { error?: Error }).error?.message), /currently unavailable/)
  assert.equal(
    parts.filter((p) => p.type === 'finish-step' && p.finishReason.unified === 'error').length,
    3,
  )
  const finish = parts.find((p) => p.type === 'finish')
  assert.equal((finish as { finishReason?: { raw?: string } })?.finishReason?.raw, 'error')
  assert.equal(usage(finish)?.inputTokens.total, 1379)
  assert.deepEqual(
    parts.filter((p) => p.type === 'tool-call').map((p) => ('toolName' in p ? p.toolName : '')),
    ['read'],
  )
})

test('a process that dies while pi waits to retry names the call it was retrying', () => {
  const lines = fixture('auto-retry')
  const cut = lines.findIndex((l) => l.includes('"type":"auto_retry_start"')) + 1
  const { parts } = translate(lines.slice(0, cut), 1)
  const error = parts.find((p) => p.type === 'error') as { error?: Error } | undefined
  assert.match(String(error?.error?.message), /exited with code 1 .*currently unavailable/s)
  assert.equal(parts.at(-1)?.type, 'finish')
})

// A stream that drops mid-reply ("terminated", which pi retries) after the call streamed a tool
// call: pi runs no tools for a failed call, and the retry makes its own.
test('a tool call the failed model call streamed before it failed is not passed on', () => {
  const lines = fixture('auto-retry')
  const failed = lines.findIndex(
    (l) => l.includes('"type":"message_start"') && l.includes('"stopReason":"error"'),
  )
  const update = (event: object) =>
    JSON.stringify({ type: 'message_update', assistantMessageEvent: event })
  const toolCall = { id: 'never-run', name: 'bash', arguments: { command: 'rm -rf build' } }
  const dropped = [
    ...lines.slice(0, failed + 1),
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'Now the' }),
    update({ type: 'text_end', contentIndex: 0 }),
    update({ type: 'toolcall_start', contentIndex: 1 }),
    update({ type: 'toolcall_end', contentIndex: 1, toolCall }),
    ...lines.slice(failed + 1),
  ]
  const { parts } = translate(dropped)
  const calls = (ps: HarnessV1StreamPart[]) =>
    ps.flatMap((p) => (p.type === 'tool-call' ? [p.toolCallId] : []))
  assert.deepEqual(calls(parts), calls(translate(fixture('edit-and-run')).parts))
  assert.ok(parts.some((p) => p.type === 'text-delta' && p.delta === 'Now the'))
  assert.ok(!parts.some((p) => p.type === 'error'))
})

// Synthetic: the auto-retry turn with its second call one pi compacts for instead of retrying, in
// pi 1.4.0's order (`agent-session.js`, `_checkCompaction`): the call, `agent_end` with
// `willRetry: false`, the `context_edit` that omits the call, `compaction_start` and
// `compaction_end` with `willRetry: true`, and a new run (`agent_start`) that repeats the call.
// `compaction-overflow`'s call fails on the context window; `compaction-length`'s stops on
// `length` below the model's `maxTokens`.
const editAndRun = () => translate(fixture('edit-and-run')).parts
const toolCalls = (ps: HarnessV1StreamPart[]) =>
  ps.flatMap((p) => (p.type === 'tool-call' ? [p.toolCallId] : []))
const overflowLines = () => fixture('compaction-overflow')
const at = (lines: string[], type: string) => lines.findIndex((l) => l.includes(`"type":"${type}"`))

test('a call that overflowed the context is a failed step, and the run pi continues after compacting carries the turn on', () => {
  const { parts } = translate(overflowLines())
  assert.ok(!parts.some((p) => p.type === 'error'))
  const steps = parts.filter((p) => p.type === 'finish-step')
  assert.equal(steps.length, 6)
  assert.deepEqual((steps[1] as { finishReason?: unknown }).finishReason, {
    unified: 'error',
    raw: 'error',
  })
  const finish = parts.find((p) => p.type === 'finish')
  assert.deepEqual((finish as { finishReason?: unknown })?.finishReason, {
    unified: 'stop',
    raw: 'stop',
  })
  assert.deepEqual(usage(finish), usage(editAndRun().find((p) => p.type === 'finish')))
  const without = (ps: HarnessV1StreamPart[]) =>
    ps.filter((p) => !(p.type === 'finish-step' && p.finishReason.unified === 'error'))
  assert.deepEqual(without(parts), editAndRun())
})

test('a call cut off at length pi compacts for keeps its step and text, and the continued run its work', () => {
  const { parts } = translate(fixture('compaction-length'))
  assert.ok(!parts.some((p) => p.type === 'error'))
  const steps = parts.filter((p) => p.type === 'finish-step')
  assert.equal(steps.length, 6)
  assert.deepEqual((steps[1] as { finishReason?: unknown }).finishReason, {
    unified: 'length',
    raw: 'length',
  })
  assert.ok(
    parts.some((p) => p.type === 'text-delta' && p.delta === "I'll write b.txt with the word"),
  )
  assert.deepEqual(toolCalls(parts), toolCalls(editAndRun()))
  const finish = parts.find((p) => p.type === 'finish')
  assert.equal((finish as { finishReason?: { raw?: string } })?.finishReason?.raw, 'stop')
  const total = usage(editAndRun().find((p) => p.type === 'finish'))
  assert.equal(usage(finish)?.inputTokens.total, (total?.inputTokens.total ?? 0) + 1490)
  assert.equal(usage(finish)?.outputTokens.total, (total?.outputTokens.total ?? 0) + 512)
})

test('twin: a compaction that fails, or a second overflow, ends the turn with the call and compaction errors', () => {
  const lines = overflowLines()
  const failedEnd = JSON.stringify({
    type: 'compaction_end',
    reason: 'overflow',
    aborted: false,
    willRetry: false,
    errorMessage: 'Context overflow recovery failed: summarization request failed',
  })
  const settled = JSON.stringify({ type: 'agent_settled', aborted: false })
  const compactionFailed = [...lines.slice(0, at(lines, 'compaction_end')), failedEnd, settled]
  // After one compact-and-retry, pi emits only `compaction_end`, with no `compaction_start`.
  const recoveryFailed = [
    ...lines.slice(0, at(lines, 'agent_end') + 1),
    JSON.stringify({
      ...JSON.parse(failedEnd),
      errorMessage:
        'Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.',
    }),
    settled,
  ]
  for (const [name, stream, compaction] of [
    ['compaction failed', compactionFailed, /summarization request failed/],
    ['recovery failed', recoveryFailed, /after one compact-and-retry attempt/],
  ] as const) {
    const { parts } = translate([...stream])
    const errors = parts.filter((p) => p.type === 'error')
    assert.equal(errors.length, 1, name)
    const message = String((errors[0] as { error?: Error }).error?.message)
    assert.match(message, /input token count \(1048577\) exceeds the maximum/, name)
    assert.match(message, compaction, name)
    const finish = parts.find((p) => p.type === 'finish')
    assert.equal((finish as { finishReason?: { raw?: string } })?.finishReason?.raw, 'error', name)
    assert.ok(!parts.some((p) => p.type === 'finish-step' && p.finishReason.unified === 'error'))
    assert.deepEqual(
      parts.filter((p) => p.type === 'tool-call').map((p) => ('toolName' in p ? p.toolName : '')),
      ['read'],
      name,
    )
  }
})

test('a process that dies while pi compacts, or before the continued run, names what pi was doing', () => {
  const lines = overflowLines()
  const died = (cut: number) => {
    const { parts } = translate(lines.slice(0, cut), 1)
    assert.equal(parts.at(-1)?.type, 'finish')
    return String((parts.find((p) => p.type === 'error') as { error?: Error })?.error?.message)
  }
  assert.match(
    died(at(lines, 'compaction_start') + 1),
    /exited with code 1 before ending the turn while compacting its context after a failed model call \(.*input token count/s,
  )
  assert.match(
    died(at(lines, 'compaction_end') + 1),
    /exited with code 1 before ending the turn while continuing after compacting its context \(.*input token count/s,
  )
  const length = fixture('compaction-length')
  const { parts } = translate(length.slice(0, at(length, 'compaction_end') + 1), 1)
  assert.match(
    String((parts.find((p) => p.type === 'error') as { error?: Error })?.error?.message),
    /while continuing after compacting its context \(a model call stopped at its output limit\)/,
  )
})

// pi also compacts on a threshold, before a run's first call (a later turn's resumed session) and
// between a run's calls, and after a turn that ended well; none of those continue the turn.
test('a compaction that continues nothing leaves the turn as it was', () => {
  const lines = fixture('edit-and-run')
  const compaction = (reason: string, willRetry = false) => [
    JSON.stringify({ type: 'compaction_start', reason }),
    JSON.stringify({ type: 'compaction_end', reason, result: {}, aborted: false, willRetry }),
  ]
  const turnEnd = at(lines, 'turn_end') + 1
  const agentEnd = at(lines, 'agent_end') + 1
  const compacted = [
    lines[0] ?? '',
    ...compaction('overflow', true),
    ...lines.slice(1, turnEnd),
    ...compaction('threshold'),
    ...lines.slice(turnEnd, agentEnd),
    ...compaction('threshold'),
    ...lines.slice(agentEnd),
  ]
  assert.deepEqual(translate(compacted).parts, editAndRun())
})

test('a turn pi ended well is not undone by pi dying or the turn aborting while it compacts on a threshold', () => {
  const lines = fixture('edit-and-run')
  const agentEnd = at(lines, 'agent_end') + 1
  const compacting = [
    ...lines.slice(0, agentEnd),
    JSON.stringify({ type: 'compaction_start', reason: 'threshold' }),
  ]
  for (const options of [{ exitCode: 137 }, { exitCode: 143, aborted: true }]) {
    const t = new PiStreamTranslator()
    const parts = [...compacting.flatMap((l) => t.push(l)), ...t.end(options)].filter(
      (p) => p.type !== 'raw',
    )
    assert.deepEqual(parts, editAndRun(), JSON.stringify(options))
  }
})

test("each stop reason pi ends a call with is that step's finish reason, pi's own kept raw", () => {
  const lastStep = (stopReason: string) => {
    const lines = fixture('edit-and-run').map((l) =>
      l.replaceAll('"stopReason":"stop"', `"stopReason":"${stopReason}"`),
    )
    const steps = translate(lines).parts.filter((p) => p.type === 'finish-step')
    return (steps.at(-1) as { finishReason?: unknown })?.finishReason
  }
  assert.deepEqual(lastStep('stop'), { unified: 'stop', raw: 'stop' })
  assert.deepEqual(lastStep('length'), { unified: 'length', raw: 'length' })
  assert.deepEqual(lastStep('aborted'), { unified: 'other', raw: 'aborted' })
})

test("a dashed MCP server's name is put back in pi's mcp__<server>__ prefix, unless it's ambiguous", () => {
  const name = (toolName: string, mcpServers: string[]) => {
    const lines = [
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'c', name: toolName } },
      },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } },
      { type: 'agent_end' },
    ].map((e) => JSON.stringify(e))
    const t = new PiStreamTranslator({ mcpServers })
    const call = lines.flatMap((l) => t.push(l)).find((p) => p.type === 'tool-call')
    return call && 'toolName' in call ? call.toolName : undefined
  }
  assert.equal(name('mcp__my_docs__x', ['my-docs']), 'mcp__my-docs__x')
  // The tool part keeps pi's `_`: the adapter doesn't know the server's tool names.
  assert.equal(name('mcp__my_docs__latest_version', ['my-docs']), 'mcp__my-docs__latest_version')
  // Two servers that sanitize alike can't be told apart, so pi's name stands.
  assert.equal(name('mcp__a_b__x', ['a-b', 'a_b']), 'mcp__a_b__x')
  assert.equal(name('mcp__stamp__house_stamp', ['stamp']), 'mcp__stamp__house_stamp')
  assert.equal(name('read', ['my-docs']), 'read')
})

test('1.1.0 durationMs and agent_settled.aborted do not change the translated turn', () => {
  const withNew = fixture('edit-and-run').map((l) => {
    if (!l) return l
    const e = JSON.parse(l) as {
      type?: string
      aborted?: boolean
      durationMs?: number
      message?: { durationMs?: number }
      toolResults?: Array<{ durationMs?: number }>
    }
    if (e.type === 'agent_settled') e.aborted = true
    if (e.type === 'tool_execution_end') e.durationMs = 12
    if (e.message) e.message.durationMs = 3
    if (e.toolResults) for (const r of e.toolResults) r.durationMs = 4
    return JSON.stringify(e)
  })
  const a = translate(fixture('edit-and-run')).parts
  const b = translate(withNew).parts
  assert.deepEqual(b, a)
  const finish = b.find((p) => p.type === 'finish')
  assert.equal((finish as { finishReason?: { raw?: string } })?.finishReason?.raw, 'stop')
})

test('twin: a process that dies before agent_end is an error, not a clean finish', () => {
  const lines = fixture('edit-and-run')
  const cut = lines.findIndex((l) => l.includes('"type":"agent_end"'))
  const { parts } = translate(lines.slice(0, cut), 1)
  assert.match(
    String((parts.find((p) => p.type === 'error') as { error?: Error })?.error),
    /exited with code 1/,
  )
})
