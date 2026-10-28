import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { fakeInstructions } from '../src/capture/fake-instructions.ts'
import {
  dispatchInput,
  mapPagePoint,
  parseInstructions,
  resolveWait,
} from '../src/capture/index.ts'
import { CARET_PIXELS, pageChanged } from '../src/capture/png.ts'
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

type Prompt = Array<{ role: string; content: unknown }>

/** The text of the prompt's user message: the goal, the page and the moves so far. */
const userText = (prompt: Prompt) =>
  ((prompt.find((m) => m.role === 'user')?.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')

/** A model that answers each call with `next(prompt text)`, as one tool call. */
function scriptedModel(next: (text: string) => [string, object], prompts: string[] = []) {
  let calls = 0
  return {
    specificationVersion: 'v4',
    provider: 'stub',
    modelId: 'stub',
    supportedUrls: {},
    doGenerate: async (options: { prompt: Prompt; abortSignal?: AbortSignal }) => {
      const text = userText(options.prompt)
      prompts.push(text)
      const [toolName, input] = next(text)
      return {
        content: [
          { type: 'tool-call', toolCallId: `c${calls++}`, toolName, input: JSON.stringify(input) },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }
    },
    doStream: async () => {
      throw new Error('the stub model does not stream')
    },
  }
}

/**
 * A 100×100 RGB PNG, white but for `painted` black pixels on its even rows. Each odd row repeats
 * the row above through the Up filter, so each painted pixel shows twice.
 */
function pagePng(painted: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(100, 0)
  ihdr.writeUInt32BE(100, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows = Buffer.alloc(100 * 301, 0xff)
  for (let y = 1; y < 100; y += 2) rows.fill(0, y * 301, (y + 1) * 301).writeUInt8(2, y * 301)
  for (let i = 0; i < painted; i++) {
    const at = 2 * Math.floor(i / 100) * 301 + 1 + (i % 100) * 3
    rows.fill(0, at, at + 3)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('pageChanged ignores a caret-sized difference, and reads bytes it cannot decode', () => {
  assert.equal(pageChanged(pagePng(0), pagePng(0)), false)
  assert.equal(pageChanged(pagePng(0), pagePng(CARET_PIXELS / 2)), false)
  assert.equal(pageChanged(pagePng(0), pagePng(CARET_PIXELS / 2 + 1)), true)
  assert.equal(pageChanged(pagePng(0), stubPng('x', 1, '/', window)), true)
  const corrupt = Buffer.from(pagePng(0))
  corrupt.fill(0, 41, 45)
  assert.equal(pageChanged(pagePng(0), corrupt), true)
})

/** A session whose screenshot changes with each move when `changes` is set, at a path per move. */
function scriptedSession(changes: boolean, paths: (moves: number) => string = () => '/sign-up') {
  const dispatched: CaptureUseAction[] = []
  return {
    dispatched,
    session: {
      window,
      cdp: {
        on() {},
        send: async (method: string) =>
          method === 'Page.getNavigationHistory'
            ? { currentIndex: 0, entries: [{ url: `http://127.0.0.1${paths(dispatched.length)}` }] }
            : {},
      },
      async navigate() {
        return { loaderId: 'n' }
      },
      async wait() {},
      async screenshot() {
        return pagePng(changes ? dispatched.length * 200 : 0)
      },
      async dispatch(action: CaptureUseAction) {
        dispatched.push(action)
      },
    },
  }
}

/** The sign-up form's moves, in order: what a model that reads its history makes. */
const SIGN_UP: Array<[string, object]> = [
  ['click', { x: 180, y: 130 }],
  ['type', { text: 'ada@example.com' }],
  ['click', { x: 180, y: 165 }],
  ['type', { text: 'Test1234!' }],
  ['click', { x: 120, y: 200 }],
  ['done', {}],
]

/** Picks the next sign-up move from the moves the prompt lists, so it repeats move 1 without them. */
const fromHistory = (text: string): [string, object] =>
  text.startsWith('Goal: Open the profile')
    ? ['done', {}]
    : (SIGN_UP[text.match(/^\d+\. /gm)?.length ?? 0] ?? ['done', {}])

const journey = (
  session: ReturnType<typeof scriptedSession>['session'],
  model: unknown,
  instructions: string[],
  remaining: () => number = () => 10_000,
) =>
  runJourney(session, 'http://127.0.0.1/sign-up', {
    wait: { ms: 0 },
    timeoutMs: 10_000,
    budgetMs: 60_000,
    fullPage: false,
    instructions,
    use: { model: 'anthropic/claude-sonnet-5' },
    remaining,
    loadModel: async () => model,
  })

test('runJourney gives the model its moves and their effect, so a multi-step form finishes', async () => {
  const prompts: string[] = []
  const { session, dispatched } = scriptedSession(true, (n) => (n >= 5 ? '/profile' : '/sign-up'))
  const result = await journey(session, scriptedModel(fromHistory, prompts), [
    'Create an account and submit the form',
    'Open the profile',
  ])
  assert.deepEqual(
    dispatched.map((a) => a.type),
    ['click', 'type', 'click', 'type', 'click'],
  )
  assert.equal(result.moves, 5)
  assert.match(
    prompts[0] ?? '',
    /^Goal: Create an account and submit the form\nThis is instruction 1 of 2\.\nThe page is at \/sign-up\.\nYou have made no moves/,
  )
  assert.match(prompts[5] ?? '', /^1\. click \{"x":180,"y":130\} → the page changed$/m)
  assert.match(
    prompts[5] ?? '',
    /^5\. click \{"x":120,"y":200\} → the page changed, now at \/profile$/m,
  )
  assert.match(
    prompts[6] ?? '',
    /instruction 2 of 2\. Already done: "Create an account and submit the form"\.\nThe page is at \/profile\./,
  )
})

test('runJourney stops a model that repeats a move that changes nothing, after nudging it', async () => {
  const prompts: string[] = []
  const { session } = scriptedSession(false)
  await assert.rejects(
    journey(
      session,
      scriptedModel(() => ['click', { x: 180, y: 130 }], prompts),
      ['Fill in the form'],
    ),
    /^Error: c\.capture\(\) instruction 1 of 1 "Fill in the form" repeated click \{"x":180,"y":130\} 4 times without the page changing$/,
  )
  assert.equal(prompts.length, 4)
  assert.doesNotMatch(prompts[1] ?? '', /Do not repeat it/)
  assert.match(
    prompts[2] ?? '',
    /2\. click \{"x":180,"y":130\} → the page did not change\nYour last moves repeated the same action without changing the page\. Do not repeat it/,
  )
})

test('runJourney names the instruction, the moves and the timeout when a model call outlives the budget', async () => {
  const { session } = scriptedSession(true)
  let calls = 0
  const slow = {
    ...scriptedModel(fromHistory),
    doGenerate: (options: { abortSignal?: AbortSignal; prompt: Prompt }) =>
      calls++ < 2
        ? scriptedModel(fromHistory).doGenerate(options)
        : new Promise((_, reject) =>
            options.abortSignal?.addEventListener('abort', () =>
              reject(options.abortSignal?.reason),
            ),
          ),
  }
  // AbortSignal.timeout's timer doesn't hold the event loop open; a run's other work does.
  const alive = setInterval(() => {}, 50)
  const start = Date.now()
  try {
    await assert.rejects(
      journey(session, slow, ['Open the profile', 'Create an account and submit the form'], () =>
        Math.max(0, 300 - (Date.now() - start)),
      ),
      (error: Error) => {
        assert.equal(error.name, 'Error')
        assert.equal(
          error.message,
          'c.capture() timed out on "Create an account and submit the form" (instruction 2 of 2, after 1 move): it used all of its 1m 00s timeout. Raise timeout on the call or capture.timeout.',
        )
        return true
      },
    )
  } finally {
    clearInterval(alive)
  }
})
