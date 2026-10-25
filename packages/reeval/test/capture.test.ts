import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { msysTreeKill } from '../src/attempt/capture.ts'
import { fakeInstructions } from '../src/capture/fake-instructions.ts'
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
import { posixShell } from '../src/sandbox/fake.ts'
import { artifactPath, parseDataPath } from '../src/view/paths.ts'

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
  assert.notDeepEqual(a, stubPng('home', 5173, '/', 'full-page'))
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
      window: { width: 390, height: 844 },
      fullPage: false,
      timeoutMs: 30_000,
      wait: 'load',
      instructions: [],
      model: undefined,
      fake: undefined,
    },
  )
  assert.deepEqual(resolveCaptureCall(9, undefined, {}), {
    port: 9,
    name: 'root',
    path: '/',
    viewport,
    window: viewport,
    fullPage: false,
    timeoutMs: 60_000,
    wait: 'load',
    instructions: [],
    model: undefined,
    fake: undefined,
  })
})

test('resolveCaptureCall accepts full-page and a wait beat', () => {
  const instructions = fakeInstructions([[{ type: 'done' }], { wait: 'idle' }, [{ type: 'done' }]])
  assert.deepEqual(
    resolveCaptureCall(
      9,
      {
        name: 'after-submit',
        viewport: 'full-page',
        wait: { ms: 3000 },
        instructions,
      },
      {},
    ),
    {
      port: 9,
      name: 'after-submit',
      path: '/',
      viewport: 'full-page',
      window: viewport,
      fullPage: true,
      timeoutMs: 60_000,
      wait: { ms: 3000 },
      instructions: ['fake[0]', { wait: 'idle' }, 'fake[1]'],
      model: undefined,
      fake: [[{ type: 'done' }], [{ type: 'done' }]],
    },
  )
})

test('resolveCaptureCall prefers call model over the cascade', () => {
  assert.equal(
    resolveCaptureCall(9, { model: 'google/gemini-3.8-flash' }, { model: 'openai/gpt-5.4' }).model,
    'google/gemini-3.8-flash',
  )
  assert.equal(
    resolveCaptureCall(9, undefined, { model: 'google/gemini-3.8-flash' }).model,
    'google/gemini-3.8-flash',
  )
  assert.throws(
    () => resolveCaptureCall(9, { use: { model: 'google/gemini-3.8-flash' } } as never, {}),
    /has no use/,
  )
  assert.throws(
    () => resolveCaptureCall(9, { fake: [[{ type: 'done' }]] } as never, {}),
    /has no fake/,
  )
})

test('nameFromPath slugs the path', () => {
  assert.equal(nameFromPath('/'), 'root')
  assert.equal(nameFromPath('/login'), 'login')
  assert.equal(nameFromPath('/foo/bar'), 'foo-bar')
  assert.equal(nameFromPath('/Login'), 'login')
  assert.equal(nameFromPath('/_next/data'), 'next-data')
  assert.equal(nameFromPath('/-/x'), 'x')
  assert.equal(nameFromPath(`/${'a'.repeat(99)}/b`), 'a'.repeat(99))
  assert.equal(nameFromPath(`/${'a'.repeat(150)}`), 'a'.repeat(100))
})

test('checkCaptureName accepts 1 to 100 of [a-z0-9_-], starting with a letter or digit', () => {
  checkCaptureName('home')
  checkCaptureName('login_1')
  checkCaptureName('0-home_')
  checkCaptureName('a'.repeat(100))
  for (const bad of ['Home', 'has space', '', '_home', '-home', 'a'.repeat(101)]) {
    assert.throws(
      () => checkCaptureName(bad),
      /name must be 1 to 100 of a-z, 0-9, _ and -, starting with a letter or digit/,
      bad,
    )
  }
})

test('every capture name reeval accepts or derives is one the studio serves', () => {
  const run = '20260101T000000Z_a1b2c3d_main_ab12'
  const served = (name: string) =>
    parseDataPath(artifactPath(run, `evals/a/e/0/artifacts/${name}.png`)) !== null
  const accepted = (name: string) => {
    try {
      checkCaptureName(name)
      return true
    } catch {
      return false
    }
  }
  for (const name of ['home', '0', '_home', '-home', 'a'.repeat(100), 'a'.repeat(124)]) {
    if (accepted(name)) assert.ok(served(name), name)
  }
  for (const path of ['/', '/_home', '/-home', `/${'a'.repeat(300)}`, '/A B/C']) {
    const name = nameFromPath(path)
    assert.ok(accepted(name) && served(name), path)
  }
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

test('msysTreeKill stops the pid and its descendants by ppid, each Win32 pid first', () => {
  const proc = mkdtempSync(join(tmpdir(), 'reeval-proc-'))
  const entry = (pid: number, ppid: number, winpid: number) => {
    mkdirSync(join(proc, String(pid)))
    writeFileSync(join(proc, String(pid), 'ppid'), `${ppid}\n`)
    writeFileSync(join(proc, String(pid), 'winpid'), `${winpid}\r\n`)
  }
  entry(100, 1, 5100)
  entry(101, 100, 5101)
  entry(102, 101, 5102)
  entry(200, 1, 5200)
  entry(201, 200, 5201)
  const script = msysTreeKill('100', '90', proc.replaceAll('\\', '/'))
  const r = spawnSync(
    posixShell(),
    [
      '-c',
      `exec 3>&1\ntaskkill() { echo "taskkill $3" >&3; }\nkill() { echo "kill $*" >&3; }\n${script}`,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'taskkill 5100',
    'kill -9 100',
    'taskkill 5101',
    'kill -9 101',
    'taskkill 5102',
    'kill -9 102',
    'kill -9 -90',
  ])
})
