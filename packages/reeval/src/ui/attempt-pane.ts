// One attempt's pane in the interactive list: what the run's events say about it, as the stream
// carries them (its progress timeline, its log lines and its errors), and those as the lines the
// pane scrolls through. Only the interactive renderer keeps them, capped per attempt.
import { formatDuration, plural } from '../text.ts'
import { type Colors, stripAnsi } from './colors.ts'
import type { EvalResult, Progress } from './events.ts'
import { offset, outcomeOf, progressLine } from './format.ts'
import { detailSegments } from './list.ts'
import type { DetailLine } from './status.ts'

/** The most timeline entries and log lines kept for one attempt; past them, the oldest go. */
export const TIMELINE_MAX = 500
export const LOG_LINES_MAX = 2000

export type AttemptRecord = {
  startedAt?: number
  timeline: Progress[]
  /** Timeline entries dropped past `TIMELINE_MAX`. */
  timelineDropped: number
  logs: Array<{ stream: 'stdout' | 'stderr'; text: string }>
  /** Log lines dropped past `LOG_LINES_MAX`. */
  logsDropped: number
  result?: EvalResult
}

/** Every attempt's events, by its key. */
export class AttemptLog {
  readonly #by = new Map<string, AttemptRecord>()

  #of(key: string): AttemptRecord {
    let a = this.#by.get(key)
    if (!a) {
      a = { timeline: [], timelineDropped: 0, logs: [], logsDropped: 0 }
      this.#by.set(key, a)
    }
    return a
  }

  get = (key: string): AttemptRecord | undefined => this.#by.get(key)

  start(key: string, at: number) {
    this.#of(key).startedAt = at
  }

  progress(key: string, p: Progress) {
    const a = this.#of(key)
    a.timeline.push(p)
    if (a.timeline.length > TIMELINE_MAX) {
      a.timeline.shift()
      a.timelineDropped++
    }
  }

  log(key: string, stream: 'stdout' | 'stderr', text: string) {
    const a = this.#of(key)
    for (const line of text.replace(/\n$/, '').split('\n')) a.logs.push({ stream, text: line })
    const over = a.logs.length - LOG_LINES_MAX
    if (over > 0) {
      a.logs.splice(0, over)
      a.logsDropped += over
    }
  }

  end(result: EvalResult) {
    this.#of(result.key).result = result
  }
}

/** `text` in lines of at most `width` columns: as it is when it fits, else unpainted and broken. */
function fit(text: string, width: number): string[] {
  const plain = stripAnsi(text)
  if (plain.length <= width) return [text]
  const out: string[] = []
  for (let at = 0; at < plain.length; at += width) out.push(plain.slice(at, at + width))
  return out
}

/** The end of an attempt as a timeline line: how it ended and how long it took. */
function endLine(c: Colors, r: EvalResult): string {
  const outcome = outcomeOf(r)
  const word = {
    pass: c.green('passed'),
    fail: c.red('failed'),
    infra_error: c.red('errored'),
    skipped: c.dim('skipped'),
    canceled: c.yellow('canceled'),
  }[outcome]
  return `${word} ${c.dim(formatDuration(r.durationMs))}`
}

/**
 * The pane's lines at `columns`: the eval and the attempt as its line reads, then its timeline,
 * logs and errors, and a note that its transcript isn't in this view.
 */
export function paneLines(
  c: Colors,
  name: string,
  line: DetailLine,
  a: AttemptRecord | undefined,
  columns: number,
  spinner?: string,
): string[] {
  const width = Math.max(20, columns - 4)
  const raw = (text: string) => (c.enabled ? text : stripAnsi(text))
  const body = (texts: string[]) => texts.flatMap((t) => fit(t, width).map((l) => `    ${l}`))
  const none = (text: string) => [`    ${c.dim(text)}`]
  const title = detailSegments(c, line, spinner)
    .map((s) => s.paint(s.text))
    .join('')
  const out = [c.bold(name), ...fit(title, columns - 2).map((l) => `  ${l}`), '']

  out.push(c.bold('Timeline'))
  const start = a?.startedAt ?? a?.timeline[0]?.at
  const at = (t: number) => c.dim(start === undefined ? '' : offset(t - start).padEnd(6))
  const timeline = [
    ...(a?.timelineDropped
      ? [c.dim(`${plural(a.timelineDropped, 'earlier entry', 'earlier entries')} not kept`)]
      : []),
    ...(a?.startedAt === undefined ? [] : [`${at(a.startedAt)} started`]),
    ...(a?.timeline ?? []).map((p) => `${at(p.at)} ${progressLine(c, p)}`),
    ...(a?.result && start !== undefined
      ? [`${at(start + a.result.durationMs)} ${endLine(c, a.result)}`]
      : []),
  ]
  out.push(...(timeline.length ? body(timeline) : none('Not started.')), '')

  out.push(c.bold('Logs'))
  const logs = [
    ...(a?.logsDropped ? [c.dim(`${plural(a.logsDropped, 'earlier line')} not kept`)] : []),
    ...(a?.logs ?? []).map((l) => (l.stream === 'stderr' ? c.yellow(raw(l.text)) : raw(l.text))),
  ]
  out.push(...(logs.length ? body(logs) : none('No logs.')), '')

  out.push(c.bold('Errors'))
  const r = a?.result
  const shown = r ? (r.formattedErrors.length ? r.formattedErrors : r.errors) : []
  const errors = shown.flatMap((e, i) => [
    ...(i ? [''] : []),
    ...raw(e).replace(/\n+$/, '').split('\n'),
  ])
  out.push(...(errors.length ? body(errors) : none(r ? 'None.' : 'None so far.')), '')

  out.push(c.bold('Transcript'))
  out.push(...none("The transcript isn't available in this view."))
  return out
}
