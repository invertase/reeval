// `reeval/judge`: judge helpers and types. Models are `'provider/model'` strings or AI SDK
// decision model objects, e.g. `openai.decisionModel('…')`.
import type { FakeAnalysisModel, FakeJudgeModel } from './types.ts'

/**
 * A judge that returns `score` without calling a model, for tests and dry runs. `score` can be a
 * function of the state the judge would see (per group, eval or call; the config takes a number).
 */
export const fakeJudge = ({
  score = 1,
}: {
  score?: FakeJudgeModel['score']
} = {}): FakeJudgeModel => ({
  kind: 'fake-judge',
  score,
})

/**
 * An analysis model for tests: `reeval analyze` gets `output` (or `output(digest)`) back as the
 * model's structured answer, each pairwise question's pair gets `vote` (a fixed `'A'`, `'B'` or
 * `'tie'`, `{ winner, reason? }`, a function of the blinded pair, or `{ error }`), and each
 * question asked of one attempt gets `answer` (its text, `{ choice?, text? }`, a function of the
 * blinded attempt, or `{ error }`), through the same parsing and validation as a real one. Insights (in `reeval run` and `reeval analyze --insights`)
 * get `insights` (or `insights(input)`, called per eval for its classification and its sentences,
 * then once for the headline), through the same validator: an uncited sentence is dropped, and one
 * with a banned word is asked for again, then dropped.
 */
export const fakeAnalysis = ({
  output,
  vote,
  answer,
  insights,
}: Pick<FakeAnalysisModel, 'output' | 'vote' | 'answer' | 'insights'>): FakeAnalysisModel => ({
  kind: 'fake-analysis',
  ...(output !== undefined ? { output } : {}),
  ...(vote !== undefined ? { vote } : {}),
  ...(answer !== undefined ? { answer } : {}),
  ...(insights !== undefined ? { insights } : {}),
})

export { DEFAULT_THRESHOLD, RECOMMENDED_JUDGE_MODEL } from './judge/index.ts'
export type {
  AnalysisConfig,
  BlindAttempt,
  BlindPair,
  ConfigJudgeOptions,
  FakeAnalysisModel,
  FakeAnswer,
  FakeInsights,
  FakeInsightsInput,
  FakeJudgeModel,
  FakeVote,
  JudgeArtifactRef,
  JudgeCallOptions,
  JudgeFailure,
  JudgeModel,
  JudgeOptions,
  JudgeState,
  Verdict,
} from './types.ts'
