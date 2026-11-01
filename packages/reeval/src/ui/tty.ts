// `reeval run` on an interactive terminal: the run header as in every mode, then a live list of
// the evals you can browse with the arrow keys, which stays up once the run ends until you quit
// it. Quitting leaves the whole list in the scrollback, as a pipe prints it. The list is drawn by
// `ink-list.ts`, imported only once there's an eval to list; if that import fails, the run prints
// as a pipe's does, so a broken install costs the list, never the result.
import { suiteResult } from '../view/suite.ts'
import type { Colors } from './colors.ts'
import type { OutputStream, ReevalEvent, Renderer } from './events.ts'
import { endLine, startLine } from './header.ts'
import { LiveList, listLines } from './list.ts'
import { PlainRenderer, type RendererOptions } from './plain.ts'
import { pointerLine, type StatusFile, type StatusList, statusList } from './status.ts'

export type ListState = {
  files: StatusFile[]
  /** Lines printed above the list while it's up: notices, sandbox preparation. */
  logs: string[]
  counts: { done: number; total: number }
  /** The run header's last line, `◆  Running...`, drawn above the list so it can say how it ended. */
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

export type InteractiveOptions = RendererOptions & {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  /** What Ctrl-C, or q pressed twice, does while the run goes. */
  cancel?: () => void
  /** Loads the Ink list; tests stand in a failing one. */
  load?: () => Promise<Pick<typeof import('./ink-list.ts'), 'mountList'>>
}

type Mounted = { waitUntilExit: () => Promise<unknown>; unmount: () => void }
type Ended = { list: StatusList; pointer: string; event: ReevalEvent }

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

  constructor(options: InteractiveOptions) {
    this.#o = options
    this.#c = options.colors
    this.#list = new LiveList(options.harness)
    const out: OutputStream = {
      write: (text) => {
        if (!this.#app || this.#fallback) return options.out.write(text)
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
    if (phase) out.write(`${phase}\n`)
    this.#fallback = new PlainRenderer({
      ...this.#o,
      timers: false,
      output: { ...this.#o.output, statusLine: false, interactive: false },
    })
    if (this.#ended) this.#fallback.onEvent(this.#ended.event)
  }

  #update() {
    const { done, total } = this.#list.counts()
    this.#store.set({ files: this.#list.files(), counts: { done, total } })
  }

  onEvent(e: ReevalEvent): void {
    if (this.#fallback) {
      if (e.type !== 'run-start') this.#fallback.onEvent(e)
      return
    }
    switch (e.type) {
      case 'run-start':
        this.#store.set({ phase: startLine(this.#c, this.#o.output) })
        return
      case 'collected':
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
        const list = statusList({
          record: e.record,
          suite: suiteResult(e.record),
          remarks: e.remarks ?? null,
          verbose: false,
          ...(e.notRun ? { notRun: e.notRun } : {}),
        })
        if (!this.#app) {
          // Nothing was listed (every eval skipped), so there's nothing to browse.
          this.#plain.onEvent(e)
          return
        }
        this.#ended = { list, pointer: pointerLine(e.summaryPath), event: e }
        this.#store.set({
          files: list.files,
          ...(this.#store.get().phase ? { phase: endLine(this.#c, e.record.status) } : {}),
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
    const { list, pointer } = this.#ended
    const text = [...(phase ? [phase, ''] : []), ...listLines(list, this.#c, true, pointer)]
    this.#o.out.write(`${text.join('\n')}\n`)
  }
}
