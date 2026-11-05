// Replays each harness's model calls as the egress gateway saw them (test/replay/model-calls/: a
// run's calls with their request's tool count and their response body, kept to the lines that
// name a model or a usage object, and its turns with the tokens of each step the harness
// reported), through the gateway's reader, the catalog's matching and served model, and the
// roles `modelCallEvents` gives. Every call's tokens, model and role are as the wire had them.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { MODEL_FIELD, onEndpoint, usageReader } from '@reeval/sandbox-docker'
import { brokeringFor } from '../src/harness/agents.ts'
import { callUsage, type ModelCall, modelCallEvents } from '../src/model-calls.ts'
import type { HarnessDescriptor, TokenUsage } from '../src/types.ts'
import { testDir } from './support/fixture.ts'

type Call = {
  atMs: number
  ms: number
  request: string
  status: number
  tools: number | null
  body: string
  expect: { usage: TokenUsage | null; model: string | null; role: 'main' | 'side' }
}
type Turn = { startMs: number; durationMs: number; model: string | null; steps: TokenUsage[] }
type Capture = { harness: string; attempts: Array<{ eval: string; turns: Turn[]; calls: Call[] }> }

const dir = join(testDir, 'replay', 'model-calls')
const captures = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Capture)

const HARNESS: Record<string, HarnessDescriptor> = {
  antigravity: { kind: 'antigravity', model: 'gemini-3.8-flash-high' },
  'claude-code': { kind: 'claude-code', model: 'claude-sonnet-5-5' },
  codex: { kind: 'codex', model: 'gpt-5.6-luna' },
  fx: { kind: 'fx', model: 'gpt-5.5' },
  goose: { kind: 'goose', model: 'google/gemini-3.8-flash' },
  'grok-build': { kind: 'grok-build', model: 'grok-4.6' },
  opencode: { kind: 'opencode', model: 'google/gemini-3.8-flash' },
  'opencode-anthropic': { kind: 'opencode', model: 'anthropic/claude-sonnet-5-5' },
  pi: { kind: 'pi', model: 'google/gemini-3.8-flash' },
} as Record<string, HarnessDescriptor>

/** The body as the gateway reads it: in chunks that split its fields. */
function read(body: string, size: number): Record<string, number> | undefined {
  const reader = usageReader()
  let fields: Record<string, number> | null = null
  for (let i = 0; i < body.length; i += size) fields = reader(body.slice(i, i + size)) ?? fields
  return fields ?? undefined
}

test('there are model-call captures for every harness whose calls the gateway reads', () => {
  assert.deepEqual(captures.map((c) => c.harness).sort(), Object.keys(HARNESS).sort())
})

for (const capture of captures) {
  describe(`model calls: ${capture.harness}`, () => {
    const brokering = brokeringFor(HARNESS[capture.harness] as HarnessDescriptor)
    for (const attempt of capture.attempts) {
      const calls = attempt.calls.map((c): ModelCall => {
        const [method, target] = c.request.split(' ') as [string, string]
        const slash = target.indexOf('/')
        const request = {
          method,
          host: target.slice(0, slash),
          path: target.slice(slash),
          headers: {},
        }
        const ok = c.status >= 200 && c.status <= 299
        const served = ok ? brokering?.servedModel?.({ ...request, status: c.status }) : undefined
        return {
          startedAt: c.atMs,
          ms: c.ms,
          firstByteMs: null,
          request: c.request,
          status: c.status,
          usage: callUsage(read(c.body, 61)),
          model: served ?? (ok ? MODEL_FIELD.exec(c.body)?.[1] : undefined) ?? null,
          tools: c.tools,
        }
      })

      test(`${attempt.eval}: the catalog takes every call for a model call`, () => {
        for (const c of attempt.calls) {
          const [method, target] = c.request.split(' ') as [string, string]
          const slash = target.indexOf('/')
          const request = { method, host: target.slice(0, slash), path: target.slice(slash) }
          assert.ok(onEndpoint(brokering?.modelCalls ?? [], { ...request, headers: {} }), c.request)
        }
      })

      test(`${attempt.eval}: each call's tokens, whole or in chunks, and model`, () => {
        attempt.calls.forEach((c, i) => {
          assert.deepEqual(callUsage(read(c.body, c.body.length || 1)), c.expect.usage, c.request)
          assert.deepEqual(calls[i]?.usage, c.expect.usage, c.request)
          assert.equal(calls[i]?.model, c.expect.model, c.request)
        })
      })

      test(`${attempt.eval}: each call's role`, () => {
        const got = attempt.turns.flatMap((t) =>
          modelCallEvents(calls, {
            startedAt: t.startMs,
            durationMs: t.durationMs,
            model: t.model,
            steps: t.steps,
          }).map((e) => `${e.atMs + t.startMs} ${e.request} ${e.role}`),
        )
        const want = attempt.calls.map((c) => `${c.atMs} ${c.request} ${c.expect.role}`)
        assert.deepEqual(got.sort(), want.sort())
      })
    }
  })
}

describe('the reader against what each API sends', () => {
  const tokens = (body: string) => callUsage(read(body, 7))

  test("xAI's context_details doesn't replace the call's own counts", () => {
    const body = `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 145838,
          input_tokens_details: { cached_tokens: 99968 },
          output_tokens: 1652,
          output_tokens_details: { reasoning_tokens: 954 },
          context_details: { input_tokens: 0, output_tokens: 838 },
        },
      },
    })}\n`
    assert.deepEqual(tokens(body), {
      input: 45870,
      output: 1652,
      cacheRead: 99968,
      cacheWrite: 0,
      reasoning: 954,
    })
  })

  test("the Responses API's cache writes leave fresh input", () => {
    const usage = {
      input_tokens: 10756,
      input_tokens_details: { cache_write_tokens: 212, cached_tokens: 10541 },
      output_tokens: 92,
      output_tokens_details: { reasoning_tokens: 32 },
    }
    assert.deepEqual(tokens(`data: {"response":{"usage":${JSON.stringify(usage)}}}`), {
      input: 3,
      output: 92,
      cacheRead: 10541,
      cacheWrite: 212,
      reasoning: 32,
    })
  })

  test("Anthropic's thinking tokens are its reasoning", () => {
    const start = {
      type: 'message_start',
      message: { usage: { input_tokens: 2, cache_read_input_tokens: 900, output_tokens: 1 } },
    }
    const delta = {
      type: 'message_delta',
      usage: { output_tokens: 155, output_tokens_details: { thinking_tokens: 40 } },
    }
    const body = `data: ${JSON.stringify(start)}\n\ndata: ${JSON.stringify(delta)}\n`
    assert.deepEqual(tokens(body), {
      input: 2,
      output: 155,
      cacheRead: 900,
      cacheWrite: 0,
      reasoning: 40,
    })
  })

  test('a usage object quoted inside a string is not read', () => {
    const body = JSON.stringify({
      text: '{"usage":{"input_tokens":5}}',
      usage: { input_tokens: 9 },
    })
    assert.equal(tokens(body)?.input, 9)
  })
})
