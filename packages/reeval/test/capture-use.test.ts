import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeInstructions } from '../src/capture/fake-instructions.ts'
import {
  dispatchInput,
  mapPagePoint,
  parseInstructions,
  resolveWait,
} from '../src/capture/index.ts'
import { stubPng } from '../src/capture/stub.ts'
import { normalizesPoints, runJourney, scalePoints } from '../src/capture/use.ts'
import type { CaptureUseAction } from '../src/types.ts'

const window = { width: 1280, height: 720 }

test('resolveWait accepts load, idle and { ms }', () => {
  assert.equal(resolveWait(undefined), 'load')
  assert.equal(resolveWait('idle'), 'idle')
  assert.deepEqual(resolveWait({ ms: 3000 }), { ms: 3000 })
  assert.throws(() => resolveWait({ ms: -1 } as never), /wait is 'load', 'idle' or \{ ms \}/)
})

test('parseInstructions keeps goals and wait beats', () => {
  assert.deepEqual(parseInstructions(['Sign in', { wait: 'idle' }, { wait: { ms: 10 } }]), [
    'Sign in',
    { wait: 'idle' },
    { wait: { ms: 10 } },
  ])
  assert.throws(() => parseInstructions(['']), /instructions\[0\] is an empty string/)
})

test('fakeInstructions brands one list of action lists and waits', () => {
  const instructions = fakeInstructions([
    [{ type: 'click', x: 50, y: 35 }, { type: 'done' }],
    { wait: 'idle' },
    [{ type: 'click', x: 230, y: 215 }, { type: 'done' }],
  ])
  assert.deepEqual(parseInstructions(instructions), ['fake[0]', { wait: 'idle' }, 'fake[1]'])
  assert.throws(
    () => fakeInstructions(['Click go'] as never),
    /fakeInstructions\(\)\[0\] is an action list or \{ wait \}/,
  )
})

test('mapPagePoint scrolls the window when the click is below it', () => {
  const onScreen = mapPagePoint(10, 20, window, { width: 1280, height: 3000 }, 0)
  assert.deepEqual(onScreen, { x: 10, y: 20, scrollY: 0, dy: 0 })
  const below = mapPagePoint(10, 2000, window, { width: 1280, height: 3000 }, 0)
  assert.equal(below.dy > 0, true)
  assert.ok(below.y >= 0 && below.y < window.height)
})

test('dispatchInput sends CDP Input events and never Runtime.evaluate', async () => {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = []
  const cdp = {
    on() {},
    async send(method: string, params?: Record<string, unknown>) {
      sent.push({ method, params })
    },
  }
  const click: CaptureUseAction = { type: 'click', x: 40, y: 50 }
  await dispatchInput(cdp, click, window)
  assert.deepEqual(
    sent.map((s) => s.method),
    ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'],
  )
  assert.equal(
    sent.every((s) => !s.method.startsWith('Runtime') && !s.method.startsWith('DOM')),
    true,
  )
  sent.length = 0
  await dispatchInput(cdp, { type: 'type', text: 'hi' }, window)
  assert.deepEqual(sent, [{ method: 'Input.insertText', params: { text: 'hi' } }])
})

/** A language model that calls `click` at (x, y), then `done`, and records its system prompts. */
function clickingModel(x: number, y: number, systems: string[]) {
  let calls = 0
  const answer = (toolName: string, input: object) => ({
    content: [
      { type: 'tool-call', toolCallId: `c${calls}`, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  })
  return {
    specificationVersion: 'v4',
    provider: 'stub',
    modelId: 'stub',
    supportedUrls: {},
    doGenerate: async (options: { prompt: Array<{ role: string; content: unknown }> }) => {
      const system = options.prompt.find((m) => m.role === 'system')
      systems.push(String(system?.content))
      return calls++ === 0 ? answer('click', { x, y }) : answer('done', {})
    },
    doStream: async () => {
      throw new Error('the stub model does not stream')
    },
  }
}

async function journeyClick(model: string, x: number, y: number) {
  const clicks: CaptureUseAction[] = []
  const systems: string[] = []
  // The journey reads only the PNG's IHDR size; the stub model never decodes it.
  const shot = stubPng('x', 1, '/', window)
  shot.writeUInt32BE(window.width, 16)
  shot.writeUInt32BE(window.height, 20)
  const session = {
    window,
    cdp: { on() {}, send: async () => ({}) },
    async navigate() {
      return { loaderId: 'n' }
    },
    async wait() {},
    async screenshot() {
      return shot
    },
    async dispatch(action: CaptureUseAction) {
      clicks.push(action)
    },
  }
  await runJourney(session, 'http://127.0.0.1/', {
    wait: { ms: 0 },
    timeoutMs: 10_000,
    fullPage: false,
    instructions: ['Click "Show price"'],
    use: { model },
    remaining: () => 10_000,
    loadModel: async () => clickingModel(x, y, systems),
  })
  return { clicks, systems }
}

test("runJourney scales a Gemini model's 0-1000 point to the screenshot's CSS pixels", async () => {
  // gemini-3.8-flash's answer for a button centered at (1000, 550) on a 1280x720 page.
  const gemini = await journeyClick('google/gemini-3.8-flash', 781, 764)
  assert.deepEqual(gemini.clicks, [{ type: 'click', x: 1000, y: 550 }])
  assert.match(gemini.systems[0] ?? '', /normalized to 0-1000/)
  const claude = await journeyClick('anthropic/claude-sonnet-5', 1000, 550)
  assert.deepEqual(claude.clicks, [{ type: 'click', x: 1000, y: 550 }])
  assert.match(claude.systems[0] ?? '', /CSS pixels/)
})

test('scalePoints scales every point of an action and only Gemini ids normalize', () => {
  const page = { width: 1280, height: 3000 }
  assert.deepEqual(scalePoints({ type: 'drag', x: 0, y: 500, toX: 1000, toY: 1000 }, page), {
    type: 'drag',
    x: 0,
    y: 1500,
    toX: 1280,
    toY: 3000,
  })
  assert.deepEqual(scalePoints({ type: 'scroll', x: 500, y: 500, dy: 300 }, page), {
    type: 'scroll',
    x: 640,
    y: 1500,
    dy: 300,
  })
  assert.deepEqual(scalePoints({ type: 'type', text: 'hi' }, page), { type: 'type', text: 'hi' })
  assert.equal(normalizesPoints('google/gemini-3.8-flash'), true)
  assert.equal(normalizesPoints('vertex/gemini-3.8-pro'), true)
  assert.equal(normalizesPoints('anthropic/claude-sonnet-5'), false)
  assert.equal(normalizesPoints('openai/gpt-5.5'), false)
})

test('runJourney times out before the saved screenshot', async () => {
  let saved = 0
  const session = {
    window,
    cdp: { on() {}, send: async () => ({}) },
    async navigate() {
      return { loaderId: 'n' }
    },
    async wait() {},
    async screenshot(fullPage: boolean) {
      if (!fullPage) {
        saved++
        throw new Error('saved shot should not run')
      }
      return stubPng('x', 1, '/', window)
    },
    async dispatch() {},
  }
  const start = Date.now()
  await assert.rejects(
    runJourney(session, 'http://127.0.0.1/', {
      wait: { ms: 0 },
      timeoutMs: 40,
      fullPage: false,
      instructions: ['never done'],
      use: { fake: [[{ type: 'click', x: 1, y: 1 }]] },
      remaining: () => 40 - (Date.now() - start),
    }),
    /timed out on "never done"/,
  )
  assert.equal(saved, 0)
})
