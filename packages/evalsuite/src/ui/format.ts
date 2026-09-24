import type { AttemptRecord } from '../history/types.ts'
import type { AttemptMeta } from '../types.ts'
import type { Colors } from './colors.ts'
import { stripAnsi } from './colors.ts'
import type { EvalResult, Progress } from './events.ts'

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
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

export function attemptOutcome(a: AttemptRecord): Outcome {
  return a.error?.kind === 'aborted' ? 'cancelled' : a.outcome
}

/** What tells an eval's attempts apart: the axes that vary (`cursor:composer-2.5 · with-skill`), else the harness. */
export function attemptAxes(a: AttemptMeta | undefined, fallback: string): string {
  return a?.label.replace(/\s*#\d+$/, '') || a?.harness.kind || fallback
}

export function mark(c: Colors, outcome: Outcome): string {
  return {
    pass: c.green('✓'),
    fail: c.red('✗'),
    infra_error: c.yellow('!'),
    skipped: c.dim('↓'),
    cancelled: c.yellow('✗'),
  }[outcome]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A command on one line: the first line, cut to 80 characters. */
export function oneLine(text: string, max = 80): string {
  const [first = ''] = text.trim().split('\n')
  const more = first.length > max || text.trim().includes('\n')
  return more ? `${first.slice(0, max).trimEnd()}…` : first
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
      return `turn ${p.turn} ${status} ${c.dim(`${formatDuration(p.ms)} · ${activity}`)}`
    }
    case 'check-start':
      return c.dim(`$ ${oneLine(p.command)}`)
    case 'check-end': {
      const exit = p.exitCode === 0 ? c.dim('exit 0') : c.red(`exit ${p.exitCode}`)
      return `$ ${oneLine(p.command)}  ${exit} ${c.dim(formatDuration(p.ms))}`
    }
    case 'judge-start':
      return c.dim(`judging: ${oneLine(p.question, 120)}`)
    case 'judge-end':
      return judgeLine(c, p)
    case 'cleanup':
      return c.dim('cleaning up')
  }
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
  }
}

export function capLines(text: string, max: number): string[] {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), `(+${lines.length - max} more lines)`]
}

/** The last lines of a message: infra errors put the cause at the end. */
export function tailLines(text: string, max: number): string[] {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length <= max) return lines
  return [`(${lines.length - max} earlier lines)`, ...lines.slice(-max)]
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
  const message = e.errors[0] ?? ''
  if (outcome === 'infra_error') {
    return [`${c.yellow('infra error')}`, ...tailLines(message, options.max)]
  }
  if (outcome === 'cancelled') return [c.yellow('cancelled')]
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
