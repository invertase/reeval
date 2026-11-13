// The Zod schemas of a `reeval analyze` document, one per type in `./analysis.ts`: the source of
// `schema/analysis.schema.json` (`ANALYSIS_SCHEMAS`), and what a reader checks a saved or uploaded
// analysis against before it shows or sends it (`parsedAnalysis`). Only `reeval/view/report` and
// the CLI load this module, so the `reeval/view` root stays free of zod.
import { z } from 'zod'
import { type Assert, dataProblem, type Same } from '../contract/shared.ts'
import type {
  ActionKind,
  AnalysisAction,
  AnalysisAnomaly,
  AnalysisBody,
  AnalysisClaim,
  AnalysisDoc,
  AnalysisScope,
  AnalysisValidation,
  AnomalyKind,
  Confidence,
  Level,
} from './analysis.ts'
import { readableAnalysis } from './record.ts'

const confidenceSchema = z.enum(['high', 'medium', 'low'])
const levelSchema = z.enum(['high', 'medium', 'low'])
const anomalyKindSchema = z.enum(['reeval-bug', 'eval-design', 'judge', 'noise', 'other'])
const actionKindSchema = z.enum(['skill', 'docs', 'eval', 'judge', 'reeval', 'harness'])
const roleSchema = z.enum(['finding', 'caveat', 'action'])
const attemptRefsSchema = z.array(z.object({ attemptId: z.string(), path: z.string() }))

const analysisClaimSchema = z.object({
  text: z.string(),
  cites: z.array(z.string()),
  confidence: confidenceSchema,
  quotes: z.array(z.string()).optional(),
  unverifiedNumbers: z.array(z.string()).optional(),
  evalId: z.string().optional(),
  role: roleSchema.optional(),
  attempts: attemptRefsSchema.optional(),
})

const analysisAnomalySchema = z.object({
  text: z.string(),
  kind: anomalyKindSchema,
  cites: z.array(z.string()),
  unverifiedNumbers: z.array(z.string()).optional(),
  evalId: z.string().optional(),
  role: roleSchema.optional(),
  attempts: attemptRefsSchema.optional(),
})

const analysisActionSchema = z.object({
  title: z.string(),
  target: z.string(),
  kind: actionKindSchema,
  change: z.string(),
  expectedEffect: z.string(),
  verify: z.string().nullable(),
  verifyProblem: z.string().optional(),
  impact: levelSchema,
  effort: levelSchema,
  cites: z.array(z.string()),
  evalId: z.string().optional(),
  role: roleSchema.optional(),
  attempts: attemptRefsSchema.optional(),
})

const analysisBodySchema = z.object({
  tldr: z.string(),
  whatHappened: z.array(analysisClaimSchema),
  results: z.array(analysisClaimSchema),
  why: z.array(analysisClaimSchema),
  anomalies: z.array(analysisAnomalySchema),
  actions: z.array(analysisActionSchema),
  confidence: z.object({ overall: confidenceSchema, why: z.string() }),
})

const analysisValidationSchema = z.object({
  citations: z.number(),
  invalid: z.array(z.string()),
  dropped: z.number(),
  commands: z.number(),
  invalidCommands: z.array(z.string()),
  unverifiedNumbers: z.number(),
})

const analysisScopeSchema = z.object({
  kind: z.literal('run'),
  head: z.string(),
  base: z.string().nullable(),
  evals: z.string().nullable(),
})

/** A document's keys it doesn't list pass, unchecked: a newer reeval may have added them. */
export const analysisDocSchema = z.object({
  kind: z.literal('reeval-analysis'),
  schemaVersion: z.literal(1),
  scope: analysisScopeSchema,
  anchor: z.string(),
  inputs: z.object({
    records: z.array(z.object({ runId: z.string(), sha256: z.string() })),
    digestVersion: z.number(),
    digestHash: z.string(),
  }),
  promptVersion: z.string(),
  model: z.string(),
  resolvedModel: z.string().nullable(),
  route: z.enum(['direct', 'gateway', 'openrouter', 'vertex', 'fake']),
  usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable() }),
  latencyMs: z.number(),
  createdAt: z.string(),
  author: z.string(),
  validation: analysisValidationSchema,
  analysis: analysisBodySchema,
  attempts: z.record(
    z.string(),
    z.object({ runId: z.string(), evalSlug: z.string(), attempt: z.string() }),
  ),
  cited: z.record(z.string(), z.string()),
  error: z.string().optional(),
})

type _SameAsSchema = [
  Assert<Same<z.infer<typeof confidenceSchema>, Confidence>>,
  Assert<Same<z.infer<typeof levelSchema>, Level>>,
  Assert<Same<z.infer<typeof anomalyKindSchema>, AnomalyKind>>,
  Assert<Same<z.infer<typeof actionKindSchema>, ActionKind>>,
  Assert<Same<z.infer<typeof analysisClaimSchema>, AnalysisClaim>>,
  Assert<Same<z.infer<typeof analysisAnomalySchema>, AnalysisAnomaly>>,
  Assert<Same<z.infer<typeof analysisActionSchema>, AnalysisAction>>,
  Assert<Same<z.infer<typeof analysisBodySchema>, AnalysisBody>>,
  Assert<Same<z.infer<typeof analysisValidationSchema>, AnalysisValidation>>,
  Assert<Same<z.infer<typeof analysisScopeSchema>, AnalysisScope>>,
  Assert<Same<z.infer<typeof analysisDocSchema>, AnalysisDoc>>,
]

/**
 * Each named schema by the type in `./analysis.ts` it validates: the `$defs` of the analysis
 * document's JSON Schema snapshot (`pnpm schema:update`), which takes each def's descriptions from
 * that type.
 */
export const ANALYSIS_SCHEMAS: Record<string, z.ZodType> = {
  ActionKind: actionKindSchema,
  AnalysisAction: analysisActionSchema,
  AnalysisAnomaly: analysisAnomalySchema,
  AnalysisBody: analysisBodySchema,
  AnalysisClaim: analysisClaimSchema,
  AnalysisDoc: analysisDocSchema,
  AnalysisScope: analysisScopeSchema,
  AnalysisValidation: analysisValidationSchema,
  AnomalyKind: anomalyKindSchema,
  Confidence: confidenceSchema,
  Level: levelSchema,
}

/**
 * `value` as an analysis every reader can show: `readableAnalysis`'s migration and read defaults,
 * then checked against `analysisDocSchema`. One that isn't an analysis, has no `schemaVersion`, or
 * has a missing or mistyped field throws one sentence naming it; one from a newer reeval throws a
 * `NewerSchemaError`.
 */
export function parsedAnalysis(value: unknown, what = 'This analysis'): AnalysisDoc {
  const v = value as { kind?: unknown; schemaVersion?: unknown } | null
  if (typeof v !== 'object' || v === null || Array.isArray(v) || v.kind !== 'reeval-analysis') {
    throw new Error(`${what} isn't a reeval analysis: its kind isn't "reeval-analysis"`)
  }
  if (typeof v.schemaVersion !== 'number') {
    throw new Error(`${what} has no schemaVersion, which every reeval analysis has`)
  }
  const doc = readableAnalysis(value as AnalysisDoc, what)
  const problem = dataProblem(analysisDocSchema, doc, what, () => [])
  if (problem) throw new Error(problem)
  return doc
}
