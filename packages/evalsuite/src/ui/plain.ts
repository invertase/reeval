// Append-only output for CI, pipes and `| tee`. Lines are never rewritten. Modelled on
// Turborepo's stream and grouped log orders.
import { type Colors, colors, stripAnsi } from './colors.ts'
import type { EsEvent, EvalResult, OutputStream, Progress, Renderer } from './events.ts'
import {
  failureLines,
  formatDuration,
  mark,
  offset,
  outcomeOf,
  phaseOf,
  progressLine,
} from './format.ts'
import type { OutputOptions } from './mode.ts'
import { renderSummary } from './summary.ts'
import { Tagger } from './tags.ts'

export type RendererOptions = {
  out: OutputStream
  colors: Colors
  output: OutputOptions
  /** The harness name in each prefix, e.g. `cursor`. */
  harness: string
  /** Where an attempt's artifacts will be, relative to the working directory. */
  attemptDir(id: string, attempt: number): string
  now?: () => number
  /** Off in tests, which call `tick()` themselves. */
  timers?: boolean
}

type Line = { at: number; text: string; kind?: Progress['kind'] }

/** In a grouped block, an end line replaces its start line and keeps its start time. */
const STARTS: Partial<Record<Progress['kind'], Progress['kind']>> = {
  'sandbox-ready': 'sandbox',
  'turn-end': 'turn-start',
  'check-end': 'check-start',
  'judge-end': 'judge-start',
}

type Attempt = {
  key: string
  id: string
  label: string
  startedAt: number
  lines: Line[]
  last: EsEvent | undefined
}

const ERROR_LINES = 12

/** GitHub Actions workflow-command escaping. */
const ghEscape = (s: string, property = false) => {
  const out = s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  return property ? out.replace(/:/g, '%3A').replace(/,/g, '%2C') : out
}

/** The eval file's line in Vitest's formatted error (`❯ evals/a.es.ts:7:33`), if any. */
function locate(result: EvalResult): { line: string; col: string } | undefined {
  const text = stripAnsi(result.formattedErrors[0] ?? '')
  const file = result.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`❯ ${file}:(\\d+):(\\d+)`).exec(text)
  return match?.[1] && match[2] ? { line: match[1], col: match[2] } : undefined
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

  constructor(options: RendererOptions) {
    this.#o = options
    this.#c = options.colors
    this.#now = options.now ?? Date.now
    const { heartbeatMs } = options.output
    if (options.timers !== false && heartbeatMs > 0) {
      this.#timer = setInterval(() => this.tick(), Math.min(heartbeatMs, 5000))
      this.#timer.unref()
    }
  }

  #write(text: string) {
    this.#o.out.write(`${text.trimEnd()}\n`)
    this.#lastWrite = this.#now()
  }

  #prefix(a: Pick<Attempt, 'label'>) {
    return this.#c.tag(a.label)(`[${a.label} ${this.#o.harness}]`)
  }

  #detail(a: Attempt, line: Line, prefixed: boolean) {
    const body = `  ${this.#c.dim(offset(line.at - a.startedAt))} ${line.text}`
    return prefixed ? `${this.#prefix(a)}${body}` : body.slice(1)
  }

  get #streaming() {
    return this.#o.output.logOrder === 'stream' && this.#o.output.outputLogs === 'full'
  }

  #add(a: Attempt, line: Line) {
    a.lines.push(line)
    if (this.#streaming) this.#write(this.#detail(a, line, true))
  }

  onEvent(e: EsEvent): void {
    const c = this.#c
    switch (e.type) {
      case 'run-start': {
        this.#runStartedAt = e.at
        const files = `${e.files} eval file${e.files === 1 ? '' : 's'}`
        const order = `${this.#o.output.logOrder} logs`
        const setup = `harness ${e.harness} · sandbox ${e.sandbox}`
        this.#write(c.dim(`es ${e.version} · ${files} · ${setup} · ${order}`))
        return
      }
      case 'collected':
        this.#tags.addFile(e.evals)
        for (const x of e.evals) if (!x.skipped) this.#queued.add(x.id)
        return
      case 'eval-start': {
        const label = this.#tags.label(e.id, e.attempt)
        const key = `${e.id}#${e.attempt}`
        const a: Attempt = { key, id: e.id, label, startedAt: e.at, lines: [], last: e }
        this.#queued.delete(e.id)
        this.#running.set(key, a)
        this.#write(`${this.#prefix(a)} ${c.dim('▶')} ${e.id}`)
        return
      }
      case 'eval-progress': {
        const a = this.#running.get(`${e.id}#${e.attempt}`)
        if (!a) return
        a.last = e
        const { progress } = e
        const line: Line = { at: progress.at, text: progressLine(c, progress), kind: progress.kind }
        const start = STARTS[progress.kind]
        const open = start && a.lines.findLastIndex((l) => l.kind === start)
        if (!this.#streaming && open !== undefined && open >= 0) {
          line.at = a.lines[open]?.at ?? line.at
          a.lines.splice(open, 1)
        }
        this.#add(a, line)
        return
      }
      case 'log': {
        const a = e.id ? this.#running.get(`${e.id}#${e.attempt ?? 1}`) : undefined
        const label = e.stream === 'stderr' ? c.yellow('stderr |') : c.dim('stdout |')
        for (const text of e.text.replace(/\n$/, '').split('\n')) {
          if (a) this.#add(a, { at: e.at, text: `${label} ${text}` })
          else this.#write(`${label} ${text}`)
        }
        return
      }
      case 'eval-end':
        this.#end(e.result, e.attempt, e.at)
        return
      case 'notice': {
        const paint = { info: c.dim, warn: c.yellow, error: c.red }[e.level]
        this.#write(paint(e.text))
        return
      }
      case 'run-end':
        this.#write('')
        for (const line of renderSummary(c, e, this.#o.attemptDir)) this.#write(line)
        return
    }
  }

  #end(result: EvalResult, attempt: number, at: number) {
    const c = this.#c
    const key = `${result.id}#${attempt}`
    const a: Attempt = this.#running.get(key) ?? {
      key,
      id: result.id,
      label: this.#tags.label(result.id, attempt),
      startedAt: at - result.durationMs,
      lines: [],
      last: undefined,
    }
    this.#running.delete(key)
    this.#queued.delete(result.id)
    const outcome = outcomeOf(result)
    const failed = outcome !== 'pass' && outcome !== 'skipped'
    const time = outcome === 'skipped' ? '' : `  ${c.dim(formatDuration(result.durationMs))}`
    const head = `${this.#prefix(a)} ${mark(c, outcome)} ${result.id}${time}`
    const { outputLogs, githubActions, logPrefix } = this.#o.output

    const showDetail =
      !this.#streaming &&
      a.lines.length > 0 &&
      (outputLogs === 'full' || (outputLogs === 'errors-only' && failed))
    // A judge failure's verdict line is already in the detail.
    const judged = result.meta?.errorKind === 'judge' && (showDetail || this.#streaming)
    const errors =
      failed && outputLogs !== 'none' && !judged
        ? failureLines(c, result, { max: ERROR_LINES })
        : []
    const lines = a.lines.filter((l) => l.kind !== 'cleanup').sort((x, y) => x.at - y.at)
    const prefixed = logPrefix === 'task'

    // Like Turborepo on GitHub Actions: passing attempts collapse into a group, failing ones
    // stay expanded under their result line.
    const group = githubActions && showDetail && !failed
    this.#write(group ? `::group::${stripAnsi(head)}` : head)
    if (showDetail) for (const line of lines) this.#write(this.#detail(a, line, prefixed))
    for (const line of errors) this.#write(prefixed ? `${this.#prefix(a)}  ${line}` : ` ${line}`)
    if (group) this.#write('::endgroup::')
    if (githubActions && failed) {
      const title = ghEscape(result.id, true)
      const message = ghEscape(failureLines(colors(false), result, { max: ERROR_LINES }).join('\n'))
      const at = locate(result)
      const where = at ? `,line=${at.line},col=${at.col}` : ''
      this.#write(`::error file=${ghEscape(result.file, true)}${where},title=${title}::${message}`)
    }
  }

  /** Prints the heartbeat if nothing was written for `heartbeatMs` and evals are running. */
  tick(now = this.#now()): void {
    const { heartbeatMs } = this.#o.output
    if (heartbeatMs <= 0 || this.#running.size === 0) return
    if (now - this.#lastWrite < heartbeatMs) return
    const c = this.#c
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
  }
}
