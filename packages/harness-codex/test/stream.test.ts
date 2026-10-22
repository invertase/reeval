import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { CodexStreamTranslator, toUsage } from '../src/codex-stream.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n')

function translate(name: string, exit = { exitCode: 0 }) {
  const t = new CodexStreamTranslator({ workDir: '/reeval/workspace' })
  const parts: HarnessV1StreamPart[] = []
  for (const line of fixture(name)) parts.push(...t.push(line))
  parts.push(...t.end(exit))
  return {
    t,
    parts: parts.filter((p) => p.type !== 'raw'),
    raw: parts.filter((p) => p.type === 'raw'),
  }
}

const types = (parts: HarnessV1StreamPart[]) => parts.map((p) => p.type)
const finish = (parts: HarnessV1StreamPart[]) =>
  parts.find((p): p is Extract<HarnessV1StreamPart, { type: 'finish' }> => p.type === 'finish')

test('a real turn with reasoning: reasoning and text blocks, edits by path, one step with its tokens', () => {
  const { t, parts, raw } = translate('plan-and-reasoning.ndjson')
  assert.equal(t.threadId, '01a0e361-0482-79c3-a5d7-7131a7715c0f')
  assert.equal(parts[0]?.type, 'stream-start')
  assert.ok(types(parts).includes('reasoning-delta'))
  assert.ok(types(parts).includes('text-delta'))
  const calls = parts.flatMap((p) =>
    p.type === 'tool-call' ? [[p.toolName, JSON.parse(p.input)]] : [],
  )
  assert.deepEqual(calls, [
    ['write', { path: 'a.txt' }],
    ['delete', { path: 'a.txt' }],
  ])
  assert.equal(parts.filter((p) => p.type === 'finish-step').length, 1)
  const done = finish(parts)
  assert.equal(done?.finishReason.unified, 'stop')
  assert.ok((done?.totalUsage.outputTokens.reasoning ?? 0) > 0, 'reasoning tokens')
  assert.equal(parts.at(-1)?.type, 'finish')
  assert.equal(raw.length, fixture('plan-and-reasoning.ndjson').filter(Boolean).length)
})

test('a command that exits non-zero is a failed shell call with its output, and the turn goes on', () => {
  const { parts } = translate('failed-command.ndjson')
  const result = parts.find((p) => p.type === 'tool-result')
  assert.ok(result?.type === 'tool-result')
  assert.equal(result.toolName, 'bash')
  assert.equal((result as { isError?: boolean }).isError, true)
  assert.match(String(result.result), /No such file or directory/)
  assert.equal(finish(parts)?.finishReason.unified, 'stop')
})

test("a refused key: each retry a failed step, then the turn's error and an error finish", () => {
  const { parts } = translate('bad-key.ndjson', { exitCode: 1 })
  const retries = parts.filter(
    (p) => p.type === 'finish-step' && p.finishReason.unified === 'error',
  )
  assert.deepEqual(
    retries.map((p) => p.type === 'finish-step' && p.finishReason.raw?.slice(0, 18)),
    [1, 2, 3, 4, 5].map((n) => `Reconnecting... ${n}/`),
    'the error announcing the failed turn is no retry',
  )
  const errors = parts.filter((p) => p.type === 'error')
  assert.equal(errors.length, 1)
  assert.match(String((errors[0] as { error: Error }).error.message), /401 Unauthorized/)
  assert.equal(finish(parts)?.finishReason.unified, 'error')
  assert.equal(parts.filter((p) => p.type === 'finish').length, 1, 'the exit adds no second end')
})

test('a process that dies before the turn ends is an error naming its exit code', () => {
  const t = new CodexStreamTranslator({ workDir: '/reeval/workspace' })
  t.push('{"type":"thread.started","thread_id":"t"}')
  t.push('not json')
  const parts = t.end({ exitCode: 3, stderr: 'boom' })
  assert.deepEqual(types(parts), ['stream-start', 'error', 'finish'])
  assert.match(
    String((parts[1] as { error: Error }).error.message),
    /codex exited with code 3 before ending the turn: boom/,
  )
  assert.deepEqual(t.end({ exitCode: 3 }), [], 'ends once')
})

test('an aborted turn finishes as other, without an error', () => {
  const t = new CodexStreamTranslator({ workDir: '/reeval/workspace' })
  t.push('{"type":"turn.started"}')
  assert.deepEqual(
    t
      .end({ exitCode: 143, aborted: true })
      .map((p) => (p.type === 'finish' ? p.finishReason.unified : p.type)),
    ['other'],
  )
})

test('an MCP call is mcp__<server>__<tool>; a failed one carries its error', () => {
  const t = new CodexStreamTranslator({ workDir: '/reeval/workspace' })
  const item = {
    id: 'm1',
    type: 'mcp_tool_call',
    server: 'stamp',
    tool: 'house_stamp',
    arguments: { a: 1 },
  }
  const started = t.push(
    JSON.stringify({ type: 'item.started', item: { ...item, status: 'in_progress' } }),
  )
  const failed = t.push(
    JSON.stringify({
      type: 'item.completed',
      item: { ...item, status: 'failed', result: null, error: { message: 'no such tool' } },
    }),
  )
  const call = started.find((p) => p.type === 'tool-call')
  assert.equal(call?.type === 'tool-call' && call.toolName, 'mcp__stamp__house_stamp')
  const result = failed.find((p) => p.type === 'tool-result')
  assert.equal(result?.type === 'tool-result' && result.result, 'no such tool')
  assert.equal((result as { isError?: boolean }).isError, true)
})

test("usage: input includes the cached tokens, output the reasoning ones, as Codex's do", () => {
  assert.deepEqual(
    toUsage({
      input_tokens: 100,
      cached_input_tokens: 60,
      cache_write_input_tokens: 10,
      output_tokens: 30,
      reasoning_output_tokens: 20,
    }),
    {
      inputTokens: { total: 100, noCache: 30, cacheRead: 60, cacheWrite: 10 },
      outputTokens: { total: 30, text: 10, reasoning: 20 },
    },
  )
})

test("a real three-turn thread: each turn's tokens are OpenAI's for that turn's calls (codex 0.163.0)", () => {
  // The Responses API's usage for each turn's model calls, summed:
  // [input_tokens, cached_tokens, cache_write_tokens, output_tokens, reasoning_tokens].
  // Codex's turn.completed reports the thread's running total (turn 3: 159437 input).
  const OPENAI = [
    [10387 + 15189 + 26598, 0 + 10384 + 15186, 10384 + 4802 + 11409, 116 + 184 + 15, 24 + 97],
    [26641 + 26801, 26595 + 26638, 43 + 160, 111 + 15, 25],
    [26844 + 26977, 26798 + 26841, 43 + 133, 84 + 15, 0],
  ]
  let threadUsage: ReturnType<typeof translate>['t']['threadUsage']
  const turns = [1, 2, 3].map((n) => {
    const t = new CodexStreamTranslator({ workDir: '/reeval/workspace', threadUsage })
    const parts = fixture(`three-turns-${n}.ndjson`).flatMap((l) => t.push(l))
    threadUsage = t.threadUsage
    const u = finish(parts)?.totalUsage
    const step = parts.find((p) => p.type === 'finish-step')
    assert.deepEqual(step?.type === 'finish-step' && step.usage, u)
    return [
      u?.inputTokens.total,
      u?.inputTokens.cacheRead,
      u?.inputTokens.cacheWrite,
      u?.outputTokens.total,
      u?.outputTokens.reasoning,
    ]
  })
  assert.deepEqual(turns, OPENAI)
})

test("a thread whose running total restarted: a count that went down is the turn's own", () => {
  const t = new CodexStreamTranslator({
    workDir: '/reeval/workspace',
    threadUsage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 90 },
  })
  const parts = t.push(
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 300, cached_input_tokens: 4100, output_tokens: 40 },
    }),
  )
  const u = finish(parts)?.totalUsage
  assert.deepEqual(
    [u?.inputTokens.total, u?.inputTokens.cacheRead, u?.outputTokens.total],
    [300, 100, 40],
  )
  assert.deepEqual(t.threadUsage, {
    input_tokens: 300,
    cached_input_tokens: 4100,
    output_tokens: 40,
  })
})

test('a real web turn: the page Codex opened is a web fetch of its URL, known when the item completes', () => {
  const { parts } = translate('web.ndjson')
  const calls = parts.flatMap((p) =>
    p.type === 'tool-call' ? [[p.toolName, JSON.parse(p.input)]] : [],
  )
  assert.deepEqual(calls, [['webFetch', { url: 'https://example.com/' }]])
  const t = new CodexStreamTranslator({ workDir: '/reeval/workspace' })
  const search = t.push(
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'w',
        type: 'web_search',
        query: 'q',
        action: { type: 'search', query: 'reeval evals' },
      },
    }),
  )
  const call = search.find((p) => p.type === 'tool-call')
  assert.equal(call?.type === 'tool-call' && call.toolName, 'webSearch')
  assert.deepEqual(call?.type === 'tool-call' && JSON.parse(call.input), { query: 'reeval evals' })
})
