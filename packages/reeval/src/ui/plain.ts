// The terminal's output while a run goes: attempt logs in Turborepo's stream and grouped log
// orders, and on a TTY (`live`) one status line under them that's rewritten in place. No line
// says how an attempt ended; the result blocks at the end do. Elsewhere it's append-only, for CI,
// pipes and `| tee`.
import { sandboxWarningLine } from '../text.ts'
import type { SandboxWarning } from '../types.ts'
import { type Colors, colors, stripAnsi } from './colors.ts'
import type {
  AttemptRef,
  EvalResult,
  OutputStream,
  Progress,
  ReevalEvent,
  Renderer,
} from './events.ts'
import {
  attemptAxes,
  debugLines,
  errorCheck,
  failureLines,
  formatDuration,
  offset,
  outcomeOf,
  phaseOf,
  prepareLines,
  progressLine,
} from './format.ts'
import type { OutputOptions } from './mode.ts'
import { resultLines } from './result.ts'
import { Tagger } from './tags.ts'

export type RendererOptions = {
  out: OutputStream
  colors: Colors
  output: OutputOptions
  /** The harness name in prefixes when an attempt doesn't say, e.g. `cursor`. */
  harness: string
  now?: () => number
  /** Off in tests, which call `tick()` themselves. */
  timers?: boolean
  /** `-v` (1) or `-vv` (2); `-vv` shows debug lines' times to the millisecond. */
  verbosity?: 0 | 1 | 2
}

/** `debug` lines carry their own timestamp instead of an offset. */
type Line = { at: number; text: string; kind?: Progress['kind']; debug?: boolean }

/** In a grouped block, an end line replaces its start line and keeps its start time. */
const STARTS: Partial<Record<Progress['kind'], Progress['kind']>> = {
  'sandbox-ready': 'sandbox',
  'turn-end': 'turn-start',
  'check-end': 'check-start',
  'judge-end': 'judge-start',
  'browser-download': 'browser-download',
}

type Attempt = {
  key: string
  id: string
  /** `[greet#1 cursor]` without color. */
  label: string
  startedAt: number
  lines: Line[]
  last: ReevalEvent | undefined
  /** In an ungated cell, whose misses don't fail the run, so they aren't painted red. */
  ungated: boolean
}

const ERROR_LINES = 12
/** Back to the start of the line and clear it, for the live status line. */
const CLEAR = '\r\x1b[2K'

/** GitHub Actions workflow-command escaping. */
const ghEscape = (s: string, property = false) => {
  const out = s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  return property ? out.replace(/:/g, '%3A').replace(/,/g, '%2C') : out
}

/** The eval file's line in Vitest's formatted error (`❯ evals/a.eval.ts:7:33`), if any. */
function locate(result: EvalResult): { line: string; col: string } | undefined {
  const text = stripAnsi(result.formattedErrors[0] ?? '')
  const file = result.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`❯ ${file}:(\\d+):(\\d+)`).exec(text)
  return match?.[1] && match[2] ? { line: match[1], col: match[2] } : undefined
}

/** `evals/a.eval.ts:7` as its file and line. */
const splitAt = (at: string): [string, string] => {
  const i = at.lastIndexOf(':')
  return [at.slice(0, i), at.slice(i + 1)]
}

export class PlainRenderer implements Renderer {
  readonly #o: RendererOptions
  readonly #c: Colors
  readonly #tags = new Tagger()
  readonly #running = new Map<string, Attempt>()
  readonly #now: () => number
  #queued = new Set<string>()
  #runStartedAt = 0
  #lastWrite = 0
  #timer: NodeJS.Timeout | undefined
  /** On a TTY: the status line is drawn under everything else, and redrawn after each write. */
  readonly #live: boolean
  #status = ''
  /** Evals and tries collected (not skipped), and the tries that ended. */
  readonly #evals = new Set<string>()
  readonly #tries = new Set<string>()
  readonly #ended = new Set<string>()

  constructor(options: RendererOptions) {
    this.#o = options
    this.#c = options.colors
    this.#now = options.now ?? Date.now
    this.#live = options.output.statusLine
    const { heartbeatMs } = options.output
    if (options.timers !== false && heartbeatMs > 0) {
      this.#timer = setInterval(() => this.tick(), Math.min(heartbeatMs, 5000))
      this.#timer.unref()
    }
  }

  #write(text: string) {
    const line = `${text.trimEnd()}\n`
    this.#o.out.write(this.#status ? `${CLEAR}${line}${this.#status}` : line)
    this.#lastWrite = this.#now()
  }

  /** `7 evals · 12/28 tries`: what's collected so far and how many tries ended. */
  #drawStatus() {
    if (!this.#live || !this.#tries.size) return
    const evals = `${this.#evals.size} eval${this.#evals.size === 1 ? '' : 's'}`
    const status = this.#c.dim(`${evals} · ${this.#ended.size}/${this.#tries.size} tries`)
    if (status === this.#status) return
    this.#o.out.write(`${CLEAR}${status}`)
    this.#status = status
  }

  #clearStatus() {
    if (!this.#status) return
    this.#o.out.write(CLEAR)
    this.#status = ''
  }

  #attempt(ref: AttemptRef, startedAt: number): Attempt {
    const n = ref.attempt?.n ?? 1
    const label = `[${this.#tags.label(ref.id, n)} ${attemptAxes(ref.attempt, this.#o.harness)}]`
    const ungated = ref.attempt?.gate === 'none'
    return { key: ref.key, id: ref.id, label, startedAt, lines: [], last: undefined, ungated }
  }

  #prefix(a: Pick<Attempt, 'label'>) {
    return this.#c.tag(a.label)(a.label)
  }

  #detail(a: Attempt, line: Line, prefixed: boolean) {
    const body = line.debug
      ? `  ${line.text}`
      : `  ${this.#c.dim(offset(line.at - a.startedAt))} ${line.text}`
    return prefixed ? `${this.#prefix(a)}${body}` : body.slice(1)
  }

  get #streaming() {
    return this.#o.output.logOrder === 'stream' && this.#o.output.outputLogs === 'full'
  }

  #add(a: Attempt, line: Line) {
    a.lines.push(line)
    if (this.#streaming) this.#write(this.#detail(a, line, true))
  }

  onEvent(e: ReevalEvent): void {
    const c = this.#c
    switch (e.type) {
      case 'run-start': {
        this.#runStartedAt = e.at
        const files = `${e.files} eval file${e.files === 1 ? '' : 's'}`
        const order = `${this.#o.output.logOrder} logs`
        const setup = `harness ${e.harness} · sandbox ${e.sandbox} · concurrency ${e.concurrency}`
        this.#write(c.dim(`reeval ${e.version} · run ${e.runId} · ${files} · ${setup} · ${order}`))
        return
      }
      case 'plan':
        for (const [i, line] of e.lines.entries()) {
          this.#write(line.startsWith('warning:') ? c.yellow(line) : i === 0 ? line : c.dim(line))
        }
        for (const w of e.sandboxWarnings ?? []) this.#sandboxWarning(w)
        return
      case 'collected':
        this.#tags.addFile(e.evals)
        for (const x of e.evals) {
          if (x.skipped) continue
          this.#queued.add(x.key)
          this.#evals.add(x.id)
          this.#tries.add(x.key)
        }
        this.#drawStatus()
        return
      case 'eval-start': {
        const a = this.#attempt(e, e.at)
        a.last = e
        this.#queued.delete(e.key)
        this.#running.set(e.key, a)
        if (this.#streaming) this.#write(`${this.#prefix(a)} ${c.dim('▶')} ${e.id}`)
        return
      }
      case 'eval-progress': {
        const a = this.#running.get(e.key)
        if (!a) return
        a.last = e
        const { progress } = e
        const paint = a.ungated ? { ...c, red: c.dim } : c
        const line: Line = {
          at: progress.at,
          text: progressLine(paint, progress),
          kind: progress.kind,
        }
        const start = STARTS[progress.kind]
        const open = start && a.lines.findLastIndex((l) => l.kind === start)
        if (!this.#streaming && open !== undefined && open >= 0) {
          line.at = a.lines[open]?.at ?? line.at
          a.lines.splice(open, 1)
        }
        this.#add(a, line)
        return
      }
      case 'debug': {
        const a = this.#running.get(e.key)
        if (!a) return
        for (const text of debugLines(c, e.line, this.#o.verbosity === 2)) {
          this.#add(a, { at: e.line.at, text, debug: true })
        }
        return
      }
      case 'log': {
        const a = e.key ? this.#running.get(e.key) : undefined
        const label = e.stream === 'stderr' ? c.yellow('stderr |') : c.dim('stdout |')
        for (const text of e.text.replace(/\n$/, '').split('\n')) {
          if (a) this.#add(a, { at: e.at, text: `${label} ${text}` })
          else this.#write(`${label} ${text}`)
        }
        return
      }
      case 'eval-end':
        this.#end(e.result, e.at)
        if (this.#tries.has(e.result.key)) this.#ended.add(e.result.key)
        this.#drawStatus()
        return
      case 'prepare': {
        for (const line of prepareLines(c, e, ERROR_LINES)) this.#write(line)
        if (e.state === 'failed' && this.#o.output.githubActions) {
          const { target, failure } = e.outcome as Extract<typeof e.outcome, { ok: false }>
          const what = target.kind === 'workspace' ? 'The' : 'Sandbox'
          const title = ghEscape(`${what} ${target.label} failed to prepare`, true)
          this.#write(`::error title=${title}::${ghEscape(failure.message)}`)
        }
        return
      }
      case 'notice': {
        const paint = { info: c.dim, warn: c.yellow, error: c.red }[e.level]
        this.#write(paint(e.text))
        return
      }
      case 'run-end':
        this.#clearStatus()
        this.#write('')
        for (const line of resultLines(c, e, (this.#o.verbosity ?? 0) > 0)) this.#write(line)
        return
    }
  }

  #sandboxWarning(w: SandboxWarning) {
    const c = this.#c
    const line = sandboxWarningLine(w)
    this.#write(w.kind === 'root' ? c.bold(c.red(line)) : c.yellow(line))
    if (!this.#o.output.githubActions) return
    const file = w.file ? `file=${ghEscape(w.file, true)},` : ''
    const title = w.kind === 'root' ? 'Sandbox runs as root' : 'Sandbox has extra capabilities'
    this.#write(`::warning ${file}title=${ghEscape(title, true)}::${ghEscape(w.message)}`)
  }

  /**
   * An ended attempt's logs, as `--output-logs` picks: grouped, its block under a `▶` header;
   * streamed, only its error lines, since the rest already printed. A sandbox that failed to
   * prepare was annotated once, for all its attempts.
   */
  #end(result: EvalResult, at: number) {
    const c = this.#c
    const a = this.#running.get(result.key) ?? this.#attempt(result, at - result.durationMs)
    this.#running.delete(result.key)
    this.#queued.delete(result.key)
    const outcome = outcomeOf(result)
    const failed = outcome !== 'pass' && outcome !== 'skipped'
    const ungated = failed && result.attempt?.gate === 'none'
    const missed = ungated && outcome === 'fail'
    const { outputLogs, githubActions, logPrefix } = this.#o.output

    const showDetail =
      !this.#streaming &&
      a.lines.length > 0 &&
      (outputLogs === 'full' || (outputLogs === 'errors-only' && failed))
    // A judge failure's verdict line is already in the detail.
    const judged = result.meta?.errorKind === 'judge' && (showDetail || this.#streaming)
    const errors =
      failed && outputLogs !== 'none' && !judged
        ? missed
          ? failureLines(colors(false), result, { max: 1 })
              .filter((l) => l.trim())
              .slice(0, 1)
              .map((l) => c.dim(l))
          : failureLines(c, result, { max: ERROR_LINES })
        : []
    const lines = a.lines.filter((l) => l.kind !== 'cleanup').sort((x, y) => x.at - y.at)
    const prefixed = logPrefix === 'task'

    // Like Turborepo on GitHub Actions: passing attempts collapse into a group, failing ones
    // stay expanded.
    const head = `${this.#prefix(a)} ${c.dim('▶')} ${result.id}`
    const group = githubActions && showDetail && (!failed || missed)
    if (showDetail || (!this.#streaming && errors.length)) {
      this.#write(group ? `::group::${stripAnsi(head)}` : head)
    }
    if (showDetail) for (const line of lines) this.#write(this.#detail(a, line, prefixed))
    for (const line of errors) this.#write(prefixed ? `${this.#prefix(a)}  ${line}` : ` ${line}`)
    if (group) this.#write('::endgroup::')
    if (githubActions && failed && !ungated && !result.meta?.prepare) {
      const which = result.attempt?.label ? ` [${result.attempt.label}]` : ''
      const title = ghEscape(`${result.id}${which}`, true)
      const checks = (result.meta?.failedChecks ?? []).filter((x) => x.at)
      // An `expect` failure doesn't end the body: each failed check is annotated on its own line.
      for (const x of checks) {
        const [file, line] = splitAt(x.at as string)
        const label = ghEscape(`${result.id}${which}: ${x.label}`, true)
        this.#write(
          `::error file=${ghEscape(file, true)},line=${line},title=${label}::${ghEscape(x.message)}`,
        )
      }
      // The attempt's own error, unless it's one of those checks.
      const shown = errorCheck(result)
      if (!shown?.at) {
        const message = ghEscape(
          failureLines(colors(false), result, { max: ERROR_LINES }).join('\n'),
        )
        const at = locate(result)
        const where = at ? `,line=${at.line},col=${at.col}` : ''
        this.#write(
          `::error file=${ghEscape(result.file, true)}${where},title=${title}::${message}`,
        )
      }
    }
  }

  /** Prints the heartbeat if nothing was written for `heartbeatMs` and evals are running. */
  tick(now = this.#now()): void {
    const { heartbeatMs } = this.#o.output
    // On a TTY the status line already says the run is alive.
    if (this.#live || heartbeatMs <= 0) return
    if (now - this.#lastWrite < heartbeatMs) return
    const c = this.#c
    if (this.#running.size === 0) return
    const running = [...this.#running.values()].map((a) => {
      const progress = a.last?.type === 'eval-progress' ? a.last.progress : undefined
      return `${this.#prefix(a)} ${phaseOf(progress)} ${c.dim(formatDuration(now - a.startedAt))}`
    })
    const queued = this.#queued.size ? `, ${this.#queued.size} queued` : ''
    const elapsed = formatDuration(now - this.#runStartedAt)
    this.#write(
      `${c.dim(`… ${this.#running.size} running${queued} after ${elapsed}:`)} ${running.join(c.dim(', '))}`,
    )
  }

  close(): void {
    clearInterval(this.#timer)
    this.#clearStatus()
  }
}
