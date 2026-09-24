// `evalsuite/judge`: judge helpers and types. Models are `'provider/model'` strings or AI SDK
// evaluation model objects, e.g. `openai.evaluationModel('…')`.
import type { FakeJudgeModel } from './types.ts'

/** A judge that always returns `score`, without calling a model. For tests and dry runs. */
export const fakeJudge = ({ score = 1 }: { score?: number } = {}): FakeJudgeModel => ({
  kind: 'fake-judge',
  score,
})

export { DEFAULT_THRESHOLD, RECOMMENDED_JUDGE_MODEL } from './judge/index.ts'
export type {
  ConfigJudgeOptions,
  FakeJudgeModel,
  JudgeCallOptions,
  JudgeModel,
  JudgeOptions,
  Verdict,
} from './types.ts'
