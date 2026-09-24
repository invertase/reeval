import type { Judgement, ResolvedConfig, Run, Verdict } from '../types.ts'

export type JudgeInput = Pick<Run, 'prompt' | 'text' | 'diff'> & { question: string }

/** A `pass` or `fail` that cites no evidence is not trusted. */
export function normaliseVerdict(raw: Verdict): Verdict {
  const evidence = raw.evidence.map((e) => e.trim()).filter(Boolean)
  if (raw.verdict !== 'inconclusive' && evidence.length === 0) {
    return { verdict: 'inconclusive', reason: `No evidence cited. ${raw.reason}`.trim(), evidence }
  }
  return { ...raw, evidence }
}

export async function runJudge(
  config: ResolvedConfig['judge'],
  input: JudgeInput,
  signal: AbortSignal,
): Promise<Judgement> {
  const model = config.fake ? 'fake' : config.model
  let raw: Verdict
  if (config.fake) {
    raw = config.fake
  } else {
    const { judgeWithModel } = await import('./model.ts')
    raw = await judgeWithModel(config.model, input, signal)
  }
  return { question: input.question, model, ...normaliseVerdict(raw) }
}
