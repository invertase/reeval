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
import { runJourney } from '../src/capture/use.ts'
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
