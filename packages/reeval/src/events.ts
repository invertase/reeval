// A run's event stream: `reeval run --events` writes the events its renderer draws as NDJSON, to a
// file or POSTed to a URL, and `reeval attach` follows it, from the file or over the WebSocket of
// the server the lines were POSTed to, and draws them again. The line shape is `RunEventLine`
// (src/view/events.ts).
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { redactJson, redactSecrets, stripCredentials } from './redact.ts'
import { processAlive } from './resume.ts'
import { formatDuration } from './text.ts'
import type { PrepareTargetView, ReevalEvent, Renderer } from './ui/events.ts'
import {
  EVENTS_SCHEMA_VERSION,
  type RunEventLine,
  type RunEventsHeader,
  readableEventLine,
} from './view/events.ts'

export const isEventsUrl = (target: string) => /^https?:\/\//i.test(target)
/** A run `reeval attach` follows over a WebSocket, at a `ws:` or `wss:` URL or its `http(s):` form. */
export const isAttachUrl = (target: string) => /^(?:wss?|https?):\/\//i.test(target)

/** The stream ended, or its writer died, before the run's exit line. Exits 3. */
export class EventStreamError extends Error {
  override name = 'EventStreamError'
}

/** How long a run waits at exit for its last POSTs. */
const POST_DRAIN_MS = 10_000
const POST_TIMEOUT_MS = 10_000

/** A run writes a heartbeat line in each interval this long that it wrote nothing else in. */
export const HEARTBEAT_MS = 5_000
/** How long `reeval attach` hears nothing from a run that writes heartbeats before it says so. */
export const STALL_MS = 20_000
/** How long it hears nothing before it stops following the run as lost. */
export const LOST_MS = 120_000

const targetView = (t: PrepareTargetView): PrepareTargetView => ({
  kind: t.kind,
  key: t.key,
  label: t.label,
  setBy: t.setBy,
  runWide: t.runWide,
})

/**
 * The event as the stream carries it: a prepare event without its prepared handles or a failure's
 * full log, which the renderers don't draw.
 */
function wire(e: ReevalEvent): ReevalEvent {
  if (e.type !== 'prepare') return e
  if (e.state === 'start') return { ...e, targets: e.targets.map(targetView) }
  const { outcome } = e
  return {
    ...e,
    outcome: outcome.ok
      ? { target: targetView(outcome.target), ok: true, ms: outcome.ms }
      : {
          target: targetView(outcome.target),
          ok: false,
          failure: { ...outcome.failure, log: null },
          ms: outcome.ms,
        },
  }
}

// Progress lines echo check commands and the agent's tool calls, which can hold a secret.
const line = (value: RunEventLine) => `${redactJson(value)}\n`

/**
 * Why `file` can't take a run's event stream, or null when it can: it's missing, empty, or starts
 * with a stream's header line. Anything else is someone's file, which the run would overwrite.
 */
export function notEventStream(file: string): string | null {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(256)
    const n = readSync(fd, buffer, 0, buffer.length, 0)
    if (n === 0 || buffer.subarray(0, n).toString().startsWith('{"type":"header"')) return null
    return `${file} isn't a reeval event stream, so reeval run won't overwrite it`
  } finally {
    closeSync(fd)
  }
}

export type EventStream = {
  write(event: ReevalEvent): void
  /** Writes the exit line; resolves once the last POST is sent (or gives up). */
  end(code: number): Promise<void>
}

/**
 * Opens a run's stream: writes `file` (a resume adds its lines after the run's) and POSTs
 * batches of lines to `url`, in order, one request at a time. A failing target is dropped with one
 * warning; the run goes on. Until the exit line, a quiet stream gets a heartbeat line.
 */
export function openEventStream(options: {
  file?: string
  /** A resume or retry of the run: add to its stream rather than start the file anew. */
  append?: boolean
  url?: string
  header: Omit<RunEventsHeader, 'type' | 'schemaVersion' | 'pid' | 'host' | 'heartbeatMs'>
  warn: (message: string) => void
  fetch?: typeof fetch
  /** `HEARTBEAT_MS` unless given; 0 writes none. */
  heartbeatMs?: number
}): EventStream {
  let fd: number | null = null
  const refused = options.file ? notEventStream(options.file) : null
  if (refused) options.warn(`not writing the event stream: ${refused}`)
  if (options.file && !refused) {
    try {
      mkdirSync(dirname(options.file), { recursive: true })
      fd = openSync(options.file, options.append ? 'a' : 'w')
    } catch (error) {
      options.warn(`can't write the event stream to ${options.file}: ${(error as Error).message}`)
    }
  }
  const post = options.fetch ?? fetch
  let url = options.url
  const queue: string[] = []
  let sending: Promise<void> | null = null
  const pump = () => {
    if (sending || !url || !queue.length) return
    const body = queue.splice(0).join('')
    const to = url
    sending = post(to, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      })
      .catch((error: Error) => {
        url = undefined
        queue.length = 0
        options.warn(
          redactSecrets(
            `stopped posting the event stream to ${stripCredentials(to)}: ${error.message}`,
          ),
        )
      })
      .finally(() => {
        sending = null
        pump()
      })
  }
  let quiet = true
  const emit = (value: RunEventLine) => {
    quiet = false
    const text = line(value)
    if (fd !== null) {
      try {
        writeSync(fd, text)
      } catch (error) {
        options.warn(`stopped writing the event stream: ${(error as Error).message}`)
        closeSync(fd)
        fd = null
      }
    }
    if (url) {
      queue.push(text)
      pump()
    }
  }
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  emit({
    type: 'header',
    schemaVersion: EVENTS_SCHEMA_VERSION,
    pid: process.pid,
    host: hostname(),
    ...options.header,
    ...(heartbeatMs > 0 ? { heartbeatMs } : {}),
  })
  let ended = false
  const beating =
    heartbeatMs > 0 && (fd !== null || url)
      ? setInterval(() => {
          if (quiet) emit({ type: 'heartbeat', at: Date.now() })
          quiet = true
        }, heartbeatMs)
      : undefined
  beating?.unref()
  return {
    write: (event) => {
      if (!ended) emit(wire(event))
    },
    async end(code) {
      if (ended) return
      clearInterval(beating)
      emit({ type: 'exit', at: Date.now(), code })
      ended = true
      if (fd !== null) closeSync(fd)
      fd = null
      const deadline = Date.now() + POST_DRAIN_MS
      while ((sending || queue.length) && url && Date.now() < deadline) {
        await (sending ?? sleep(10))
      }
    },
  }
}

/** A renderer that also sends every event it draws to `stream`. */
export const teeRenderer = (renderer: Renderer, stream: EventStream): Renderer => ({
  onEvent(event) {
    stream.write(event)
    renderer.onEvent(event)
  },
  close: () => renderer.close(),
  ...(renderer.wait ? { wait: () => renderer.wait?.() ?? Promise.resolve() } : {}),
})

function parse(text: string, where: string): RunEventLine {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new EventStreamError(`${where} has a line that isn't JSON: ${text.slice(0, 80)}`)
  }
  return readableEventLine(value as RunEventLine)
}

export type FollowOptions = {
  signal?: AbortSignal
  /** How often a file at its end is read again. */
  pollMs?: number
  /** Whether a run's process is alive, from its header. */
  alive?: (pid: number, host: string) => boolean
  /** Opens a run's event socket; Node's `WebSocket` unless given. */
  connect?: (url: string) => WebSocket
  /** How long a dropped socket is reconnected to before following gives up; `LOST_MS` unless given. */
  reconnectMs?: number
  /** Called once each time the socket drops and following starts reconnecting. */
  onDrop?: () => void
}

/** Splits text into whole lines, keeping a trailing partial line for the next chunk. */
function* lines(state: { rest: string }, chunk: string): Generator<string> {
  const parts = (state.rest + chunk).split('\n')
  state.rest = parts.pop() ?? ''
  for (const part of parts) if (part.trim()) yield part
}

/**
 * Every line of a stream file from its start, then each one as it's appended, until the run's exit
 * line is the last one: an exit line a resume's header follows is passed on, and following goes on.
 * Throws an `EventStreamError` when the run's process on this host is gone without an exit line.
 */
async function* followFile(file: string, options: FollowOptions): AsyncGenerator<RunEventLine> {
  const alive = options.alive ?? processAlive
  const pollMs = options.pollMs ?? 100
  const fd = openSync(file, 'r')
  const buffer = Buffer.alloc(64 * 1024)
  const state = { rest: '' }
  let position = 0
  let last: RunEventLine | undefined
  let header: RunEventsHeader | undefined
  const decoder = new TextDecoder()
  const read = () => {
    if (fstatSync(fd).size < position) {
      throw new EventStreamError(
        `${file} was cut short while reeval attach read it: another run may have started writing it`,
      )
    }
    const out: RunEventLine[] = []
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, position)
      if (n === 0) return out
      position += n
      for (const text of lines(state, decoder.decode(buffer.subarray(0, n), { stream: true }))) {
        out.push(parse(text, file))
      }
    }
  }
  try {
    for (;;) {
      const got = read()
      for (const l of got) {
        if (l.type === 'header') header = l
        last = l
        yield l
      }
      if (got.length) continue
      if (last?.type === 'exit') return
      if (header && header.host === hostname() && !alive(header.pid, header.host)) {
        // It may have written its last lines as it exited.
        const tail = read()
        if (!tail.length) {
          throw new EventStreamError(
            `run ${header.runId}'s reeval run (pid ${header.pid}) ended without finishing its event stream`,
          )
        }
        for (const l of tail) {
          if (l.type === 'header') header = l
          last = l
          yield l
        }
        continue
      }
      if (options.signal?.aborted) return
      await sleep(pollMs, undefined, { signal: options.signal }).catch(() => {})
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * How a run's event socket closes. The server closes with `done` once it has sent the run's last
 * line and the run is over; any code from 4000 on, or 1008, refuses this viewer for good, and every
 * other close is a dropped connection that `reeval attach` reconnects after.
 */
export const SOCKET_CLOSE = {
  done: 1000,
  unauthorized: 4401,
  forbidden: 4403,
  notFound: 4404,
  /** The run already has as many viewers as it takes. */
  tooManyViewers: 4429,
} as const

/** The waits between reconnects to a run's event socket, the last repeated. */
const RECONNECT_MS = [250, 500, 1_000, 2_000, 5_000]

type SocketEvent =
  | { type: 'frame'; data: string }
  | { type: 'close'; code: number; reason: string; opened: boolean }

/** One connection's frames, then its close. */
async function* socketEvents(
  url: string,
  connect: (url: string) => WebSocket,
  signal: AbortSignal | undefined,
): AsyncGenerator<SocketEvent> {
  const socket = connect(url)
  socket.binaryType = 'arraybuffer'
  const queue: SocketEvent[] = []
  let wake: (() => void) | undefined
  let opened = false
  const push = (event: SocketEvent) => {
    queue.push(event)
    wake?.()
  }
  const decoder = new TextDecoder()
  socket.onopen = () => {
    opened = true
  }
  socket.onmessage = (e: MessageEvent) =>
    push({
      type: 'frame',
      data: typeof e.data === 'string' ? e.data : decoder.decode(e.data as ArrayBuffer),
    })
  // A refused connection fires only `error`, with no `close` after it.
  let closed = false
  const close = (code: number, reason: string) => {
    if (closed) return
    closed = true
    push({ type: 'close', code, reason, opened })
  }
  socket.onclose = (e: CloseEvent) => close(e.code, e.reason)
  socket.onerror = () => close(1006, '')
  const abort = () => socket.close(SOCKET_CLOSE.done)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      const next = queue.shift()
      if (!next) {
        await new Promise<void>((resolve) => (wake = resolve))
        wake = undefined
        continue
      }
      yield next
      if (next.type === 'close') return
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    if (socket.readyState === socket.CONNECTING || socket.readyState === socket.OPEN) {
      socket.close(SOCKET_CLOSE.done)
    }
  }
}

/** The run's socket URL, from a `ws:`, `wss:`, `http:` or `https:` one. */
const socketUrl = (source: string) => {
  const url = new URL(source)
  url.protocol = url.protocol.replace(/^http/, 'ws')
  return url
}

function refusal(source: string, code: number, reason: string): string | null {
  const why = reason ? ` (${reason})` : ''
  if (code === SOCKET_CLOSE.tooManyViewers) {
    return `the run at ${source} has as many viewers as it takes${why}: detach one and attach again`
  }
  if (code === SOCKET_CLOSE.unauthorized) return `the run at ${source} refused the token${why}`
  if (code === SOCKET_CLOSE.forbidden) return `the run at ${source} refused this viewer${why}`
  if (code === SOCKET_CLOSE.notFound) return `there's no run at ${source}${why}`
  if (code === 1008 || code >= 4000) return `the run at ${source} closed with ${code}${why}`
  return null
}

/**
 * A run's stream over a WebSocket: each frame is `{"seq":n,"line":<RunEventLine>}`, `seq` counting
 * the run's lines from 1. It connects with `?after=<seq>`, so the server replays the lines after it
 * and then sends each new one; a dropped connection reconnects after the last line it got, until the
 * run's exit line. Reconnecting for longer than `LOST_MS` gives up.
 */
async function* followSocket(source: string, options: FollowOptions): AsyncGenerator<RunEventLine> {
  const connect = options.connect ?? ((url: string) => new WebSocket(url))
  const giveUpMs = options.reconnectMs ?? LOST_MS
  const base = socketUrl(source)
  let seq = 0
  let everOpened = false
  let failures = 0
  let droppedAt: number | undefined
  for (;;) {
    const url = new URL(base)
    url.searchParams.set('after', String(seq))
    let closed: Extract<SocketEvent, { type: 'close' }> | undefined
    for await (const event of socketEvents(url.href, connect, options.signal)) {
      if (event.type === 'close') {
        closed = event
        break
      }
      let frame: { seq?: unknown; line?: unknown }
      try {
        frame = JSON.parse(event.data)
      } catch {
        throw new EventStreamError(
          `${source} sent a frame that isn't JSON: ${event.data.slice(0, 80)}`,
        )
      }
      if (typeof frame.seq !== 'number' || typeof frame.line !== 'object' || !frame.line) {
        throw new EventStreamError(
          `${source} sent a frame without a seq and line: ${event.data.slice(0, 80)}`,
        )
      }
      if (frame.seq <= seq) continue
      if (frame.seq !== seq + 1) {
        throw new EventStreamError(`${source} skipped from line ${seq} to line ${frame.seq}`)
      }
      seq = frame.seq
      failures = 0
      droppedAt = undefined
      const line = readableEventLine(frame.line as RunEventLine)
      yield line
      if (line.type === 'exit') return
    }
    if (options.signal?.aborted || !closed) return
    if (closed.opened) {
      everOpened = true
      failures = 0
    }
    if (closed.code === SOCKET_CLOSE.done) return
    const refused = refusal(source, closed.code, closed.reason)
    if (refused) throw new EventStreamError(refused)
    if (!everOpened) throw new EventStreamError(`can't connect to the event stream at ${source}`)
    if (droppedAt === undefined) {
      droppedAt = Date.now()
      options.onDrop?.()
    }
    if (Date.now() - droppedAt > giveUpMs) {
      throw new EventStreamError(
        `lost the connection to ${source} and couldn't reconnect for ${formatDuration(giveUpMs)}`,
      )
    }
    const wait = RECONNECT_MS[Math.min(failures, RECONNECT_MS.length - 1)] ?? 0
    failures++
    await sleep(wait, undefined, { signal: options.signal }).catch(() => {})
    if (options.signal?.aborted) return
  }
}

/** A run's stream, from a file or a run's socket URL, from its first line on. */
export const followEvents = (source: string, options: FollowOptions = {}) =>
  isAttachUrl(source) ? followSocket(source, options) : followFile(source, options)
