import type { ExecResult, JSONValue, JudgeJsonState, JudgeSees, TranscriptEvent } from '../types.ts'
import { describeSize } from './size.ts'
import { transcriptForJudge } from './transcript.ts'

/** Roughly four characters a token, as `withInputSize` counts: an estimate, not the model's. */
const tokensOf = (chars: number) => Math.ceil(chars / 4)
const k = (tokens: number) => (tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`)

/** Known state budgets in tokens, by model prefix: state plus the longest question. */
export const STATE_BUDGETS: ReadonlyArray<{ prefix: string; tokens: number }> = [
  // TypeSafe's models page: 32k tokens for `state` plus the longest question.
  { prefix: 'typesafe-ai/jev-', tokens: 32_000 },
]
/** Every other language-model judge. */
export const DEFAULT_STATE_BUDGET = 100_000

/** `maxInputTokens`, else the model's budget; a fake judge has none. */
export function stateBudget(model: string, maxInputTokens?: number): number | undefined {
  if (maxInputTokens !== undefined) return maxInputTokens
  if (model === 'fake') return undefined
  return STATE_BUDGETS.find((b) => model.startsWith(b.prefix))?.tokens ?? DEFAULT_STATE_BUDGET
}

type Mode = Exclude<JudgeSees['transcript'], false | undefined>

export type DraftTranscript = {
  events: readonly TranscriptEvent[]
  mode: Mode
  lines: string[]
  /** Events cut from the middle for the budget. */
  omitted: number
}

export type DraftTurn = { task?: string; output?: JSONValue; transcript?: DraftTranscript }

/** The judge's state before it's serialised, in a form the budget can cut. */
export type Draft = {
  all: boolean
  turns: DraftTurn[]
  files?: string[]
  diff?: string
  contents?: Record<string, string | null>
  checks?: Array<{ command: string } & ExecResult>
}

export const draftTranscript = (
  events: readonly TranscriptEvent[],
  mode: Mode,
): DraftTranscript => ({
  events,
  mode,
  lines: transcriptForJudge(events, mode),
  omitted: 0,
})

function transcriptText(t: DraftTranscript): string {
  if (!t.omitted) return t.lines.join('\n')
  const half = Math.ceil(t.lines.length / 2)
  return [
    ...t.lines.slice(0, half),
    `[reeval: dropped ${t.omitted} event${t.omitted === 1 ? '' : 's'}: over the judge's budget]`,
    ...t.lines.slice(half),
  ].join('\n')
}

function turnState(t: DraftTurn): JudgeJsonState {
  return {
    ...(t.task !== undefined ? { task: t.task } : {}),
    ...(t.output !== undefined ? { output: t.output } : {}),
    ...(t.transcript ? { transcript: transcriptText(t.transcript) } : {}),
  }
}

/** The JSON the judge reads: the graded turn's keys at the top, or every turn under `turns`. */
export function stateOf(d: Draft): JudgeJsonState {
  const last = d.turns.at(-1) ?? {}
  const { transcript, ...top } = d.all ? {} : turnState(last)
  return {
    ...(d.all ? { turns: d.turns.map(turnState) } : top),
    ...(d.files ? { files: d.files } : {}),
    ...(d.diff !== undefined ? { diff: d.diff } : {}),
    ...(d.contents ? { contents: d.contents } : {}),
    ...(d.checks ? { checks: d.checks } : {}),
    ...(transcript !== undefined ? { transcript } : {}),
  }
}

const sizeOf = (d: Draft, question: string) =>
  tokensOf(JSON.stringify(stateOf(d)).length + question.length)

const diffParts = (patch: string) => patch.split(/(?=^diff --git )/m).filter((p) => p.length > 0)
const diffPath = (part: string) => /^diff --git a\/.+ b\/(.+)$/m.exec(part)?.[1] ?? null

export type Fit = { dropped: string[] } | { error: string }

/**
 * Cuts the draft to `budget` tokens: tool output clipped, then transcript events from the middle,
 * then whole diff files, check output and file contents, largest first. Each cut is named. The
 * question, task, output and changed files are never cut: when they alone are over, it's an error.
 */
export function fitBudget(
  d: Draft,
  question: string,
  budget: number | undefined,
  model: string,
): Fit {
  const dropped: string[] = []
  if (budget === undefined) return { dropped }
  const over = () => sizeOf(d, question) > budget
  const why = `over the judge's budget of ${k(budget)} tokens`
  const transcripts = d.turns.flatMap((t, i) => (t.transcript ? [{ t: t.transcript, i }] : []))
  const label = (i: number) => (d.all ? `turn ${i + 1} transcript` : 'transcript')

  for (const { t, i } of transcripts) {
    if (!over()) break
    if (t.mode !== 'full') continue
    t.lines = transcriptForJudge(t.events, t.mode, true)
    dropped.push(`${label(i)}: tool input and output clipped, ${why}`)
  }
  for (const { t, i } of transcripts) {
    if (!over()) break
    while (t.lines.length > 0 && over()) {
      let excess = (sizeOf(d, question) - budget) * 4
      while (t.lines.length > 0 && excess > 0) {
        const [line = ''] = t.lines.splice(Math.floor(t.lines.length / 2), 1)
        excess -= line.length + 3
        t.omitted++
      }
    }
    if (t.omitted)
      dropped.push(`${label(i)}: ${t.omitted} event${t.omitted === 1 ? '' : 's'}, ${why}`)
  }
  if (d.diff && over()) {
    const parts = diffParts(d.diff)
    const order = parts.map((p, i) => ({ i, size: p.length })).sort((a, b) => b.size - a.size)
    for (const { i } of order) {
      if (!over()) break
      const path = diffPath(parts[i] ?? '')
      if (!path) continue
      parts[i] = `[reeval: dropped ${path}: over the judge's budget]\n`
      d.diff = parts.join('')
      dropped.push(`${path}: ${why}`)
    }
  }
  for (const check of [...(d.checks ?? [])].sort(
    (a, b) => b.stdout.length + b.stderr.length - (a.stdout.length + a.stderr.length),
  )) {
    if (!over()) break
    const size = tokensOf(check.stdout.length + check.stderr.length)
    if (!size) continue
    check.stdout = "[reeval: dropped: over the judge's budget]"
    check.stderr = ''
    dropped.push(`checks ${JSON.stringify(check.command)}: output, ~${k(size)} tokens, ${why}`)
  }
  const contents = d.contents
  if (contents) {
    const order = Object.entries(contents)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .sort((a, b) => b[1].length - a[1].length)
    for (const [path, text] of order) {
      if (!over()) break
      contents[path] =
        `[reeval: dropped: ~${k(tokensOf(text.length))} tokens, over the judge's budget]`
      dropped.push(`contents ${path}: ~${k(tokensOf(text.length))} tokens, ${why}`)
    }
  }
  if (!over()) return { dropped }
  const state = stateOf(d)
  return {
    error:
      `The judge's input is ~${k(sizeOf(d, question))} tokens (estimated) after every cut, over ${model}'s budget of ${k(budget)}: ` +
      `${describeSize(state, question)}. Leave a part out with sees, e.g. { sees: { output: false } }, or raise judge.maxInputTokens.`,
  }
}
