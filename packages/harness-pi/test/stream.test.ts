import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { PiStreamTranslator } from '../src/pi-stream.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.ndjson`, import.meta.url), 'utf8').split('\n')

/** A pi 0.87.1 turn through the translator, raw parts dropped. */
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

test('twin: a process that dies before agent_end is an error, not a clean finish', () => {
  const lines = fixture('edit-and-run')
  const cut = lines.findIndex((l) => l.includes('"type":"agent_end"'))
  const { parts } = translate(lines.slice(0, cut), 1)
  assert.match(
    String((parts.find((p) => p.type === 'error') as { error?: Error })?.error),
    /exited with code 1/,
  )
})
