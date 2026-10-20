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
 * model's structured answer, and each compare question's pair gets `vote` (a fixed `'A'`, `'B'` or
 * `'tie'`, `{ winner, reason? }`, a function of the blinded pair, or `{ error }`), through the same
 * parsing and validation as a real one. With `analysis.agent`, each note calls the same tools a real
 * model would, then answers with `note` (or `note(input)`), or throws `note.error`.
 * `reeval analyze --insights` gets `insights` (or `insights(input)`, called per eval for its
 * classification and its sentences, then once for the headline), through the same validator: an
 * uncited sentence is dropped, and one with a banned word is asked for again, then dropped.
 */
export const fakeAnalysis = ({
  output,
  note,
  vote,
  insights,
}: Pick<FakeAnalysisModel, 'output' | 'note' | 'vote' | 'insights'>): FakeAnalysisModel => ({
  kind: 'fake-analysis',
  ...(output !== undefined ? { output } : {}),
  ...(note !== undefined ? { note } : {}),
  ...(vote !== undefined ? { vote } : {}),
  ...(insights !== undefined ? { insights } : {}),
})

export { DEFAULT_THRESHOLD, RECOMMENDED_JUDGE_MODEL } from './judge/index.ts'
export type {
  AnalysisConfig,
  BlindPair,
  ConfigJudgeOptions,
  FakeAnalysisModel,
  FakeInsights,
  FakeInsightsInput,
  FakeJudgeModel,
  FakeNoteInput,
  FakeVote,
  JudgeArtifactRef,
  JudgeCallOptions,
  JudgeFailure,
  JudgeModel,
  JudgeOptions,
  JudgeState,
  Verdict,
} from './types.ts'
