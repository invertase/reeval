// A run's event stream: `reeval run --events` writes the events its renderer draws as NDJSON, to a
// file or POSTed to a URL, and `reeval attach` follows it, from the file or over the WebSocket of
// the server the lines were POSTed to, and draws them again. The line shape is `RunEventLine`
// (src/view/events.ts).
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { EngineOptions } from './engine/node.ts'
import { redactJson, redactSecrets, stripCredentials } from './redact.ts'
import { processAlive } from './resume.ts'
import type { MachineHoldings } from './sandbox/machine-service.ts'
import { formatDuration } from './text.ts'
import type { PrepareTargetView, ReevalEvent, Renderer } from './ui/events.ts'
import {
  EVENTS_SCHEMA_VERSION,
  type RunEventLine,
  type RunEventsHeader,
  type RunEventsHeartbeat,
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
/** How often, while the eval files run, a heartbeat line names the attempts in progress. */
export const ATTEMPTS_HEARTBEAT_MS = 30_000
/** The intervals `REEVAL_EVENTS_HEARTBEAT` takes besides 0. */
export const ATTEMPTS_HEARTBEAT_RANGE = { min: 1_000, max: 600_000, says: '1s to 10m' }
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
  if (e.state === 'image')
    return {
      ...e,
      target: targetView(e.target),
      image: { name: e.image.name, cached: e.image.cached },
    }
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
  /** Writes a heartbeat line naming the attempts in progress; no renderer draws it. */
  heartbeat(beat: AttemptsHeartbeat): void
  /** Writes the exit line; resolves once the last POST is sent (or gives up). */
  end(code: number): Promise<void>
}

/** What an attempts heartbeat line carries beside its type and time. */
export type AttemptsHeartbeat = Required<Pick<RunEventsHeartbeat, 'attempts' | 'machines'>> &
  Pick<RunEventsHeartbeat, 'done'>

/** The run's attempts heartbeat: how often, and where each beat goes. */
export type AttemptsBeat = { ms: number; send: (beat: AttemptsHeartbeat) => void }

/** The engine's heartbeat for `beat`, with each attempt's machine and the machines `pools` hold. */
export function beatWith(
  beat: AttemptsBeat,
  pools: { holdings(): MachineHoldings },
): NonNullable<EngineOptions['heartbeat']> {
  return {
    ms: beat.ms,
    beat: (keys, done) => {
      const { machines, leases } = pools.holdings()
      beat.send({
        attempts: keys.map((key) => {
          const machine = leases.get(key)
          return machine === undefined ? { key } : { key, machine }
        }),
        machines,
        ...(done ? { done: true as const } : {}),
      })
    },
  }
}

/** The waits before each try again of a batch the target failed, the last repeated. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** The most of the queue one POST carries; a longer line goes alone. */
const BATCH_BYTES = 1024 * 1024
/** The most the queue holds while the target fails; past it, its oldest lines go. */
const QUEUE_BYTES = 32 * 1024 * 1024

/** Statuses that refuse a batch for good: it's dropped (or, for 413, split) and the rest go on. */
const refusesBatch = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429

type Queued = { text: string; bytes: number; beat: boolean }

/**
 * Opens a run's stream: writes `file` (a resume adds its lines after the run's) and POSTs
 * batches of lines to `url`, in order, one request at a time. A batch the target fails (a network
 * error, a timeout, a 408, 425, 429 or 5xx) is tried again, after a backoff, with every line after
 * it kept; one it refuses with another 4xx is dropped, and one too large (413) is split until a
 * single line is, which is dropped. While the target fails, a newer attempts heartbeat replaces
 * a queued one and, past `QUEUE_BYTES`, the oldest queued lines go, each with a warning. The run
 * goes on. Until the exit line, a quiet stream gets a heartbeat line.
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
  /** `RETRY_MS` unless given. */
  retryMs?: readonly number[]
  /** How long `end` waits for the queue to go; `POST_DRAIN_MS` unless given. */
  drainMs?: number
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
  const url = options.url
  const shown = url ? displayUrl(url) : ''
  const retryMs = options.retryMs ?? RETRY_MS
  const warn = (message: string) => options.warn(redactSecrets(message))
  const queue: Queued[] = []
  let queuedBytes = 0
  /** How many of the queue's first lines the POST under way carries. */
  let inFlight = 0
  let sending = false
  let retry: NodeJS.Timeout | undefined
  let failures = 0
  let batchBytes = BATCH_BYTES
  /** The target is failing: the first failure warned, and dropped lines warn once until it's back. */
  let failing = false
  let droppedWarned = false
  const unqueue = (index: number, count: number) => {
    for (const q of queue.splice(index, count)) queuedBytes -= q.bytes
  }
  const settle = async (res: Response | Error, sent: number, bytes: number) => {
    if (!(res instanceof Error) && res.ok) {
      unqueue(0, sent)
      failures = 0
      batchBytes = BATCH_BYTES
      if (failing) warn(`posting the event stream to ${shown} again`)
      failing = droppedWarned = false
      return 0
    }
    if (!(res instanceof Error) && refusesBatch(res.status)) {
      const said = await serverMessage(res)
      if (res.status === 413 && sent > 1) {
        batchBytes = Math.max(1, Math.floor(bytes / 2))
        return 0
      }
      unqueue(0, sent)
      warn(
        res.status === 413
          ? `dropped a line of the event stream to ${shown}: the server refused it as too large (HTTP 413${said})`
          : `dropped ${sent === 1 ? 'a line' : `${sent} lines`} of the event stream to ${shown}: the server refused them (HTTP ${res.status}${said})`,
      )
      return 0
    }
    const why = res instanceof Error ? res.message : `HTTP ${res.status}${await serverMessage(res)}`
    if (!failing) warn(`posting the event stream to ${shown} failed, trying again: ${why}`)
    failing = true
    failures++
    return retryMs[Math.min(failures, retryMs.length) - 1] ?? 0
  }
  const pump = () => {
    if (sending || retry || !url || !queue.length) return
    let bytes = 0
    let sent = 0
    while (sent < queue.length && (sent === 0 || bytes + (queue[sent]?.bytes ?? 0) <= batchBytes)) {
      bytes += queue[sent]?.bytes ?? 0
      sent++
    }
    const body = queue
      .slice(0, sent)
      .map((q) => q.text)
      .join('')
    sending = true
    inFlight = sent
    post(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
      .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
      .then((res) => settle(res, sent, bytes))
      .then((wait) => {
        sending = false
        inFlight = 0
        if (wait > 0) {
          retry = setTimeout(() => {
            retry = undefined
            pump()
          }, wait)
          retry.unref()
        }
        pump()
      })
  }
  const enqueue = (text: string, beat: boolean) => {
    if (beat) {
      for (let i = queue.length - 1; i >= inFlight; i--) {
        if (queue[i]?.beat) unqueue(i, 1)
      }
    }
    queue.push({ text, bytes: Buffer.byteLength(text), beat })
    queuedBytes += Buffer.byteLength(text)
    let dropped = 0
    while (queuedBytes > QUEUE_BYTES && queue.length > inFlight + 1) {
      unqueue(inFlight, 1)
      dropped++
    }
    if (dropped && !droppedWarned) {
      droppedWarned = true
      warn(
        `the event stream's queue for ${shown} passed ${QUEUE_BYTES / 1024 / 1024} MiB while posting failed: dropping its oldest lines`,
      )
    }
    pump()
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
    if (url) enqueue(text, value.type === 'heartbeat' && value.attempts !== undefined)
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
    heartbeat: (beat) => {
      if (!ended) emit({ type: 'heartbeat', at: Date.now(), ...beat })
    },
    async end(code) {
      if (ended) return
      clearInterval(beating)
      emit({ type: 'exit', at: Date.now(), code })
      ended = true
      if (fd !== null) closeSync(fd)
      fd = null
      const deadline = Date.now() + (options.drainMs ?? POST_DRAIN_MS)
      while (queue.length && url && Date.now() < deadline) await sleep(10)
      clearTimeout(retry)
      if (queue.length && url) {
        warn(
          `gave up posting the event stream to ${shown} at exit: ${queue.length === 1 ? 'its last line' : `its last ${queue.length} lines`} didn't go`,
        )
      }
    },
  }
}

/** The message in an error response's `{ error: { message } }` body, as ` (message)`, or ''. */
async function serverMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } }
    const message = body?.error?.message
    return typeof message === 'string' && message ? ` (${message.slice(0, 200)})` : ''
  } catch {
    return ''
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
  /** How often a connected socket sends `ping`; 30s unless given. */
  pingMs?: number
  /** How long a socket stays up before its next drop starts the backoff over; 5s unless given. */
  stableMs?: number
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
 * other close is a dropped connection that `reeval attach` reconnects after, 1001 included, which
 * the server sends a viewer it evicts as stale.
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
/**
 * A viewer sends `PING` this often, and the server answers `PONG` (text frames, since Node's
 * WebSocket can't send protocol pings). A server may close, with 1001, a viewer that has pinged
 * before but not lately.
 */
const PING_MS = 30_000
const PING = 'ping'
const PONG = 'pong'
/** How long a connection stays up, with no frame, before the backoff starts over. */
const STABLE_MS = 5_000

/** A URL as messages show it: no user name or password, and every query value masked. */
export function displayUrl(source: string): string {
  let url: URL
  try {
    url = new URL(stripCredentials(source))
  } catch {
    return stripCredentials(source)
  }
  for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, '***')
  return url.href.replace(/%2A/g, '*')
}

type SocketEvent =
  | { type: 'open' }
  | { type: 'frame'; data: string }
  | { type: 'close'; code: number; reason: string; opened: boolean }

/** One connection's open, its frames, then its close. */
async function* socketEvents(
  url: string,
  connect: (url: string) => WebSocket,
  signal: AbortSignal | undefined,
  pingMs: number,
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
  let pinging: NodeJS.Timeout | undefined
  socket.onopen = () => {
    opened = true
    pinging = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.send(PING)
    }, pingMs)
    pinging.unref()
    push({ type: 'open' })
  }
  socket.onmessage = (e: MessageEvent) =>
    push({
      type: 'frame',
      data: typeof e.data === 'string' ? e.data : decoder.decode(e.data as ArrayBuffer),
    })
  // A refused connection fires only `error`, with no `close` after it.
  let closed = false
  const close = (code: number, reason: string) => {
    clearInterval(pinging)
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
    clearInterval(pinging)
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
 * and then sends each new one, and closes with 1000 once the run is over: a resume's lines can
 * follow an exit line. A dropped connection reconnects after the last line it got; going `LOST_MS`
 * without one that opens gives up.
 */
async function* followSocket(source: string, options: FollowOptions): AsyncGenerator<RunEventLine> {
  const connect = options.connect ?? ((url: string) => new WebSocket(url))
  const giveUpMs = options.reconnectMs ?? LOST_MS
  const stableMs = options.stableMs ?? STABLE_MS
  const pingMs = options.pingMs ?? PING_MS
  const shown = displayUrl(source)
  const base = socketUrl(source)
  let seq = 0
  let everOpened = false
  let failures = 0
  /** Since when no connection has opened, while reconnecting. */
  let droppedAt: number | undefined
  /** Reconnecting, which ends with a frame or a connection that stays up. */
  let reconnecting = false
  for (;;) {
    const url = new URL(base)
    url.searchParams.set('after', String(seq))
    let closed: Extract<SocketEvent, { type: 'close' }> | undefined
    let openedAt: number | undefined
    for await (const event of socketEvents(url.href, connect, options.signal, pingMs)) {
      if (event.type === 'open') {
        openedAt = Date.now()
        droppedAt = undefined
        continue
      }
      if (event.type === 'close') {
        closed = event
        break
      }
      if (event.data === PONG) continue
      let frame: { seq?: unknown; line?: unknown } | null
      try {
        frame = JSON.parse(event.data)
      } catch {
        throw new EventStreamError(
          `${shown} sent a frame that isn't JSON: ${event.data.slice(0, 80)}`,
        )
      }
      if (
        typeof frame !== 'object' ||
        !frame ||
        typeof frame.seq !== 'number' ||
        typeof frame.line !== 'object' ||
        !frame.line
      ) {
        throw new EventStreamError(
          `${shown} sent a frame without a seq and line: ${event.data.slice(0, 80)}`,
        )
      }
      failures = 0
      reconnecting = false
      if (frame.seq <= seq) continue
      if (frame.seq !== seq + 1) {
        throw new EventStreamError(`${shown} skipped from line ${seq} to line ${frame.seq}`)
      }
      seq = frame.seq
      yield readableEventLine(frame.line as RunEventLine)
    }
    if (options.signal?.aborted || !closed) return
    if (closed.opened) everOpened = true
    if (closed.code === SOCKET_CLOSE.done) return
    const refused = refusal(shown, closed.code, closed.reason)
    if (refused) throw new EventStreamError(refused)
    if (!everOpened) throw new EventStreamError(`can't connect to the event stream at ${shown}`)
    if (openedAt !== undefined && Date.now() - openedAt >= stableMs) {
      failures = 0
      reconnecting = false
    }
    if (!reconnecting) {
      reconnecting = true
      options.onDrop?.()
    }
    droppedAt ??= Date.now()
    if (Date.now() - droppedAt > giveUpMs) {
      throw new EventStreamError(
        `lost the connection to ${shown} and couldn't reconnect for ${formatDuration(giveUpMs)}`,
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
