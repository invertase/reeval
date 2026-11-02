// The status list as text, for every surface that prints it line by line: CI and pipes (with
// tree glyphs), coding agents (without), and the interactive list's rows. `LiveList` builds the
// rows a run in progress shows from its events, before the record exists.
import { formatDuration, plural } from '../text.ts'
import type { CellGate } from '../types.ts'
import type { Colors } from './colors.ts'
import type { AttemptRef, CollectedEval, EvalResult, Progress } from './events.ts'
import { attemptAxes, failureReason, outcomeOf, phaseOf } from './format.ts'
import {
  type DetailLine,
  type DetailMark,
  type StatusFile,
  type StatusIcon,
  type StatusList,
  type StatusRow,
  shownDetail,
} from './status.ts'

export const ICON: Record<StatusIcon, string> = {
  queued: '·',
  running: '◌',
  failing: '◌',
  pass: '✓',
  fail: '✗',
  observe: '●',
  skipped: '–',
  canceled: '○',
}

/** The spinner the interactive list draws a running eval with. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function paintIcon(c: Colors, icon: StatusIcon, glyph = ICON[icon]): string {
  if (icon === 'pass') return c.green(glyph)
  if (icon === 'fail' || icon === 'failing') return c.red(glyph)
  if (icon === 'running') return c.teal(glyph)
  if (icon === 'canceled') return c.yellow(glyph)
  if (icon === 'observe') return c.blue(glyph)
  return c.dim(glyph)
}

export const MARK: Record<DetailMark, string> = {
  spin: ICON.running,
  pass: ICON.pass,
  fail: ICON.fail,
  miss: ICON.fail,
  error: ICON.fail,
  queued: ICON.queued,
  skipped: ICON.skipped,
}

/** A detail line in parts, each with its paint: its mark (`glyph` for a spinning one), text and note. */
export type Segment = { text: string; paint: (text: string) => string }

export function detailSegments(c: Colors, line: DetailLine, glyph?: string): Segment[] {
  const mark = line.mark
  const markPaint =
    mark === 'pass'
      ? c.green
      : mark === 'fail' || mark === 'error'
        ? c.red
        : mark === 'spin'
          ? c.teal
          : c.dim
  const textPaint =
    line.tone === 'red'
      ? c.red
      : line.tone === 'dim'
        ? c.dim
        : line.tone === 'heading'
          ? c.bold
          : (t: string) => t
  return [
    ...(mark
      ? [{ text: `${mark === 'spin' && glyph ? glyph : MARK[mark]} `, paint: markPaint }]
      : []),
    { text: line.text, paint: textPaint },
    ...(line.note ? [{ text: ` · ${line.note}`, paint: c.dim }] : []),
  ]
}

export function paintDetail(c: Colors, line: DetailLine, glyph?: string): string {
  const parts = detailSegments(c, line, glyph).map((s) => (s.text ? s.paint(s.text) : ''))
  return `${'  '.repeat(line.depth)}${parts.join('')}`
}

const NAME_MAX = 60

/** The name column's width in a file: its longest name, at most `NAME_MAX`. */
export const nameWidth = (rows: StatusRow[]) =>
  Math.min(NAME_MAX, Math.max(0, ...rows.map((r) => r.name.length)))

const fit = (name: string, width: number) =>
  name.length > width ? `${name.slice(0, width - 1)}…` : name.padEnd(width)

export const rowText = (c: Colors, row: StatusRow, width: number, glyph?: string) =>
  `${paintIcon(c, row.icon, glyph)} ${fit(row.name, width)}  ${c.dim(row.summary)}`.trimEnd()

export type ListTextOptions = {
  colors: Colors
  /** `├─`/`└─` before each row and `│` down a detail; off for coding agents. */
  glyphs: boolean
  /** Which rows print their detail. */
  expand: (row: StatusRow) => boolean
  /** The full detail (`-v`), not the compact one. */
  full?: boolean
}

/** Each file's heading and rows, a blank line between files. */
export function fileLines(files: StatusFile[], o: ListTextOptions): string[] {
  const c = o.colors
  const out: string[] = []
  for (const [i, file] of files.entries()) {
    if (i) out.push('')
    out.push(c.bold(file.path))
    const width = nameWidth(file.rows)
    for (const [j, row] of file.rows.entries()) {
      const last = j === file.rows.length - 1
      const branch = o.glyphs ? c.dim(last ? '└─ ' : '├─ ') : '  '
      out.push(`${branch}${rowText(c, row, width)}`)
      if (!o.expand(row)) continue
      const down = o.glyphs ? c.dim(last ? '     ' : '│    ') : '    '
      for (const line of shownDetail(row.detail, o.full ?? false)) {
        out.push(`${down}${paintDetail(c, line)}`.trimEnd())
      }
    }
  }
  return out
}

/**
 * The whole list once, as the run ends: failures, compares and evals with remarks expanded (with `-v`, every
 * row), other passes on one line each. `full` adds the detail the interactive list keeps behind
 * `→ more` (the rest of each message, file excerpts, snapshots); `-v` implies it.
 */
export function listLines(
  list: StatusList,
  c: Colors,
  glyphs: boolean,
  pointer: string,
  verbose = false,
  full = verbose,
): string[] {
  const expand = (row: StatusRow) =>
    row.detail.length > 0 &&
    (verbose || row.compare || row.remarks > 0 || row.icon === 'fail' || row.icon === 'canceled')
  return [
    ...list.errors.flatMap((e) => [c.red(`error: ${e.split('\n')[0] ?? ''}`)]),
    ...(list.errors.length ? [''] : []),
    ...fileLines(list.files, { colors: c, glyphs, expand, full }),
    '',
    ...(list.hiddenRemarks ? [c.dim(`+${plural(list.hiddenRemarks, 'more remark')} (-v)`)] : []),
    ...list.notes.map((n) => c.yellow(n)),
    list.done,
    c.dim(pointer),
  ]
}

type LiveAttempt = {
  key: string
  axes: string
  n: number
  state: 'queued' | 'running' | 'pass' | 'fail' | 'error' | 'skipped' | 'canceled'
  gated: boolean
  /** Its cell's key and gate, once it starts; a cell's attempts decide it together. */
  cell?: string
  gate?: CellGate
  phase: string
  error?: string
}

/**
 * Whether some cell's ended attempts already miss its gate, whatever its other attempts do: under
 * `all` any fail or error, under `{ passRate }` once the passes it can still reach fall short. A
 * `minLift` is decided only from the record.
 */
function gateMissed(attempts: LiveAttempt[]): boolean {
  // An attempt not yet started has no cell yet; it may be any cell's, so each counts it as left.
  const unplaced = attempts.filter((a) => !a.cell).length
  const cells = new Map<string, LiveAttempt[]>()
  for (const a of attempts) if (a.cell) cells.set(a.cell, [...(cells.get(a.cell) ?? []), a])
  return [...cells.values()].some((own) => {
    const gate = own[0]?.gate ?? 'all'
    const failed = own.filter((a) => a.state === 'fail').length
    const errored = own.filter((a) => a.state === 'error').length
    if (gate === 'all' || gate === 'none') return failed + errored > 0
    const passed = own.filter((a) => a.state === 'pass').length
    const left = own.filter((a) => a.state === 'running').length + unplaced
    const best = passed + left + failed
    return best > 0 ? (passed + left) / best < gate.passRate : errored > 0
  })
}

type LiveEval = { id: string; file: string; name: string; attempts: LiveAttempt[] }

/** The list while a run goes, from its events: each eval's attempts and where they are. */
export class LiveList {
  readonly #evals = new Map<string, LiveEval>()
  readonly #byKey = new Map<string, LiveAttempt>()
  readonly #harness: string

  constructor(harness: string) {
    this.#harness = harness
  }

  collected(file: string, evals: CollectedEval[]) {
    for (const x of evals) {
      if (x.skipped) continue
      const e = this.#evals.get(x.id) ?? {
        id: x.id,
        file,
        name: [...x.group, x.name].join(' › '),
        attempts: [],
      }
      const a: LiveAttempt = {
        key: x.key,
        axes: '',
        n: e.attempts.length + 1,
        state: 'queued',
        gated: true,
        phase: '',
      }
      e.attempts.push(a)
      this.#byKey.set(x.key, a)
      this.#evals.set(x.id, e)
    }
  }

  start(ref: AttemptRef) {
    const a = this.#byKey.get(ref.key)
    if (!a) return
    a.state = 'running'
    a.n = ref.attempt?.n ?? a.n
    a.axes = attemptAxes(ref.attempt, this.#harness)
    a.gated = ref.attempt?.gate !== 'none'
    if (ref.attempt) {
      a.cell = ref.attempt.cell.key
      a.gate = ref.attempt.gate
    }
    a.phase = phaseOf(undefined)
  }

  progress(key: string, progress: Progress) {
    const a = this.#byKey.get(key)
    if (a && progress.kind !== 'warning') a.phase = phaseOf(progress)
  }

  end(result: EvalResult) {
    const a = this.#byKey.get(result.key)
    if (!a) return
    const outcome = outcomeOf(result)
    a.gated = result.attempt?.gate !== 'none'
    if (result.attempt) {
      a.cell = result.attempt.cell.key
      a.gate = result.attempt.gate
    }
    a.state =
      outcome === 'pass'
        ? 'pass'
        : outcome === 'skipped'
          ? 'skipped'
          : outcome === 'canceled'
            ? 'canceled'
            : outcome === 'fail'
              ? 'fail'
              : 'error'
    if (a.state === 'fail' || a.state === 'error') a.error = failureReason(result) || undefined
  }

  /**
   * Evals with every attempt ended, and evals in all; of the ended ones, those that failed, and of
   * the rest, those with a run that already failed (`failing`), which isn't their outcome yet.
   */
  counts(): { done: number; total: number; running: number; failed: number; failing: number } {
    const rows = [...this.#evals.values()].map((e) => this.#row(e).icon)
    const all = [...this.#evals.values()]
    const finished = (e: LiveEval) =>
      e.attempts.every((a) => a.state !== 'queued' && a.state !== 'running')
    return {
      done: all.filter(finished).length,
      total: all.length,
      running: all.filter((e) => e.attempts.some((a) => a.state === 'running')).length,
      failed: rows.filter((i) => i === 'fail').length,
      failing: rows.filter((i) => i === 'failing').length,
    }
  }

  files(): StatusFile[] {
    const by = new Map<string, StatusRow[]>()
    for (const e of this.#evals.values()) {
      const rows = by.get(e.file) ?? []
      rows.push(this.#row(e))
      by.set(e.file, rows)
    }
    // In path order, as the finished list has them, whichever file's worker collected first.
    return [...by]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, rows]) => ({ path, rows }))
  }

  #row(e: LiveEval): StatusRow {
    const ended = e.attempts.filter((a) => a.state !== 'queued' && a.state !== 'running')
    const running = e.attempts.some((a) => a.state === 'running')
    const decide = e.attempts.some((a) => a.gated) ? e.attempts.filter((a) => a.gated) : e.attempts
    const failed = gateMissed(decide)
    const done = ended.length === e.attempts.length
    // Only an eval whose every run ended gets its ✓ or ✗; one still going with a failed run
    // spins red, so the failure shows without reading as the outcome.
    const icon: StatusIcon = !done
      ? failed
        ? 'failing'
        : running || ended.length
          ? 'running'
          : 'queued'
      : failed
        ? 'fail'
        : decide.every((a) => !a.gated)
          ? 'observe'
          : 'pass'
    const passed = decide.filter((a) => a.state === 'pass').length
    const summary = done
      ? `${passed} of ${plural(decide.length, 'run')} passed`
      : `${ended.length} of ${plural(e.attempts.length, 'run')} done`
    // A failed check is a fail, its message dim; only an error (a timeout, infra) is red.
    const detail: DetailLine[] = e.attempts.map((a): DetailLine => {
      const who = `${a.axes || this.#harness} #${a.n}`
      if (a.state === 'running') return { depth: 0, mark: 'spin', text: `${who} ${a.phase}` }
      if (a.state === 'queued')
        return { depth: 0, mark: 'queued', text: `${who} queued`, tone: 'dim' }
      if (a.state === 'pass') return { depth: 0, mark: 'pass', text: `${who} passed` }
      if (a.state === 'skipped' || a.state === 'canceled') {
        return { depth: 0, mark: 'skipped', text: `${who} ${a.state}`, tone: 'dim' }
      }
      if (a.state === 'fail') {
        return {
          depth: 0,
          mark: a.gated ? 'fail' : 'miss',
          text: `${who} failed`,
          ...(a.error ? { note: a.error } : {}),
        }
      }
      const error = a.error ? `: ${a.error}` : ''
      return { depth: 0, mark: 'error', text: `${who} errored${error}`, tone: 'red' }
    })
    return { id: e.id, name: e.name, icon, summary, detail, remarks: 0, compare: false }
  }
}

/** `… 2 of 5 evals done (3m 05s)`, the line CI prints on a timer while a run goes. */
export const progressText = (done: number, total: number, elapsedMs: number) =>
  `… ${done} of ${plural(total, 'eval')} done (${formatDuration(elapsedMs)})`
