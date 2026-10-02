import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Viewport } from '../types.ts'
import { unzip } from './zip.ts'

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

class Cdp {
  #ws: WebSocket
  #next = 0
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  #events = new Map<string, Array<(p: unknown) => void>>()

  constructor(ws: WebSocket) {
    this.#ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as CdpReply
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id)
        if (!p) return
        this.#pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
        return
      }
      if (msg.method) for (const fn of this.#events.get(msg.method) ?? []) fn(msg)
    })
  }

  on(method: string, fn: (p: unknown) => void) {
    const list = this.#events.get(method) ?? []
    list.push(fn)
    this.#events.set(method, list)
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.#next
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }))
  }

  close() {
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

/** Navigate `url` and return a PNG from `Page.captureScreenshot`. */
export async function screenshotWithChrome(
  bin: string,
  url: string,
  viewport: Viewport,
  timeoutMs: number,
): Promise<Buffer> {
  const userData = join(tmpdir(), `reeval-chrome-${process.pid}-${Date.now()}`)
  mkdirSync(userData, { recursive: true })
  const child = spawn(
    bin,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--remote-allow-origins=*',
      `--window-size=${viewport.width},${viewport.height}`,
      `--user-data-dir=${userData}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  try {
    const port = await waitForPortFile(join(userData, 'DevToolsActivePort'), timeoutMs)
    const cdp = await cdpConnect(await pageDebuggerUrl(port, timeoutMs), timeoutMs)
    try {
      await cdp.send('Page.enable')
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      const loaded = new Promise<void>((resolve) => {
        cdp.on('Page.loadEventFired', () => resolve())
      })
      await cdp.send('Page.navigate', { url })
      await Promise.race([
        loaded,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('page load timed out')), timeoutMs),
        ),
      ])
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
        data?: string
      }
      if (!shot.data) throw new Error('Page.captureScreenshot returned no data')
      return Buffer.from(shot.data, 'base64')
    } finally {
      cdp.close()
    }
  } finally {
    child.kill('SIGKILL')
    rmSync(userData, { recursive: true, force: true })
  }
}
