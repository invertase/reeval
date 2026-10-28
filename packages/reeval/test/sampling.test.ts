// reeval's own model calls leave sampling to the provider: Anthropic's API refuses `temperature`,
// `top_p` and `top_k` on newer models. Each call here goes through Vercel AI Gateway.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { callAnalysisModel, type ResolvedAnalysisModel } from '../src/analysis/model.ts'
import type { PairAttempt } from '../src/compare/pairs.ts'
import { answerQuestion } from '../src/compare/questions.ts'
import { scoreWithModel } from '../src/judge/model.ts'

const MODEL = 'anthropic/claude-sonnet-4.5'
const SAMPLING = ['temperature', 'topP', 'topK', 'top_p', 'top_k']

describe('sampling parameters on anthropic/* models', () => {
  const realFetch = globalThis.fetch
  const env = { ...process.env }
  let bodies: Array<Record<string, unknown>> = []

  beforeEach(() => {
    bodies = []
    process.env.AI_GATEWAY_API_KEY = 'gw-test'
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    delete process.env.TYPESAFE_AI_API_KEY
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      return new Response(
        JSON.stringify({ error: { message: 'stubbed', type: 'invalid_request' } }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    process.env = { ...env }
  })

  const assertNoSampling = (call: string) => {
    assert.ok(bodies.length > 0, `${call} sent a request`)
    for (const body of bodies) {
      for (const key of SAMPLING) assert.equal(key in body, false, `${call} sent ${key}`)
    }
  }

  const gateway: ResolvedAnalysisModel = { name: MODEL, route: 'gateway' }

  test('reeval analyze', async () => {
    await assert.rejects(callAnalysisModel(gateway, {} as never, 'go', 100))
    assertNoSampling('analysis')
  })

  test('compare questions', async () => {
    const side = (arm: string): PairAttempt => ({
      harness: 'cursor:composer-2.5',
      arm,
      run: 1,
      diff: '',
      checksPassed: true,
    })
    const answer = await answerQuestion({
      question: 'Which is cleaner?',
      model: MODEL,
      gateway: 'vercel',
      pairs: [
        {
          cut: 'within',
          harness: 'cursor:composer-2.5',
          run: 1,
          a: side('base'),
          b: side('skilled'),
        },
      ],
      state: { task: true, diff: true },
      maxInputTokens: 10_000,
      maxOutputTokens: 100,
    })
    assert.ok(answer.error, 'the stubbed call failed')
    assertNoSampling('compare question')
  })

  test('the judge', async () => {
    await assert.rejects(
      scoreWithModel(
        MODEL,
        'Is it done?',
        { messages: [] } as never,
        undefined,
        AbortSignal.timeout(10_000),
        'vercel',
      ),
    )
    assertNoSampling('judge')
  })
})
