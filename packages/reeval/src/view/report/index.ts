export { buildRunReport, type RunReportOptions } from './build.ts'
export {
  countFigure,
  countOf,
  diffLinesText,
  durationFigure,
  figure,
  judgeScoreText,
  medianWithDelta,
  pctDelta,
  ptsDelta,
  ptsInterval,
  rateOf,
  spreadOf,
  tokensFigure,
  tokensText,
  usdFigure,
} from './format.ts'
export { type AttemptIdMap, attemptAnchor, attemptIds, idOf, selectedEvals } from './ids.ts'
export {
  COMPARE_STATUS_LABEL,
  compareStatusLabel,
  contrastMeasureLabel,
  DISCOVERY_SOURCE_LABEL,
  discoverySourceLabel,
  MEASURE_LABEL,
  measurePhrase,
  PASS_RATE_OUTCOME_LABEL,
  type PassRateOutcome,
  passRateOutcomeFromMatchers,
  VERDICT_LABEL,
  verdictLabel,
} from './labels.ts'
export {
  attemptHref,
  attemptRef,
  captureHref,
  evalAnchorHref,
  gfmAnchor,
  questionHref,
  recordHref,
  withBase,
  worktreePatchLink,
} from './links.ts'
export { blockMarkdown, FORBIDDEN_OUTPUT, runReportMarkdown } from './markdown.ts'
export { REPORT_POLICY, type ReportPolicy } from './policy.ts'
export { provenanceState, stateRows, warnings } from './provenance.ts'
export {
  attemptRefSchema,
  countSchema,
  deltaSchema,
  figureSchema,
  headlinePrimarySchema,
  intervalSchema,
  rateSchema,
  reportClaimSchema,
  runReportSchema,
  spreadSchema,
} from './schema.ts'
export type * from './types.ts'
