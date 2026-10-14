import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import {
  cacheLabel,
  checkCaptureName,
  chromeBinaryPath,
  ensureChrome,
  nameFromPath,
  pageUrl,
  pickPageDebuggerUrl,
  refusedBrowser,
  removeChromeProfile,
  resolveCaptureCall,
  resolveCaptureTarget,
  stubPng,
} from '../src/capture/index.ts'
import { unzip } from '../src/capture/zip.ts'

const viewport = { width: 1280, height: 720 }

test('stub PNG bytes are unique for the capture key', () => {
  const a = stubPng('home', 5173, '/', viewport)
  const b = stubPng('home', 5173, '/', viewport)
  const other = stubPng('login', 5173, '/', viewport)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, other)
  assert.notDeepEqual(a, stubPng('home', 4173, '/', viewport))
  assert.notDeepEqual(a, stubPng('home', 5173, '/login', viewport))
  assert.notDeepEqual(a, stubPng('home', 5173, '/', { width: 390, height: 844 }))
  assert.equal(a.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
})

test('refusedBrowser names the env first when both refuse', () => {
  const prev = process.env.REEVAL_CAPTURE_BROWSER
  process.env.REEVAL_CAPTURE_BROWSER = '0'
  try {
    assert.equal(
      refusedBrowser({ browser: false }),
      'c.capture() is refused: REEVAL_CAPTURE_BROWSER=0',
    )
  } finally {
    if (prev === undefined) delete process.env.REEVAL_CAPTURE_BROWSER
    else process.env.REEVAL_CAPTURE_BROWSER = prev
  }
  assert.equal(
    refusedBrowser({ browser: false }),
    'c.capture() is refused: capture.browser is false',
  )
  assert.equal(refusedBrowser({}), undefined)
})

test('resolveCaptureCall takes a port or ServeHandle, not options.port', () => {
  assert.throws(
    () => resolveCaptureTarget({ port: 9 } as never),
    /needs a port or a ServeHandle as the first argument/,
  )
  assert.throws(
    () => resolveCaptureTarget(0),
    /c\.capture\(\) port is a container port from 1 to 65535 \(got 0\)/,
  )
  assert.throws(
    () => resolveCaptureCall(9, { port: 9 } as never, {}),
    /takes the port as the first argument, not in the options/,
  )
  const handle = { port: 4173, kill: async () => {} }
  assert.deepEqual(
    resolveCaptureCall(
      handle,
      { name: 'home', path: '/login', timeout: '30s' },
      {
        viewport: { width: 390, height: 844 },
      },
    ),
    {
      port: 4173,
      name: 'home',
      path: '/login',
      viewport: { width: 390, height: 844 },
      timeoutMs: 30_000,
      wait: 'load',
    },
  )
  assert.deepEqual(resolveCaptureCall(9, undefined, {}), {
    port: 9,
    name: 'root',
    path: '/',
    viewport,
    timeoutMs: 60_000,
    wait: 'load',
  })
})

test('nameFromPath slugs the path', () => {
  assert.equal(nameFromPath('/'), 'root')
  assert.equal(nameFromPath('/login'), 'login')
  assert.equal(nameFromPath('/foo/bar'), 'foo-bar')
  assert.equal(nameFromPath('/Login'), 'login')
})

test('checkCaptureName accepts [a-z0-9_-]+', () => {
  checkCaptureName('home')
  checkCaptureName('login_1')
  assert.throws(() => checkCaptureName('Home'), /name must match/)
  assert.throws(() => checkCaptureName('has space'), /name must match/)
})

test('pickPageDebuggerUrl skips the browser target', () => {
  assert.equal(
    pickPageDebuggerUrl([
      { type: 'browser', webSocketDebuggerUrl: 'ws://127.0.0.1:9/browser' },
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9/page' },
    ]),
    'ws://127.0.0.1:9/page',
  )
  assert.equal(
    pickPageDebuggerUrl([{ type: 'browser', webSocketDebuggerUrl: 'ws://x' }]),
    undefined,
  )
})

test('pageUrl joins origin and path without a doubled slash', () => {
  assert.equal(pageUrl('http://127.0.0.1:9', '/'), 'http://127.0.0.1:9/')
  assert.equal(pageUrl('http://127.0.0.1:9/', '/login'), 'http://127.0.0.1:9/login')
  assert.equal(pageUrl('http://127.0.0.1:9', 'login'), 'http://127.0.0.1:9/login')
})

test('cacheLabel uses ~/.cache/reeval for the default dir', () => {
  assert.match(cacheLabel(), /reeval/)
})

test('removeChromeProfile deletes a profile and ignores a busy one', () => {
  const dir = join(tmpdir(), `reeval-chrome-rm-${process.pid}`)
  mkdirSync(join(dir, 'Default'), { recursive: true })
  writeFileSync(join(dir, 'Default', 'Prefs'), 'x')
  removeChromeProfile(dir)
  assert.equal(existsSync(dir), false)

  const busy = Object.assign(new Error('ENOTEMPTY, Directory not empty'), { code: 'ENOTEMPTY' })
  assert.doesNotThrow(() =>
    removeChromeProfile('/nope', () => {
      throw busy
    }),
  )
  const locked = Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
  assert.doesNotThrow(() =>
    removeChromeProfile('/nope', () => {
      throw locked
    }),
  )
})

test('ensureChrome skips download when the binary is cached', async () => {
  const cache = join(tmpdir(), `reeval-chrome-test-${process.pid}`)
  const bin = chromeBinaryPath(cache)
  mkdirSync(join(bin, '..'), { recursive: true })
  writeFileSync(bin, 'ok')
  let progress = 0
  const found = await ensureChrome(cache, {
    cacheLabel: cache,
    onProgress: () => {
      progress++
    },
  })
  assert.equal(found, bin)
  assert.equal(progress, 0)
})

test('unzip reads store and deflate entries', () => {
  const name = Buffer.from('a.txt')
  const raw = Buffer.from('hi')
  const deflated = deflateRawSync(raw)
  const store = Buffer.alloc(30 + name.length + raw.length)
  store.writeUInt32LE(0x04034b50, 0)
  store.writeUInt16LE(0, 8)
  store.writeUInt32LE(raw.length, 18)
  store.writeUInt16LE(name.length, 26)
  name.copy(store, 30)
  raw.copy(store, 30 + name.length)
  const def = Buffer.alloc(30 + name.length + deflated.length)
  def.writeUInt32LE(0x04034b50, 0)
  def.writeUInt16LE(8, 8)
  def.writeUInt32LE(deflated.length, 18)
  def.writeUInt16LE(name.length, 26)
  name.copy(def, 30)
  deflated.copy(def, 30 + name.length)
  assert.equal(unzip(store).get('a.txt')?.toString(), 'hi')
  assert.equal(unzip(def).get('a.txt')?.toString(), 'hi')
})
