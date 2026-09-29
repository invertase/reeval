// What `analysis.agent`'s model can read about one eval on one harness: pure readers over the
// attempts' records, never a whole transcript. An attempt comes from the run's staging records
// while it runs, or from a recorded run's record and artifacts, as the same `AttemptView`.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mergeOutcome } from '../../history/assemble.ts'
import type { AttemptRecord } from '../../history/types.ts'
import { recordFileName } from '../../ids.ts'
import { clip } from '../../text.ts'
import type { EvalRecord, Outcome, TranscriptEvent } from '../../types.ts'
import type { EvalResult } from '../../ui/events.ts'
import { parseTranscript } from '../../view/model.ts'

/** One attempt as the tools see it: outcome, checks, verdicts, and each turn's steps in one line each. */
export type AttemptView = {
  /** `<cell key>#<n>`. */
  id: string
  cell: string
  n: number
  outcome: Outcome
  error: { kind: string; message: string } | null
  checks: Array<{ command: string; exitCode: number; output: string }>
  judgements: Array<{ question: string; verdict: string; score: number }>
  turns: Array<{ prompt: string; text: string; status: string; steps: string[] }>
  /** Changed files, from the diff. */
  files: string[]
  /** The workspace diff (`diff.patch`); empty when nothing changed. */
  patch: string
}

const INPUT_KEYS = [
  'command',
  'cmd',
  'path',
  'file_path',
  'filePath',
  'target_file',
  'pattern',
  'query',
  'url',
]

/** A tool call's input in a few words: its command or path when it has one. */
function inputSummary(input: unknown): string {
  if (typeof input === 'string') return clip(input.replace(/\s+/g, ' '), 120)
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  for (const key of INPUT_KEYS) {
    const value = fields[key]
    if (typeof value === 'string' && value) return clip(value.replace(/\s+/g, ' '), 120)
    if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
      return clip(value.join(' '), 120)
  }
  return clip(JSON.stringify(input), 120)
}

/** One transcript event as a step, or null for text and reasoning (a turn's text is kept whole). */
export function stepOf(event: TranscriptEvent): string | null {
  switch (event.type) {
    case 'tool': {
      const input = inputSummary(event.input)
      return `${event.tool}${input ? `: ${input}` : ''}${event.ok ? '' : ' (failed)'}`
    }
    case 'file-edit':
      return `edit (${event.kind}): ${event.path}`
    case 'web-search':
      return `web-search: ${clip(event.query, 120)}`
    case 'web-fetch':
      return `web-fetch: ${event.url}${event.ok ? '' : ' (failed)'}`
    case 'error':
      return `error: ${clip(event.message, 200)}`
    case 'retry':
      return `retry: ${clip(event.message, 200)}`
    default:
      return null
  }
}

const steps = (events: TranscriptEvent[]) => events.flatMap((e) => stepOf(e) ?? [])

const tail = (text: string, max: number) => (text.length <= max ? text : `…${text.slice(-max)}`)
const head = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n… ${text.length - max} more characters`

/** A worker's staged record, read the way the run will assemble it. */
export function fromStaged(result: EvalResult, record: EvalRecord | null): AttemptView | null {
  const attempt = result.attempt
  if (!attempt) return null
  const { outcome, error } = mergeOutcome(result, record)
  return {
    id: `${attempt.cell.key}#${attempt.n}`,
    cell: attempt.cell.key,
    n: attempt.n,
    outcome,
    error: error ? { kind: error.kind, message: error.message } : null,
    checks: (record?.checks ?? []).map((c) => ({
      command: c.command,
      exitCode: c.exitCode,
      output: tail(`${c.stdout}\n${c.stderr}`.trim(), 600),
    })),
    judgements: (record?.judgements ?? []).map((j) => ({
      question: j.question,
      verdict: j.verdict,
      score: j.score,
    })),
    turns: (record?.turns ?? []).map((t) => ({
      prompt: t.prompt,
      text: t.text,
      status: t.status,
      steps: steps(t.transcript),
    })),
    files: (record?.diff?.files ?? []).map((f) => f.path),
    patch: record?.diff?.patch ?? '',
  }
}

/** The staged attempts of one eval on one harness, from `.reeval/staging/<run>/evals`. */
export async function stagedAttempts(
  stagingDir: string,
  results: EvalResult[],
): Promise<AttemptView[]> {
  const views: AttemptView[] = []
  for (const result of results) {
    const path = join(stagingDir, 'evals', recordFileName(result.key))
    let record: EvalRecord | null = null
    try {
      record = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      // Missing or cut short: the engine's result still says how the attempt ended.
    }
    const view = fromStaged(result, record)
    if (view) views.push(view)
  }
  return views
}

/** A recorded attempt, read from its run's artifact directory (`<history>/<run>/`, or `.reeval/runs/<run>/`). */
export async function fromRecorded(runDir: string, attempt: AttemptRecord): Promise<AttemptView> {
  const read = (path: string | undefined) =>
    path ? readFile(join(runDir, path), 'utf8').catch(() => '') : Promise.resolve('')
  const lines = parseTranscript(await read(attempt.files.transcript?.path))
  return {
    id: attempt.id,
    cell: attempt.cell,
    n: attempt.n,
    outcome: attempt.outcome,
    error: attempt.error ? { kind: attempt.error.kind, message: attempt.error.message } : null,
    checks: await Promise.all(
      attempt.checks.map(async (c) => ({
        command: c.command,
        exitCode: c.exitCode,
        output: tail((await read(c.log?.path)).trim(), 600),
      })),
    ),
    judgements: attempt.judgements.map((j) => ({
      question: j.question,
      verdict: j.verdict,
      score: j.score,
    })),
    turns: attempt.turns.map((t, i) => ({
      prompt: t.prompt,
      text: t.text,
      status: t.status,
      steps: steps(
        lines.filter(
          (l): l is TranscriptEvent & { turn: number } =>
            l.turn === i && l.type !== 'prompt' && l.type !== 'turn-end',
        ),
      ),
    })),
    files: attempt.changedFiles.map((f) => f.path),
    patch: await read(attempt.files.diff?.path),
  }
}

/** A failed attempt and a passing one to read beside it: same cell when there is one, else the harness's other cell. */
export type FailedPair = { failed: string; passed: string; match: 'cell' | 'harness' }

/** Each failed attempt beside the nearest passing run of its cell, else of another cell. */
export function failedVsPassed(attempts: AttemptView[]): FailedPair[] {
  const passed = attempts.filter((a) => a.outcome === 'pass')
  const near = (a: AttemptView) => (b: AttemptView, c: AttemptView) =>
    Math.abs(b.n - a.n) - Math.abs(c.n - a.n)
  return attempts
    .filter((a) => a.outcome === 'fail')
    .flatMap((a) => {
      const sameCell = passed.filter((p) => p.cell === a.cell).sort(near(a))[0]
      const other = passed.filter((p) => p.cell !== a.cell).sort(near(a))[0]
      const match = sameCell ?? other
      return match
        ? [
            {
              failed: a.id,
              passed: match.id,
              match: sameCell ? ('cell' as const) : ('harness' as const),
            },
          ]
        : []
    })
}

const stepCount = (a: AttemptView) => a.turns.reduce((n, t) => n + t.steps.length, 0)

/** `list_attempts`: every attempt's outcome in a line, and the failed-vs-passed pairs to open. */
export function listOutcomes(attempts: AttemptView[]) {
  return {
    attempts: attempts.map((a) => ({
      id: a.id,
      outcome: a.outcome,
      error: a.error ? `${a.error.kind}: ${clip(a.error.message, 300)}` : null,
      failedChecks: a.checks.filter((c) => c.exitCode !== 0).map((c) => c.command),
      judgements: a.judgements.map(
        (j) => `${j.verdict} ${j.score.toFixed(2)}: ${clip(j.question, 120)}`,
      ),
      turns: a.turns.length,
      steps: stepCount(a),
      files: a.files.length,
    })),
    pairs: failedVsPassed(attempts),
  }
}

/** `open_attempt`: one attempt's turns, steps (the first 40 and last 20), checks, verdicts and diff. */
export function attemptSummary(a: AttemptView) {
  return {
    id: a.id,
    outcome: a.outcome,
    error: a.error ? { kind: a.error.kind, message: clip(a.error.message, 1000) } : null,
    turns: a.turns.map((t, i) => ({
      turn: i + 1,
      prompt: clip(t.prompt, 400),
      status: t.status,
      steps:
        t.steps.length > 60
          ? [...t.steps.slice(0, 40), `… ${t.steps.length - 60} steps …`, ...t.steps.slice(-20)]
          : t.steps,
      text: clip(t.text, 800),
    })),
    checks: a.checks.map((c) => ({
      command: c.command,
      exitCode: c.exitCode,
      ...(c.exitCode !== 0 ? { output: c.output } : {}),
    })),
    judgements: a.judgements,
    files: a.files.slice(0, 50),
    diff: head(a.patch, 3000),
  }
}

/**
 * `compare_attempts`: where a failed attempt's steps first differ from a passing one's, a few
 * steps either side, the checks, verdicts and files that differ, and the start of each diff.
 */
export function divergence(failed: AttemptView, passed: AttemptView, window = 6) {
  const a = failed.turns.flatMap((t) => t.steps)
  const b = passed.turns.flatMap((t) => t.steps)
  let same = 0
  while (same < a.length && same < b.length && a[same] === b[same]) same++
  const diverged = same < a.length || same < b.length
  const from = Math.max(0, same - 2)
  const commands = [...new Set([...failed.checks, ...passed.checks].map((c) => c.command))]
  const exit = (v: AttemptView, command: string) =>
    v.checks.find((c) => c.command === command)?.exitCode ?? null
  const verdict = (v: AttemptView, question: string) =>
    v.judgements.find((j) => j.question === question)?.verdict ?? null
  const questions = [
    ...new Set([...failed.judgements, ...passed.judgements].map((j) => j.question)),
  ]
  const last = (v: AttemptView) => clip(v.turns.at(-1)?.text ?? '', 600)
  return {
    failed: failed.id,
    passed: passed.id,
    error: failed.error ? `${failed.error.kind}: ${clip(failed.error.message, 600)}` : null,
    stepsInCommon: same,
    /** The first step (from 1) where they differ; null when the steps are the same. */
    divergedAt: diverged ? same + 1 : null,
    steps: { failed: a.length, passed: b.length },
    failedSteps: a.slice(from, same + window),
    passedSteps: b.slice(from, same + window),
    checks: commands
      .filter((c) => exit(failed, c) !== exit(passed, c))
      .map((c) => ({
        command: c,
        failed: exit(failed, c),
        passed: exit(passed, c),
        failedOutput: failed.checks.find((x) => x.command === c)?.output ?? null,
      })),
    judgements: questions
      .filter((q) => verdict(failed, q) !== verdict(passed, q))
      .map((q) => ({
        question: clip(q, 200),
        failed: verdict(failed, q),
        passed: verdict(passed, q),
      })),
    files: {
      onlyFailed: failed.files.filter((f) => !passed.files.includes(f)).slice(0, 30),
      onlyPassed: passed.files.filter((f) => !failed.files.includes(f)).slice(0, 30),
    },
    finalText: { failed: last(failed), passed: last(passed) },
    diff: { failed: head(failed.patch, 1500), passed: head(passed.patch, 1500) },
  }
}
