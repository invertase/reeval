// For coding agents running `reeval run`: they read every line back into context, so nothing
// prints while attempts run but what needs attention now (a sandbox that failed to prepare, a
// warning), and the run ends with the same result blocks as the terminal, without color.
import { sandboxWarningLine } from '../text.ts'
import { colors } from './colors.ts'
import type { OutputStream, ReevalEvent, Renderer } from './events.ts'
import { attemptAxes, debugLines, prepareLines, progressLine } from './format.ts'
import { resultLines } from './result.ts'
import { Tagger } from './tags.ts'

const MAX_LINES = 12

export type AgentRendererOptions = {
  out: OutputStream
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
        this.#write(e.line)
        for (const line of e.details) this.#write(line)
        for (const w of e.warnings) this.#write(`warning: ${w}`)
        for (const h of e.hints) this.#write(`hint: ${h}`)
        for (const w of e.sandboxWarnings ?? []) this.#write(sandboxWarningLine(w))
        return
      case 'run-start':
        this.#write(`reeval run: ${e.runId} · ${e.files} eval file${e.files === 1 ? '' : 's'}`)
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
        for (const line of prepareLines(this.#c, e, MAX_LINES)) this.#write(line)
        return
      case 'notice':
        if (e.level !== 'info') this.#write(e.text)
        return
      case 'run-end':
        this.#write('')
        for (const line of resultLines(this.#c, e, (this.#o.verbosity ?? 0) > 0)) {
          this.#write(line)
        }
        return
      default:
        return
    }
  }

  close(): void {}
}
