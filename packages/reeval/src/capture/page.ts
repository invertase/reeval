import { clip } from '../text.ts'
import type { CaptureConsoleMessage, CaptureFailedRequest, CapturePage } from '../types.ts'
import type { CdpClient } from './browser.ts'

/** Most entries a list keeps (each console level apart); the rest are counted in `dropped`. */
export const PAGE_ENTRIES = 100
const TEXT_MAX = 2000

type RemoteObject = {
  type?: string
  value?: unknown
  description?: string
  unserializableValue?: string
}

type CallFrame = { url?: string }

const params = <T>(msg: unknown): T => ((msg as { params?: T }).params ?? msg) as T

function argText(arg: RemoteObject): string {
  if (arg.type === 'string') return String(arg.value)
  if (arg.unserializableValue !== undefined) return arg.unserializableValue
  if (arg.description !== undefined) return arg.description
  if (arg.value !== undefined) return JSON.stringify(arg.value)
  return String(arg.type ?? '')
}

/** `console.*` call types that print nothing of their own. */
const SILENT = new Set(['clear', 'endGroup', 'profile', 'profileEnd'])

function consoleLevel(type: string): CaptureConsoleMessage['level'] {
  if (type === 'error' || type === 'assert') return 'error'
  if (type === 'warning') return 'warning'
  if (type === 'info') return 'info'
  if (type === 'debug') return 'debug'
  return 'log'
}

function logLevel(level: string | undefined): CaptureConsoleMessage['level'] {
  if (level === 'error' || level === 'warning' || level === 'info') return level
  return 'debug'
}

/**
 * Collects what the tab reports from the moment it's called: its console, its page errors
 * (uncaught exceptions and unhandled rejections), its failed requests and its main frame's
 * document status. Needs `Runtime.enable`, `Log.enable` and `Network.enable` sent after it, and
 * the main frame's id once it's known.
 */
export function watchPage(cdp: Pick<CdpClient, 'on'>): {
  mainFrame(id: string): void
  facts(url: string, origin: string): CapturePage
} {
  const consoleLines: CaptureConsoleMessage[] = []
  const errors: Array<{ id?: number; text: string }> = []
  const droppedErrors = new Set<number>()
  const failed: CaptureFailedRequest[] = []
  const requests = new Map<string, { url: string; method: string }>()
  let frame: string | undefined
  let status: number | undefined
  let frameUrl = ''
  let dropped = 0
  const keep = <T>(list: T[], item: T, count = list.length) => {
    if (count < PAGE_ENTRIES) list.push(item)
    else dropped++
    return count < PAGE_ENTRIES
  }
  // Clipped as kept, with room for the origin `facts` strips, so a huge line isn't held whole.
  const held = (text: string) => clip(text, TEXT_MAX * 2)
  // Each level is capped apart, so a page's many logs can't push out its errors.
  const keepConsole = (line: CaptureConsoleMessage) =>
    keep(consoleLines, line, consoleLines.filter((l) => l.level === line.level).length)
  cdp.on('Runtime.consoleAPICalled', (msg) => {
    const p = params<{
      type?: string
      args?: RemoteObject[]
      stackTrace?: { callFrames?: CallFrame[] }
    }>(msg)
    const type = p.type ?? 'log'
    if (SILENT.has(type)) return
    const url = p.stackTrace?.callFrames?.[0]?.url
    keepConsole({
      level: consoleLevel(type),
      text: held((p.args ?? []).map(argText).join(' ')),
      source: 'console-api',
      ...(url ? { url } : {}),
    })
  })
  cdp.on('Log.entryAdded', (msg) => {
    const { entry } = params<{
      entry?: { source?: string; level?: string; text?: string; url?: string }
    }>(msg)
    if (!entry) return
    keepConsole({
      level: logLevel(entry.level),
      text: held(entry.text ?? ''),
      source: entry.source ?? 'other',
      ...(entry.url ? { url: entry.url } : {}),
    })
  })
  cdp.on('Runtime.exceptionThrown', (msg) => {
    const { exceptionDetails: d } = params<{
      exceptionDetails?: { exceptionId?: number; text?: string; exception?: RemoteObject }
    }>(msg)
    if (!d) return
    const thrown = d.exception ? argText(d.exception) : ''
    const text = held(thrown ? `${d.text ?? 'Uncaught'} ${thrown}`.trim() : (d.text ?? 'Uncaught'))
    if (!keep(errors, { id: d.exceptionId, text }) && d.exceptionId !== undefined) {
      droppedErrors.add(d.exceptionId)
    }
  })
  // A rejection the page handles later is revoked, and is no longer a page error.
  cdp.on('Runtime.exceptionRevoked', (msg) => {
    const { exceptionId: id } = params<{ exceptionId?: number }>(msg)
    if (id === undefined) return
    if (droppedErrors.delete(id)) {
      dropped--
      return
    }
    const at = errors.findIndex((e) => e.id === id)
    if (at >= 0) errors.splice(at, 1)
  })
  cdp.on('Page.frameNavigated', (msg) => {
    const { frame: f } = params<{ frame?: { id?: string; url?: string; urlFragment?: string } }>(
      msg,
    )
    if (f?.id && f.id === frame && f.url) frameUrl = f.url + (f.urlFragment ?? '')
  })
  cdp.on('Page.navigatedWithinDocument', (msg) => {
    const p = params<{ frameId?: string; url?: string }>(msg)
    if (p.frameId && p.frameId === frame && p.url) frameUrl = p.url
  })
  cdp.on('Network.requestWillBeSent', (msg) => {
    const p = params<{ requestId?: string; request?: { url?: string; method?: string } }>(msg)
    if (p.requestId && p.request?.url) {
      requests.set(p.requestId, { url: p.request.url, method: p.request.method ?? 'GET' })
    }
  })
  cdp.on('Network.responseReceived', (msg) => {
    const p = params<{
      requestId?: string
      type?: string
      frameId?: string
      response?: { url?: string; status?: number }
    }>(msg)
    const code = p.response?.status ?? 0
    // A redirect's hops come as `requestWillBeSent`s; this is the final response. A full
    // navigation's document replaces it; a client-side route change sends none.
    if (p.type === 'Document' && p.frameId && p.frameId === frame) status = p.response?.status
    if (code < 400) return
    const req = p.requestId ? requests.get(p.requestId) : undefined
    keep(failed, {
      method: req?.method ?? 'GET',
      url: p.response?.url ?? req?.url ?? '',
      status: code,
    })
  })
  cdp.on('Network.loadingFinished', (msg) => {
    const { requestId } = params<{ requestId?: string }>(msg)
    if (requestId) requests.delete(requestId)
  })
  cdp.on('Network.loadingFailed', (msg) => {
    const p = params<{
      requestId?: string
      errorText?: string
      canceled?: boolean
      corsErrorStatus?: { corsError?: string }
    }>(msg)
    const req = p.requestId ? requests.get(p.requestId) : undefined
    if (p.requestId) requests.delete(p.requestId)
    if (p.canceled || !req) return
    const cors = p.corsErrorStatus?.corsError
    const error = `${p.errorText ?? 'failed'}${cors ? ` (CORS ${cors})` : ''}`
    keep(failed, { method: req.method, url: req.url, error })
  })
  return {
    mainFrame(id) {
      frame = id
    },
    facts(url, origin) {
      url ||= frameUrl
      const base = origin.replace(/\/$/, '')
      // Not followed by a digit, so `:4123` doesn't match inside `:41234`.
      const at = base
        ? new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`, 'g')
        : undefined
      const local = (text: string) => clip(at ? text.replace(at, '') : text, TEXT_MAX)
      const path = (u: string) => local(u) || '/'
      return {
        ...(status ? { status } : {}),
        finalUrl: path(url),
        console: consoleLines.map((l) => ({
          ...l,
          text: local(l.text),
          ...(l.url ? { url: path(l.url) } : {}),
        })),
        errors: errors.map((e) => local(e.text)),
        failedRequests: failed.map((r) => ({ ...r, url: path(r.url) })),
        ...(dropped ? { dropped } : {}),
      }
    },
  }
}
