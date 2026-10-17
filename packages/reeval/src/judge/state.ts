import type { ExecResult, JSONValue, JudgeJsonState } from '../types.ts'

export type DraftTurn = { task?: string; output?: JSONValue; transcript?: string }

/** The judge's state before it's serialised: each part `sees` kept. */
export type Draft = {
  all: boolean
  turns: DraftTurn[]
  files?: string[]
  diff?: string
  contents?: Record<string, string | null>
  checks?: Array<{ command: string } & ExecResult>
}

function turnState(t: DraftTurn): JudgeJsonState {
  return {
    ...(t.task !== undefined ? { task: t.task } : {}),
    ...(t.output !== undefined ? { output: t.output } : {}),
    ...(t.transcript !== undefined ? { transcript: t.transcript } : {}),
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
