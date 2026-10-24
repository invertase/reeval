// Maps eval/group option keys (src/options.ts EVAL_OPTION_KEYS and nested cascade paths) to the
// inventory feature that covers them. matrix.test.ts fails when a key is missing, when dry-run
// coverage lacks a plan case, or when refusal coverage lacks rows in test/refusals/.

export type EvalOptionSpec = {
  /** Top-level key from EVAL_OPTION_KEYS, or a dotted cascade path such as question.model. */
  key: string
  /** inventory.ts entry id. */
  featureId: string
  /** `reeval run --dry-run` output names this; needs a plan case under test/plan/. */
  plan?: true
  /** Plan-time refusal rows must mention this key in test/refusals/. */
  refusals?: true
}

export const EVAL_OPTION_SPECS: EvalOptionSpec[] = [
  { key: 'harness', featureId: 'matrix.harness-runs', plan: true, refusals: true },
  { key: 'sandbox', featureId: 'environment.sandbox', plan: true, refusals: true },
  { key: 'environment', featureId: 'matrix.cascade', plan: true, refusals: true },
  { key: 'compare', featureId: 'compare', plan: true, refusals: true },
  { key: 'runs', featureId: 'matrix.harness-runs', plan: true },
  { key: 'gate', featureId: 'gate.hint', plan: true, refusals: true },
  { key: 'env', featureId: 'env.vars', refusals: true },
  { key: 'egress', featureId: 'egress', plan: true, refusals: true },
  { key: 'judge', featureId: 'judge', refusals: true },
  { key: 'capture', featureId: 'ui.capture', plan: true },
  { key: 'questions', featureId: 'compare.questions', plan: true, refusals: true },
  { key: 'question', featureId: 'compare.questions.state', plan: true, refusals: true },
  { key: 'question.model', featureId: 'compare.questions.state', plan: true, refusals: true },
  { key: 'timeout', featureId: 'cancel' },
  { key: 'tags', featureId: 'selection.tags', plan: true },
  { key: 'pin', featureId: 'profiles', plan: true },
]
