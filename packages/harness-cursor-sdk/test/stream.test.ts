import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { CursorSdkStreamTranslator, modelLabel, toUsage } from '../src/cursor-sdk-stream.ts'
import { fixture, visible } from './support.ts'

const translate = (ndjson: string, end?: Parameters<CursorSdkStreamTranslator['end']>[0]) => {
  const t = new CursorSdkStreamTranslator()
  const parts: HarnessV1StreamPart[] = []
  for (const line of ndjson.split('\n')) parts.push(...t.push(line))
  if (end) parts.push(...t.end(end))
  return { parts: visible(parts), translator: t }
}

const line = (value: unknown) => JSON.stringify(value)
/** A multi-turn runner capture, split at each turn's `init` line. */
const turns = (ndjson: string) =>
  ndjson
    .trim()
    .split(/\n(?=\{"type":"init")/)
    .map((t) => `${t}\n`)
const event = (e: Record<string, unknown>) => line({ type: 'event', event: e })

describe('stream translation', () => {
  test('a real turn: shell, grep, reads, edits, delete, MCP, skills and rules (SDK 1.0.32)', () => {
    const { parts, translator } = translate(fixture('tools-mcp-skills.ndjson'))
    assert.equal(translator.agentId, 'agent-922f53b4-2f6c-4f26-9507-5878e7749f8f')
    // The resolved model with its parameters: what the turn ran on, not just what was asked for.
    assert.deepEqual(parts[0], { type: 'stream-start', modelId: 'composer-2.5[fast=false]' })
    const calls = parts.filter((p) => p.type === 'tool-call')
    assert.deepEqual(
      calls.map((c) => c.toolName),
      ['bash', 'grep', 'read', 'read', 'glob', 'edit', 'mcp', 'edit', 'delete'],
    )
    assert.ok(calls.every((c) => c.providerExecuted === true))
    const bash = calls[0]
    assert.equal(bash?.nativeName, 'shell')
    assert.equal(JSON.parse(bash?.input ?? '{}').command, 'echo hi-from-shell')
    const mcp = JSON.parse(calls[6]?.input ?? '{}')
    assert.deepEqual([mcp.providerIdentifier, mcp.toolName], ['codes', 'get_code'])

    const results = parts.filter((p) => p.type === 'tool-result')
    assert.equal(results.length, calls.length, 'every call gets exactly one result')
    const byId = new Map(results.map((r) => [r.toolCallId, r]))
    assert.equal(byId.get(bash?.toolCallId ?? '')?.result, 'hi-from-shell\n')
    assert.deepEqual(byId.get(calls[6]?.toolCallId ?? '')?.result, [
      { type: 'text', text: 'LAUNCH-CODE-7731' },
    ])
    const create = byId.get(calls[5]?.toolCallId ?? '')?.result as Record<string, unknown>
    assert.equal(create.linesAdded, 1)
    assert.match(String(create.diffString), /^--- \/dev\/null/)
    assert.ok(results.every((r) => r.isError !== true))

    const text = parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => p.delta)
      .join('')
    assert.match(text, /LAUNCH-CODE-7731/)
    assert.match(text, /PERIWINKLE/, 'the home skill was read')
    assert.match(text, /Ahoy, friend!/, 'the workspace skill was read')
    assert.match(text, /BANANA\s*$/, 'the AGENTS.md rule was followed')
    assert.ok(parts.some((p) => p.type === 'reasoning-delta'))

    const steps = parts.filter((p) => p.type === 'finish-step')
    assert.equal(steps.length, 1, 'the SDK reports usage once per turn')
    const finish = parts.at(-1)
    assert.equal(finish?.type, 'finish')
    if (finish?.type !== 'finish') return
    assert.deepEqual(finish.finishReason, { unified: 'stop', raw: 'finished' })
    assert.deepEqual(finish.totalUsage.inputTokens, {
      total: 34668 + 29164,
      noCache: 34668,
      cacheRead: 29164,
      cacheWrite: 0,
    })
    assert.equal(finish.totalUsage.outputTokens.total, 692)
    const meta = finish.harnessMetadata?.cursorSdk as Record<string, unknown>
    assert.equal(meta.runId, 'run-5f8111fe-50fa-4dfa-a8b6-7ccc7772fd86')
    assert.deepEqual(meta.model, { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] })
  })

  test('a real web turn on SDK 1.0.32: the agent searched and fetched, the stream has no tool call', () => {
    // Captured live: the backend sent webSearchToolCall and webFetchToolCall, and the SDK
    // dropped both, so there is nothing here to translate and nothing is invented.
    const ndjson = fixture('web-1.0.32.ndjson')
    assert.ok(!ndjson.includes('"tool_call"'))
    const { parts } = translate(ndjson)
    assert.equal(parts.filter((p) => p.type === 'tool-call').length, 0)
    const text = parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => p.delta)
      .join('')
    assert.match(text, /104\.238\.50\.245/, "the fetched page's content reached the reply")
  })

  test("the runner's recovered web calls: provider-executed builtins, with results", () => {
    // Live, two turns: the runner read each turn's web calls from the stored conversation.
    const [first = '', second = ''] = turns(fixture('web-recovered.ndjson'))
    const { parts } = translate(first)
    const calls = parts.filter((p) => p.type === 'tool-call')
    assert.deepEqual(
      calls.map((c) => [c.toolName, c.providerExecuted, c.dynamic ?? false]),
      [
        ['webFetch', true, false],
        ['webSearch', true, false],
      ],
    )
    const [fetch, search] = calls.map((c) => JSON.parse(c.input))
    assert.equal(fetch.url, 'https://httpbin.org/ip')
    assert.equal(search.query, 'IANA example domain RFC 2606', 'the common webSearch field')
    const results = new Map(
      parts.flatMap((p) => (p.type === 'tool-result' ? [[p.toolCallId, p]] : [])),
    )
    const [fetchResult, searchResult] = calls.map(
      (c) => results.get(c.toolCallId)?.result as Record<string, unknown>,
    )
    assert.match(String(fetchResult?.markdown), /104\.238\.50\.251/)
    assert.equal((searchResult?.references as unknown[] | undefined)?.length, 2)
    const finish = parts.at(-1)
    assert.equal(
      finish?.type === 'finish' && 'unreportedTools' in (finish.harnessMetadata?.cursorSdk ?? {}),
      false,
      'nothing unreported',
    )

    // The follow-up reports only its own fetch, not the first turn's again.
    const next = translate(second).parts.filter((p) => p.type === 'tool-call')
    assert.deepEqual(
      next.map((c) => [c.toolName, JSON.parse(c.input).url]),
      [['webFetch', 'https://httpbin.org/uuid']],
    )
  })

  test('a turn whose web calls went unrecovered says so in its finish metadata', () => {
    const unreported = (parts: HarnessV1StreamPart[]) => {
      const finish = parts.at(-1)
      return finish?.type === 'finish'
        ? (finish.harnessMetadata?.cursorSdk as { unreportedTools?: string[] })?.unreportedTools
        : undefined
    }
    const lost = translate(
      [
        line({ type: 'init', agentId: 'agent-1' }),
        line({ type: 'unreported', tools: ['webSearch', 'webFetch'], message: 'store locked' }),
        line({ type: 'result', status: 'finished', result: 'done' }),
      ].join('\n'),
    )
    assert.deepEqual(unreported(lost.parts), ['webSearch', 'webFetch'])
    // A turn that ended before its result never got to recover them.
    const died = translate(line({ type: 'init', agentId: 'agent-1' }), { exitCode: 1 })
    assert.deepEqual(unreported(died.parts), ['webSearch', 'webFetch'])
    const failed = translate(line({ type: 'error', message: 'boom' }))
    assert.deepEqual(unreported(failed.parts), ['webSearch', 'webFetch'])
  })

  test('a resumed turn keeps the agent id and reports its own usage', () => {
    const { parts, translator } = translate(fixture('resume.ndjson'))
    assert.equal(translator.agentId, 'agent-922f53b4-2f6c-4f26-9507-5878e7749f8f')
    const finish = parts.at(-1)
    assert.equal(finish?.type === 'finish' && finish.totalUsage.outputTokens.total, 109)
  })

  test('blocks are ordered: reasoning closes before text, text before a tool call', () => {
    const { parts } = translate(
      [
        line({ type: 'init', agentId: 'agent-1' }),
        event({ type: 'thinking', text: 'plan' }),
        event({ type: 'thinking', text: '', thinking_duration_ms: 5 }),
        event({ type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] } }),
        event({ type: 'tool_call', call_id: 'c1', name: 'ls', status: 'running', args: {} }),
        event({ type: 'tool_call', call_id: 'c1', name: 'ls', status: 'running', args: {} }),
        event({
          type: 'tool_call',
          call_id: 'c1',
          name: 'ls',
          status: 'error',
          result: { status: 'error', error: 'denied' },
        }),
        line({ type: 'result', status: 'finished', result: 'on it' }),
      ].join('\n'),
    )
    assert.deepEqual(
      parts.map((p) => p.type),
      [
        'stream-start',
        'reasoning-start',
        'reasoning-delta',
        'reasoning-end',
        'text-start',
        'text-delta',
        'text-end',
        'tool-call',
        'tool-result',
        'finish',
      ],
    )
    const result = parts.find((p) => p.type === 'tool-result')
    assert.equal(result?.type === 'tool-result' && result.isError, true)
    assert.equal(result?.type === 'tool-result' && result.result, 'denied')
  })

  test('an unknown tool is dynamic under its native name', () => {
    const { parts } = translate(
      event({ type: 'tool_call', call_id: 'x', name: 'brandNewTool', status: 'running' }),
    )
    const call = parts.find((p) => p.type === 'tool-call')
    assert.equal(call?.type === 'tool-call' && call.dynamic, true)
    assert.equal(call?.type === 'tool-call' && call.toolName, 'brandNewTool')
  })

  test('a failed run is an error part and an error finish', () => {
    const { parts } = translate(
      line({ type: 'result', status: 'error', error: { message: 'Usage limit exceeded' } }),
    )
    assert.deepEqual(
      parts.map((p) => p.type),
      ['stream-start', 'error', 'finish'],
    )
    const error = parts[1]
    assert.equal(error?.type === 'error' && (error.error as Error).message, 'Usage limit exceeded')
  })

  test('modelLabel: the id alone, or with its parameters in brackets', () => {
    assert.equal(modelLabel(undefined), undefined)
    assert.equal(modelLabel({ id: 'gpt-5.2' }), 'gpt-5.2')
    assert.equal(
      modelLabel({
        id: 'auto-smart',
        params: [
          { id: 'optimize_for', value: 'cost' },
          { id: 'fast', value: 'true' },
        ],
      }),
      'auto-smart[optimize_for=cost,fast=true]',
    )
  })

  test('a runner error line fails the turn with its message', () => {
    const { parts } = translate(
      line({ type: 'error', message: 'Invalid API key', code: 'unauthenticated' }),
    )
    const finish = parts.at(-1)
    assert.equal(finish?.type === 'finish' && finish.finishReason.raw, 'unauthenticated')
  })

  test('a runner that dies closes open calls and reports its stderr', () => {
    const { parts } = translate(
      event({ type: 'tool_call', call_id: 'c', name: 'shell', status: 'running', args: {} }),
      { exitCode: 137, stderr: 'Killed' },
    )
    assert.deepEqual(
      parts.map((p) => p.type),
      ['stream-start', 'tool-call', 'tool-result', 'error', 'finish'],
    )
    const error = parts[3]
    assert.match(
      String(error?.type === 'error' && (error.error as Error).message),
      /code 137.*Killed/,
    )
  })

  test('an aborted runner finishes without an error part', () => {
    const { parts } = translate('', { exitCode: 130, aborted: true })
    assert.deepEqual(
      parts.map((p) => p.type),
      ['stream-start', 'finish'],
    )
  })

  test('non-JSON lines pass through as raw', () => {
    const t = new CursorSdkStreamTranslator()
    assert.deepEqual(t.push('12:00 INFO something'), [
      { type: 'raw', rawValue: { unparsed: '12:00 INFO something' } },
    ])
  })

  test('toUsage: input total adds the cache; reasoning is part of output', () => {
    const usage = toUsage({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 100,
      cacheWriteTokens: 3,
      totalTokens: 120,
      reasoningTokens: 2,
    })
    assert.deepEqual(usage.inputTokens, { total: 113, noCache: 10, cacheRead: 100, cacheWrite: 3 })
    assert.deepEqual(usage.outputTokens, { total: 7, text: 5, reasoning: 2 })
    assert.equal(toUsage(undefined).inputTokens.total, undefined)
  })
})
