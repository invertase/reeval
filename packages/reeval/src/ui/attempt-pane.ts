// One attempt's pane in the interactive list: what the run's events say about it, as the stream
// carries them (its progress timeline, its log lines and its errors), and those as the lines the
// pane scrolls through. Only the interactive renderer keeps them, masked as they come in (before
// the pane breaks a line, which could split a secret), and capped per attempt and in all.
import stringWidth from 'string-width'
import { redactFields, redactSecrets } from '../redact.ts'
import { formatDuration, plural } from '../text.ts'
import { type Colors, stripAnsi } from './colors.ts'
import type { EvalResult, Progress } from './events.ts'
import { offset, outcomeOf, progressLine } from './format.ts'
import { detailSegments } from './list.ts'
import type { DetailLine } from './status.ts'

/** The most timeline entries and log lines kept for one attempt; past them, the oldest go. */
export const TIMELINE_MAX = 500
export const LOG_LINES_MAX = 2000
/**
 * The most timeline entries and log lines kept for every attempt together; past it, the attempts
 * that ended first lose theirs, so a run of thousands of attempts stays bounded.
 */
export const KEPT_MAX = 50_000

export type AttemptRecord = {
  startedAt?: number
  timeline: Progress[]
  /** Timeline entries dropped past `TIMELINE_MAX` or `KEPT_MAX`. */
  timelineDropped: number
  logs: Array<{ stream: 'stdout' | 'stderr'; text: string }>
  /** Log lines dropped past `LOG_LINES_MAX` or `KEPT_MAX`. */
  logsDropped: number
  result?: EvalResult
}

const ESC = String.fromCharCode(27)
/** An SGR (color) sequence, which is all of an escape sequence the pane keeps. */
const SGR = new RegExp(`^${ESC}\\[[0-9;]*m$`)
const SGR_SPLIT = new RegExp(`(${ESC}\\[[0-9;]*m)`)
const RESET = new RegExp(`^${ESC}\\[0?m$`)
/**
 * Escape and control sequences: a CSI sequence, a string sequence (OSC, DCS, APC, PM, SOS) to its
 * terminator, any other escape, and the C0 and C1 controls but the tab and the line feed.
 */
const CONTROL = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}[\\]PX^_][\\s\\S]*?(?:\\u0007|${ESC}\\\\|$)`,
    `${ESC}[\\s\\S]?`,
    '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]',
  ].join('|'),
  'g',
)

/** Text from the run as the pane may draw it: its SGR codes kept, every other control dropped. */
export function sanitize(text: string): string {
  return text.replaceAll('\t', '    ').replace(CONTROL, (m) => (SGR.test(m) ? m : ''))
}

/** Every attempt's events, by its key. */
export class AttemptLog {
  readonly #by = new Map<string, AttemptRecord>()
  /** The attempts that ended, first first: the ones to shed past `KEPT_MAX`. */
  readonly #ended: string[] = []
  #kept = 0

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
    a.timeline.push(redactFields(p, ['kind']))
    this.#kept++
    if (a.timeline.length > TIMELINE_MAX) {
      a.timeline.shift()
      a.timelineDropped++
      this.#kept--
    }
    this.#shed()
  }

  log(key: string, stream: 'stdout' | 'stderr', text: string) {
    const a = this.#of(key)
    const lines = redactSecrets(text).replace(/\n$/, '').split('\n')
    for (const line of lines) a.logs.push({ stream, text: sanitize(line) })
    this.#kept += lines.length
    const over = a.logs.length - LOG_LINES_MAX
    if (over > 0) {
      a.logs.splice(0, over)
      a.logsDropped += over
      this.#kept -= over
    }
    this.#shed()
  }

  end(result: EvalResult) {
    this.#of(result.key).result = {
      ...result,
      errors: result.errors.map((e) => sanitize(redactSecrets(e))),
      formattedErrors: result.formattedErrors.map((e) => sanitize(redactSecrets(e))),
    }
    this.#ended.push(result.key)
  }

  /** Past `KEPT_MAX`, drops the timeline and logs of the attempts that ended first. */
  #shed() {
    while (this.#kept > KEPT_MAX && this.#ended.length) {
      const a = this.#by.get(this.#ended.shift() as string)
      if (!a) continue
      a.timelineDropped += a.timeline.length
      a.logsDropped += a.logs.length
      this.#kept -= a.timeline.length + a.logs.length
      a.timeline = []
      a.logs = []
    }
  }
}

/**
 * `text` in lines of at most `width` columns, as the terminal counts them (wide characters take
 * two): as it is when it fits, else broken between graphemes, each piece in the colors it had.
 */
export function fit(text: string, width: number): string[] {
  if (stringWidth(text) <= width) return [text]
  const out: string[] = []
  const graphemes = new Intl.Segmenter()
  let line = ''
  let cols = 0
  /** The SGR codes since the last reset, which a continued line starts with. */
  let paint = ''
  for (const part of text.split(SGR_SPLIT)) {
    if (SGR.test(part)) {
      line += part
      paint = RESET.test(part) ? '' : paint + part
      continue
    }
    for (const { segment } of graphemes.segment(part)) {
      const w = stringWidth(segment)
      if (cols + w > width && cols > 0) {
        out.push(paint ? `${line}${ESC}[0m` : line)
        line = paint
        cols = 0
      }
      line += segment
      cols += w
    }
  }
  out.push(line)
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
  // A line from the run can leave a color on, which would run on past it.
  const closed = (t: string) => (t.includes(ESC) ? `${t}${ESC}[0m` : t)
  const body = (texts: string[]) =>
    texts.flatMap((t) => fit(closed(t), width).map((l) => `    ${l}`))
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
