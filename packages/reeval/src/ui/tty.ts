// `reeval run` on an interactive terminal: the run header as in every mode, then a live list of
// the evals you can browse with the arrow keys, which stays up once the run ends until you quit
// it. Quitting leaves the whole list in the scrollback, as a pipe prints it. The list is drawn by
// `ink-list.ts`, imported only once there's an eval to list; if that import fails, the run prints
// as a pipe's does, so a broken install costs the list, never the result.
import stringWidth from 'string-width'
import { suiteResult } from '../view/suite.ts'
import type { Colors } from './colors.ts'
import type { OutputStream, ReevalEvent, Renderer } from './events.ts'
import { endText, startText } from './header.ts'
import { LiveList, listLines, SPINNER } from './list.ts'
import { PlainRenderer, type RendererOptions } from './plain.ts'
import { pointerLine, type StatusFile, type StatusList, statusList } from './status.ts'

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

/**
 * Before the list is up, the sandbox prepare step: the glyph of its `◆  Preparing…` line spins in
 * place (the cursor goes up to it and back) until each sandbox is ready or failed, then settles to
 * `◆`. What prints under it is kept and measured again at each frame, in display columns at the
 * terminal's current width, so a wide character or a resize (which terminals reflow) still finds
 * the step line; once it would be out of reach, it stops without drawing.
 */
export class StepSpinner {
  readonly #write: (text: string) => void
  readonly #c: Colors
  readonly #size: () => { rows: number; columns: number }
  #timer: NodeJS.Timeout | undefined
  #frame = 0
  /** The step line and everything printed under it since. */
  #text = ''
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

  /** Terminal lines from the step line down to the cursor after `text`, at the width now. */
  #up(text = this.#text): number {
    const columns = Math.max(1, this.#size().columns)
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines.reduce((n, l) => n + Math.max(1, Math.ceil(stringWidth(l) / columns)), 0)
  }

  /** The step line was just written as `text`; it spins until `targets` have reported. */
  start(text: string, targets: number) {
    this.settle()
    this.#text = text
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
    return this.#up(text) < this.#size().rows - 1
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
  /** What Ctrl-C, or q pressed twice, does while the run goes. */
  cancel?: () => void
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
          this.#spinner.before(String(text))
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
    const cancel = this.#o.cancel ?? (() => process.kill(process.pid, 'SIGINT'))
    const load = this.#o.load ?? (() => import('./ink-list.ts'))
    this.#app = load()
      .then((m) =>
        m.mountList({
          store: this.#store,
          colors: this.#c,
          cancel,
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
        const listOf = (verbose: boolean) =>
          statusList({
            record: e.record,
            suite: suiteResult(e.record),
            remarks: e.remarks ?? null,
            verbose,
            ...(e.notRun ? { notRun: e.notRun } : {}),
          })
        const list = listOf(false)
        const verbose = (this.#o.verbosity ?? 0) > 0
        if (!this.#app) {
          // Nothing was listed (every eval skipped), so there's nothing to browse.
          this.#plain.onEvent(e)
          return
        }
        this.#ended = {
          scrollback: verbose ? listOf(true) : list,
          verbose,
          pointer: pointerLine(e.summaryPath),
          event: e,
        }
        this.#store.set({
          files: list.files,
          ...(this.#store.get().phase ? { phase: endText(e.record.status) } : {}),
          finished: {
            done: list.done,
            notes: list.notes,
            pointer: pointerLine(e.summaryPath),
            errors: list.errors,
          },
        })
        return
      }
      default:
        this.#plain.onEvent(e)
    }
  }

  close(): void {
    this.#spinner.settle()
    this.#plain.close()
    this.#fallback?.close()
    // Without a run-end the run failed: take the list down so the error prints below it.
    if (!this.#store.get().finished) {
      this.#closed = true
      void this.#app?.then((a) => a?.unmount())
    }
  }

  /** Until the user quits the list, then the whole list into the scrollback; at once when there's none. */
  async wait(): Promise<void> {
    const app = await this.#app
    if (!app || !this.#ended) return
    await app.waitUntilExit()
    const { phase } = this.#store.get()
    const { scrollback, verbose, pointer } = this.#ended
    const head = phase ? [`  ${this.#c.teal('◆')}  ${phase}`, ''] : []
    const text = [...head, ...listLines(scrollback, this.#c, true, pointer, verbose)]
    this.#o.out.write(`${text.join('\n')}\n`)
  }
}

const sizeOf = (stdout: NodeJS.WriteStream | undefined) => {
  const { rows, columns } = (stdout ?? {}) as { rows?: number; columns?: number }
  return { rows: rows || 24, columns: columns || 80 }
}
