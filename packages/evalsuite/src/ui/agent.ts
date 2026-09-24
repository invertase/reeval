// For coding agents running `es run`: they read every line back into context, so print only
// failures, each with where its detail lives, in a stable greppable vocabulary.
import { colors } from './colors.ts'
import type { EsEvent, EvalResult, OutputStream, Renderer } from './events.ts'
import { capLines, failureLines, formatDuration, outcomeOf } from './format.ts'
import { type AttemptDir, failingAttempts, resultFor } from './summary.ts'

const MAX_LINES = 12
const WORD = { fail: 'FAIL', infra_error: 'INFRA', cancelled: 'CANCELLED' } as const

export type AgentRendererOptions = {
  out: OutputStream
  attemptDir: AttemptDir
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

  #failure(result: EvalResult, cell: string, n: number) {
    const outcome = outcomeOf(result)
    if (outcome === 'pass' || outcome === 'skipped') return
    this.#printed.add(result.key)
    const kind = outcome === 'fail' ? (result.meta?.errorKind ?? 'assertion') : null
    const detail = [formatDuration(result.durationMs), kind].filter(Boolean).join(', ')
    const which = result.attempt?.label ? ` [${result.attempt.label}]` : ''
    this.#write(`${WORD[outcome]} ${result.id}${which} (${detail})`)
    if (outcome !== 'cancelled') {
      for (const line of failureLines(this.#c, result, { max: MAX_LINES })) {
        this.#write(`  ${line}`)
      }
    }
    const logs = this.#logs.get(result.key)
    if (logs?.length) {
      this.#write('  console:')
      for (const line of capLines(logs.join('\n'), MAX_LINES)) this.#write(`    ${line}`)
    }
    this.#write(`  record: ${this.#o.attemptDir(result.id, cell, n)}`)
  }

  onEvent(e: EsEvent): void {
    switch (e.type) {
      case 'run-start':
        this.#write(`es run: ${e.files} eval file${e.files === 1 ? '' : 's'}`)
        return
      case 'log': {
        if (!e.key) return
        const logs = this.#logs.get(e.key) ?? []
        logs.push(...e.text.replace(/\n$/, '').split('\n'))
        this.#logs.set(e.key, logs)
        return
      }
      case 'eval-end': {
        const { attempt } = e.result
        this.#failure(e.result, attempt?.cell.key ?? '', attempt?.n ?? 1)
        return
      }
      case 'notice':
        if (e.level !== 'info') this.#write(e.text)
        return
      case 'run-end': {
        const failing = failingAttempts(e.record.evals)
        for (const { entry, attempt, outcome } of failing) {
          const result = resultFor(entry, attempt, e.results)
          if (outcome === 'cancelled' && !this.#printed.has(result.key)) {
            this.#failure(result, attempt.cell, attempt.n)
          }
        }
        for (const error of e.unhandledErrors) this.#write(`ERROR ${error}`)
        const s = e.record.summary
        const cancelled = failing.filter((f) => f.outcome === 'cancelled').length
        const parts = [
          s.pass && `${s.pass} passed`,
          s.fail - cancelled > 0 && `${s.fail - cancelled} failed`,
          s.infraError && `${s.infraError} infra error`,
          cancelled && `${cancelled} cancelled`,
          s.skipped && `${s.skipped} skipped`,
        ].filter(Boolean)
        const scope = s.attempts === s.evals ? '' : ` (${s.attempts} attempts, ${s.evals} evals)`
        this.#write(parts.length ? `${parts.join(', ')}${scope}` : 'no evals ran')
        this.#write(`summary: ${e.summaryPath}`)
        return
      }
      default:
        return
    }
  }

  close(): void {}
}
