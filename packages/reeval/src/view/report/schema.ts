import { z } from 'zod'
import { type Assert, dataProblem, type Same } from '../../contract/shared.ts'
import type { AttemptFacts } from '../classify.ts'
import { fillDefaults, MIGRATIONS, NewerSchemaError } from '../record.ts'
import { REPORT_VERSION } from './split.ts'
import type {
  Arm,
  ArmRef,
  ArmRow,
  AssertionRow,
  AttemptIndexRow,
  AttemptRef,
  BehaviorRow,
  BreakdownRow,
  CaptureGallery,
  CaptureShot,
  ChangeRow,
  CheckCell,
  ChoiceBreakdown,
  ContrastRow,
  Count,
  Delta,
  DiscoveryRate,
  EffortPivotRow,
  EvalHeadline,
  EvalSection,
  ExecutiveRollup,
  FailureCluster,
  FailureClusters,
  Figure,
  HeadlinePrimary,
  IntegrityIssue,
  Interval,
  JudgeRow,
  JudgmentBreakdown,
  MeasureCells,
  MeasureVsBaseline,
  PairwiseRow,
  ProvenanceState,
  QualitativeAnswers,
  Quote,
  Rate,
  RegressionChanges,
  ReportClaim,
  RosterRow,
  RunHeader,
  RunReport,
  RunTally,
  Spread,
  TaskResults,
  VariantComparison,
} from './types.ts'

const figureSchema: z.ZodType<Figure> = z.strictObject({
  value: z.number().nullable(),
  text: z.string(),
})

const deltaSchema: z.ZodType<Delta> = z.strictObject({
  value: z.number().nullable(),
  unit: z.enum(['pct', 'pts']),
  text: z.string(),
})

const intervalSchema: z.ZodType<Interval> = z.strictObject({
  lo: z.number(),
  hi: z.number(),
  text: z.string(),
})

const spreadSchema: z.ZodType<Spread> = z.strictObject({
  n: z.number().int().nonnegative(),
  median: figureSchema,
  q1: figureSchema,
  q3: figureSchema,
})

const countSchema: z.ZodType<Count> = z.strictObject({
  k: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
  text: z.string(),
})

const rateSchema: z.ZodType<Rate> = z.strictObject({
  k: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
  rate: z.number().nullable(),
  text: z.string(),
  interval: intervalSchema.nullable(),
})

const attemptRefSchema: z.ZodType<AttemptRef> = z.strictObject({
  id: z.string(),
  key: z.string(),
  href: z.string(),
})

const armRefSchema: z.ZodType<ArmRef> = z.strictObject({
  id: z.string(),
  label: z.string(),
})

const measureKeySchema = z.enum([
  'tokens',
  'toolCalls',
  'turns',
  'costUsd',
  'agentMs',
  'filesChanged',
  'linesAdded',
  'linesRemoved',
])

const measureUnitSchema = z.enum(['tokens', 'ms', 'usd', 'count', 'lines', 'files'])

const measureCellsSchema: z.ZodType<MeasureCells> = z.strictObject({
  tokens: spreadSchema.nullable(),
  toolCalls: spreadSchema.nullable(),
  turns: spreadSchema.nullable(),
  costUsd: spreadSchema.nullable(),
  agentMs: spreadSchema.nullable(),
  filesChanged: spreadSchema.nullable(),
  linesAdded: spreadSchema.nullable(),
  linesRemoved: spreadSchema.nullable(),
})

const quoteSchema: z.ZodType<Quote> = z.strictObject({
  text: z.string(),
  attempt: attemptRefSchema,
  harness: z.string(),
  arm: z.string().nullable(),
  case: z.string().nullable(),
  input: z.string().nullable(),
})

const otherVariantSchema = z.strictObject({
  variant: armRefSchema,
  points: deltaSchema,
  interval: intervalSchema,
  rate: rateSchema,
})

const tiedLeadSchema = z.strictObject({
  measure: measureKeySchema,
  baseline: figureSchema,
  variant: figureSchema,
  delta: deltaSchema,
})

const compareStatusSchema = z.enum([
  'regressed',
  'fixed',
  'same',
  'gate',
  'drift',
  'added',
  'removed',
  'infra',
])

const changeRowSchema: z.ZodType<ChangeRow> = z.strictObject({
  signal: z.string(),
  kind: z.enum(['outcome', 'assertion', 'judgment', 'choice', 'measure', 'observation']),
  harness: z.string().nullable(),
  prior: z.string(),
  current: z.string(),
  delta: deltaSchema.nullable(),
  status: compareStatusSchema,
  gate: z.boolean(),
})

export const headlinePrimarySchema: z.ZodType<HeadlinePrimary> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pass-rate'),
    rate: rateSchema,
    assertions: z.number().int().positive(),
    harnesses: z.number().int().positive(),
    outcome: z.enum(['passed', 'found', 'used']),
  }),
  z.strictObject({
    kind: z.literal('lift'),
    baseline: armRefSchema,
    variant: armRefSchema,
    points: deltaSchema,
    interval: intervalSchema,
    baselineRate: rateSchema,
    variantRate: rateSchema,
    others: z.array(otherVariantSchema),
  }),
  z.strictObject({
    kind: z.literal('tied-ceiling'),
    baseline: armRefSchema,
    variant: armRefSchema,
    rate: rateSchema,
    assertions: z.number().int().positive(),
    lead: tiedLeadSchema,
  }),
  z.strictObject({
    kind: z.literal('choice'),
    question: z.string(),
    options: z
      .array(z.strictObject({ label: z.string(), count: z.number().int().nonnegative() }))
      .min(2),
    attempts: z.number().int().positive(),
    noPick: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('measure'),
    label: z.string(),
    unit: measureUnitSchema,
    spread: spreadSchema,
  }),
  z.strictObject({
    kind: z.literal('judge'),
    label: z.string(),
    question: z.string(),
    scale: z.tuple([z.number(), z.number()]),
    threshold: z.number().nullable(),
    spread: spreadSchema,
    atOrAbove: countSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('text'),
    question: z.string(),
    answered: countSchema,
    lead: quoteSchema.nullable(),
    leadRole: z.enum(['sole', 'representative']).nullable(),
  }),
  z.strictObject({
    kind: z.literal('regression'),
    worse: z.number().int().nonnegative(),
    fixed: z.number().int().nonnegative(),
    lead: changeRowSchema.nullable(),
  }),
])

const fairnessSchema = z.enum(['clear', 'within-noise', 'too-few-runs'])
const evalShapeSchema = z.enum(['task', 'ab', 'discoverability', 'regression'])

const evalHeadlineSchema: z.ZodType<EvalHeadline> = z.strictObject({
  task: z.string(),
  kicker: z.string().nullable(),
  fairness: fairnessSchema,
  primary: headlinePrimarySchema,
  foot: z.string(),
})

const checkCellSchema: z.ZodType<CheckCell> = z.strictObject({
  status: z.enum(['pass', 'fail', 'mixed', 'na', 'error', 'not-run']),
  passed: z.number().int().nonnegative(),
  answered: z.number().int().nonnegative(),
  notApplicable: z.number().int().nonnegative(),
  preSatisfied: z.number().int().nonnegative(),
  text: z.string(),
  reason: z.string().nullable(),
})

const assertionRowSchema: z.ZodType<AssertionRow> = z.strictObject({
  label: z.string(),
  matcher: z.string(),
  at: z.string().nullable(),
  cells: z.record(z.string(), checkCellSchema),
  total: checkCellSchema,
})

const breakdownRowSchema: z.ZodType<BreakdownRow> = z.strictObject({
  keys: z.array(z.string()),
  rate: rateSchema.nullable(),
  measures: measureCellsSchema,
})

const taskResultsSchema = z.strictObject({
  kind: z.literal('task'),
  columns: z.array(z.string()),
  assertions: z.array(assertionRowSchema),
  axes: z.array(z.string()),
  breakdown: z.array(breakdownRowSchema),
  median: breakdownRowSchema.nullable(),
})

const armSchema: z.ZodType<Arm> = z.strictObject({
  id: z.string(),
  label: z.string(),
  environment: z.string(),
  environmentDigest: z.string().nullable(),
  role: z.enum(['baseline', 'variant']),
  change: z.string().nullable(),
  prompts: z.array(z.string()),
})

const measureVsBaselineSchema: z.ZodType<MeasureVsBaseline> = z.strictObject({
  value: spreadSchema.nullable(),
  delta: deltaSchema.nullable(),
  lower: countSchema.nullable(),
})

const measureVsBaselineRecordSchema: z.ZodType<
  Record<z.infer<typeof measureKeySchema>, MeasureVsBaseline>
> = z.strictObject({
  tokens: measureVsBaselineSchema,
  toolCalls: measureVsBaselineSchema,
  turns: measureVsBaselineSchema,
  costUsd: measureVsBaselineSchema,
  agentMs: measureVsBaselineSchema,
  filesChanged: measureVsBaselineSchema,
  linesAdded: measureVsBaselineSchema,
  linesRemoved: measureVsBaselineSchema,
})

const armRowSchema: z.ZodType<ArmRow> = z.strictObject({
  arm: z.string(),
  rate: rateSchema,
  lift: deltaSchema.nullable(),
  interval: intervalSchema.nullable(),
  verdict: z.enum(['baseline', 'helped', 'made-worse', 'within-noise', 'too-few-runs']),
  verdictScope: z.literal('pass-rate'),
  measures: measureVsBaselineRecordSchema,
})

const effortPivotRowSchema: z.ZodType<EffortPivotRow> = z.strictObject({
  harness: z.string(),
  arm: z.string(),
  rate: rateSchema,
  measures: measureVsBaselineRecordSchema,
})

const behaviorRowSchema: z.ZodType<BehaviorRow> = z.strictObject({
  label: z.string(),
  matcher: z.string(),
  cells: z.record(z.string(), countSchema.nullable()),
})

const contrastRowSchema: z.ZodType<ContrastRow> = z.strictObject({
  from: z.string(),
  to: z.string(),
  measure: z.union([z.literal('pass-rate'), measureKeySchema]),
  delta: deltaSchema,
  interval: intervalSchema.nullable(),
  verdict: z.enum(['helped', 'made-worse', 'within-noise', 'too-few-runs', 'fewer', 'more']),
  verdictScope: z.enum(['pass-rate', 'measure']),
})

const variantComparisonSchema = z.strictObject({
  kind: z.literal('comparison'),
  arms: z.array(armSchema),
  uniformLead: z.string().nullable(),
  summary: z.array(armRowSchema),
  assertionsByArm: z.array(assertionRowSchema),
  behavior: z.array(behaviorRowSchema),
  contrasts: z.array(contrastRowSchema),
  effortByHarness: z.array(effortPivotRowSchema),
})

const regressionChangesSchema = z.strictObject({
  kind: z.literal('regression'),
  baseRunId: z.string(),
  prior: z.strictObject({
    runId: z.string(),
    startedAt: z.string(),
    gitSha: z.string().nullable(),
    branch: z.string().nullable(),
    author: z.string(),
  }),
  whatChanged: z.array(z.string()),
  rows: z.array(changeRowSchema),
  unchanged: z.array(changeRowSchema),
})

const primaryBlockSchema = z.discriminatedUnion('kind', [
  taskResultsSchema,
  variantComparisonSchema,
  regressionChangesSchema,
]) as z.ZodType<TaskResults | VariantComparison | RegressionChanges>

const choiceBreakdownSchema: z.ZodType<ChoiceBreakdown> = z.strictObject({
  question: z.string(),
  options: z.array(z.strictObject({ label: z.string(), count: z.number().int().nonnegative() })),
  noPick: z.number().int().nonnegative(),
  rows: z.array(
    z.strictObject({
      arm: z.string().nullable(),
      prompt: z.string().nullable(),
      harness: z.string(),
      counts: z.record(z.string(), z.number().int().nonnegative()),
      attempts: z.number().int().nonnegative(),
      text: z.string(),
    }),
  ),
  passByPick: z.array(z.strictObject({ option: z.string(), rate: rateSchema })),
})

const discoveryRateSchema: z.ZodType<DiscoveryRate> = z.strictObject({
  what: z.string(),
  matcher: z.string(),
  found: countSchema,
  rows: z.array(z.strictObject({ keys: z.array(z.string()), found: countSchema })),
  sources: z.array(
    z.strictObject({
      source: z.enum(['placed', 'skill-dir', 'elsewhere', 'mcp', 'web']),
      count: z.number().int().nonnegative(),
    }),
  ),
})

const judgeRowSchema: z.ZodType<JudgeRow> = z.strictObject({
  label: z.string(),
  question: z.string(),
  assertion: z.string().nullable(),
  threshold: z.number().nullable(),
  keys: z.array(z.string()),
  spread: spreadSchema,
  atOrAbove: countSchema.nullable(),
})

const pairwiseRowSchema: z.ZodType<PairwiseRow> = z.strictObject({
  question: z.string(),
  cut: z.enum(['within', 'across']),
  a: z.string(),
  b: z.string(),
  aWins: z.number().int().nonnegative(),
  bWins: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  pairs: z.number().int().nonnegative(),
  reasons: z.array(
    z.strictObject({
      text: z.string(),
      cites: z.tuple([attemptRefSchema, attemptRefSchema]),
      input: z.string().nullable(),
    }),
  ),
})

const judgmentBreakdownSchema: z.ZodType<JudgmentBreakdown> = z.strictObject({
  axes: z.array(z.string()),
  scores: z.array(judgeRowSchema),
  pairwise: z.array(pairwiseRowSchema),
})

const qualitativeAnswersSchema: z.ZodType<QualitativeAnswers> = z.strictObject({
  question: z.string(),
  answered: countSchema,
  themes: z.array(z.strictObject({ title: z.string(), quotes: z.array(quoteSchema) })).nullable(),
  entries: z.array(quoteSchema),
})

const captureShotSchema: z.ZodType<CaptureShot> = z.strictObject({
  name: z.string(),
  href: z.string().nullable(),
  meta: z.string().nullable(),
  attempt: attemptRefSchema,
  status: z.number().nullable(),
  pageErrors: z.number().nullable(),
  consoleErrors: z.number().nullable(),
})

const captureGallerySchema: z.ZodType<CaptureGallery> = z.strictObject({
  rows: z.array(
    z.strictObject({
      harness: z.string(),
      arm: z.string().nullable(),
      case: z.string().nullable(),
      shots: z.array(captureShotSchema),
    }),
  ),
})

const failureClusterSchema: z.ZodType<FailureCluster> = z.strictObject({
  kind: z.enum(['assertion', 'turn-error', 'infra-error', 'capture-error', 'error']),
  label: z.string(),
  at: z.string().nullable(),
  count: countSchema,
  attempts: z.array(attemptRefSchema),
})

const failureClustersSchema: z.ZodType<FailureClusters> = z.strictObject({
  clusters: z.array(failureClusterSchema),
  remarks: z.array(
    z.strictObject({
      kind: z.enum([
        'too-few-tries',
        'cant-tell-apart',
        'check-never-fails',
        'flaky-check',
        'slow-mcp-start',
        'proxy-only-egress',
        'setup-process-secret',
        'setup-tunnel-closed',
        'snapshot-too-large',
        'observe-throws',
      ]),
      severity: z.enum(['concern', 'suggestion']),
      text: z.string(),
      fix: z.strictObject({ at: z.string(), edit: z.string() }),
    }),
  ),
})

const reportClaimSchema: z.ZodType<ReportClaim> = z.strictObject({
  role: z.enum(['finding', 'caveat', 'action']),
  text: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  cites: z.array(attemptRefSchema),
  action: z
    .strictObject({
      kind: z.enum(['skill', 'docs', 'eval', 'judge', 'reeval', 'harness']),
      target: z.string(),
      change: z.string(),
      verify: z.string().nullable(),
    })
    .nullable(),
})

const evalSectionSchema = z.strictObject({
  id: z.string(),
  anchor: z.string(),
  name: z.string(),
  file: z.string(),
  shapes: z.array(evalShapeSchema),
  design: z.string(),
  headline: evalHeadlineSchema,
  insights: z.array(reportClaimSchema),
  primary: primaryBlockSchema.nullable(),
  choices: z.array(choiceBreakdownSchema),
  discovery: z.array(discoveryRateSchema),
  judgments: judgmentBreakdownSchema.nullable(),
  qualitative: z.array(qualitativeAnswersSchema),
  captures: captureGallerySchema.nullable(),
  failures: failureClustersSchema.nullable(),
}) as z.ZodType<EvalSection>

const runTallySchema: z.ZodType<RunTally> = z.strictObject({
  counted: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  ungated: z.strictObject({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  infraError: z.number().int().nonnegative(),
  reclassified: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
})

const runHeaderSchema: z.ZodType<RunHeader> = z.strictObject({
  title: z.string(),
  status: z.enum(['complete', 'interrupted', 'budget']),
  startedAt: z.string(),
  author: z.string(),
  reeval: z.string(),
  profile: z.string().nullable(),
  scope: z
    .strictObject({
      profile: z.string().nullable(),
      subset: z.boolean(),
      configKey: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
  runsPerCell: z.number().int().positive().nullable(),
  wall: figureSchema,
  tally: runTallySchema,
  tokens: z
    .strictObject({
      total: figureSchema,
      cacheRead: figureSchema,
    })
    .nullable(),
  cost: z
    .strictObject({
      agent: figureSchema.nullable(),
      judge: figureSchema.nullable(),
      total: figureSchema.nullable(),
      basis: z.enum(['reported', 'estimated', 'mixed']),
    })
    .nullable(),
  git: z
    .strictObject({
      sha: z.string(),
      branch: z.string().nullable(),
      dirty: z.boolean(),
      repo: z.string().nullable(),
    })
    .nullable(),
})

const integrityIssueSchema: z.ZodType<IntegrityIssue> = z.strictObject({
  kind: z.enum([
    'run-incomplete',
    'turn-error',
    'pre-satisfied',
    'fairness-floor',
    'served-model-drift',
    'unreported-usage',
    'prompt-confounded',
    'duplicate-environment',
    'baseline-never-passes',
    'dirty-worktree',
  ]),
  severity: z.enum(['error', 'warn']),
  text: z.string(),
  evalId: z.string().nullable(),
  cites: z.array(attemptRefSchema),
})

const executiveRollupSchema: z.ZodType<ExecutiveRollup> = z.strictObject({
  lead: reportClaimSchema.nullable(),
  rows: z.array(
    z.strictObject({
      evalId: z.string(),
      name: z.string(),
      anchor: z.string(),
      shapes: z.array(evalShapeSchema),
      design: z.string(),
      primary: z.string(),
      medianTokens: figureSchema,
    }),
  ),
  findings: z.array(reportClaimSchema),
})

const rosterRowSchema: z.ZodType<RosterRow> = z.strictObject({
  harness: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  servedModels: z.array(z.string()),
  gateway: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
})

const provenanceStateSchema: z.ZodType<ProvenanceState> = z.strictObject({
  rows: z.array(z.strictObject({ field: z.string(), value: z.string() })),
  context: z.strictObject({
    count: z.number().int().nonnegative(),
    files: z.array(z.strictObject({ path: z.string(), sha256: z.string() })),
  }),
  artifacts: z.enum(['all', 'evidence', 'failures', 'none']),
  record: z.string(),
  warnings: z.array(z.string()),
})

const attemptFactsSchema: z.ZodType<AttemptFacts> = z.strictObject({
  toolCalls: z.number().int().nonnegative(),
  byClass: z.strictObject({
    context: z.number().int().nonnegative(),
    dependency: z.number().int().nonnegative(),
    web: z.number().int().nonnegative(),
    verify: z.number().int().nonnegative(),
    workspace: z.number().int().nonnegative(),
  }),
  skills: z.array(
    z.strictObject({
      skill: z.string(),
      source: z.enum(['placed', 'skill-dir', 'elsewhere']),
      reads: z.number().int().positive(),
      firstLine: z.number().int().positive(),
    }),
  ),
  contextFiles: z.array(
    z.strictObject({
      path: z.string(),
      reads: z.number().int().positive(),
      firstLine: z.number().int().positive(),
    }),
  ),
})

const attemptIndexRowSchema: z.ZodType<AttemptIndexRow> = z.strictObject({
  id: z.string(),
  key: z.string(),
  evalId: z.string(),
  harness: z.string(),
  arm: z.string().nullable(),
  case: z.string().nullable(),
  outcome: z.enum(['pass', 'fail', 'infra_error', 'canceled']),
  reclassified: z.boolean(),
  turnError: z.string().nullable(),
  tokens: figureSchema,
  agentMs: figureSchema,
  toolCalls: figureSchema,
  facts: attemptFactsSchema.optional(),
  diff: z
    .strictObject({
      files: z.number().int().nonnegative(),
      added: z.number().int().nullable(),
      removed: z.number().int().nullable(),
      text: z.string(),
    })
    .nullable(),
  links: z.strictObject({
    transcript: z.string().nullable(),
    diff: z.string().nullable(),
    captures: z.array(z.strictObject({ name: z.string(), href: z.string() })),
    questions: z.array(z.string()),
  }),
  href: z.string(),
})

export const runReportSchema: z.ZodType<RunReport> = z.strictObject({
  reportVersion: z.literal(1),
  runId: z.string(),
  single: z.boolean(),
  header: runHeaderSchema,
  integrity: z.array(integrityIssueSchema),
  rollup: executiveRollupSchema.nullable(),
  roster: z.array(rosterRowSchema),
  evals: z.array(evalSectionSchema).min(1, 'must hold at least one eval'),
  actions: z.array(reportClaimSchema),
  provenance: provenanceStateSchema,
  attempts: z.array(attemptIndexRowSchema),
})

export type _SameAsSchema = [
  Assert<Same<z.infer<typeof figureSchema>, Figure>>,
  Assert<Same<z.infer<typeof deltaSchema>, Delta>>,
  Assert<Same<z.infer<typeof intervalSchema>, Interval>>,
  Assert<Same<z.infer<typeof spreadSchema>, Spread>>,
  Assert<Same<z.infer<typeof countSchema>, Count>>,
  Assert<Same<z.infer<typeof rateSchema>, Rate>>,
  Assert<Same<z.infer<typeof headlinePrimarySchema>, HeadlinePrimary>>,
  Assert<Same<z.infer<typeof taskResultsSchema>, TaskResults>>,
  Assert<Same<z.infer<typeof variantComparisonSchema>, VariantComparison>>,
  Assert<Same<z.infer<typeof regressionChangesSchema>, RegressionChanges>>,
  Assert<Same<z.infer<typeof evalSectionSchema>, EvalSection>>,
  Assert<Same<z.infer<typeof runReportSchema>, RunReport>>,
]

export {
  attemptRefSchema,
  countSchema,
  deltaSchema,
  figureSchema,
  intervalSchema,
  rateSchema,
  reportClaimSchema,
  spreadSchema,
}

/**
 * Each named schema by the type in `./types.ts` it validates: the `$defs` of `report.json`'s JSON
 * Schema snapshot (`pnpm schema:update`), which takes each def's descriptions from that type.
 */
export const REPORT_SCHEMAS: Record<string, z.ZodType> = {
  Arm: armSchema,
  ArmRef: armRefSchema,
  ArmRow: armRowSchema,
  AssertionRow: assertionRowSchema,
  AttemptFacts: attemptFactsSchema,
  AttemptIndexRow: attemptIndexRowSchema,
  AttemptRef: attemptRefSchema,
  BehaviorRow: behaviorRowSchema,
  BreakdownRow: breakdownRowSchema,
  CaptureGallery: captureGallerySchema,
  CaptureShot: captureShotSchema,
  ChangeRow: changeRowSchema,
  CheckCell: checkCellSchema,
  ChoiceBreakdown: choiceBreakdownSchema,
  ContrastRow: contrastRowSchema,
  Count: countSchema,
  Delta: deltaSchema,
  DiscoveryRate: discoveryRateSchema,
  EffortPivotRow: effortPivotRowSchema,
  EvalHeadline: evalHeadlineSchema,
  EvalSection: evalSectionSchema,
  ExecutiveRollup: executiveRollupSchema,
  FailureCluster: failureClusterSchema,
  FailureClusters: failureClustersSchema,
  Figure: figureSchema,
  HeadlinePrimary: headlinePrimarySchema,
  IntegrityIssue: integrityIssueSchema,
  Interval: intervalSchema,
  JudgeRow: judgeRowSchema,
  JudgmentBreakdown: judgmentBreakdownSchema,
  MeasureCells: measureCellsSchema,
  MeasureVsBaseline: measureVsBaselineSchema,
  PairwiseRow: pairwiseRowSchema,
  ProvenanceState: provenanceStateSchema,
  QualitativeAnswers: qualitativeAnswersSchema,
  Quote: quoteSchema,
  Rate: rateSchema,
  RegressionChanges: regressionChangesSchema,
  ReportClaim: reportClaimSchema,
  RosterRow: rosterRowSchema,
  RunHeader: runHeaderSchema,
  RunReport: runReportSchema,
  RunTally: runTallySchema,
  Spread: spreadSchema,
  TaskResults: taskResultsSchema,
  VariantComparison: variantComparisonSchema,
}

const LEAVES = new Set(['string', 'number', 'boolean', 'literal', 'enum', 'null', 'unknown'])
const loosened = new WeakMap<z.ZodType, z.ZodType>()

/**
 * `schema` with every object in it, at any depth, accepting keys it doesn't list (kept, not
 * stripped). Each node is a clone of the strict one with only its children and `catchall`
 * replaced, so checks such as `.min(1)` hold in both.
 */
function loose<T extends z.ZodType>(schema: T): T {
  const known = loosened.get(schema)
  if (known) return known as T
  // biome-ignore lint/suspicious/noExplicitAny: each case reads its own kind's def
  const def = schema.def as any
  let out: z.ZodType
  switch (def.type) {
    case 'object':
      out = schema.clone({
        ...def,
        shape: Object.fromEntries(
          Object.entries(def.shape as Record<string, z.ZodType>).map(([k, v]) => [k, loose(v)]),
        ),
        catchall: z.unknown(),
      })
      break
    case 'array':
      out = schema.clone({ ...def, element: loose(def.element) })
      break
    case 'nullable':
    case 'optional':
      out = schema.clone({ ...def, innerType: loose(def.innerType) })
      break
    case 'union':
      out = schema.clone({ ...def, options: def.options.map(loose) })
      break
    case 'tuple':
      out = schema.clone({ ...def, items: def.items.map(loose), rest: def.rest && loose(def.rest) })
      break
    case 'record':
      out = schema.clone({ ...def, valueType: loose(def.valueType) })
      break
    default:
      if (!LEAVES.has(def.type)) throw new Error(`loose(): no rule for a Zod ${def.type} schema`)
      out = schema
  }
  loosened.set(schema, out)
  return out as T
}

/** `runReportSchema` with unknown fields allowed at every level, for reading a stored report. */
export const looseRunReportSchema: z.ZodType<RunReport> = loose(runReportSchema)

/**
 * A stored `report.json` as a reader sees it: migrated to this reeval's `reportVersion`, each field
 * added after it was written read as its default (`READ_DEFAULTS['run-report']`), and fields a
 * newer reeval added, at any depth, passed through. A missing or mistyped field throws one sentence
 * naming it (`This report's header.title is missing: …`), and a `reportVersion` above this reeval's
 * a `NewerSchemaError`.
 */
export function readableRunReport(value: unknown, what = 'This report'): RunReport {
  let version = (value as { reportVersion?: unknown } | null)?.reportVersion
  if (typeof version === 'number' && version > REPORT_VERSION) {
    throw new NewerSchemaError(what, version, REPORT_VERSION, 'reportVersion')
  }
  let v = value
  for (; typeof version === 'number' && version < REPORT_VERSION; version++) {
    const migrate = MIGRATIONS['run-report']?.[version]
    if (!migrate) break
    v = migrate(v as never)
  }
  const filled = fillDefaults('run-report', v)
  const parsed = looseRunReportSchema.safeParse(filled)
  if (parsed.success) return parsed.data
  throw new Error(dataProblem(looseRunReportSchema, filled, what, () => []))
}
