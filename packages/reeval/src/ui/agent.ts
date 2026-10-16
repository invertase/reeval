// For coding agents running `reeval run`: they read every line back into context, so print only
// failures (and, as MISS, ungated cells' expected misses), each with where its detail lives, in
// a stable greppable vocabulary.
import { sampleReasons } from '../compare/pairs.ts'
import { answersLabel, undiscriminating, undiscriminatingLabel } from '../history/summary.ts'
import { sandboxWarningLine } from '../text.ts'
import { familyHeadLabel, familyLiftLabel, familyRateLabel } from '../view/family.ts'
import { colors } from './colors.ts'
import type { EsEvent, EvalResult, OutputStream, Renderer } from './events.ts'
import {
  attemptAxes,
  capLines,
  debugLines,
  failureLines,
  formatDuration,
  outcomeOf,
  prepareLines,
  progressLine,
} from './format.ts'
import { type AttemptDir, failingAttempts, resultFor } from './summary.ts'
import { Tagger } from './tags.ts'

const MAX_LINES = 12
const WORD = { fail: 'FAIL', infra_error: 'INFRA', cancelled: 'CANCELLED' } as const

export type AgentRendererOptions = {
  out: OutputStream
  attemptDir: AttemptDir
  verbosity?: 0 | 1 | 2
}

export class AgentRenderer implements Renderer {
  readonly #o: AgentRendererOptions
  readonly #c = colors(false)
  readonly #logs = new Map<string, string[]>()
  readonly #printed = new Set<string>()
  /** `[key]` prefixes for `-v` lines, from each attempt's start. */
  readonly #labels = new Map<string, string>()
  readonly #tags = new Tagger()

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
    const detail = [
      formatDuration(result.durationMs),
      kind,
      result.attempt?.gate === 'none' ? 'not gated' : '',
    ]
      .filter(Boolean)
      .join(', ')
    const which = result.attempt?.label ? ` [${result.attempt.label}]` : ''
    // An ungated cell's miss (a compare's control, by default) doesn't fail the run: one line of why.
    const missed = outcome === 'fail' && result.attempt?.gate === 'none'
    this.#write(`${missed ? 'MISS' : WORD[outcome]} ${result.id}${which} (${detail})`)
    if (outcome !== 'cancelled') {
      const lines = failureLines(this.#c, result, { max: MAX_LINES })
      for (const line of missed ? lines.filter((l) => l.trim()).slice(0, 1) : lines) {
        this.#write(`  ${line}`)
      }
    }
    const logs = missed ? undefined : this.#logs.get(result.key)
    if (logs?.length) {
      this.#write('  console:')
      for (const line of capLines(logs.join('\n'), MAX_LINES)) this.#write(`    ${line}`)
    }
    // Its sandbox never started, so there's no attempt directory to point at.
    if (!result.meta?.prepare) this.#write(`  record: ${this.#o.attemptDir(result.id, cell, n)}`)
  }

  onEvent(e: EsEvent): void {
    switch (e.type) {
      case 'plan':
        for (const line of e.lines) this.#write(line)
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
      case 'log': {
        if (!e.key) return
        const logs = this.#logs.get(e.key) ?? []
        logs.push(...e.text.replace(/\n$/, '').split('\n'))
        this.#logs.set(e.key, logs)
        return
      }
      case 'eval-progress': {
        if (e.progress.kind !== 'browser-download') return
        const label = this.#labels.get(e.key) ?? `[${e.key}]`
        this.#write(`${label} ${progressLine(this.#c, e.progress)}`)
        return
      }
      case 'eval-end': {
        const { attempt } = e.result
        this.#failure(e.result, attempt?.cell.key ?? '', attempt?.n ?? 1)
        return
      }
      case 'prepare':
        for (const line of prepareLines(this.#c, e, MAX_LINES)) this.#write(line)
        return
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
        for (const entry of e.record.evals) {
          for (const a of entry.answers ?? []) {
            this.#write(`question ${entry.id}: ${answersLabel(a)}`)
            for (const reason of sampleReasons(a.votes)) this.#write(`  ${reason}`)
          }
        }
        for (const x of undiscriminating(e.record.evals)) {
          this.#write(`check doesn't discriminate: ${undiscriminatingLabel(x)}`)
        }
        for (const family of e.record.families ?? []) {
          const pooled = family.lifts.length
            ? family.lifts.map((l) => {
                const gate =
                  l.minLift === undefined
                    ? ''
                    : ` (minLift ${Math.round(l.minLift * 100)}${l.outcome === 'fail' ? ', FAIL' : ''})`
                return `${l.variant} ${familyLiftLabel(l)}${gate}`
              })
            : family.rates.map((r) => `${r.cell} ${familyRateLabel(r)}`)
          this.#write(`family ${family.id}: ${familyHeadLabel(family)} · ${pooled.join(' · ')}`)
        }
        const s = e.record.summary
        const cancelled = failing.filter((f) => f.outcome === 'cancelled').length
        const parts = [
          s.pass && `${s.pass} passed`,
          s.fail - s.notGated - cancelled > 0 && `${s.fail - s.notGated - cancelled} failed`,
          s.notGated > 0 && `${s.notGated} missed, not gated`,
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
