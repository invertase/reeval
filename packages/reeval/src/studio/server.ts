import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { type Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { attemptDebugDir, parseAttemptKey } from '../debug/files.ts'
import { type AnalysisIndex, sortAnalyses } from '../view/analysis.ts'
import {
  DEBUG_LOG,
  type DebugRequest,
  type DebugView,
  parseDebugLog,
  parseNdjson,
  REQUESTS_FILE,
  TRACE_FILE,
} from '../view/debug.ts'
import type { LiveIndex, LiveRun } from '../view/live.ts'
import type { StudioInfo } from '../view/model.ts'
import { indexFiles } from '../view/model.ts'
import { artifactType, parseDataPath, RUN_ID } from '../view/paths.ts'
import { readableDebugRequest } from '../view/record.ts'
import { listLive, liveTranscript } from './live.ts'
import { listHeaders, resolveFile, type StudioSource } from './source.ts'

export const COOKIE = 'reeval_studio_token'

export type StudioServerOptions = {
  source: StudioSource
  /** The prebuilt web app (index.html and assets/). */
  appDir: string
  es: string
  project: string
  /** null turns the token check off (`--no-token`). */
  token: string | null
  /** Host headers to accept, e.g. `127.0.0.1:4984`; empty accepts any (tests only). */
  hosts: string[]
  /** Subscribes to history and live-run changes; returns an unsubscribe function. */
  subscribe?: (listener: (event: StudioEvent) => void) => () => void
  maxEventClients?: number
}

/** What `/api/events` streams: a run landed or was recorded, or a run in progress moved. */
export type StudioEvent = { type: 'history.changed' } | { type: 'run.progress'; runs: LiveRun[] }

export const newToken = () => randomBytes(32).toString('base64url')

/** Every name a browser may use to reach a server bound to `host:port`. */
export function allowedHosts(host: string, port: number): string[] {
  const names = new Set(['127.0.0.1', 'localhost', '[::1]'])
  names.add(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host)
  return [...names].map((name) => `${name}:${port}`)
}

const APP_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The request path relative to the root, percent-decoded exactly once; null if malformed. */
function requestPath(url: string): string | null {
  let path: string
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    return null
  }
  if (path.includes('\0') || path.includes('\\')) return null
  return path.replace(/^\/+/, '')
}

async function sendFile(
  c: Context,
  file: string,
  headers: Record<string, string>,
): Promise<Response> {
  const info = await stat(file)
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
  const common = { ...headers, ETag: etag, 'Content-Length': String(info.size) }
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag })
  if (c.req.method === 'HEAD') return c.body(null, 200, common)
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream
  return c.body(body, 200, common)
}

/** The studio's local HTTP app: read-only, GET only, behind a Host check and a session token. */
export function createStudioApp(options: StudioServerOptions) {
  const { source, token, hosts } = options
  const maxClients = options.maxEventClients ?? 16
  let clients = 0
  const app = new Hono()

  app.use('*', async (c, next) => {
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.text('Method not allowed', 405, { Allow: 'GET, HEAD' })
    }
    const host = c.req.header('host') ?? ''
    if (hosts.length && !hosts.includes(host)) return c.text('Unknown host', 403)
    const origin = c.req.header('origin')
    if (origin && hosts.length && !hosts.some((h) => origin === `http://${h}`)) {
      return c.text('Cross-origin requests are not allowed', 403)
    }
    if (token === null) return next()
    const url = new URL(c.req.url)
    const offered = url.searchParams.get('token')
    if (offered !== null) {
      if (!sameToken(offered, token)) return c.text('Wrong studio token', 401)
      setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/' })
      url.searchParams.delete('token')
      return c.redirect(`${url.pathname}${url.search}${url.hash}`, 302)
    }
    const cookie = getCookie(c, COOKIE)
    if (!cookie || !sameToken(cookie, token)) {
      return c.text(
        'This studio needs its session token. Open the full URL that reeval studio printed.',
        401,
      )
    }
    return next()
  })

  app.get('/api/events', (c) => {
    if (!options.subscribe) return c.text('Live updates are off', 404)
    if (clients >= maxClients) return c.text('Too many live clients', 503)
    const subscribe = options.subscribe
    clients++
    return streamSSE(c, async (stream) => {
      let id = 0
      const unsubscribe = subscribe((event) => {
        const data = event.type === 'run.progress' ? JSON.stringify({ runs: event.runs }) : '{}'
        void stream.writeSSE({ event: event.type, data, id: String(++id) })
      })
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve))
      await stream.writeSSE({ event: 'ready', data: '{}', id: String(id) })
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '{}' }), 25_000)
      await closed
      clearInterval(ping)
      unsubscribe()
      clients--
    })
  })

  // Runs in progress, from .reeval/staging: only here, never in a static build.
  app.get('/api/live', async (c) => {
    const index: LiveIndex = { runs: await listLive(source) }
    return c.json(index, 200, { 'Cache-Control': 'no-cache' })
  })
  app.get('/api/live/:runId/transcript', async (c) => {
    const text = await liveTranscript(source, c.req.param('runId'), c.req.query('attempt') ?? '')
    if (text === null) return c.text('No transcript for this attempt yet', 404)
    return c.body(text, 200, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': 'sandbox',
    })
  })

  // Local debug data from .reeval/debug: only here, never in a static build.
  const debugDir = (runId: string, key: string | undefined) => {
    const attempt = key ? parseAttemptKey(key) : null
    if (!RUN_ID.test(runId) || !attempt) return null
    return attemptDebugDir(source.root, runId, attempt.evalId, attempt.cell, attempt.n)
  }
  const readText = (path: string) => readFile(path, 'utf8').catch(() => null)
  app.get('/api/debug/:runId', async (c) => {
    const dir = debugDir(c.req.param('runId'), c.req.query('attempt'))
    const log = dir && (await readText(join(dir, DEBUG_LOG)))
    // Most attempts have none (recorded elsewhere, or cleaned): that's an answer, not an error.
    if (!dir || log === null) return c.json(null, 200, { 'Cache-Control': 'no-cache' })
    const view: DebugView = {
      lines: parseDebugLog(log),
      requests: parseNdjson<DebugRequest>((await readText(join(dir, REQUESTS_FILE))) ?? '').map(
        readableDebugRequest,
      ),
      trace: (await stat(join(dir, TRACE_FILE)).catch(() => null))?.isFile() ?? false,
    }
    return c.json(view, 200, { 'Cache-Control': 'no-cache' })
  })
  app.get('/api/debug/:runId/trace', async (c) => {
    const dir = debugDir(c.req.param('runId'), c.req.query('attempt'))
    const file = dir && join(dir, TRACE_FILE)
    if (!file || !(await stat(file).catch(() => null))?.isFile()) {
      return c.text('No trace for this attempt', 404)
    }
    return sendFile(c, file, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': 'sandbox',
    })
  })

  app.get('*', async (c) => {
    const path = requestPath(c.req.url)
    if (path === null) return c.text('Bad path', 400)
    const target = parseDataPath(path)
    if (target) {
      const noStore = { 'Cache-Control': 'no-cache' }
      if (target.kind === 'studio') {
        const info: StudioInfo = {
          mode: 'live',
          es: options.es,
          project: options.project,
          generatedAt: new Date().toISOString(),
          features: {
            live: !!options.subscribe,
            scratch: source.scratch,
            artifacts: true,
            debug: true,
          },
        }
        return c.json(info, 200, noStore)
      }
      if (target.kind === 'manifest' || target.kind === 'shard') {
        const files = indexFiles(await listHeaders(source))
        const body = files.get(path)
        if (body === undefined) return c.json([], 200, noStore)
        return c.json(body, 200, noStore)
      }
      if (target.kind === 'analysis') {
        const { listAnalyses, listNotes } = await import('../analysis/files.ts')
        const entries = await listAnalyses(source.root, [source.historyDir], target.runId, true)
        const notes = await listNotes(source.root, target.runId)
        const index: AnalysisIndex = {
          runId: target.runId,
          entries: sortAnalyses(entries),
          ...(notes.length ? { notes } : {}),
        }
        return c.json(index, 200, noStore)
      }
      const file = await resolveFile(source, target)
      if (!file) return c.text('Not found', 404)
      if (target.kind === 'record') {
        return sendFile(c, file, { ...noStore, 'Content-Type': APP_TYPES['.json'] as string })
      }
      return sendFile(c, file, {
        ...noStore,
        'Content-Type': artifactType(file),
        'Content-Security-Policy': 'sandbox',
      })
    }
    if (path.startsWith('data/') || path.startsWith('api/')) return c.text('Not found', 404)
    return serveApp(c, options.appDir, path)
  })

  return app
}

const APP_FILE = /^(?:assets\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

async function serveApp(c: Context, dir: string, path: string): Promise<Response> {
  const appDir = resolve(dir)
  const name = path === '' ? 'index.html' : path
  if (!APP_FILE.test(name) || name.includes('..')) return c.text('Not found', 404)
  const file = join(appDir, ...name.split('/'))
  if (!file.startsWith(appDir + sep)) return c.text('Not found', 404)
  try {
    if (!(await stat(file)).isFile()) return c.text('Not found', 404)
  } catch {
    return c.text('Not found', 404)
  }
  const hashed = name.startsWith('assets/')
  return sendFile(c, file, {
    'Content-Type': APP_TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(name === 'index.html' ? { 'Content-Security-Policy': APP_CSP } : {}),
  })
}
