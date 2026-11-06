// A run's event stream: `reeval run --events` writes the events its renderer draws as NDJSON, to a
// file or POSTed to a URL, and `reeval attach` follows it and draws them again. The line shape is
// `RunEventLine` (src/view/events.ts).
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { redactJson, redactSecrets, stripCredentials } from './redact.ts'
import { processAlive } from './resume.ts'
import type { PrepareTargetView, ReevalEvent, Renderer } from './ui/events.ts'
import {
  EVENTS_SCHEMA_VERSION,
  type RunEventLine,
  type RunEventsHeader,
  readableEventLine,
} from './view/events.ts'

export const isEventsUrl = (target: string) => /^https?:\/\//i.test(target)

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
  header: Omit<RunEventsHeader, 'type' | 'schemaVersion' | 'pid' | 'host'>
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
  emit({
    type: 'header',
    schemaVersion: EVENTS_SCHEMA_VERSION,
    pid: process.pid,
    host: hostname(),
    ...options.header,
  })
  let ended = false
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
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
  fetch?: typeof fetch
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

/** Every line a stream URL answers a GET with, as they arrive, until the response ends. */
async function* followUrl(url: string, options: FollowOptions): AsyncGenerator<RunEventLine> {
  const get = options.fetch ?? fetch
  const res = await get(url, {
    headers: { accept: 'application/x-ndjson' },
    ...(options.signal ? { signal: options.signal } : {}),
  }).catch((error: Error) => {
    throw new EventStreamError(`can't read the event stream at ${url}: ${error.message}`)
  })
  if (!res.ok || !res.body) {
    throw new EventStreamError(`can't read the event stream at ${url}: HTTP ${res.status}`)
  }
  const state = { rest: '' }
  const decoder = new TextDecoder()
  for await (const chunk of res.body) {
    for (const text of lines(state, decoder.decode(chunk, { stream: true }))) yield parse(text, url)
  }
  if (state.rest.trim()) yield parse(state.rest, url)
}

/** A run's stream, from a file or a URL, from its first line on. */
export const followEvents = (source: string, options: FollowOptions = {}) =>
  isEventsUrl(source) ? followUrl(source, options) : followFile(source, options)
