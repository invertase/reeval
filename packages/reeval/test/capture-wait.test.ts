import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  listenForCaptureWait,
  resolveCaptureCall,
  resolveCaptureWait,
} from '../src/capture/index.ts'

const viewport = { width: 1280, height: 720 }

test('resolveCaptureCall passes wait idle and defaults to load', () => {
  const call = { wait: 'idle' as const }
  assert.deepEqual(resolveCaptureCall(9, call, {}), {
    port: 9,
    name: 'root',
    path: '/',
    viewport,
    timeoutMs: 60_000,
    wait: 'idle',
  })
})

test('resolveCaptureWait defaults to load and rejects anything else', () => {
  assert.equal(resolveCaptureWait(undefined), 'load')
  assert.equal(resolveCaptureWait('load'), 'load')
  assert.equal(resolveCaptureWait('idle'), 'idle')
  assert.throws(
    () => resolveCaptureWait('networkIdle' as never),
    (error: Error) => {
      assert.equal(error.message, `c.capture() wait is 'load' or 'idle' (got "networkIdle")`)
      return true
    },
  )
})

function fakeCdp() {
  const listeners = new Map<string, Array<(p: unknown) => void>>()
  return {
    on(method: string, fn: (p: unknown) => void) {
      const list = listeners.get(method) ?? []
      list.push(fn)
      listeners.set(method, list)
    },
    emit(method: string, msg: unknown) {
      for (const fn of listeners.get(method) ?? []) fn(msg)
    },
  }
}

test('listenForCaptureWait load resolves on Page.loadEventFired', async () => {
  const cdp = fakeCdp()
  const page = listenForCaptureWait(cdp, 'load')
  cdp.emit('Page.loadEventFired', {})
  page.arm()
  const ready = page.ready(undefined, 1_000)
  cdp.emit('Page.loadEventFired', {})
  await ready
})

test('listenForCaptureWait idle accepts a buffered event after arm', async () => {
  const cdp = fakeCdp()
  const page = listenForCaptureWait(cdp, 'idle')
  page.arm()
  cdp.emit('Page.lifecycleEvent', {
    params: { name: 'networkAlmostIdle', loaderId: 'nav' },
  })
  await page.ready({ loaderId: 'nav' }, 1_000)
})

test('listenForCaptureWait idle waits for networkAlmostIdle on the navigated loader', async () => {
  const cdp = fakeCdp()
  const page = listenForCaptureWait(cdp, 'idle')
  page.arm()
  cdp.emit('Page.lifecycleEvent', { params: { name: 'load', loaderId: 'nav' } })
  cdp.emit('Page.lifecycleEvent', {
    params: { name: 'networkAlmostIdle', loaderId: 'blank' },
  })
  const ready = page.ready({ loaderId: 'nav' }, 1_000)
  cdp.emit('Page.lifecycleEvent', {
    params: { name: 'networkAlmostIdle', loaderId: 'nav' },
  })
  await ready
})

test('listenForCaptureWait times out naming the wait and does not resolve late', async () => {
  const cdp = fakeCdp()
  const page = listenForCaptureWait(cdp, 'idle')
  page.arm()
  await assert.rejects(
    page.ready({ loaderId: 'nav' }, 20),
    /c\.capture\(\) timed out waiting for networkAlmostIdle/,
  )
})

test('listenForCaptureWait load timeout names load', async () => {
  const cdp = fakeCdp()
  const page = listenForCaptureWait(cdp, 'load')
  page.arm()
  await assert.rejects(page.ready(undefined, 20), /c\.capture\(\) timed out waiting for load/)
})
