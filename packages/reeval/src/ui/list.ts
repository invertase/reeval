// The status list as text, for every surface that prints it line by line: CI and pipes (with
// tree glyphs), coding agents (without), and the interactive list's rows. `LiveList` builds the
// rows a run in progress shows from its events, before the record exists.
import { formatDuration, plural } from '../text.ts'
import type { Colors } from './colors.ts'
import { colors as makeColors } from './colors.ts'
import type { AttemptRef, CollectedEval, EvalResult, Progress } from './events.ts'
import { attemptAxes, failureLines, outcomeOf, phaseOf } from './format.ts'
import type { DetailLine, StatusFile, StatusIcon, StatusList, StatusRow } from './status.ts'

export const ICON: Record<StatusIcon, string> = {
  queued: '·',
  running: '◌',
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
  if (icon === 'fail') return c.red(glyph)
  if (icon === 'canceled') return c.yellow(glyph)
  if (icon === 'observe') return c.blue(glyph)
  return c.dim(glyph)
}

export function paintDetail(c: Colors, line: DetailLine): string {
  const indent = '  '.repeat(line.depth)
  const text =
    line.tone === 'red'
      ? c.red(line.text)
      : line.tone === 'dim'
        ? c.dim(line.text)
        : line.tone === 'heading'
          ? c.bold(line.text)
          : line.text
  return `${indent}${text}`
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
      for (const line of row.detail) out.push(`${down}${paintDetail(c, line)}`.trimEnd())
    }
  }
  return out
}

/**
 * The whole list once, as the run ends: failures, compares and evals with remarks expanded (with `-v`, every
 * row), other passes on one line each.
 */
export function listLines(
  list: StatusList,
  c: Colors,
  glyphs: boolean,
  pointer: string,
  verbose = false,
): string[] {
  const expand = (row: StatusRow) =>
    row.detail.length > 0 &&
    (verbose || row.compare || row.remarks > 0 || row.icon === 'fail' || row.icon === 'canceled')
  return [
    ...list.errors.flatMap((e) => [c.red(`error: ${e.split('\n')[0] ?? ''}`)]),
    ...(list.errors.length ? [''] : []),
    ...fileLines(list.files, { colors: c, glyphs, expand }),
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
  state: 'queued' | 'running' | 'pass' | 'fail' | 'error' | 'skipped'
  gated: boolean
  phase: string
  error?: string
}

type LiveEval = { id: string; file: string; name: string; attempts: LiveAttempt[] }

/** The list while a run goes, from its events: each eval's attempts and where they are. */
export class LiveList {
  readonly #evals = new Map<string, LiveEval>()
  readonly #byKey = new Map<string, LiveAttempt>()
  readonly #harness: string
  readonly #plain = makeColors(false)

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
    a.state =
      outcome === 'pass'
        ? 'pass'
        : outcome === 'skipped'
          ? 'skipped'
          : outcome === 'fail'
            ? 'fail'
            : 'error'
    if (a.state === 'fail' || a.state === 'error') {
      a.error = failureLines(this.#plain, result, { max: 1 })
        .find((l) => l.trim())
        ?.trim()
    }
  }

  /** Evals with every attempt ended, and evals in all. */
  counts(): { done: number; total: number; running: number } {
    const all = [...this.#evals.values()]
    const finished = (e: LiveEval) =>
      e.attempts.every((a) => a.state !== 'queued' && a.state !== 'running')
    return {
      done: all.filter(finished).length,
      total: all.length,
      running: all.filter((e) => e.attempts.some((a) => a.state === 'running')).length,
    }
  }

  files(): StatusFile[] {
    const by = new Map<string, StatusRow[]>()
    for (const e of this.#evals.values()) {
      const rows = by.get(e.file) ?? []
      rows.push(this.#row(e))
      by.set(e.file, rows)
    }
    return [...by].map(([path, rows]) => ({ path, rows }))
  }

  #row(e: LiveEval): StatusRow {
    const ended = e.attempts.filter((a) => a.state !== 'queued' && a.state !== 'running')
    const running = e.attempts.some((a) => a.state === 'running')
    const decide = e.attempts.some((a) => a.gated) ? e.attempts.filter((a) => a.gated) : e.attempts
    const failed = decide.some((a) => a.state === 'fail' || a.state === 'error')
    const done = ended.length === e.attempts.length
    const icon: StatusIcon = failed
      ? 'fail'
      : !done
        ? running || ended.length
          ? 'running'
          : 'queued'
        : decide.every((a) => !a.gated)
          ? 'observe'
          : 'pass'
    const passed = decide.filter((a) => a.state === 'pass').length
    const summary = done
      ? `${passed} of ${plural(decide.length, 'run')} passed`
      : `${ended.length} of ${plural(e.attempts.length, 'run')} done`
    const detail: DetailLine[] = e.attempts.map((a) => {
      const who = `${a.axes || this.#harness} #${a.n}`
      if (a.state === 'running') return { depth: 0, text: `${who} ${a.phase}` }
      if (a.state === 'queued') return { depth: 0, text: `${who} queued`, tone: 'dim' }
      if (a.state === 'pass') return { depth: 0, text: `${who} passed` }
      if (a.state === 'skipped') return { depth: 0, text: `${who} skipped`, tone: 'dim' }
      const what = a.state === 'error' ? 'errored' : 'failed'
      return { depth: 0, text: `${who} ${what}${a.error ? `: ${a.error}` : ''}`, tone: 'red' }
    })
    return { id: e.id, name: e.name, icon, summary, detail, remarks: 0, compare: false }
  }
}

/** `… 2 of 5 evals done (3m 05s)`, the line CI prints on a timer while a run goes. */
export const progressText = (done: number, total: number, elapsedMs: number) =>
  `… ${done} of ${plural(total, 'eval')} done (${formatDuration(elapsedMs)})`
