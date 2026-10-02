import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseDuration } from '../duration.ts'
import { cacheDir } from '../root.ts'
import type { CaptureCall, CaptureOptions, Duration, ServeHandle, Viewport } from '../types.ts'

export type { DownloadProgress, DownloadReporter } from './browser.ts'
export {
  CHROME_NAME,
  CHROME_VERSION,
  chromeBinaryPath,
  ensureChrome,
  pickPageDebuggerUrl,
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

export function resolveCaptureTarget(target: number | ServeHandle): number {
  if (typeof target === 'number') {
    if (!(Number.isInteger(target) && target >= 1 && target <= 65535)) {
      throw new Error(
        `c.capture() port is a container port from 1 to 65535 (got ${String(target)})`,
      )
    }
    return target
  }
  if (
    target !== null &&
    typeof target === 'object' &&
    typeof target.port === 'number' &&
    typeof target.kill === 'function'
  ) {
    return resolveCaptureTarget(target.port)
  }
  throw new Error('c.capture() needs a port or a ServeHandle as the first argument')
}

/** Artifact name from a path: `/login` → `login`, `/foo/bar` → `foo-bar`, `/` → `root`. */
export function nameFromPath(path: string): string {
  const slug = (path.split(/[?#]/, 1)[0] ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'root'
}

export function resolveCaptureCall(
  target: number | ServeHandle,
  call: CaptureCall | undefined,
  cascade: CaptureOptions,
): { port: number; name: string; path: string; viewport: Viewport; timeoutMs: number } {
  if (call && Object.hasOwn(call, 'port')) {
    throw new Error('c.capture() takes the port as the first argument, not in the options')
  }
  const port = resolveCaptureTarget(target)
  const path = call?.path || '/'
  const name = call?.name ?? nameFromPath(path)
  checkCaptureName(name)
  return {
    port,
    name,
    path,
    viewport: call?.viewport ?? cascade.viewport ?? DEFAULT_VIEWPORT,
    timeoutMs: parseDuration(call?.timeout ?? cascade.timeout ?? DEFAULT_TIMEOUT),
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
