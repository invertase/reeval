import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Cdp, withChrome } from '../src/capture/browser.ts'
import { PAGE_ENTRIES, watchPage } from '../src/capture/page.ts'
import { pageLines } from '../src/view/capture.ts'

function fakeCdp() {
  const handlers = new Map<string, Array<(p: unknown) => void>>()
  return {
    on(method: string, fn: (p: unknown) => void) {
      handlers.set(method, [...(handlers.get(method) ?? []), fn])
    },
    emit(method: string, params: unknown) {
      for (const fn of handlers.get(method) ?? []) fn({ method, params })
    },
  }
}

const ORIGIN = 'http://127.0.0.1:41234'

test("watchPage keeps the console, page errors, failed requests and the main frame's status", () => {
  const cdp = fakeCdp()
  const watched = watchPage(cdp)
  watched.mainFrame('main')
  cdp.emit('Network.requestWillBeSent', { requestId: 'd', request: { url: `${ORIGIN}/old` } })
  cdp.emit('Network.responseReceived', {
    requestId: 'd',
    type: 'Document',
    frameId: 'main',
    response: { url: `${ORIGIN}/login`, status: 404 },
  })
  cdp.emit('Network.responseReceived', {
    requestId: 'f',
    type: 'Document',
    frameId: 'iframe',
    response: { url: `${ORIGIN}/frame`, status: 200 },
  })
  cdp.emit('Runtime.consoleAPICalled', {
    type: 'log',
    args: [
      { type: 'string', value: 'hello' },
      { type: 'number', value: 3 },
    ],
    stackTrace: { callFrames: [{ url: `${ORIGIN}/assets/a.js` }] },
  })
  cdp.emit('Runtime.consoleAPICalled', { type: 'clear', args: [] })
  cdp.emit('Runtime.consoleAPICalled', {
    type: 'assert',
    args: [{ type: 'object', description: `Error: at ${ORIGIN}/assets/a.js:1` }],
  })
  cdp.emit('Runtime.exceptionThrown', {
    exceptionDetails: {
      text: 'Uncaught',
      exception: { type: 'object', description: `Error: boom\n    at ${ORIGIN}/assets/a.js:2:1` },
    },
  })
  cdp.emit('Runtime.exceptionThrown', {
    exceptionDetails: {
      text: 'Uncaught (in promise)',
      exception: { type: 'object', description: 'Error: no session' },
    },
  })
  cdp.emit('Log.entryAdded', {
    entry: {
      source: 'network',
      level: 'error',
      text: 'Failed to load resource: 404',
      url: `${ORIGIN}/missing.js`,
    },
  })
  cdp.emit('Log.entryAdded', { entry: { source: 'violation', level: 'verbose', text: 'slow' } })
  cdp.emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { url: `${ORIGIN}/missing.js`, method: 'GET' },
  })
  cdp.emit('Network.responseReceived', {
    requestId: '1',
    type: 'Script',
    response: { url: `${ORIGIN}/missing.js`, status: 404 },
  })
  cdp.emit('Network.requestWillBeSent', {
    requestId: '2',
    request: { url: 'https://example.com/api', method: 'POST' },
  })
  cdp.emit('Network.loadingFailed', {
    requestId: '2',
    errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED',
  })
  cdp.emit('Network.requestWillBeSent', { requestId: '3', request: { url: `${ORIGIN}/gone` } })
  cdp.emit('Network.loadingFailed', {
    requestId: '3',
    errorText: 'net::ERR_ABORTED',
    canceled: true,
  })

  const page = watched.facts(`${ORIGIN}/login`, `${ORIGIN}/`)
  assert.deepEqual(page, {
    status: 404,
    finalUrl: '/login',
    console: [
      { level: 'log', text: 'hello 3', source: 'console-api', url: '/assets/a.js' },
      { level: 'error', text: 'Error: at /assets/a.js:1', source: 'console-api' },
      {
        level: 'error',
        text: 'Failed to load resource: 404',
        source: 'network',
        url: '/missing.js',
      },
      { level: 'debug', text: 'slow', source: 'violation' },
    ],
    errors: [
      'Uncaught Error: boom\n    at /assets/a.js:2:1',
      'Uncaught (in promise) Error: no session',
    ],
    failedRequests: [
      { method: 'GET', url: '/login', status: 404 },
      { method: 'GET', url: '/missing.js', status: 404 },
      {
        method: 'POST',
        url: 'https://example.com/api',
        error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
      },
    ],
  })
  assert.deepEqual(pageLines(page).slice(0, 3), [
    'page error: Uncaught Error: boom\n    at /assets/a.js:2:1',
    'page error: Uncaught (in promise) Error: no session',
    'console log (console-api): hello 3',
  ])
  assert.equal(
    pageLines(page).at(-1),
    'failed request: POST https://example.com/api → net::ERR_TUNNEL_CONNECTION_FAILED',
  )
})

test('watchPage has no status without a main-frame document, and caps each console level apart', () => {
  const cdp = fakeCdp()
  const watched = watchPage(cdp)
  for (let i = 0; i < PAGE_ENTRIES + 5; i++) {
    cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'x' }] })
  }
  cdp.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'e' }] })
  const page = watched.facts('', ORIGIN)
  assert.equal(page.status, undefined)
  assert.equal(page.finalUrl, '/')
  assert.equal(page.console.filter((m) => m.level === 'log').length, PAGE_ENTRIES)
  assert.deepEqual(page.console.at(-1), { level: 'error', text: 'e', source: 'console-api' })
  assert.equal(page.dropped, 5)
})

test("watchPage turns only the served origin into paths, not a longer port's", () => {
  const cdp = fakeCdp()
  const watched = watchPage(cdp)
  cdp.emit('Runtime.exceptionThrown', {
    exceptionDetails: { text: `Uncaught at ${ORIGIN}/a.js and ${ORIGIN}9/b.js` },
  })
  const page = watched.facts(`${ORIGIN}?q=1`, ORIGIN)
  assert.deepEqual(page.errors, [`Uncaught at /a.js and ${ORIGIN}9/b.js`])
  assert.equal(page.finalUrl, '?q=1')
})

test('watchPage drops a rejection the page handles later, and takes the latest document', () => {
  const cdp = fakeCdp()
  const watched = watchPage(cdp)
  watched.mainFrame('main')
  const doc = (status: number) =>
    cdp.emit('Network.responseReceived', {
      type: 'Document',
      frameId: 'main',
      response: { status },
    })
  doc(200)
  cdp.emit('Page.frameNavigated', {
    frame: { id: 'main', url: `${ORIGIN}/nav`, urlFragment: '#top' },
  })
  cdp.emit('Page.frameNavigated', { frame: { id: 'child', url: `${ORIGIN}/frame` } })
  const reject = (exceptionId: number, text: string) =>
    cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { exceptionId, text } })
  reject(1, 'Uncaught (in promise) handled later')
  reject(2, 'Uncaught (in promise) never handled')
  cdp.emit('Runtime.exceptionRevoked', { exceptionId: 1 })
  cdp.emit('Runtime.exceptionRevoked', {})
  assert.equal(watched.facts('', ORIGIN).finalUrl, '/nav#top')
  doc(500)
  cdp.emit('Page.navigatedWithinDocument', { frameId: 'main', url: `${ORIGIN}/500b?x` })
  cdp.emit('Page.navigatedWithinDocument', { frameId: 'child', url: `${ORIGIN}/other` })
  const page = watched.facts('', ORIGIN)
  assert.equal(page.status, 500)
  assert.equal(page.finalUrl, '/500b?x')
  assert.deepEqual(page.errors, ['Uncaught (in promise) never handled'])
  assert.equal(watched.facts(`${ORIGIN}/history`, ORIGIN).finalUrl, '/history')
})

test('watchPage un-counts a revoked rejection past the cap, and names a CORS failure', () => {
  const cdp = fakeCdp()
  const watched = watchPage(cdp)
  for (let i = 0; i <= PAGE_ENTRIES; i++) {
    cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { exceptionId: i, text: `e${i}` } })
  }
  cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'no id' } })
  assert.equal(watched.facts('', ORIGIN).dropped, 2)
  cdp.emit('Runtime.exceptionRevoked', { exceptionId: PAGE_ENTRIES })
  cdp.emit('Network.requestWillBeSent', { requestId: 'c', request: { url: 'https://api.test/x' } })
  cdp.emit('Network.loadingFailed', {
    requestId: 'c',
    errorText: 'net::ERR_FAILED',
    corsErrorStatus: { corsError: 'MissingAllowOriginHeader' },
  })
  cdp.emit('Network.requestWillBeSent', { requestId: 'ok', request: { url: `${ORIGIN}/ok` } })
  cdp.emit('Network.loadingFinished', { requestId: 'ok' })
  cdp.emit('Network.loadingFailed', { requestId: 'ok', errorText: 'late' })
  const page = watched.facts('', ORIGIN)
  assert.equal(page.dropped, 1)
  assert.equal(page.errors.length, PAGE_ENTRIES)
  assert.deepEqual(page.failedRequests, [
    {
      method: 'GET',
      url: 'https://api.test/x',
      error: 'net::ERR_FAILED (CORS MissingAllowOriginHeader)',
    },
  ])
})

test('watchPage clips a huge console line as it keeps it', () => {
  const cdp = fakeCdp()
  const watched = watchPage(cdp)
  cdp.emit('Runtime.consoleAPICalled', {
    type: 'log',
    args: [{ type: 'string', value: 'x'.repeat(5 * 1024 * 1024) }],
  })
  assert.ok((watched.facts('', ORIGIN).console[0]?.text.length ?? 0) <= 2001)
})

function fakeSocket() {
  const listeners = new Map<string, Array<(ev: unknown) => void>>()
  const sent: Array<{ id: number; method: string }> = []
  return {
    sent,
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {},
    addEventListener: (type: string, fn: (ev: unknown) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    fire: (type: string, ev: unknown = {}) => {
      for (const fn of listeners.get(type) ?? []) fn(ev)
    },
  }
}

test('a CDP call settles on its reply, its error, its deadline or the socket closing', async () => {
  const ws = fakeSocket()
  const cdp = new Cdp(ws as never)
  cdp.callMs = () => 0
  const events: unknown[] = []
  cdp.on('Page.loadEventFired', (p) => events.push(p))
  const ok = cdp.send('Page.enable')
  const bad = cdp.send('Page.navigate')
  ws.fire('message', { data: JSON.stringify({ id: 1, result: { done: true } }) })
  ws.fire('message', { data: JSON.stringify({ id: 2, error: { message: 'nope' } }) })
  ws.fire('message', { data: JSON.stringify({ id: 99, result: {} }) })
  ws.fire('message', { data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }) })
  ws.fire('message', { data: JSON.stringify({ method: 'Page.other' }) })
  assert.deepEqual(await ok, { done: true })
  await assert.rejects(bad, /nope/)
  assert.equal(events.length, 1)
  await assert.rejects(
    cdp.send('Page.getNavigationHistory'),
    /timed out after 1000ms waiting for the browser \(Page\.getNavigationHistory\)/,
  )
  const hung = cdp.send('Page.captureScreenshot')
  ws.fire('close')
  await assert.rejects(hung, /closed its DevTools connection/)
  await assert.rejects(cdp.send('Page.enable'), /closed its DevTools connection/)
  const other = new Cdp(fakeSocket() as never)
  const pending = other.send('Page.enable')
  other.close()
  await assert.rejects(pending, /the capture closed its DevTools connection/)
})

test('canceling withChrome while the browser starts stops it at once, not at its budget', {
  skip: process.platform === 'win32' && 'the stand-in browser is a shell script',
}, async () => {
  // A browser that never opens its DevTools port, so startup waits on it.
  const dir = mkdtempSync(join(tmpdir(), 'reeval-stuck-chrome-'))
  const bin = join(dir, 'chrome')
  writeFileSync(bin, '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 })
  const canceled = new AbortController()
  setTimeout(() => canceled.abort(new Error('the run was canceled')), 200)
  const started = Date.now()
  await assert.rejects(
    withChrome(bin, { width: 800, height: 600 }, 60_000, {}, async () => 1, canceled.signal),
    /the run was canceled/,
  )
  assert.ok(Date.now() - started < 10_000, `stopped after ${Date.now() - started}ms`)
  rmSync(dir, { recursive: true, force: true })
})
