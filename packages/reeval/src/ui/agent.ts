// For coding agents running `reeval run`: they read every line back into context, so after the
// run header (the one every mode prints, without color) nothing prints while attempts run but
// what needs attention now (a sandbox that failed to prepare, a warning), and the run ends with
// the same status list as CI, without color or tree glyphs.
import { suiteResult } from '../view/suite.ts'
import { colors } from './colors.ts'
import type { OutputStream, ReevalEvent, Renderer } from './events.ts'
import { attemptAxes, debugLines, progressLine } from './format.ts'
import { noticeLines, planLines, prepareStepLines, startLine } from './header.ts'
import { listLines } from './list.ts'
import type { OutputOptions } from './mode.ts'
import { pointerLine, statusList } from './status.ts'
import { Tagger } from './tags.ts'

const MAX_LINES = 12
/** Agents read whole lines, so the header's notes don't wrap. */
const WIDTH = Number.POSITIVE_INFINITY

export type AgentRendererOptions = {
  out: OutputStream
  output: OutputOptions
  verbosity?: 0 | 1 | 2
}

export class AgentRenderer implements Renderer {
  readonly #o: AgentRendererOptions
  readonly #c = colors(false)
  /** `[key]` prefixes for `-v` lines, from each attempt's start. */
  readonly #labels = new Map<string, string>()
  readonly #tags = new Tagger()

  constructor(options: AgentRendererOptions) {
    this.#o = options
  }

  #write(text: string) {
    this.#o.out.write(`${text.trimEnd()}\n`)
  }

  onEvent(e: ReevalEvent): void {
    switch (e.type) {
      case 'plan':
        for (const line of planLines(this.#c, e, WIDTH)) this.#write(line)
        return
      case 'run-start':
        // No attempt's logs print here, whatever --output-logs says.
        this.#write(startLine(this.#c, { ...this.#o.output, outputLogs: 'none' }))
        return
      case 'collected':
        this.#tags.addFile(e.evals)
        return
      case 'eval-start': {
        const tag = this.#tags.label(e.id, e.attempt?.n ?? 1)
        this.#labels.set(e.key, `[${tag} ${attemptAxes(e.attempt, 'agent')}]`)
        return
      }
      case 'debug': {
        const label = this.#labels.get(e.key) ?? `[${e.key}]`
        for (const line of debugLines(this.#c, e.line, this.#o.verbosity === 2)) {
          this.#write(`${label} ${line}`)
        }
        return
      }
      case 'eval-progress': {
        if (e.progress.kind !== 'browser-download' && e.progress.kind !== 'warning') return
        const label = this.#labels.get(e.key) ?? `[${e.key}]`
        this.#write(`${label} ${progressLine(this.#c, e.progress)}`)
        return
      }
      case 'prepare':
        for (const line of prepareStepLines(this.#c, e, WIDTH, MAX_LINES)) this.#write(line)
        return
      case 'notice':
        for (const line of noticeLines(this.#c, e, WIDTH)) this.#write(line)
        return
      case 'run-end': {
        this.#write('')
        const verbose = (this.#o.verbosity ?? 0) > 0
        const list = statusList({
          record: e.record,
          suite: suiteResult(e.record),
          remarks: e.remarks ?? null,
          verbose,
          ...(e.notRun ? { notRun: e.notRun } : {}),
        })
        // An agent can't press → for the rest, and the snapshot and excerpt are what it acts on.
        const pointer = pointerLine(e.summaryPath)
        for (const line of listLines(list, this.#c, false, pointer, verbose, true)) {
          this.#write(line)
        }
        return
      }
      default:
        return
    }
  }

  close(): void {}
}
