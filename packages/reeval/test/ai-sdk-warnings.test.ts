// The AI SDK calls reeval makes with images (a capture's journey, a judge given captures) send
// nothing it reports as deprecated, which it would print to the attempt's stderr.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { generateText } from 'ai'
import { stubPng } from '../src/capture/stub.ts'
import { runJourney } from '../src/capture/use.ts'
import { decideState, filePartsOf, resolveJudgeArtifacts } from '../src/judge/artifacts.ts'
import { runJudge } from '../src/judge/index.ts'
import type { CaptureUseAction } from '../src/types.ts'

type Warning = { type: string; setting?: string; message?: string }
const warnings: Warning[] = []
const global = globalThis as { AI_SDK_LOG_WARNINGS?: unknown }
const before = global.AI_SDK_LOG_WARNINGS
global.AI_SDK_LOG_WARNINGS = (options: { warnings: Warning[] }) =>
  warnings.push(...options.warnings)
after(() => {
  global.AI_SDK_LOG_WARNINGS = before
})

const window = { width: 1280, height: 720 }
const png = stubPng('x', 1, '/', window)

const languageModel = (toolName: string) => ({
  specificationVersion: 'v4',
  provider: 'stub',
  modelId: 'stub',
  supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: 'c', toolName, input: '{}' }],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }),
  doStream: async () => {
    throw new Error('the stub model does not stream')
  },
})

const deprecated = () => warnings.filter((w) => w.type === 'deprecated')

test('the warning hook sees a deprecated "image" part', async () => {
  await generateText({
    model: languageModel('done') as never,
    messages: [{ role: 'user', content: [{ type: 'image', image: png }] }],
  })
  assert.match(deprecated()[0]?.setting ?? '', /"image" content part/)
  warnings.length = 0
})

test('a capture journey and a judge given its capture send nothing deprecated', async () => {
  const session = {
    window,
    cdp: { on() {}, send: async () => ({}) },
    async navigate() {
      return { loaderId: 'n' }
    },
    async wait() {},
    async screenshot() {
      return png
    },
    async dispatch(_: CaptureUseAction) {},
  }
  const journey = await runJourney(session, 'http://127.0.0.1/', {
    wait: { ms: 0 },
    timeoutMs: 10_000,
    fullPage: false,
    instructions: ['Look at the page'],
    use: { model: 'anthropic/claude-sonnet-5' },
    remaining: () => 10_000,
    loadModel: async () => languageModel('done'),
  })
  const files = filePartsOf(resolveJudgeArtifacts(true, new Map([['home', journey.png]])))
  const decided: unknown[] = []
  const judged = await runJudge(
    'Does the page show a heading?',
    decideState({ answer: 'done' }, files),
    {
      model: {
        specificationVersion: 'v4',
        provider: 'stub',
        modelId: 'stub',
        supportedQuestionTypes: ['boolean'],
        doDecide: async (options: { state: unknown }) => {
          decided.push(options.state)
          return { answers: { answer: { type: 'boolean', probability: 0.9 } }, warnings: [] }
        },
      } as never,
      threshold: 0.8,
    },
    new AbortController().signal,
  )
  assert.equal(judged.verdict.verdict, 'pass')
  assert.equal((decided[0] as Array<{ type: string }>).at(-1)?.type, 'file')
  assert.deepEqual(deprecated(), [])
})
