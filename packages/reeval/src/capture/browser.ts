import { type ChildProcess, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CaptureKey,
  CapturePage,
  CaptureUseAction,
  CaptureWait,
  CaptureWindow,
  Wait,
} from '../types.ts'
import { watchPage } from './page.ts'
import { unzip } from './zip.ts'

const isMs = (wait: Wait): wait is { ms: number } => typeof wait === 'object' && wait !== null

export type CdpClient = {
  on(method: string, fn: (p: unknown) => void): void
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
}

/** The CDP event `'idle'` waits for; `'load'` is `Page.loadEventFired`. */
export function captureWaitLabel(wait: CaptureWait): 'load' | 'networkAlmostIdle' {
  return wait === 'idle' ? 'networkAlmostIdle' : 'load'
}

export function captureWaitTimeout(wait: CaptureWait): Error {
  return new Error(`c.capture() timed out waiting for ${captureWaitLabel(wait)}`)
}

export function waitTimeout(wait: Wait, detail?: string): Error {
  if (isMs(wait)) {
    return new Error(`c.capture() timed out${detail ? ` on ${detail}` : ''} waiting ${wait.ms}ms`)
  }
  return captureWaitTimeout(wait)
}

export async function waitForPage(
  cdp: CdpClient,
  wait: Wait,
  timeoutMs: number,
  nav?: { loaderId?: string },
): Promise<void> {
  if (isMs(wait)) {
    if (timeoutMs <= 0) throw waitTimeout(wait)
    const ms = Math.min(wait.ms, timeoutMs)
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
    return
  }
  const page = listenForCaptureWait(cdp, wait)
  page.arm()
  await page.ready(nav, timeoutMs)
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Map a full-page click onto the live window, scrolling with the wheel if needed. */
export function mapPagePoint(
  x: number,
  y: number,
  window: CaptureWindow,
  page: { width: number; height: number } | undefined,
  scrollY: number,
): { x: number; y: number; scrollY: number; dy: number } {
  const maxY = Math.max(0, (page?.height ?? window.height) - window.height)
  const target = y >= window.height || y < 0 ? clamp(y - window.height / 2, 0, maxY) : scrollY
  const nextY = clamp(target, 0, maxY)
  return {
    x: clamp(x, 0, window.width - 1),
    y: clamp(y - nextY, 0, window.height - 1),
    scrollY: nextY,
    dy: nextY - scrollY,
  }
}

type KeyEvent = {
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
  modifiers?: number
  commands?: string[]
}

const KEYS: Record<CaptureKey, KeyEvent> = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
}

/** `CaptureKey` names, for the driver's tool schema. */
export const CAPTURE_KEYS = Object.keys(KEYS) as [CaptureKey, ...CaptureKey[]]

async function pressKey(cdp: CdpClient, event: KeyEvent): Promise<void> {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event })
  const { text: _text, commands: _commands, ...up } = event
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...up })
}

export async function dispatchInput(
  cdp: CdpClient,
  action: CaptureUseAction,
  window: CaptureWindow,
  page?: { width: number; height: number },
  scrollY = 0,
): Promise<number> {
  if (action.type === 'done') return scrollY
  if (action.type === 'type') {
    if (action.replace) {
      await pressKey(cdp, {
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2,
        commands: ['selectAll'],
      })
      if (!action.text) await pressKey(cdp, KEYS.Backspace)
    }
    if (action.text) await cdp.send('Input.insertText', { text: action.text })
    return scrollY
  }
  if (action.type === 'key') {
    const event = KEYS[action.key]
    if (!event) {
      throw new Error(
        `c.capture() can't press ${JSON.stringify(action.key)}: use one of ${CAPTURE_KEYS.join(', ')}`,
      )
    }
    await pressKey(cdp, event)
    return scrollY
  }
  if (action.type === 'scroll') {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: action.x,
      y: action.y,
      deltaX: 0,
      deltaY: action.dy,
    })
    return scrollY + action.dy
  }
  const mapped = mapPagePoint(
    action.type === 'drag' ? action.x : action.x,
    action.type === 'drag' ? action.y : action.y,
    window,
    page,
    scrollY,
  )
  if (mapped.dy !== 0) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: window.width / 2,
      y: window.height / 2,
      deltaX: 0,
      deltaY: mapped.dy,
    })
  }
  const at = { x: mapped.x, y: mapped.y }
  if (action.type === 'hover') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
    return mapped.scrollY
  }
  if (action.type === 'click') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'left' })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...at,
      button: 'left',
      clickCount: 1,
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...at,
      button: 'left',
      clickCount: 1,
    })
    return mapped.scrollY
  }
  const end = mapPagePoint(action.toX, action.toY, window, page, mapped.scrollY)
  if (end.dy !== 0) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: window.width / 2,
      y: window.height / 2,
      deltaX: 0,
      deltaY: end.dy,
    })
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: at.x,
    y: at.y,
    button: 'left',
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: at.x,
    y: at.y,
    button: 'left',
    clickCount: 1,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: end.x,
    y: end.y,
    button: 'left',
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: end.x,
    y: end.y,
    button: 'left',
    clickCount: 1,
  })
  return end.scrollY
}

function lifecycleParams(msg: unknown): { name?: string; loaderId?: string } {
  const body = msg as {
    params?: { name?: string; loaderId?: string }
    name?: string
    loaderId?: string
  }
  return body.params ?? body
}

/**
 * Arms after `Page.enable` so about:blank's events cannot resolve the wait.
 * Call `arm` immediately before `Page.navigate`.
 */
export function listenForCaptureWait(
  cdp: Pick<CdpClient, 'on'>,
  wait: CaptureWait,
): {
  arm(): void
  ready(nav: { loaderId?: string } | undefined, timeoutMs: number): Promise<void>
} {
  const method = wait === 'idle' ? 'Page.lifecycleEvent' : 'Page.loadEventFired'
  const pending: unknown[] = []
  let deliver: ((msg: unknown) => void) | undefined
  let started = false
  cdp.on(method, (msg) => {
    if (!started) return
    if (deliver) deliver(msg)
    else pending.push(msg)
  })
  const matches = (msg: unknown, loaderId?: string) => {
    if (wait === 'load') return true
    const params = lifecycleParams(msg)
    if (params.name !== 'networkAlmostIdle') return false
    return !loaderId || params.loaderId === loaderId
  }
  return {
    arm() {
      started = true
    },
    ready(nav, timeoutMs) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(captureWaitTimeout(wait)), timeoutMs)
        const finish = () => {
          clearTimeout(timer)
          resolve()
        }
        deliver = (msg) => {
          if (matches(msg, nav?.loaderId)) finish()
        }
        if (pending.some((msg) => matches(msg, nav?.loaderId))) finish()
      })
    },
  }
}

/** Chromium's `networkAlmostIdle` rule: at most two requests in flight for 500ms. */
export const NETWORK_QUIET_MS = 500
const QUIET_IN_FLIGHT = 2
const FRESH_REQUEST_MS = 2000

/** How long a screenshot waits, in tries, for a page that has no layout yet. */
const SCREENSHOT_TRIES = 20
const SCREENSHOT_RETRY_MS = 100

function requestId(msg: unknown): string | undefined {
  const body = msg as { params?: { requestId?: string }; requestId?: string }
  return (body.params ?? body).requestId
}

/**
 * Counts the tab's requests from `Network.enable` on, for a journey's `{ wait: 'idle' }` beat.
 * Chromium emits `networkAlmostIdle` once per document, so after a click that only fetches it
 * never comes again. As in Chromium, every request that starts or ends restarts the quiet window.
 */
export function trackNetwork(
  cdp: Pick<CdpClient, 'on'>,
  quietMs = NETWORK_QUIET_MS,
): { quiet(timeoutMs: number): Promise<void>; fresh(): boolean } {
  const inFlight = new Map<string, number>()
  let changed: (() => void) | undefined
  cdp.on('Network.requestWillBeSent', (msg) => {
    const id = requestId(msg)
    if (id === undefined) return
    inFlight.set(id, Date.now())
    changed?.()
  })
  const end = (msg: unknown) => {
    const id = requestId(msg)
    if (id === undefined || !inFlight.delete(id)) return
    changed?.()
  }
  cdp.on('Network.loadingFinished', end)
  cdp.on('Network.loadingFailed', end)
  return {
    /** A request started in the last `FRESH_REQUEST_MS` is still in flight; a long poll is not fresh. */
    fresh() {
      const since = Date.now() - FRESH_REQUEST_MS
      for (const started of inFlight.values()) if (started >= since) return true
      return false
    },
    quiet(timeoutMs) {
      return new Promise<void>((resolve, reject) => {
        let settle: ReturnType<typeof setTimeout> | undefined
        const stop = () => {
          clearTimeout(timer)
          clearTimeout(settle)
          changed = undefined
        }
        const timer = setTimeout(() => {
          stop()
          reject(captureWaitTimeout('idle'))
        }, timeoutMs)
        changed = () => {
          clearTimeout(settle)
          if (inFlight.size > QUIET_IN_FLIGHT) return
          settle = setTimeout(() => {
            stop()
            resolve()
          }, quietMs)
        }
        changed()
      })
    },
  }
}

/** Pinned Chrome for Testing `chrome-headless-shell` build. */
export const CHROME_VERSION = '140.0.7339.185'
export const CHROME_NAME = 'chrome-headless-shell'

export type DownloadProgress = {
  name: string
  version: string
  bytes: number | null
  received: number
  cache: string
}

export type DownloadReporter = (p: DownloadProgress) => void

function chromePlatform(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (process.platform === 'win32') return 'win64'
  return 'linux64'
}

function chromeUrl(platform: string): string {
  return `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${platform}/${CHROME_NAME}-${platform}.zip`
}

function binaryName(): string {
  return process.platform === 'win32' ? `${CHROME_NAME}.exe` : CHROME_NAME
}

export function chromeBinaryPath(cacheRoot: string, platform = chromePlatform()): string {
  return join(cacheRoot, CHROME_NAME, CHROME_VERSION, platform, binaryName())
}

async function downloadZip(
  url: string,
  onProgress: DownloadReporter | undefined,
  cacheLabel: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || null
  const report = (received: number) =>
    onProgress?.({
      name: CHROME_NAME,
      version: CHROME_VERSION,
      bytes: total,
      received,
      cache: cacheLabel,
    })
  report(0)
  if (!res.body) return Buffer.from(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let last = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (received - last >= 256 * 1024 || (total && received === total)) {
      report(received)
      last = received
    }
  }
  if (received !== last) report(received)
  return Buffer.concat(chunks)
}

function extractBinary(zip: Buffer, dest: string, platform: string): void {
  const files = unzip(zip)
  const needle = `/${binaryName()}`
  const entry = [...files.entries()].find(
    ([name]) =>
      name.endsWith(needle) || name === binaryName() || name.endsWith(`\\${binaryName()}`),
  )
  if (!entry) {
    const names = [...files.keys()].slice(0, 8).join(', ')
    throw new Error(`zip has no ${binaryName()} (saw ${names || 'nothing'})`)
  }
  const prefix = entry[0].slice(0, -binaryName().length)
  mkdirSync(dest, { recursive: true })
  for (const [name, data] of files) {
    const rel = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name
    if (!rel || rel.endsWith('/')) continue
    const target = join(dest, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, data)
  }
  const bin = join(dest, binaryName())
  if (!existsSync(bin)) writeFileSync(bin, entry[1])
  if (process.platform !== 'win32') chmodSync(bin, 0o755)
  void platform
}

/**
 * Returns the cached binary, downloading on a miss. `onProgress` runs only for a download.
 */
export async function ensureChrome(
  cacheRoot: string,
  options: { onProgress?: DownloadReporter; cacheLabel: string; signal?: AbortSignal } = {
    cacheLabel: cacheRoot,
  },
): Promise<string> {
  const platform = chromePlatform()
  const dest = join(cacheRoot, CHROME_NAME, CHROME_VERSION, platform)
  const bin = join(dest, binaryName())
  if (existsSync(bin)) return bin
  mkdirSync(join(cacheRoot, CHROME_NAME, CHROME_VERSION), { recursive: true })
  const partial = `${dest}.${process.pid}.partial`
  rmSync(partial, { recursive: true, force: true })
  try {
    const zip = await downloadZip(
      chromeUrl(platform),
      options.onProgress,
      options.cacheLabel,
      options.signal,
    )
    extractBinary(zip, partial, platform)
    try {
      renameSync(partial, dest)
    } catch (error) {
      rmSync(partial, { recursive: true, force: true })
      if (!existsSync(bin)) throw error
    }
  } catch (error) {
    rmSync(partial, { recursive: true, force: true })
    if (existsSync(bin)) return bin
    throw error
  }
  return bin
}

type CdpReply = { id?: number; method?: string; result?: unknown; error?: { message: string } }

/** The least time a CDP call gets, so the page facts still come after a screenshot near the deadline. */
const CDP_CALL_MIN_MS = 1_000

/**
 * A CDP connection whose every call settles: with the reply, at `callMs()` (at least
 * `CDP_CALL_MIN_MS`), or when the socket closes. A blocked browser can't hold a capture past its
 * budget.
 */
export class Cdp {
  #ws: Pick<WebSocket, 'send' | 'close' | 'addEventListener'>
  #next = 0
  #pending = new Map<number, { reject: (e: Error) => void; settle: (msg: CdpReply) => void }>()
  #events = new Map<string, Array<(p: unknown) => void>>()
  #closed: Error | undefined
  callMs: () => number = () => 30_000

  constructor(ws: Pick<WebSocket, 'send' | 'close' | 'addEventListener'>) {
    this.#ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as CdpReply
      if (msg.id !== undefined) {
        this.#pending.get(msg.id)?.settle(msg)
        return
      }
      if (msg.method) for (const fn of this.#events.get(msg.method) ?? []) fn(msg)
    })
    ws.addEventListener('close', () =>
      this.#fail(new Error('the browser closed its DevTools connection')),
    )
    ws.addEventListener('error', () =>
      this.#fail(new Error('the browser closed its DevTools connection')),
    )
  }

  #fail(error: Error) {
    this.#closed ??= error
    for (const p of [...this.#pending.values()]) p.reject(this.#closed)
  }

  on(method: string, fn: (p: unknown) => void) {
    const list = this.#events.get(method) ?? []
    list.push(fn)
    this.#events.set(method, list)
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed)
    const id = ++this.#next
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        this.#pending.delete(id)
      }
      const ms = Math.max(CDP_CALL_MIN_MS, this.callMs())
      const timer = setTimeout(() => {
        done()
        reject(new Error(`c.capture() timed out after ${ms}ms waiting for the browser (${method})`))
      }, ms)
      this.#pending.set(id, {
        reject: (e) => {
          done()
          reject(e)
        },
        settle: (msg) => {
          done()
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        },
      })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.#fail(new Error('the capture closed its DevTools connection'))
    this.#ws.close()
  }
}

function waitForPortFile(file: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(file)) {
        const line = readFileSync(file, 'utf8').split(/\r?\n/)[0]
        const port = Number(line)
        if (port > 0) {
          resolve(port)
          return
        }
      }
      if (Date.now() > deadline) {
        reject(new Error('chrome-headless-shell did not open a DevTools port'))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

export function pickPageDebuggerUrl(
  targets: Array<{ type?: string; webSocketDebuggerUrl?: string }>,
): string | undefined {
  return targets.find((t) => t.webSocketDebuggerUrl && t.type !== 'browser')?.webSocketDebuggerUrl
}

async function pageDebuggerUrl(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const listPages = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!res.ok) return undefined
    const list = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>
    return pickPageDebuggerUrl(list)
  }
  for (;;) {
    const url = await listPages()
    if (url) return url
    if (Date.now() > deadline) break
    await new Promise((r) => setTimeout(r, 50))
  }
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
    webSocketDebuggerUrl?: string
  }
  if (!version.webSocketDebuggerUrl) {
    throw new Error('chrome-headless-shell reported no DevTools URL')
  }
  const browser = await cdpConnect(version.webSocketDebuggerUrl, timeoutMs)
  try {
    await browser.send('Target.createTarget', { url: 'about:blank' })
  } finally {
    browser.close()
  }
  const created = await listPages()
  if (!created) throw new Error('chrome-headless-shell reported no page target')
  return created
}

async function cdpConnect(url: string, timeoutMs: number): Promise<Cdp> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP websocket timed out')), timeoutMs)
    ws.addEventListener('open', () => {
      clearTimeout(t)
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(t)
      reject(new Error('CDP websocket failed'))
    })
  })
  return new Cdp(ws)
}

/**
 * Drops a chrome-headless-shell profile. Chrome can still write after SIGKILL,
 * so `ENOTEMPTY` / `EBUSY` must not replace a PNG already in hand.
 */
export function removeChromeProfile(dir: string, rm: typeof rmSync = rmSync): void {
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } catch {
    scheduleChromeProfileSweep(dir, rm)
  }
}

function scheduleChromeProfileSweep(dir: string, rm: typeof rmSync): void {
  const later = setTimeout(() => {
    try {
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // leftover in os.tmpdir(); the OS sweep takes it
    }
  }, 250)
  later.unref()
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      child.off('exit', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    child.once('exit', finish)
  })
}

/** Kills the shell and drops its profile. Never throws: the PNG is already in hand. */
async function disposeChrome(child: ChildProcess, userData: string): Promise<void> {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await waitForExit(child, 1_000)
  } catch {}
  removeChromeProfile(userData)
}

type DialogOpening = { type?: string; message?: string; defaultPrompt?: string }

export type ChromeSession = {
  cdp: CdpClient
  window: CaptureWindow
  navigate(url: string): Promise<{ loaderId?: string } | undefined>
  /** Without `nav` (a journey's beat), `'idle'` is the tab's network going quiet from now. */
  wait(wait: Wait, timeoutMs: number, nav?: { loaderId?: string }): Promise<void>
  screenshot(fullPage: boolean): Promise<Buffer>
  dispatch(action: CaptureUseAction, page?: { width: number; height: number }): Promise<void>
  /** A frame is loading, or a request started in the last two seconds is in flight. */
  busy(): boolean
  /** The dialogs (`alert "hi"`) the page opened since the last call, each accepted. */
  dialogs(): string[]
  /** What the tab saw so far, with URLs on `origin` as paths. */
  page(origin: string): Promise<CapturePage>
}

/**
 * Chrome's flags for `proxy`: every request goes to it, loopback ones included, which Chrome
 * otherwise never proxies.
 */
export function proxyArgs(proxy: string | undefined): string[] {
  return proxy ? [`--proxy-server=http://${proxy}`, '--proxy-bypass-list=<-loopback>'] : []
}

/** One Chrome process, one tab. `fn` must not keep the session after it returns. */
export async function withChrome<T>(
  bin: string,
  window: CaptureWindow,
  timeoutMs: number,
  options: { proxy?: string },
  fn: (session: ChromeSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  const deadline = Date.now() + timeoutMs
  const userData = mkdtempSync(join(tmpdir(), `reeval-chrome-${process.pid}-`))
  const child = spawn(
    bin,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--remote-allow-origins=*',
      `--window-size=${window.width},${window.height}`,
      `--user-data-dir=${userData}`,
      '--remote-debugging-port=0',
      ...proxyArgs(options.proxy),
      'about:blank',
    ],
    // Chrome writes the page's console to stderr; an unread pipe fills and blocks the browser.
    { stdio: 'ignore' },
  )
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  signal?.addEventListener('abort', kill, { once: true })
  try {
    const port = await waitForPortFile(join(userData, 'DevToolsActivePort'), timeoutMs)
    const cdp = await cdpConnect(await pageDebuggerUrl(port, timeoutMs), timeoutMs)
    cdp.callMs = () => deadline - Date.now()
    const abort = () => cdp.close()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await cdp.send('Page.enable')
      await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true })
      const watched = watchPage(cdp)
      const tree = (await cdp.send('Page.getFrameTree')) as
        | { frameTree?: { frame?: { id?: string } } }
        | undefined
      const mainFrame = tree?.frameTree?.frame?.id
      if (mainFrame) watched.mainFrame(mainFrame)
      await cdp.send('Runtime.enable')
      await cdp.send('Log.enable')
      const network = trackNetwork(cdp)
      const loading = new Set<string>()
      const frame = (msg: unknown) => {
        const body = msg as { params?: { frameId?: string }; frameId?: string }
        return (body.params ?? body).frameId ?? ''
      }
      cdp.on('Page.frameStartedLoading', (msg) => loading.add(frame(msg)))
      cdp.on('Page.frameStoppedLoading', (msg) => loading.delete(frame(msg)))
      cdp.on('Page.frameDetached', (msg) => loading.delete(frame(msg)))
      // An open dialog blocks every Input and Page call, so each one is accepted as it opens.
      const opened: string[] = []
      cdp.on('Page.javascriptDialogOpening', (msg) => {
        const body = msg as { params?: DialogOpening } & DialogOpening
        const { type = 'dialog', message = '', defaultPrompt = '' } = body.params ?? body
        opened.push(`${type} ${JSON.stringify(message.slice(0, 60))}`)
        cdp
          .send('Page.handleJavaScriptDialog', { accept: true, promptText: defaultPrompt })
          .catch(() => {})
      })
      await cdp.send('Network.enable')
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: window.width,
        height: window.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      let scrollY = 0
      const session: ChromeSession = {
        cdp,
        window,
        async navigate(url) {
          scrollY = 0
          const nav = (await cdp.send('Page.navigate', { url })) as
            | { loaderId?: string; errorText?: string }
            | undefined
          if (nav?.errorText) {
            throw new Error(`c.capture() navigation failed: ${nav.errorText}`)
          }
          return nav
        },
        wait(wait, waitMs, nav) {
          if (wait === 'idle' && !nav) return network.quiet(waitMs)
          return waitForPage(cdp, wait, waitMs, nav)
        },
        async screenshot(fullPage) {
          for (let tries = 1; ; tries++) {
            try {
              const shot = (await cdp.send('Page.captureScreenshot', {
                format: 'png',
                captureBeyondViewport: fullPage,
              })) as { data?: string }
              if (!shot.data) throw new Error('Page.captureScreenshot returned no data')
              return Buffer.from(shot.data, 'base64')
            } catch (error) {
              // A page mid-navigation has no layout yet, and Chrome refuses to shoot it.
              const unlaid = /Cannot take screenshot with 0 (width|height)/.test(String(error))
              if (!unlaid || tries >= SCREENSHOT_TRIES) throw error
              await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_RETRY_MS))
            }
          }
        },
        async dispatch(action, page) {
          scrollY = await dispatchInput(cdp, action, window, page, scrollY)
        },
        busy() {
          return loading.size > 0 || network.fresh()
        },
        dialogs() {
          return opened.splice(0)
        },
        async page(origin) {
          const history = (await cdp.send('Page.getNavigationHistory').catch(() => undefined)) as
            | { currentIndex?: number; entries?: Array<{ url?: string }> }
            | undefined
          const url = history?.entries?.[history.currentIndex ?? -1]?.url ?? ''
          return watched.facts(url, origin)
        },
      }
      const run = fn(session)
      if (!signal) return await run
      run.catch(() => {})
      // A journey's waits are timers; canceling must not sit them out.
      let stop = () => {}
      const canceled = new Promise<never>((_, reject) => {
        stop = () => reject(signal.reason)
        if (signal.aborted) stop()
        else signal.addEventListener('abort', stop, { once: true })
      })
      try {
        return await Promise.race([run, canceled])
      } finally {
        signal.removeEventListener('abort', stop)
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      cdp.close()
    }
  } finally {
    signal?.removeEventListener('abort', kill)
    await disposeChrome(child, userData)
  }
}

/** Arm the wait, then navigate, then wait. `arm` is before `Page.navigate`. */
export async function navigateAndWait(
  session: ChromeSession,
  url: string,
  wait: Wait,
  timeoutMs: number,
): Promise<void> {
  if (isMs(wait)) {
    const nav = await session.navigate(url)
    await session.wait(wait, timeoutMs, nav)
    return
  }
  const page = listenForCaptureWait(session.cdp, wait)
  page.arm()
  const nav = await session.navigate(url)
  await page.ready(nav, timeoutMs)
}
