// `reeval run` on an interactive terminal: the run header as in every mode, then a live list of
// the evals you can browse with the arrow keys, which stays up once the run ends until you quit
// it. Quitting leaves the whole list in the scrollback, as a pipe prints it. The list is drawn by
// `ink-list.ts`, imported only once there's an eval to list; if that import fails, the run prints
// as a pipe's does, so a broken install costs the list, never the result. Events update the list
// once per turn of the event loop, so a stream `reeval attach` replays from its start draws once.
import stringWidth from 'string-width'
import { redactSecrets } from '../redact.ts'
import { suiteResult } from '../view/suite.ts'
import type { Colors } from './colors.ts'
import type { OutputStream, ReevalEvent, Renderer } from './events.ts'
import { endText, startText } from './header.ts'
import { LiveList, listLines, SPINNER } from './list.ts'
import { PlainRenderer, type RendererOptions } from './plain.ts'
import { onHost, pointerLine, type StatusFile, type StatusList, statusList } from './status.ts'

export type ListState = {
  files: StatusFile[]
  /** Lines printed above the list while it's up: notices, sandbox preparation. */
  logs: string[]
  counts: { done: number; total: number; failed?: number; failing?: number }
  /**
   * The run header's last line's text, `Running...`, drawn above the list (spinning while the run
   * goes) so it can say how it ended.
   */
  phase: string | null
  /** Set once the run ends. */
  finished: {
    done: string
    notes: string[]
    pointer: string
    errors: string[]
  } | null
  /** Takes the finished list down as q does, with no key pressed. */
  quit?: true
  /** Following another process's run: whether x can cancel it now. */
  cancelable?: boolean
}

/** The list's state, which the Ink app reads with `useSyncExternalStore`. */
export class ListStore {
  #state: ListState = {
    files: [],
    logs: [],
    counts: { done: 0, total: 0 },
    phase: null,
    finished: null,
  }
  readonly #listeners = new Set<() => void>()

  get = (): ListState => this.#state

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  set(next: Partial<ListState>) {
    this.#state = { ...this.#state, ...next }
    for (const l of this.#listeners) l()
  }
}

const FRAME_MS = 80
const CANCELABLE_MS = 1000

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
/** A CSI sequence (colors, cursor moves) or an OSC one (a hyperlink), which take no columns. */
const ESCAPE = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\))`,
  'g',
)
const graphemes = new Intl.Segmenter()

/**
 * Terminal rows one line takes at `columns`, placed as a terminal places it: a wide character that
 * doesn't fit in the row's last column moves to the next row, `\r` returns to the row's start and
 * `\t` goes to the next stop of eight without wrapping.
 */
export function rowsOf(line: string, columns: number): number {
  let rows = 1
  let column = 0
  for (const { segment } of graphemes.segment(line.replace(ESCAPE, ''))) {
    if (segment === '\r') column = 0
    else if (segment === '\t') column = Math.min(columns - 1, (Math.floor(column / 8) + 1) * 8)
    else if (segment === '\b') column = Math.max(0, column - 1)
    else {
      const width = stringWidth(segment)
      if (!width) continue
      if (column + width > columns) {
        rows += 1
        column = 0
      }
      column += width
    }
  }
  return rows
}

/**
 * Before the list is up, the sandbox prepare step: the glyph of its `◆  Preparing…` line spins in
 * place (the cursor goes up to it and back) until each sandbox is ready or failed, then settles to
 * `◆`. What prints under it is kept and measured in rows as the terminal placed it, so a wide
 * character still finds the step line. Once the step line would be out of reach, or the width
 * changes (some terminals reflow what they show, some don't, so its row is unknown), it stops
 * without drawing.
 */
export class StepSpinner {
  readonly #write: (text: string) => void
  readonly #c: Colors
  readonly #size: () => { rows: number; columns: number }
  #timer: NodeJS.Timeout | undefined
  #frame = 0
  /** The step line and everything printed under it since. */
  #text = ''
  /** The width `#text` was printed at. */
  #columns = 0
  #pending = 0

  constructor(
    write: (text: string) => void,
    c: Colors,
    size: () => { rows: number; columns: number },
  ) {
    this.#write = write
    this.#c = c
    this.#size = size
  }

  /** Terminal lines from the step line down to the cursor after `text`. */
  #up(text = this.#text): number {
    const columns = Math.max(1, this.#columns)
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines.reduce((n, l) => n + rowsOf(l, columns), 0)
  }

  /** The step line was just written as `text`; it spins until `targets` have reported. */
  start(text: string, targets: number) {
    this.settle()
    this.#text = text
    this.#columns = this.#size().columns
    this.#pending = targets
    this.#timer = setInterval(() => this.#draw(), FRAME_MS)
    this.#timer.unref()
    this.#draw()
  }

  /** Before `text` prints under it; settles first if the step line would scroll out of reach. */
  before(text: string) {
    if (!this.#timer) return
    const next = this.#text + text
    if (!this.#reachable(next)) this.settle()
    this.#text = next
  }

  /** One sandbox reported; the last settles it. */
  reported() {
    this.#pending -= 1
    if (this.#pending <= 0) this.settle()
  }

  #reachable(text = this.#text): boolean {
    const { rows, columns } = this.#size()
    return columns === this.#columns && this.#up(text) < rows - 1
  }

  #draw(glyph = SPINNER[this.#frame++ % SPINNER.length] ?? '◆') {
    if (!this.#reachable()) {
      clearInterval(this.#timer)
      this.#timer = undefined
      return
    }
    const up = this.#up()
    this.#write(`\x1b[${up}A\r\x1b[2C${this.#c.teal(glyph)}\r\x1b[${up}B`)
  }

  settle() {
    if (!this.#timer) return
    this.#draw('◆')
    clearInterval(this.#timer)
    this.#timer = undefined
  }
}

export type InteractiveOptions = RendererOptions & {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  /**
   * What Ctrl-C, or q pressed twice, does while the run goes (x twice under `attached`, where it
   * returns false when the run could not be reached).
   */
  cancel?: () => boolean | undefined
  /**
   * The run is another process's, which `reeval attach` follows: q and Ctrl-C call `detach`, and
   * only `cancel` reaches the run, while `cancelable` (asked every `CANCELABLE_MS`) says it can.
   * `host` is the run's when it isn't this one's, and marks the paths the run prints as being there.
   */
  attached?: { detach: () => void; host?: string; cancelable?: () => boolean }
  /** Loads the Ink list; tests stand in a failing one. */
  load?: () => Promise<Pick<typeof import('./ink-list.ts'), 'mountList'>>
}

type Mounted = { waitUntilExit: () => Promise<unknown>; unmount: () => void }
type Ended = { scrollback: StatusList; verbose: boolean; pointer: string; event: ReevalEvent }

export class InteractiveRenderer implements Renderer {
  readonly #o: InteractiveOptions
  readonly #c: Colors
  readonly #store = new ListStore()
  readonly #list: LiveList
  /** The header and run-level lines, as every terminal prints them. */
  readonly #plain: PlainRenderer
  #app: Promise<Mounted | undefined> | undefined
  /** Set once the list couldn't load: from then on, the run prints as a pipe's does. */
  #fallback: PlainRenderer | undefined
  #ended: Ended | undefined
  #closed = false
  #detached = false
  #pending: NodeJS.Immediate | undefined
  #polling: NodeJS.Timeout | undefined
  readonly #spinner: StepSpinner
  /** What the plain renderer wrote since `#written` was reset, while the list isn't up. */
  #written = ''

  constructor(options: InteractiveOptions) {
    this.#o = options
    this.#c = options.colors
    this.#list = new LiveList(options.harness)
    this.#spinner = new StepSpinner(
      (text) => options.out.write(text),
      options.colors,
      () => sizeOf(options.stdout),
    )
    const out: OutputStream = {
      write: (text) => {
        if (!this.#app || this.#fallback) {
          // Measured as the terminal shows it, after the masking the stream below applies.
          this.#spinner.before(redactSecrets(String(text)))
          this.#written += String(text)
          return options.out.write(text)
        }
        const lines = String(text).replace(/\n$/, '').split('\n')
        this.#store.set({ logs: [...this.#store.get().logs, ...lines] })
        return true
      },
    }
    this.#plain = new PlainRenderer({
      ...options,
      out,
      timers: false,
      output: { ...options.output, statusLine: false, interactive: false, outputLogs: 'none' },
    })
  }

  #mount() {
    if (this.#app || this.#closed) return
    const { attached } = this.#o
    const cancel = attached
      ? this.#o.cancel
      : (this.#o.cancel ?? (() => process.kill(process.pid, 'SIGINT')))
    const load = this.#o.load ?? (() => import('./ink-list.ts'))
    const asked = attached?.cancelable
    if (asked) {
      const poll = () => {
        const cancelable = asked()
        if (cancelable !== this.#store.get().cancelable) this.#store.set({ cancelable })
      }
      poll()
      this.#polling = setInterval(poll, CANCELABLE_MS)
      this.#polling.unref()
    }
    this.#app = load()
      .then((m) =>
        m.mountList({
          store: this.#store,
          colors: this.#c,
          ...(cancel ? { cancel } : {}),
          ...(attached
            ? {
                detach: () => {
                  this.#detached = true
                  attached.detach()
                },
              }
            : {}),
          stdout: this.#o.stdout,
          stdin: this.#o.stdin,
        }),
      )
      .catch((error: unknown) => {
        this.#fallBack(error)
        return undefined
      })
  }

  #fallBack(error: unknown) {
    const out = this.#o.out
    const { logs, phase } = this.#store.get()
    for (const line of logs) out.write(`${line}\n`)
    const reason = error instanceof Error ? error.message : String(error)
    out.write(`${this.#c.yellow(`Couldn't draw the interactive list (${reason}).`)}\n`)
    if (phase) out.write(`  ${this.#c.teal('◆')}  ${phase}\n`)
    this.#fallback = new PlainRenderer({
      ...this.#o,
      timers: false,
      output: { ...this.#o.output, statusLine: false, interactive: false },
    })
    if (this.#ended) this.#fallback.onEvent(this.#ended.event)
  }

  #update() {
    this.#pending ??= setImmediate(() => this.#flush())
  }

  #flush() {
    if (this.#pending) clearImmediate(this.#pending)
    this.#pending = undefined
    const { done, total, failed, failing } = this.#list.counts()
    this.#store.set({ files: this.#list.files(), counts: { done, total, failed, failing } })
  }

  onEvent(e: ReevalEvent): void {
    if (this.#fallback) {
      if (e.type !== 'run-start') this.#fallback.onEvent(e)
      return
    }
    switch (e.type) {
      case 'run-start':
        this.#spinner.settle()
        this.#store.set({ phase: startText(this.#o.output) })
        return
      case 'prepare':
        this.#written = ''
        this.#plain.onEvent(e)
        // REEVAL_DEBUG writes the image builds to stderr, past what the spinner counts, so its
        // step line would be lost; the step keeps its still ◆.
        if (this.#app || this.#o.timers === false || process.env.REEVAL_DEBUG) return
        if (e.state === 'start') this.#spinner.start(this.#written, e.targets.length)
        else this.#spinner.reported()
        return
      case 'plan': {
        this.#list.planned(e.header.evals)
        const { record } = e.header
        const host = this.#o.attached?.host
        this.#plain.onEvent(
          record && host ? { ...e, header: { ...e.header, record: onHost(record, host) } } : e,
        )
        return
      }
      case 'collected':
        this.#spinner.settle()
        this.#list.collected(e.file, e.evals)
        this.#mount()
        this.#update()
        return
      case 'eval-start':
        this.#list.start(e)
        this.#update()
        return
      case 'eval-progress':
        if (e.progress.kind === 'warning' || e.progress.kind === 'browser-download') {
          this.#plain.onEvent(e)
        }
        this.#list.progress(e.key, e.progress)
        this.#update()
        return
      case 'eval-end':
        this.#list.end(e.result)
        this.#update()
        return
      case 'debug':
        return
      case 'run-end': {
        const host = this.#o.attached?.host
        const listOf = (verbose: boolean) =>
          statusList({
            record: e.record,
            suite: suiteResult(e.record),
            remarks: e.remarks ?? null,
            verbose,
            ...(e.notRun ? { notRun: e.notRun } : {}),
            ...(host ? { host } : {}),
          })
        const list = listOf(false)
        const verbose = (this.#o.verbosity ?? 0) > 0
        if (!this.#app) {
          // Nothing was listed (every eval skipped), so there's nothing to browse.
          this.#plain.onEvent(e)
          return
        }
        this.#flush()
        this.#stopPolling()
        const pointer = pointerLine(e.summaryPath, host)
        this.#ended = { scrollback: verbose ? listOf(true) : list, verbose, pointer, event: e }
        this.#store.set({
          files: list.files,
          ...(this.#store.get().phase ? { phase: endText(e.record.status) } : {}),
          finished: {
            done: list.done,
            notes: list.notes,
            pointer,
            errors: list.errors,
          },
        })
        return
      }
      default:
        this.#plain.onEvent(e)
    }
  }

  #stopPolling() {
    clearInterval(this.#polling)
    this.#polling = undefined
  }

  close(): void {
    this.#stopPolling()
    if (this.#pending) this.#flush()
    this.#spinner.settle()
    this.#plain.close()
    this.#fallback?.close()
    // Without a run-end the run failed: take the list down so the error prints below it. A
    // detached list takes itself down.
    if (!this.#store.get().finished && !this.#detached) {
      this.#closed = true
      void this.#app?.then((a) => a?.unmount())
    }
  }

  /**
   * Until the user quits the list, then the whole list into the scrollback; at once when there's
   * none. Detached from a run that goes on, until the list is down, with nothing printed.
   */
  async wait(): Promise<void> {
    const app = await this.#app
    if (!app || !(this.#ended || this.#detached)) return
    await app.waitUntilExit()
    if (!this.#ended) return
    const { phase } = this.#store.get()
    const { scrollback, verbose, pointer } = this.#ended
    const head = phase ? [`  ${this.#c.teal('◆')}  ${phase}`, ''] : []
    const text = [...head, ...listLines(scrollback, this.#c, true, pointer, verbose)]
    this.#o.out.write(`${text.join('\n')}\n`)
  }

  /** Takes a finished list down without a key, then prints it as `wait` does. */
  async dismiss(): Promise<void> {
    if (this.#ended) this.#store.set({ quit: true })
    await this.wait()
  }
}

const sizeOf = (stdout: NodeJS.WriteStream | undefined) => {
  const { rows, columns } = (stdout ?? {}) as { rows?: number; columns?: number }
  return { rows: rows || 24, columns: columns || 80 }
}
