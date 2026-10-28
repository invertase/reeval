import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import {
  listenForCaptureWait,
  pollHttp,
  resolveCaptureCall,
  resolveCaptureWait,
  trackNetwork,
} from '../src/capture/index.ts'

const viewport = { width: 1280, height: 720 }

test('resolveCaptureCall passes wait idle and defaults to load', () => {
  const call = { wait: 'idle' as const }
  assert.deepEqual(resolveCaptureCall(9, call, {}), {
    port: 9,
    name: 'root',
    path: '/',
    viewport,
    window: viewport,
    fullPage: false,
    timeoutMs: 60_000,
    wait: 'idle',
    instructions: [],
    model: undefined,
    fake: undefined,
  })
})

test('resolveCaptureWait defaults to load and rejects anything else', () => {
  assert.equal(resolveCaptureWait(undefined), 'load')
  assert.equal(resolveCaptureWait('load'), 'load')
  assert.equal(resolveCaptureWait('idle'), 'idle')
  assert.throws(
    () => resolveCaptureWait('networkIdle' as never),
    (error: Error) => {
      assert.equal(
        error.message,
        `c.capture() wait is 'load', 'idle' or { ms } (got "networkIdle")`,
      )
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('trackNetwork quiet waits out a request that starts inside the quiet window', async () => {
  const cdp = fakeCdp()
  const network = trackNetwork(cdp, 100)
  const started = Date.now()
  const quiet = network.quiet(2_000)
  await sleep(60)
  cdp.emit('Network.requestWillBeSent', { requestId: 'late' })
  await sleep(30)
  cdp.emit('Network.loadingFinished', { requestId: 'late' })
  await quiet
  // Restarted at the request's end it settles at 190ms, and at 160ms if only its start restarts
  // the window; timers can fire a millisecond early by Date.now.
  assert.ok(Date.now() - started >= 180, 'the quiet window restarts when the request ends')
})

test('trackNetwork quiet holds while more than two requests are in flight', async () => {
  const cdp = fakeCdp()
  const network = trackNetwork(cdp, 50)
  for (const requestId of ['a', 'b', 'c']) cdp.emit('Network.requestWillBeSent', { requestId })
  let settled = false
  const quiet = network.quiet(2_000).then(() => {
    settled = true
  })
  await sleep(120)
  assert.equal(settled, false)
  cdp.emit('Network.loadingFailed', { params: { requestId: 'c' } })
  await quiet
})

test('trackNetwork quiet times out naming networkAlmostIdle', async () => {
  const cdp = fakeCdp()
  const network = trackNetwork(cdp, 50)
  for (const requestId of ['a', 'b', 'c']) cdp.emit('Network.requestWillBeSent', { requestId })
  await assert.rejects(network.quiet(30), /c\.capture\(\) timed out waiting for networkAlmostIdle/)
})

test('pollHttp polls past a 503 while the server starts, and takes one at the deadline', async () => {
  let hits = 0
  const server = createServer((_, res) => {
    hits++
    res.writeHead(hits < 3 ? 503 : 200).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  try {
    await pollHttp(`http://127.0.0.1:${port}/`, 10_000)
    assert.equal(hits, 3)
    hits = -1_000
    const started = Date.now()
    await pollHttp(`http://127.0.0.1:${port}/`, 400)
    assert.ok(Date.now() - started >= 400)
  } finally {
    server.close()
  }
})
