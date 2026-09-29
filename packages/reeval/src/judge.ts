// `reeval/judge`: judge helpers and types. Models are `'provider/model'` strings or AI SDK
// evaluation model objects, e.g. `openai.evaluationModel('…')`.
import type { FakeAnalysisModel, FakeJudgeModel } from './types.ts'

/** A judge that always returns `score`, without calling a model. For tests and dry runs. */
export const fakeJudge = ({ score = 1 }: { score?: number } = {}): FakeJudgeModel => ({
  kind: 'fake-judge',
  score,
})

/**
 * An analysis model for tests: `reeval analyze` gets `output` (or `output(digest)`) back as the
 * model's structured answer, through the same parsing and validation as a real one. With
 * `analysis.agent`, each note calls the same tools a real model would, then answers with `note`
 * (or `note(input)`), or throws `note.error`.
 */
export const fakeAnalysis = ({
  output,
  note,
}: {
  output?: FakeAnalysisModel['output']
  note?: FakeAnalysisModel['note']
}): FakeAnalysisModel => ({
  kind: 'fake-analysis',
  ...(output !== undefined ? { output } : {}),
  ...(note !== undefined ? { note } : {}),
})

export { DEFAULT_THRESHOLD, RECOMMENDED_JUDGE_MODEL } from './judge/index.ts'
export type {
  AnalysisConfig,
  ConfigJudgeOptions,
  FakeAnalysisModel,
  FakeJudgeModel,
  FakeNoteInput,
  JudgeCallOptions,
  JudgeModel,
  JudgeOptions,
  Verdict,
} from './types.ts'
