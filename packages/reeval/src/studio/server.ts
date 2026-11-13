import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { type Context, Hono } from 'hono'
import { readReportInputs } from '../history/report-inputs.ts'
import {
  artifactType,
  type Handshake,
  type PairResponse,
  pageRuns,
  parseStudioPath,
  reportLinks,
  STUDIO_API_VERSION,
  STUDIO_ROUTES,
  transcriptQuery,
} from '../view/api.ts'
import { buildRunReport } from '../view/report/build.ts'
import { REPORT_VERSION, splitRunReport } from '../view/report/split.ts'
import { pageJsonl } from './jsonl.ts'
import { listHeaders, readRun, resolveFile, runDirIsReal, type StudioSource } from './source.ts'

export type StudioApiOptions = {
  source: StudioSource
  reeval: string
  project: string
  /** The one origin a browser may call from: the hosted studio's. */
  origin: string
  /** The one-time token the hosted page trades for a session. */
  pairingToken: string
  /** Host headers to accept, e.g. `127.0.0.1:4984`; empty accepts any (tests only). */
  hosts: string[]
  /** The run to open first; null opens the newest. */
  focus: string | null
  /** Called once, when the pairing token is traded for a session. */
  onPair?: () => void
}

export const newToken = () => randomBytes(32).toString('base64url')

/** Every name a browser may use to reach a server bound to `host:port`. */
export function allowedHosts(host: string, port: number): string[] {
  const names = new Set(['127.0.0.1', 'localhost', '[::1]'])
  names.add(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host)
  return [...names].map((name) => `${name}:${port}`)
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const MAX_PAIR_BODY = 1024

/** The request's body as text, or null once it passes `max` bytes, reading no further. */
async function cappedText(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * `reeval studio`'s data server: the studio API over local run files. It answers a browser only
 * from `origin`, and every route but `pair` only with the session that the one-time pairing token
 * was traded for, which lives as long as this process.
 */
export function createStudioApi(options: StudioApiOptions) {
  const { source, origin, hosts } = options
  let pairingToken: string | null = options.pairingToken
  let session: string | null = null
  const handshake = async (): Promise<Handshake> => ({
    api: STUDIO_API_VERSION,
    reportVersion: REPORT_VERSION,
    reeval: options.reeval,
    project: options.project,
    routes: [...STUDIO_ROUTES],
    focus: options.focus ?? (await listHeaders(source)).at(-1)?.runId ?? null,
  })
  const app = new Hono()

  app.use('*', async (c, next) => {
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cache-Control', 'no-store')
    c.header('Vary', 'Origin')
    const host = c.req.header('host') ?? ''
    if (hosts.length && !hosts.includes(host)) return c.text('Unknown host', 403)
    const from = c.req.header('origin')
    if (from !== undefined && from !== origin) {
      return c.text('Cross-origin requests are only allowed from the hosted studio', 403)
    }
    if (from !== undefined) c.header('Access-Control-Allow-Origin', origin)
    if (c.req.method === 'OPTIONS') {
      if (from === undefined) return c.text('Not a CORS preflight', 400)
      c.header('Access-Control-Allow-Methods', 'GET, POST')
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      c.header('Access-Control-Max-Age', '600')
      if (c.req.header('access-control-request-private-network') === 'true') {
        c.header('Access-Control-Allow-Private-Network', 'true')
      }
      return c.body(null, 204)
    }
    const target = parseStudioPath(new URL(c.req.url).pathname)
    if (!target) return c.text('Not found', 404)
    const method = target.route === 'pair' ? 'POST' : 'GET'
    if (c.req.method !== method && !(method === 'GET' && c.req.method === 'HEAD')) {
      return c.text('Method not allowed', 405, { Allow: method === 'GET' ? 'GET, HEAD' : 'POST' })
    }
    if (target.route === 'pair') return next()
    const auth = c.req.header('authorization') ?? ''
    const offered = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!session || !offered || !sameToken(offered, session)) {
      return c.text('Pair with this studio first: open the URL reeval studio printed', 401)
    }
    return next()
  })

  app.post('/api/v1/pair', async (c) => {
    const text = await cappedText(c.req.raw, MAX_PAIR_BODY)
    if (text === null) return c.text('Pairing request too large', 413)
    let token: unknown
    try {
      token = (JSON.parse(text) as { token?: unknown }).token
    } catch {
      return c.text('Send { "token": "<pairing token>" }', 400)
    }
    if (pairingToken === null) return c.text('This studio is already paired', 409)
    if (typeof token !== 'string' || !sameToken(token, pairingToken)) {
      return c.text('Wrong pairing token', 401)
    }
    pairingToken = null
    session = newToken()
    options.onPair?.()
    const body: PairResponse = { session, handshake: await handshake() }
    return c.json(body)
  })

  app.get('/api/v1/handshake', async (c) => c.json(await handshake()))

  app.get('/api/v1/runs', async (c) => {
    return c.json(pageRuns(await listHeaders(source), c.req.query()))
  })

  app.get('*', async (c) => {
    const target = parseStudioPath(new URL(c.req.url).pathname)
    if (!target || !('runId' in target)) return c.text('Not found', 404)
    if (target.route === 'artifact') {
      const file = await resolveFile(source, { kind: 'artifact', ...target })
      if (!file) return c.text('Not found', 404)
      const query = c.req.query()
      if (file.endsWith('.jsonl') && ('cursor' in query || 'limit' in query)) {
        const range = transcriptQuery(query)
        if (typeof range === 'string') return c.text(range, 400)
        return c.json(await pageJsonl(file, range))
      }
      return sendFile(c, file, artifactType(file))
    }
    const run = await readRun(source, target.runId)
    if (!run || !(await runDirIsReal(run.dir, target.runId))) {
      return c.text(`No run ${target.runId}`, 404)
    }
    if (run.record.evals.length === 0) return c.text(`Run ${target.runId} has no evals`, 404)
    const report = buildRunReport(run.record, {
      ...(await readReportInputs(join(run.dir, target.runId))),
      links: reportLinks(target.runId),
    })
    const { index, details } = splitRunReport(report)
    if (target.route === 'report') return c.json(index)
    const detail = details.find((d) => d.eval.id === target.evalId)
    if (!detail) return c.text(`No eval ${target.evalId} in ${target.runId}`, 404)
    return c.json(detail)
  })

  return app
}

async function sendFile(c: Context, file: string, type: string): Promise<Response> {
  const info = await stat(file)
  const headers = {
    'Content-Type': type,
    'Content-Length': String(info.size),
    'Content-Security-Policy': 'sandbox',
  }
  if (c.req.method === 'HEAD') return c.body(null, 200, headers)
  if (info.size < 64 * 1024) return c.body(new Uint8Array(await readFile(file)), 200, headers)
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200, headers)
}
