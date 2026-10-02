import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseDuration } from '../duration.ts'
import { cacheDir } from '../root.ts'
import type { CaptureCall, CaptureOptions, Duration, Viewport } from '../types.ts'

export type { DownloadProgress, DownloadReporter } from './browser.ts'
export {
  CHROME_NAME,
  CHROME_VERSION,
  chromeBinaryPath,
  ensureChrome,
  screenshotWithChrome,
} from './browser.ts'
export { pollHttp } from './poll.ts'
export { pngSize, stubPng } from './stub.ts'

/** Default CSS pixels when the call and cascade omit `viewport`. */
export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 }

/** Default poll (and screenshot) budget when the call and cascade omit `timeout`. */
export const DEFAULT_TIMEOUT: Duration = '60s'

export const CAPTURE_NAME = /^[a-z0-9_-]+$/

/** `~/.cache/reeval` when that's the resolved dir; otherwise the absolute path. */
export function cacheLabel(dir = cacheDir()): string {
  const home = homedir()
  const posix = dir.replaceAll('\\', '/')
  const def = join(home, '.cache', 'reeval').replaceAll('\\', '/')
  if (posix === def) return '~/.cache/reeval'
  return dir
}

/**
 * Env is named first when both refuse. `undefined` means the host binary is allowed
 * (the fake tier still never downloads).
 */
export function refusedBrowser(capture: CaptureOptions): string | undefined {
  if (process.env.REEVAL_CAPTURE_BROWSER === '0') {
    return 'c.capture() is refused: REEVAL_CAPTURE_BROWSER=0'
  }
  if (capture.browser === false) {
    return 'c.capture() is refused: capture.browser is false'
  }
}

export function resolveCaptureCall(
  call: CaptureCall,
  cascade: CaptureOptions,
): { port: number; path: string; viewport: Viewport; timeoutMs: number } {
  const port = call.port
  if (port === undefined) {
    throw new Error('c.capture() needs a port: pass port on the call')
  }
  if (!(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw new Error(`c.capture() port is a container port from 1 to 65535 (got ${String(port)})`)
  }
  return {
    port,
    path: call.path,
    viewport: call.viewport ?? cascade.viewport ?? DEFAULT_VIEWPORT,
    timeoutMs: parseDuration(call.timeout ?? cascade.timeout ?? DEFAULT_TIMEOUT),
  }
}

export function checkCaptureName(name: string): void {
  if (!CAPTURE_NAME.test(name)) {
    throw new Error(`c.capture() name must match [a-z0-9_-]+ (got ${JSON.stringify(name)})`)
  }
}

/** A free host port. Closed before the promise resolves, so the caller can bind it. */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

/** Origin plus a path (`/login`), without a doubled slash. */
export function pageUrl(origin: string, path: string): string {
  const base = origin.endsWith('/') ? origin : `${origin}/`
  const rel = path.startsWith('/') ? path.slice(1) : path
  return new URL(rel, base).href
}
