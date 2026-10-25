// One attempt's debug trace, on the worker. `-v` lines go to debug.log (always) and, with -v,
// to the terminal. Raw payloads go to a size-capped buffer, like a flight recorder, which is
// written to trace.ndjson only when the attempt fails or with --trace. Everything is redacted.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactJson, redactJsonText, redactSecrets } from '../redact.ts'
import {
  DEBUG_LOG,
  type DebugLine,
  type DebugPhase,
  type DebugRequest,
  debugLogLine,
  REQUESTS_FILE,
  requestLine,
  TRACE_FILE,
} from '../view/debug.ts'

export type Verbosity = 0 | 1 | 2

/** A trace entry bigger than this keeps its head only. */
const MAX_ENTRY = 256 * 1024
const ENTRY_HEAD = 64 * 1024
/** Most of a payload the terminal shows under a `-vv` line; trace.ndjson has the rest. */
const MAX_SCREEN = 2000

export type AttemptDebugOptions = {
  /** `.reeval/debug/<runId>/<eval>/<cell>/<n>`. */
  dir: string
  verbosity: Verbosity
  /** Bytes of trace kept in memory; older entries are dropped first. */
  traceLimit: number
  /** Streams a line to the terminal (only called at the matching verbosity). */
  emit?: (line: DebugLine) => void
}

/** Debug lines are one line each: a multi-line command reads `a ⏎ b`. */
const oneLine = (text: string) => text.replace(/\r?\n/g, ' ⏎ ')

const json = (value: unknown) => {
  try {
    return JSON.stringify(value, (_k, v) =>
      typeof v === 'bigint'
        ? String(v)
        : v instanceof Uint8Array
          ? `<${v.byteLength} bytes>`
          : v instanceof Error
            ? { name: v.name, message: v.message }
            : v,
    )
  } catch (error) {
    return JSON.stringify({ unserialisable: (error as Error).message })
  }
}

export class AttemptDebug {
  readonly dir: string
  readonly verbosity: Verbosity
  readonly #emit: AttemptDebugOptions['emit']
  readonly #startedAt = Date.now()
  readonly #limit: number
  #log: WriteStream | undefined
  #requests: WriteStream | undefined
  #trace: string[] = []
  #head = 0
  #bytes = 0
  #dropped = 0
  #closed = false

  constructor(options: AttemptDebugOptions) {
    this.dir = options.dir
    this.verbosity = options.verbosity
    this.#emit = options.emit
    this.#limit = options.traceLimit
    try {
      mkdirSync(this.dir, { recursive: true })
      this.#log = createWriteStream(join(this.dir, DEBUG_LOG), { flags: 'a' })
      this.#log.on('error', () => {})
    } catch {}
  }

  /** A `-v` line: always in debug.log, on the terminal with -v. */
  log(phase: DebugPhase, text: string): void {
    if (this.#closed) return
    const line: DebugLine = { at: Date.now(), level: 1, phase, text: redactSecrets(oneLine(text)) }
    this.#log?.write(`${debugLogLine(line)}\n`)
    this.trace(phase, 'log', { text: line.text }, false)
    if (this.verbosity >= 1) this.#emit?.(line)
  }

  /**
   * A raw payload for trace.ndjson; with -vv also on the terminal, as `summary` (default: the kind)
   * with the payload under it.
   */
  trace(phase: DebugPhase, kind: string, data: unknown, show: boolean | string = true): void {
    if (this.#closed) return
    const at = Date.now()
    let entry = json({
      at: new Date(at).toISOString(),
      ms: at - this.#startedAt,
      phase,
      kind,
      data,
    })
    if (entry.length > MAX_ENTRY) {
      const head = json(data).slice(0, ENTRY_HEAD)
      entry = json({
        at: new Date(at).toISOString(),
        ms: at - this.#startedAt,
        phase,
        kind,
        data: { clipped: entry.length, head },
      })
    }
    this.#push(entry)
    if (this.verbosity < 2 || show === false) return
    const payload = redactJsonText(json(data) ?? '')
    this.#emit?.({
      at,
      level: 2,
      phase,
      text: redactSecrets(oneLine(typeof show === 'string' ? show : kind)),
      ...(typeof show === 'string' && data === undefined
        ? {}
        : {
            detail:
              payload.length > MAX_SCREEN
                ? `${payload.slice(0, MAX_SCREEN)}… (${payload.length - MAX_SCREEN} more)`
                : payload,
          }),
    })
  }

  /** A `-vv` line with its own detail text, e.g. a docker command and its output. */
  traceLine(phase: DebugPhase, kind: string, data: unknown, text: string, detail?: string): void {
    if (this.#closed) return
    this.trace(phase, kind, data, false)
    if (this.verbosity < 2) return
    this.#emit?.({
      at: Date.now(),
      level: 2,
      phase,
      text: redactSecrets(oneLine(text)),
      ...(detail ? { detail: redactSecrets(detail) } : {}),
    })
  }

  /**
   * One gateway request: a `gateway` line, a line of requests.ndjson, and its headers traced.
   * An `expected` one (a refused host the harness always tries) is a `-vv` line instead.
   */
  request(
    r: DebugRequest,
    headers?: { request?: unknown; response?: unknown },
    expected = false,
  ): void {
    if (this.#closed) return
    if (!this.#requests) {
      this.#requests = createWriteStream(join(this.dir, REQUESTS_FILE), { flags: 'a' })
      this.#requests.on('error', () => {})
    }
    this.#requests.write(`${redactJson(r)}\n`)
    if (expected) this.traceLine('gateway', 'request', r, requestLine(r))
    else this.log('gateway', requestLine(r))
    if (headers) this.trace('gateway', 'headers', { url: r.url, ...headers }, `headers ${r.url}`)
  }

  #push(entry: string) {
    this.#trace.push(entry)
    this.#bytes += entry.length + 1
    while (this.#bytes > this.#limit && this.#head < this.#trace.length - 1) {
      this.#bytes -= (this.#trace[this.#head]?.length ?? 0) + 1
      this.#trace[this.#head] = ''
      this.#head++
      this.#dropped++
    }
    if (this.#head > 1024 && this.#head * 2 > this.#trace.length) {
      this.#trace = this.#trace.slice(this.#head)
      this.#head = 0
    }
  }

  /** Closes debug.log and, when `keepTrace`, writes the buffer to trace.ndjson. */
  async finish(keepTrace: boolean): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const closing = [this.#log, this.#requests].map(
      (s) => new Promise<void>((resolve) => (s ? s.end(resolve) : resolve())),
    )
    if (keepTrace) {
      const head = json({
        kind: 'trace',
        startedAt: new Date(this.#startedAt).toISOString(),
        limitBytes: this.#limit,
        dropped: this.#dropped,
      })
      const body = this.#trace.slice(this.#head).join('\n')
      await writeFile(join(this.dir, TRACE_FILE), redactJsonText(`${head}\n${body}\n`)).catch(
        () => {},
      )
    }
    this.#trace = []
    await Promise.all(closing)
  }
}

const current = new AsyncLocalStorage<AttemptDebug>()

/** Runs `fn` with `debug` as the attempt's trace, so code anywhere under it can add to it. */
export const withDebug = <T>(debug: AttemptDebug, fn: () => T): T => current.run(debug, fn)

/** The running attempt's trace, if any. */
export const attemptDebug = (): AttemptDebug | undefined => current.getStore()

/** Adds a `-v` line to the running attempt's trace; a no-op outside one. */
export const debugLog = (phase: DebugPhase, text: string): void =>
  current.getStore()?.log(phase, text)

/** Adds a raw payload to the running attempt's trace; a no-op outside one. */
export const debugTrace = (
  phase: DebugPhase,
  kind: string,
  data: unknown,
  show?: string | false,
): void => current.getStore()?.trace(phase, kind, data, show ?? true)
