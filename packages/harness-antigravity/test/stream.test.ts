import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { AntigravityStreamTranslator, toUsage } from '../src/antigravity-stream.ts'
import { fixture, visible } from './support.ts'

const translate = (ndjson: string, end?: Parameters<AntigravityStreamTranslator['end']>[0]) => {
  const t = new AntigravityStreamTranslator({ turn: 1 })
  const parts: HarnessV1StreamPart[] = []
  for (const line of ndjson.split('\n')) parts.push(...t.push(line))
  if (end) parts.push(...t.end(end))
  return { parts: visible(parts), translator: t }
}

const line = (event: unknown) => JSON.stringify(event)
const step = (s: Record<string, unknown>) => line({ event: 'step_update', step_update: s })

describe('stream translation', () => {
  test('a real run: write, then run a command, then reply (CLI 1.2.11)', () => {
    const { parts, translator } = translate(fixture('write-and-run.ndjson'))
    assert.equal(translator.conversationId, '73cd5f6c-f829-405b-afa5-edf7330b51cd')
    assert.deepEqual(
      parts.map((p) => p.type),
      [
        'stream-start',
        'finish-step',
        'tool-call',
        'tool-result',
        'finish-step',
        'tool-call',
        'tool-result',
        'text-start',
        'text-delta',
        'text-end',
        'finish-step',
        'finish',
      ],
    )
    assert.deepEqual(parts[0], { type: 'stream-start', modelId: 'gemini-3.8-flash-low' })
    const calls = parts.filter((p) => p.type === 'tool-call')
    assert.deepEqual(
      calls.map((c) => [c.toolName, c.nativeName, JSON.parse(c.input)]),
      [
        [
          'write',
          'write_to_file',
          { TargetFile: '/es/workspace/hello.txt', file_path: '/es/workspace/hello.txt' },
        ],
        ['bash', 'run_command', { CommandLine: 'cat hello.txt', command: 'cat hello.txt' }],
      ],
    )
    assert.ok(calls.every((c) => c.providerExecuted === true && c.toolCallId.startsWith('agy-')))
    const results = parts.filter((p) => p.type === 'tool-result')
    assert.deepEqual(
      results.map((r) => [r.toolCallId === calls[results.indexOf(r)]?.toolCallId, r.result]),
      [
        [true, ''],
        [true, 'hi\r\n'],
      ],
    )
    assert.ok(
      results.every((r) => !('providerExecuted' in r)),
      'not a tool-result field',
    )
    // The step before a tool finishes as tool-calls, the last one as stop.
    const steps = parts.filter((p) => p.type === 'finish-step')
    assert.deepEqual(
      steps.map((s) => s.finishReason.unified),
      ['tool-calls', 'tool-calls', 'stop'],
    )
    const text = parts.find((p) => p.type === 'text-delta')
    assert.equal(text?.type === 'text-delta' && text.delta, 'DONE\n')
    const finish = parts.at(-1)
    assert.ok(finish?.type === 'finish')
    assert.deepEqual(finish.finishReason, { unified: 'stop', raw: 'SUCCESS' })
    assert.equal(finish.totalUsage.inputTokens.total, 37429)
    assert.equal(finish.totalUsage.outputTokens.total, 265)
    assert.equal(finish.totalUsage.outputTokens.reasoning, 129)
    assert.equal(finish.totalUsage.outputTokens.text, 136)
  })

  test('web tools get common names, and a failed tool is an error result', () => {
    const { parts } = translate(fixture('web-and-errors.ndjson'))
    const calls = parts.filter((p) => p.type === 'tool-call')
    assert.deepEqual(
      calls.map((c) => [c.toolName, JSON.parse(c.input)]),
      [
        ['webSearch', { query: 'antigravity cli headless' }],
        ['webFetch', { Url: 'https://example.com', url: 'https://example.com' }],
        ['write', { TargetFile: '/es/workspace/new.txt', file_path: '/es/workspace/new.txt' }],
        ['read', { AbsolutePath: '/nope.txt', file_path: '/nope.txt' }],
      ],
    )
    // One call per step, though the CLI reports ACTIVE and then DONE.
    assert.equal(new Set(calls.map((c) => c.toolCallId)).size, calls.length)
    const failed = parts.filter((p) => p.type === 'tool-result' && p.isError)
    assert.equal(failed.length, 1)
    assert.match(String(failed[0]?.type === 'tool-result' && failed[0].result), /no such file/)
  })

  test('streamed text deltas join into one block per step', () => {
    const { parts } = translate(
      [
        line({ event: 'init', conversation_id: 'c1', init: {} }),
        step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hel' }),
        step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'lo' }),
        step({ step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '!' }),
        line({ event: 'result', result: { status: 'SUCCESS', response: 'Hello!' } }),
      ].join('\n'),
    )
    const deltas = parts.flatMap((p) => (p.type === 'text-delta' ? [p.delta] : []))
    assert.deepEqual(deltas, ['Hel', 'lo', '!'])
    assert.equal(parts.filter((p) => p.type === 'text-start').length, 1)
    assert.equal(parts.filter((p) => p.type === 'text-end').length, 1)
  })

  test('a response only in the result still becomes text, once', () => {
    const { parts } = translate(
      line({ event: 'result', result: { status: 'SUCCESS', response: 'pong\n', usage: {} } }),
    )
    assert.deepEqual(
      parts.map((p) => p.type),
      ['stream-start', 'text-start', 'text-delta', 'text-end', 'finish-step', 'finish'],
    )
  })

  test('an ERROR result is an error part and an error finish', () => {
    const { parts } = translate(
      line({
        event: 'result',
        result: { status: 'ERROR', response: '', error: 'invalid model selection' },
      }),
    )
    const error = parts.find((p) => p.type === 'error')
    assert.match(String(error?.type === 'error' && (error.error as Error).message), /invalid model/)
    const finish = parts.at(-1)
    assert.ok(finish?.type === 'finish')
    assert.deepEqual(finish.finishReason, { unified: 'error', raw: 'ERROR' })
  })

  test('a process that exits without a result ends the turn with its stderr', () => {
    const { parts } = translate(line({ event: 'init', init: {} }), {
      exitCode: 3,
      stderr: 'error: authentication required\n',
    })
    const error = parts.find((p) => p.type === 'error')
    assert.match(
      String(error?.type === 'error' && (error.error as Error).message),
      /exited with code 3 .*authentication required/,
    )
    assert.deepEqual(parts.at(-1)?.type === 'finish' && parts.at(-1), {
      type: 'finish',
      finishReason: { unified: 'error', raw: 'exit 3' },
      totalUsage: toUsage(undefined),
    })
  })

  test('an aborted turn finishes without an error, and end() after a result adds nothing', () => {
    const aborted = translate('', { exitCode: 137, aborted: true })
    assert.deepEqual(
      aborted.parts.map((p) => p.type),
      ['stream-start', 'finish'],
    )
    const t = new AntigravityStreamTranslator({ turn: 1 })
    t.push(line({ event: 'result', result: { status: 'SUCCESS', response: 'x' } }))
    assert.deepEqual(t.end({ exitCode: 0 }), [])
  })

  test('a tool still running when the process ends gets an error result', () => {
    const running = [
      line({ event: 'init', conversation_id: 'c1', init: {} }),
      step({
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 600' } },
      }),
    ].join('\n')
    for (const [end, message] of [
      [{ exitCode: 137, aborted: true }, 'run_command aborted'],
      [{ exitCode: 1 }, 'run_command interrupted'],
    ] as const) {
      const { parts } = translate(running, end)
      const call = parts.find((p) => p.type === 'tool-call')
      const result = parts.find((p) => p.type === 'tool-result')
      assert.ok(call?.type === 'tool-call' && result?.type === 'tool-result')
      assert.deepEqual(result, {
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: 'bash',
        result: message,
        isError: true,
      })
      assert.equal(parts.at(-1)?.type, 'finish')
    }
  })

  test('tools outside the catalog are dynamic; unparsable lines pass through as raw', () => {
    const t = new AntigravityStreamTranslator({ turn: 2 })
    const parts = [
      ...t.push(
        step({
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_info: { name: 'browser_click_element', parameters: { Index: 3 } },
        }),
      ),
      ...t.push('not json'),
    ]
    const call = parts.find((p) => p.type === 'tool-call')
    assert.ok(call?.type === 'tool-call')
    assert.equal(call.toolName, 'browser_click_element')
    assert.equal(call.dynamic, true)
    assert.equal(call.toolCallId, 'agy-turn2-1')
    assert.deepEqual(parts.at(-1), { type: 'raw', rawValue: { unparsed: 'not json' } })
  })

  test('usage maps onto the AI SDK shape and keeps the raw counts', () => {
    assert.deepEqual(
      toUsage({
        input_tokens: 100,
        output_tokens: 30,
        thinking_tokens: 10,
        cache_read_tokens: 40,
        total_tokens: 130,
      }),
      {
        inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: undefined },
        outputTokens: { total: 30, text: 20, reasoning: 10 },
        raw: {
          input_tokens: 100,
          output_tokens: 30,
          thinking_tokens: 10,
          cache_read_tokens: 40,
          total_tokens: 130,
        },
      },
    )
  })
})
