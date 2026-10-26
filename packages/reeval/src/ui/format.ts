import { clip, formatDuration, plural } from '../text.ts'
import type { AttemptMeta } from '../types.ts'
import { type DebugLine, debugTime } from '../view/debug.ts'
import { triesNote } from '../view/judgements.ts'
import type { Colors } from './colors.ts'
import { stripAnsi } from './colors.ts'
import type { EvalResult, Progress, ReevalEvent } from './events.ts'

export { formatDuration }

/** Most detail lines a `-vv` payload prints under its line. */
const DEBUG_DETAIL_LINES = 40

/**
 * A debug line as the terminal shows it, `12:50:01 image     cache hit …` (with milliseconds under
 * `-vv`), then its detail indented under it.
 */
export function debugLines(c: Colors, line: DebugLine, ms: boolean): string[] {
  const phase = line.phase.padEnd(9)
  const head = `${c.dim(debugTime(line.at, ms))} ${c.dim(phase)} ${line.level === 2 ? c.dim(line.text) : line.text}`
  const detail = (line.detail ?? '').split('\n').filter((l) => l.trim())
  const shown = detail.slice(0, DEBUG_DETAIL_LINES).map((l) => c.dim(`    ${l}`))
  const more = detail.length - shown.length
  return [head, ...shown, ...(more > 0 ? [c.dim(`    … ${more} more lines in trace.ndjson`)] : [])]
}

/** Offset into an attempt, `+1:05`. */
export function offset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export type Outcome = 'pass' | 'fail' | 'infra_error' | 'skipped' | 'cancelled'

export function outcomeOf(e: EvalResult): Outcome {
  if (e.state === 'skipped') return 'skipped'
  if (e.meta?.errorKind === 'aborted') return 'cancelled'
  return e.meta?.outcome ?? (e.state === 'passed' ? 'pass' : 'fail')
}

/** What tells an eval's attempts apart: the axes that vary (`cursor:composer-2.5 · with-skill`), else the harness. */
export function attemptAxes(a: AttemptMeta | undefined, fallback: string): string {
  return a?.label.replace(/\s*#\d+$/, '') || a?.harness.kind || fallback
}

/** A command on one line: the first line, cut to 80 characters at a word boundary. */
export function oneLine(text: string, max = 80): string {
  const [first = ''] = text.trim().split('\n')
  const cut = clip(first, max)
  return cut === first && text.trim().includes('\n') ? `${first}…` : cut
}

/** One line per worker progress event, without prefix or offset. */
export function progressLine(c: Colors, p: Progress): string {
  switch (p.kind) {
    case 'sandbox':
      return c.dim('sandbox starting')
    case 'sandbox-ready':
      return `sandbox ready ${c.dim(formatDuration(p.ms))}`
    case 'turn-start':
      return `turn ${p.turn} started`
    case 'turn-end': {
      const status = p.status === 'completed' ? 'done' : c.red(p.status)
      const activity = [plural(p.tools, 'tool call'), plural(p.fileEdits, 'file edit')].join(', ')
      const error = p.error ? `: ${c.red(oneLine(p.error, 160))}` : ''
      return `turn ${p.turn} ${status}${error} ${c.dim(`${formatDuration(p.ms)} · ${activity}`)}`
    }
    case 'check-start':
      return c.dim(`$ ${oneLine(p.command)}`)
    case 'check-end': {
      const exit = p.exitCode === 0 ? c.dim('exit 0') : c.red(`exit ${p.exitCode}`)
      const tries = p.try && p.tries ? triesNote(p.exitCode, p.try, p.tries) : null
      return `$ ${oneLine(p.command)}  ${exit} ${c.dim([formatDuration(p.ms), tries].filter(Boolean).join(' · '))}`
    }
    case 'judge-start':
      return c.dim(`judging: ${oneLine(p.question, 120)}`)
    case 'judge-end':
      return judgeLine(c, p)
    case 'cleanup':
      return c.dim('cleaning up')
    case 'browser-download': {
      const total = p.bytes == null ? '?' : formatBytes(p.bytes)
      return `downloading ${p.name} ${p.version} ${formatBytes(p.received)} / ${total} → ${p.cache}`
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function judgeLine(
  c: Colors,
  j: {
    verdict: 'pass' | 'fail' | 'error'
    score: number | null
    threshold: number | null
    question: string
  },
): string {
  const verdict = j.verdict === 'pass' ? c.green('pass') : c.red(j.verdict)
  const score = j.score === null ? '' : ` ${j.score.toFixed(2)}`
  const threshold = j.threshold === null ? '' : ` ${c.dim(`(≥ ${j.threshold})`)}`
  return `${c.dim('judge')}  ${verdict}${score}${threshold}  ${j.question}`
}

/** The phase a running attempt is in, for the heartbeat. */
export function phaseOf(p: Progress | undefined): string {
  switch (p?.kind) {
    case undefined:
      return 'starting'
    case 'sandbox':
      return 'sandbox'
    case 'sandbox-ready':
      return 'sandbox ready'
    case 'turn-start':
      return `turn ${p.turn}`
    case 'turn-end':
      return `turn ${p.turn} done`
    case 'check-start':
    case 'check-end':
      return 'checks'
    case 'judge-start':
    case 'judge-end':
      return 'judging'
    case 'cleanup':
      return 'cleanup'
    case 'browser-download':
      return 'browser download'
  }
}

export function capLines(text: string, max: number): string[] {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), `(+${lines.length - max} more lines)`]
}

/** An infra error's headline, then its last lines: the cause is at the end. */
export function tailLines(text: string, max: number): string[] {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length <= max) return lines
  const rest = Math.max(1, max - 1)
  return [lines[0] ?? '', `(${lines.length - 1 - rest} more lines)`, ...lines.slice(-rest)]
}

/**
 * Why an eval failed, as lines: the judge verdict (and reason) for judge failures, Vitest's
 * formatted error (diff, code frame) for assertions, the tail of the message for infra errors.
 */
export function failureLines(
  c: Colors,
  e: EvalResult,
  options: { max: number; reasons?: Array<string | null> },
): string[] {
  const outcome = outcomeOf(e)
  if (outcome === 'cancelled') return [c.yellow('cancelled')]
  const message = e.errors[0] ?? ''
  const turns = (e.meta?.turnErrors ?? [])
    .filter((t) => !message.includes(t.replace(/^turn \d+ error: /, '')))
    .map((t) => c.yellow(t))
  return [...failureBody(c, e, outcome, message, options), ...turns]
}

function failureBody(
  c: Colors,
  e: EvalResult,
  outcome: ReturnType<typeof outcomeOf>,
  message: string,
  options: { max: number; reasons?: Array<string | null> },
): string[] {
  if (outcome === 'infra_error') {
    // Its sandbox's failure was printed in full before the run; each attempt names it.
    if (e.meta?.prepare) {
      const lines = message.trimEnd().split('\n')
      return [c.yellow('infra error'), lines[0] ?? '', lines.at(-1) ?? ''].filter(
        (l, i, all) => all.indexOf(l) === i,
      )
    }
    return [`${c.yellow('infra error')}`, ...tailLines(message, options.max)]
  }
  const failed = (e.meta?.judgements ?? []).filter((j) => j.verdict !== 'pass')
  if (e.meta?.errorKind === 'judge' && failed.length) {
    return failed.flatMap((j, i) => {
      const reason = options.reasons?.[i]
      return [judgeLine(c, { ...j, threshold: j.threshold }), ...(reason ? [`  ${reason}`] : [])]
    })
  }
  const formatted = e.formattedErrors[0]
  const body = formatted && e.meta?.errorKind !== 'timeout' ? formatted : message
  const text = c.enabled ? body : stripAnsi(body)
  return capLines(text.replace(/^\n+/, ''), options.max).map((l) =>
    c.enabled && body === message ? c.red(l) : l,
  )
}

/** Preflight's lines: which sandboxes it prepares, the slow ones when ready, and each failure. */
export function prepareLines(
  c: Colors,
  e: Extract<ReevalEvent, { type: 'prepare' }>,
  max: number,
): string[] {
  if (e.state === 'start') {
    const n = e.targets.length
    const names = e.targets.map((t) => t.label).join(', ')
    return [c.dim(`preparing ${n} sandbox${n === 1 ? '' : 'es'}: ${names}`)]
  }
  const { outcome } = e
  if (outcome.ok) {
    return outcome.ms >= 1000
      ? [c.dim(`${c.green('✓')} ${outcome.target.label} ready ${formatDuration(outcome.ms)}`)]
      : []
  }
  const who = outcome.target.setBy.join(', ')
  return [
    `${c.red('✗')} ${outcome.target.label} failed to prepare ${c.dim(`(set by ${who}; only its attempts fail)`)}`,
    ...tailLines(outcome.failure.message, max).map((l) => `  ${c.yellow(l)}`),
  ]
}
