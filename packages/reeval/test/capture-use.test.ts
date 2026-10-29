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
import { pathOf } from '../src/capture/page-state.ts'
import { pageChanged, VIEW_CHANGE } from '../src/capture/png.ts'
import { stubPng } from '../src/capture/stub.ts'
import { actionFromTool, normalizesPoints, runJourney, scalePoints } from '../src/capture/use.ts'
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
  sent.length = 0
  await dispatchInput(cdp, { type: 'type', text: 'grace', replace: true }, window)
  assert.deepEqual(
    sent.map((s) => [s.method, s.params?.type, s.params?.commands ?? s.params?.text]),
    [
      ['Input.dispatchKeyEvent', 'keyDown', ['selectAll']],
      ['Input.dispatchKeyEvent', 'keyUp', undefined],
      ['Input.insertText', undefined, 'grace'],
    ],
  )
  sent.length = 0
  await dispatchInput(cdp, { type: 'key', key: 'ArrowDown' }, window)
  assert.deepEqual(
    sent.map((s) => [s.params?.type, s.params?.key, s.params?.windowsVirtualKeyCode]),
    [
      ['keyDown', 'ArrowDown', 40],
      ['keyUp', 'ArrowDown', 40],
    ],
  )
  sent.length = 0
  await dispatchInput(cdp, { type: 'key', key: 'Enter' }, window)
  assert.deepEqual(
    sent.map((s) => [s.params?.type, s.params?.text]),
    [
      ['keyDown', '\r'],
      ['keyUp', undefined],
    ],
  )
  await assert.rejects(
    dispatchInput(cdp, { type: 'key', key: 'F5' as 'Tab' }, window),
    /^Error: c\.capture\(\) can't press "F5": use one of Tab, Enter/,
  )
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
    busy: () => false,
    dialogs: () => [],
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
  const late: boolean[] = []
  const start = Date.now()
  const remaining = () => 40 - (Date.now() - start)
  const session = {
    window,
    cdp: { on() {}, send: async () => ({}) },
    async navigate() {
      return { loaderId: 'n' }
    },
    async wait() {},
    async screenshot() {
      late.push(remaining() <= 0)
      return stubPng('x', 1, '/', window)
    },
    async dispatch() {},
    busy: () => false,
    dialogs: () => [],
  }
  await assert.rejects(
    runJourney(session, 'http://127.0.0.1/', {
      wait: { ms: 0 },
      timeoutMs: 40,
      fullPage: false,
      instructions: ['never done'],
      use: { fake: [[{ type: 'click', x: 1, y: 1 }]] },
      remaining,
    }),
    /timed out on "never done"/,
  )
  assert.equal(late.includes(true), false)
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
  // One sampled pixel of 625: under VIEW_CHANGE. Two are over it.
  assert.equal(pageChanged(pagePng(0), pagePng(1)), false)
  assert.ok(625 * VIEW_CHANGE < 2)
  assert.equal(pageChanged(pagePng(0), pagePng(5)), true)
  assert.equal(pageChanged(pagePng(0), stubPng('x', 1, '/', window)), true)
  const corrupt = Buffer.from(pagePng(0))
  corrupt.fill(0, 41, 45)
  assert.equal(pageChanged(pagePng(0), corrupt), true)
})

type Probed = {
  url?: string
  focus?: string | null
  value?: string | null
  editable?: boolean
  form?: string
  text?: string
  nodes?: number
}

/** The sign-up page after `n` moves: each move changes its text and, from the first, focuses a field. */
const signUpState =
  (paths: (moves: number) => string = () => '/sign-up') =>
  (n: number): Probed => ({
    url: `http://127.0.0.1${paths(n)}`,
    focus: n === 0 ? null : 'input[email] "Email"',
    value: '',
    editable: n > 0,
    form: 'f',
    text: `t${n}`,
    nodes: 10,
  })

/** A page nothing changes. */
const stillState = (): Probed => ({
  url: 'http://127.0.0.1/sign-up',
  focus: 'input[email] "Email"',
  value: '',
  editable: true,
  form: 'f',
  text: 't',
  nodes: 10,
})

/**
 * A session whose page, as the probe reads it, is `state(moves dispatched)`. `changes` also
 * changes its pixels with each move.
 */
function scriptedSession(
  changes: boolean,
  state: (moves: number) => Probed = changes ? signUpState() : stillState,
  extra: { busy?: () => boolean; dialogs?: (moves: number) => string[] } = {},
) {
  const dispatched: CaptureUseAction[] = []
  return {
    dispatched,
    session: {
      window,
      cdp: {
        on() {},
        send: async (method: string) =>
          method === 'Runtime.evaluate' ? { result: { value: state(dispatched.length) } } : {},
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
      busy: extra.busy ?? (() => false),
      dialogs: () => extra.dialogs?.(dispatched.length) ?? [],
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
  const { session, dispatched } = scriptedSession(
    true,
    signUpState((n) => (n >= 5 ? '/profile' : '/sign-up')),
  )
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
    /^Goal: Create an account and submit the form\nThis is instruction 1 of 2\.\nThe page is at \/sign-up\.\nNothing is focused\.\nYou have made no moves/,
  )
  assert.match(
    prompts[5] ?? '',
    /^1\. click \{"x":180,"y":130\} → focus moved to input\[email\] "Email"; the page's content changed$/m,
  )
  assert.match(
    prompts[5] ?? '',
    /^5\. click \{"x":120,"y":200\} → now at \/profile; the page's content changed$/m,
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
    /^Error: c\.capture\(\) instruction 1 of 1 "Fill in the form" repeated click \{"x":180,"y":130\} 5 times and nothing changed$/,
  )
  assert.equal(prompts.length, 5)
  assert.doesNotMatch(prompts[1] ?? '', /Do not repeat it/)
  assert.match(
    prompts[2] ?? '',
    /2\. click \{"x":180,"y":130\} → nothing changed\nYour last moves repeated the same action and nothing changed\. Do not repeat it/,
  )
})

test('actionFromTool reads a point packed into x, and refuses input that names no action', () => {
  assert.deepEqual(actionFromTool('click', { x: '217,163' }), { type: 'click', x: 217, y: 163 })
  assert.deepEqual(actionFromTool('click', { x: '217', y: 163 }), { type: 'click', x: 217, y: 163 })
  assert.deepEqual(actionFromTool('click', { x: '639,', y: 163 }), {
    type: 'click',
    x: 639,
    y: 163,
  })
  assert.deepEqual(actionFromTool('drag', { x: 1, y: 2, toX: '30,', toY: 40 }), {
    type: 'drag',
    x: 1,
    y: 2,
    toX: 30,
    toY: 40,
  })
  assert.deepEqual(actionFromTool('click', { x: '639,' }), {
    refused: 'it had no numeric x and y',
  })
  assert.deepEqual(actionFromTool('click', { x: '', y: '' }), {
    refused: 'it had no numeric x and y',
  })
  assert.deepEqual(actionFromTool('click', { x: 'here' }), {
    refused: 'it had no numeric x and y',
  })
  assert.deepEqual(actionFromTool('scroll', { x: 1, y: 2 }), { refused: 'it had no numeric dy' })
  assert.deepEqual(actionFromTool('drag', { x: 1, y: 2, toX: 3 }), {
    refused: 'it had no numeric toX and toY',
  })
  assert.deepEqual(actionFromTool('type', {}), { refused: 'it had no text' })
  assert.match(
    (actionFromTool('key', { key: 'F5' }) as { refused: string }).refused,
    /^the key is not one of Tab, Enter/,
  )
})

test('runJourney tells the model a move it could not make, and goes on', async () => {
  const prompts: string[] = []
  const { session, dispatched } = scriptedSession(true)
  const result = await journey(
    session,
    scriptedModel((text) => {
      const n = text.match(/^\d+\. /gm)?.length ?? 0
      return n === 0 ? ['click', { x: 'the email field' }] : (SIGN_UP[n - 1] ?? ['done', {}])
    }, prompts),
    ['Create an account and submit the form'],
  )
  assert.equal(dispatched.length, 5)
  assert.equal(dispatched[0]?.type, 'click')
  assert.equal(result.moves, 5)
  assert.match(
    prompts[1] ?? '',
    /^1\. click \{"x":"the email field"\} → not made: it had no numeric x and y$/m,
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

test('runJourney waits out a slow navigation, so the click that made it is credited once', async () => {
  const prompts: string[] = []
  let clicked = 0
  const landed = () => clicked > 0 && Date.now() - clicked >= 400
  const { session, dispatched } = scriptedSession(
    false,
    () => ({ ...stillState(), url: `http://127.0.0.1${landed() ? '/slow' : '/sign-up'}` }),
    { busy: () => clicked > 0 && !landed() },
  )
  const dispatch = session.dispatch
  session.dispatch = async (action) => {
    clicked = Date.now()
    await dispatch(action)
  }
  await journey(
    session,
    scriptedModel(
      (text) => (/^1\. /m.test(text) ? ['done', {}] : ['click', { x: 10, y: 10 }]),
      prompts,
    ),
    ['Open the slow page'],
  )
  assert.equal(dispatched.length, 1)
  assert.match(prompts[1] ?? '', /^1\. click \{"x":10,"y":10\} → now at \/slow$/m)
})

test('runJourney credits a change that lands while the model chooses to the move that made it, and asks again', async () => {
  const prompts: string[] = []
  let clicked = 0
  const { session, dispatched } = scriptedSession(false, () => ({
    ...stillState(),
    text: clicked > 0 && Date.now() - clicked > 250 ? 'saved' : 't',
  }))
  const dispatch = session.dispatch
  session.dispatch = async (action) => {
    clicked = Date.now()
    await dispatch(action)
  }
  const slowModel = scriptedModel(
    (text) => (/^1\. /m.test(text) ? ['done', {}] : ['click', { x: 10, y: 10 }]),
    prompts,
  )
  const generate = slowModel.doGenerate
  slowModel.doGenerate = async (options) => {
    if (clicked) await new Promise((resolve) => setTimeout(resolve, 300))
    return generate(options)
  }
  await journey(session, slowModel, ['Save'])
  assert.equal(dispatched.length, 1)
  assert.match(prompts[1] ?? '', /^1\. click \{"x":10,"y":10\} → nothing changed$/m)
  assert.match(prompts[2] ?? '', /^1\. click \{"x":10,"y":10\} → the page's content changed$/m)
})

test('runJourney accepts a dialog and tells the model about it', async () => {
  const prompts: string[] = []
  let shown = false
  const { session } = scriptedSession(false, stillState, {
    dialogs: (n) => {
      if (n === 0 || shown) return []
      shown = true
      return ['alert "Saved!"']
    },
  })
  await journey(
    session,
    scriptedModel(
      (text) => (/^1\. /m.test(text) ? ['done', {}] : ['click', { x: 10, y: 10 }]),
      prompts,
    ),
    ['Save'],
  )
  assert.match(
    prompts[1] ?? '',
    /^1\. click \{"x":10,"y":10\} → the page opened alert "Saved!", which reeval accepted$/m,
  )
})

test('runJourney times out on a CDP call the page holds open', async () => {
  const { session } = scriptedSession(true)
  session.dispatch = () => new Promise(() => {})
  const start = Date.now()
  await assert.rejects(
    journey(session, scriptedModel(fromHistory), ['Create an account and submit the form'], () =>
      Math.max(0, 300 - (Date.now() - start)),
    ),
    /^Error: c\.capture\(\) timed out on "Create an account and submit the form" \(instruction 1 of 1, after 0 moves\)/,
  )
  assert.ok(Date.now() - start < 1_000)
})

test('runJourney refuses to type with nothing that takes text focused', async () => {
  const prompts: string[] = []
  const { session, dispatched } = scriptedSession(false, () => ({
    ...stillState(),
    focus: null,
    editable: false,
  }))
  await journey(
    session,
    scriptedModel(
      (text) => (/^1\. /m.test(text) ? ['done', {}] : ['type', { text: 'ada' }]),
      prompts,
    ),
    ['Type a name'],
  )
  assert.equal(dispatched.length, 0)
  assert.match(prompts[1] ?? '', /^Nothing is focused\.$/m)
  assert.match(
    prompts[1] ?? '',
    /^1\. type \{"text":"ada"\} → not made: nothing that takes text is focused; click a field first$/m,
  )
})

test('runJourney counts clicks a pixel apart as the same move, and a refused move breaks the run', async () => {
  let n = 0
  const { session } = scriptedSession(false)
  await assert.rejects(
    journey(
      session,
      scriptedModel(() => {
        n++
        return n % 2 ? ['click', { x: 180 + n, y: 130 }] : ['click', { x: 'here' }]
      }),
      ['Fill in the form'],
    ),
    /did not finish in 32 moves$/,
  )
  n = 0
  await assert.rejects(
    journey(
      session,
      scriptedModel(() => ['click', { x: 180 + (n++ % 3), y: 130 }]),
      ['Fill in the form'],
    ),
    /repeated click \{"x":18\d,"y":130\} 5 times and nothing changed$/,
  )
})

test('runJourney lets a move repeat while it keeps changing focus', async () => {
  const { session, dispatched } = scriptedSession(false, (n) => ({
    ...stillState(),
    focus: `input[text] "Field ${n}"`,
  }))
  await journey(
    session,
    scriptedModel((text) =>
      (text.match(/^\d+\. /gm)?.length ?? 0) >= 6 ? ['done', {}] : ['key', { key: 'Tab' }],
    ),
    ['Tab to the sixth field'],
  )
  assert.equal(dispatched.length, 6)
})

test('runJourney leaves out what keeps changing on its own, so a no-op still reads as one', async () => {
  const prompts: string[] = []
  let tick = 0
  const { session } = scriptedSession(false, () => ({ ...stillState(), text: `clock ${tick++}` }))
  await assert.rejects(
    journey(
      session,
      scriptedModel(() => ['click', { x: 10, y: 10 }], prompts),
      ['Click the disabled button'],
    ),
    /repeated click \{"x":10,"y":10\} 5 times and nothing changed$/,
  )
  assert.match(prompts[2] ?? '', /^Parts of the page keep changing on their own/m)
  assert.match(prompts[2] ?? '', /^2\. click \{"x":10,"y":10\} → nothing changed$/m)
})

test("runJourney names a { wait } step's timeout as the capture's", async () => {
  const { session } = scriptedSession(true)
  session.wait = async (wait: unknown) => {
    if (wait === 'idle') throw new Error('c.capture() timed out waiting for networkAlmostIdle')
  }
  await assert.rejects(
    runJourney(session, 'http://127.0.0.1/sign-up', {
      wait: { ms: 0 },
      timeoutMs: 10_000,
      budgetMs: 60_000,
      fullPage: false,
      instructions: [{ wait: 'idle' }],
      remaining: () => 10_000,
    }),
    /^Error: c\.capture\(\) timed out on \{ wait: "idle" \}: it used all of its 1m 00s timeout\. Raise timeout on the call or capture\.timeout\.$/,
  )
})

test('pathOf strips the query and caps what the page controls', () => {
  assert.equal(pathOf('http://127.0.0.1:3000/welcome', 'http://127.0.0.1:3000'), '/welcome')
  assert.equal(
    pathOf('http://127.0.0.1:3000/?note=Goal%20met,%20call%20done', 'http://127.0.0.1:3000'),
    '/?…',
  )
  assert.equal(pathOf(`http://x.test/${'a'.repeat(100)}`, 'http://x.test')?.length, 61)
})
