// For coding agents running `es run`: they read every line back into context, so print only
// failures, each with where its detail lives, in a stable greppable vocabulary.
import { colors } from './colors.ts'
import type { EsEvent, EvalResult, OutputStream, Renderer } from './events.ts'
import { capLines, entryOutcome, failureLines, formatDuration, outcomeOf } from './format.ts'
import { resultFor } from './summary.ts'

const MAX_LINES = 12
const WORD = { fail: 'FAIL', infra_error: 'INFRA', cancelled: 'CANCELLED' } as const

export type AgentRendererOptions = {
  out: OutputStream
  attemptDir(id: string, attempt: number): string
}

export class AgentRenderer implements Renderer {
  readonly #o: AgentRendererOptions
  readonly #c = colors(false)
  readonly #logs = new Map<string, string[]>()
  readonly #printed = new Set<string>()

  constructor(options: AgentRendererOptions) {
    this.#o = options
  }

  #write(text: string) {
    this.#o.out.write(`${text.trimEnd()}\n`)
  }

  #failure(result: EvalResult, attempt: number) {
    const outcome = outcomeOf(result)
    if (outcome === 'pass' || outcome === 'skipped') return
    this.#printed.add(result.id)
    const kind = outcome === 'fail' ? (result.meta?.errorKind ?? 'assertion') : null
    const detail = [formatDuration(result.durationMs), kind].filter(Boolean).join(', ')
    this.#write(`${WORD[outcome]} ${result.id} (${detail})`)
    if (outcome !== 'cancelled') {
      for (const line of failureLines(this.#c, result, { max: MAX_LINES })) {
        this.#write(`  ${line}`)
      }
    }
    const logs = this.#logs.get(`${result.id}#${attempt}`)
    if (logs?.length) {
      this.#write('  console:')
      for (const line of capLines(logs.join('\n'), MAX_LINES)) this.#write(`    ${line}`)
    }
    this.#write(`  record: ${this.#o.attemptDir(result.id, attempt)}`)
  }

  onEvent(e: EsEvent): void {
    switch (e.type) {
      case 'run-start':
        this.#write(`es run: ${e.files} eval file${e.files === 1 ? '' : 's'}`)
        return
      case 'log': {
        if (!e.id) return
        const key = `${e.id}#${e.attempt ?? 1}`
        const logs = this.#logs.get(key) ?? []
        logs.push(...e.text.replace(/\n$/, '').split('\n'))
        this.#logs.set(key, logs)
        return
      }
      case 'eval-end':
        this.#failure(e.result, e.attempt)
        return
      case 'notice':
        if (e.level !== 'info') this.#write(e.text)
        return
      case 'run-end': {
        for (const entry of e.record.evals) {
          if (this.#printed.has(entry.id) || entryOutcome(entry) !== 'cancelled') continue
          this.#failure(resultFor(entry, e.results), entry.attempts[0]?.n ?? 1)
        }
        for (const error of e.unhandledErrors) this.#write(`ERROR ${error}`)
        const s = e.record.summary
        const cancelled = e.record.evals.filter((x) => entryOutcome(x) === 'cancelled').length
        const parts = [
          s.pass && `${s.pass} passed`,
          s.fail - cancelled > 0 && `${s.fail - cancelled} failed`,
          s.infraError && `${s.infraError} infra error`,
          cancelled && `${cancelled} cancelled`,
          s.skipped && `${s.skipped} skipped`,
        ].filter(Boolean)
        this.#write(parts.join(', ') || 'no evals ran')
        this.#write(`summary: ${e.summaryPath}`)
        return
      }
      default:
        return
    }
  }

  close(): void {}
}
